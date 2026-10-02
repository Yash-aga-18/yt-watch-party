// sockets/socket.room.js

import crypto from "node:crypto";
import Participant from "../services/Participant.js";
import { ROLES, canControlPlayback, isHost } from "../utils/permissions.js";
import { extractVideoId } from "../utils/youtube.js";

const ACTIONS = [ "play", "pause", "seek", "change_video", "mute", "unmute", "set_rate", "set_captions" ];

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DISCONNECT_GRACE_MS = 30 * 1000;

function cleanName(username) {
    return typeof username === "string" ? username.trim().slice(0, 30) : "";
}

export default class RoomSocketHandler {
    constructor(io, roomManager, socket) {
        this.io = io;
        this.rooms = roomManager;
        this.socket = socket;
    }

    register() {
        const on = (event, fn) => {
            this.socket.on(event, async (payload, cb) => {
                if (typeof payload === "function") {
                    cb = payload;
                    payload = {};
                }

                const ack = typeof cb === "function" ? cb : () => {};

                try {
                    await fn(payload || {}, ack);
                } catch (error) {
                    console.error(`Error in ${event}:`, error);
                    ack({
                        ok: false,
                        error: "Server error"
                    });
                }
            });
        };

        // Room events
        on("create_room", (data, ack) => this.createRoom(data, ack));
        on("join_room", (data, ack) => this.joinRoom(data, ack));
        on("resolve_join", (data, ack) => this.resolveJoin(data, ack));
        on("leave_room", () => this.leaveRoom());
        on("request_sync", () => this.requestSync());

        // Playback events
        on("heartbeat", (data) => this.heartbeat(data));
        on("play", (data, ack) => this.control("play", data, ack));
        on("pause", (data, ack) => this.control("pause", data, ack));
        on("seek", (data, ack) => this.control("seek", data, ack));
        on("change_video", (data, ack) =>
            this.control("change_video", data, ack)
        );
        on("mute", (data, ack) => this.control("mute", data, ack));
        on("unmute", (data, ack) => this.control("unmute", data, ack));
        on("set_rate", (data, ack) =>
            this.control("set_rate", data, ack)
        );
        on("set_captions", (data, ack) =>
            this.control("set_captions", data, ack)
        );

        // Participants request playback changes instead of controlling directly.
        on("request_action", (data, ack) =>
            this.requestAction(data, ack)
        );
        on("resolve_request", (data, ack) =>
            this.resolveRequest(data, ack)
        );

        // Host events
        on("assign_role", (data, ack) =>
            this.assignRole(data, ack)
        );
        on("remove_participant", (data, ack) =>
            this.removeParticipant(data, ack)
        );
        on("transfer_host", (data, ack) =>
            this.transferHost(data, ack)
        );

        // Chat
        on("chat_message", (data, ack) =>
            this.chatMessage(data, ack)
        );

        this.socket.on("disconnect", () => {
            try {
                this.onDisconnect();
            } catch (error) {
                console.error("Error in disconnect:", error);
            }
        });
    }

    // Send an error to both the client UI and callback.
    deny(event, ack, message) {
        this.socket.emit("error_message", {
            event,
            message
        });

        ack({
            ok: false,
            error: message
        });
    }

    // Gets the room and participant using server-side socket data.
    context() {
        const { roomId, userId } = this.socket.data;

        const room = this.rooms.getLoadedRoom(roomId);
        const me = room?.participants.get(userId);

        return room && me
            ? { room, me }
            : null;
    }

    // Data sent to a participant when they join or reconnect.
    joinPayload(room, me) {
        return {
            ok: true,
            roomId: room.code,

            // Token is only sent to the participant who owns it.
            you: {
                userId: me.userId,
                username: me.username,
                role: me.role,
                token: me.token
            },

            participants: room.getParticipantList(),
            state: room.getSyncState(),
            requests: room.getRequestsFor(me),
            joinRequests: isHost(me.role)
                ? room.getJoinRequestList()
                : [],
            chat: room.chat
        };
    }

    broadcastSync(room, updatedBy) {
        this.io.to(room.code).emit("sync_state", {
            ...room.getSyncState(),
            updatedBy
        });
    }

    broadcastRequests(room) {
        for (const participant of room.participants.values()) {
            if (participant.connected) {
                this.io
                    .to(participant.socketId)
                    .emit("requests_updated", {
                        requests: room.getRequestsFor(participant)
                    });
            }
        }
    }

    // Only the host sees pending join requests.
    broadcastJoinRequests(room) {
        const host = room.getHost();

        if (host?.connected) {
            this.io
                .to(host.socketId)
                .emit("join_requests_updated", {
                    joinRequests: room.getJoinRequestList()
                });
        }
    }

    // Validate and clean playback input before changing room state.
    validateAction(action, payload = {}) {
        if (!ACTIONS.includes(action)) {
            return {
                ok: false,
                error: "Unknown action"
            };
        }

        if (action === "seek") {
            const time = Number(payload.time);

            if (!Number.isFinite(time) || time < 0) {
                return {
                    ok: false,
                    error: "Invalid seek time"
                };
            }

            return {
                ok: true,
                payload: { time }
            };
        }

        if (action === "set_captions") {
            const { lang, kind } = payload;

            if (
                lang === null ||
                lang === undefined ||
                lang === ""
            ) {
                return {
                    ok: true,
                    payload: { captions: null }
                };
            }

            if (
                typeof lang !== "string" ||
                !/^[A-Za-z0-9-]{2,15}$/.test(lang)
            ) {
                return {
                    ok: false,
                    error: "Invalid caption language"
                };
            }

            const cleanKind =
                typeof kind === "string" &&
                /^[a-z]{0,10}$/.test(kind)
                    ? kind
                    : "";

            return {
                ok: true,
                payload: {
                    captions: {
                        lang,
                        kind: cleanKind
                    }
                }
            };
        }

        if (action === "set_rate") {
            const rate = Number(payload.rate);

            if (!SPEEDS.includes(rate)) {
                return {
                    ok: false,
                    error: "Invalid playback speed"
                };
            }

            return {
                ok: true,
                payload: { rate }
            };
        }

        if (action === "change_video") {
            const videoId = extractVideoId(payload.videoId);

            if (!videoId) {
                return {
                    ok: false,
                    error: "That is not a valid YouTube link"
                };
            }

            return {
                ok: true,
                payload: { videoId }
            };
        }

        const time = payload.time;

        if (
            typeof time === "number" &&
            Number.isFinite(time) &&
            time >= 0
        ) {
            return {
                ok: true,
                payload: { time }
            };
        }

        return {
            ok: true,
            payload: {}
        };
    }

    // Attach a participant to a socket after joining or reconnecting.
    attach(room, me, name) {
        const wasOffline = !me.connected;

        if (me.removalTimer) {
            clearTimeout(me.removalTimer);
        }

        me.removalTimer = null;
        me.socketId = this.socket.id;
        me.connected = true;
        me.username = name;

        room.touch();

        this.socket.join(room.code);

        // Server controls the user's identity and role.
        this.socket.data = {
            roomId: room.code,
            userId: me.userId
        };

        if (wasOffline) {
            this.socket.to(room.code).emit("user_joined", {
                username: me.username,
                userId: me.userId,
                role: me.role,
                participants: room.getParticipantList()
            });
        }
    }

    // ---------- joining and leaving ----------

    async createRoom({ username, userId }, ack) {
        const name = cleanName(username);

        if (!name || !userId) {
            return ack({
                ok: false,
                error: "Please enter your name"
            });
        }

        this.leaveCurrentRoom();

        const room = await this.rooms.createRoom();

        // The server assigns the host role.
        const me = new Participant({
            userId,
            username: name,
            socketId: this.socket.id,
            role: ROLES.HOST
        });

        room.addParticipant(me);

        this.socket.join(room.code);

        this.socket.data = {
            roomId: room.code,
            userId
        };

        this.rooms.save(room);

        ack(this.joinPayload(room, me));
    }

    async joinRoom(
        { roomId, username, userId, token },
        ack
    ) {
        const name = cleanName(username);

        if (!name || !userId) {
            return ack({
                ok: false,
                error: "Please enter your name"
            });
        }

        const room = await this.rooms.getRoom(roomId);

        if (!room) {
            return ack({
                ok: false,
                error: "Room not found"
            });
        }

        if (
            this.socket.data.roomId &&
            this.socket.data.roomId !== room.code
        ) {
            this.leaveCurrentRoom();
        }

        // Matching token restores the user's previous role.
        const existing = room.participants.get(userId);

        if (existing && existing.token === token) {
            this.attach(room, existing, name);
            return ack(this.joinPayload(room, existing));
        }

        // Prevent another browser from using an existing userId.
        const myId = existing
            ? crypto.randomUUID()
            : userId;

        const host = room.getHost();

        // If there is no active host, the new user becomes host.
        if (!host || (!host.connected && !host.removalTimer)) {
            if (host) {
                host.role = ROLES.MODERATOR;
            }

            const person = new Participant({
                userId: myId,
                username: name,
                socketId: this.socket.id,
                role: ROLES.HOST
            });

            room.addParticipant(person);

            this.socket.join(room.code);

            this.socket.data = {
                roomId: room.code,
                userId: myId
            };

            this.socket.to(room.code).emit("user_joined", {
                username: person.username,
                userId: person.userId,
                role: person.role,
                participants: room.getParticipantList()
            });

            this.socket.to(room.code).emit("host_transferred", {
                oldHostId: host ? host.userId : null,
                newHostId: person.userId,
                participants: room.getParticipantList()
            });

            this.rooms.save(room);

            return ack(this.joinPayload(room, person));
        }

        // Otherwise the user waits for host approval.
        room.pendingJoins.set(myId, {
            userId: myId,
            username: name,
            socketId: this.socket.id
        });

        this.socket.data = {
            pendingRoomId: room.code,
            pendingUserId: myId
        };

        ack({
            ok: true,
            pending: true,
            roomId: room.code
        });

        this.broadcastJoinRequests(room);
    }

    async resolveJoin({ userId, approve }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "resolve_join",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (!isHost(me.role)) {
            return this.deny(
                "resolve_join",
                ack,
                "Only the host can let people in"
            );
        }

        const pending = room.pendingJoins.get(userId);

        if (!pending) {
            return this.deny(
                "resolve_join",
                ack,
                "That person is no longer waiting"
            );
        }

        room.pendingJoins.delete(userId);

        const targetSocket =
            this.io.sockets.sockets.get(pending.socketId);

        if (approve && targetSocket) {
            const person = new Participant({
                userId,
                username: pending.username,
                socketId: pending.socketId
            });

            room.addParticipant(person);

            targetSocket.join(room.code);

            targetSocket.data = {
                roomId: room.code,
                userId
            };

            targetSocket.emit(
                "join_approved",
                this.joinPayload(room, person)
            );

            this.io.to(room.code).emit("user_joined", {
                username: person.username,
                userId: person.userId,
                role: person.role,
                participants: room.getParticipantList()
            });

            this.rooms.save(room);
        } else if (targetSocket) {
            targetSocket.data = {};

            targetSocket.emit("join_rejected", {
                message: "The host did not let you in."
            });
        }

        this.broadcastJoinRequests(room);

        ack({ ok: true });
    }

    leaveRoom() {
        this.leaveCurrentRoom();
    }

    leaveCurrentRoom() {
        this.cancelPending();

        const ctx = this.context();

        if (!ctx) return;

        this.socket.leave(ctx.room.code);
        this.socket.data = {};

        this.depart(ctx.room, ctx.me);
    }

    cancelPending() {
        const {
            pendingRoomId,
            pendingUserId
        } = this.socket.data;

        if (!pendingRoomId) return;

        const room =
            this.rooms.getLoadedRoom(pendingRoomId);

        const pending =
            room?.pendingJoins.get(pendingUserId);

        // Check socketId so an old socket cannot cancel a newer connection.
        if (
            pending &&
            pending.socketId === this.socket.id
        ) {
            room.pendingJoins.delete(pendingUserId);
            this.broadcastJoinRequests(room);
        }

        this.socket.data = {};
    }

    // Give a reconnecting browser a short grace period.
    onDisconnect() {
        this.cancelPending();

        const ctx = this.context();

        if (!ctx) return;

        const { room, me } = ctx;

        // A newer socket already owns this participant.
        if (me.socketId !== this.socket.id) return;

        me.connected = false;

        room.touch();

        this.io.to(room.code).emit("user_left", {
            username: me.username,
            userId: me.userId,
            participants: room.getParticipantList()
        });

        me.removalTimer = setTimeout(() => {
            if (
                !me.connected &&
                room.participants.get(me.userId) === me
            ) {
                this.depart(room, me);
            }
        }, DISCONNECT_GRACE_MS);
    }

    // Give the host role to someone who is already waiting.
    handOverToWaiting(room, oldHost) {
        const first = [...room.pendingJoins.values()][0];

        const socket =
            first &&
            this.io.sockets.sockets.get(first.socketId);

        if (!first || !socket) return false;

        room.pendingJoins.delete(first.userId);

        const person = new Participant({
            userId: first.userId,
            username: first.username,
            socketId: first.socketId
        });

        room.addParticipant(person);
        room.transferHost(person.userId);
        room.removeParticipant(oldHost.userId);

        socket.join(room.code);

        socket.data = {
            roomId: room.code,
            userId: person.userId
        };

        socket.emit(
            "join_approved",
            this.joinPayload(room, person)
        );

        socket.to(room.code).emit("user_joined", {
            username: person.username,
            userId: person.userId,
            role: person.role,
            participants: room.getParticipantList()
        });

        socket.to(room.code).emit("host_transferred", {
            oldHostId: oldHost.userId,
            newHostId: person.userId,
            participants: room.getParticipantList()
        });

        socket.to(room.code).emit("user_left", {
            username: oldHost.username,
            userId: oldHost.userId,
            participants: room.getParticipantList()
        });

        this.broadcastRequests(room);
        this.broadcastJoinRequests(room);

        this.rooms.save(room);

        return true;
    }

    // Remove a participant and handle host transfer if needed.
    depart(room, me) {
        if (me.role === ROLES.HOST) {
            const next = room.pickNextHost(me.userId);

            if (!next) {
                // Give the room to someone waiting if possible.
                if (this.handOverToWaiting(room, me)) {
                    return;
                }

                // Keep the host seat so they can reconnect later.
                me.connected = false;
                return;
            }

            room.transferHost(next.userId);
            room.removeParticipant(me.userId);

            this.io.to(room.code).emit("host_transferred", {
                oldHostId: me.userId,
                newHostId: next.userId,
                participants: room.getParticipantList()
            });

            this.broadcastJoinRequests(room);
        } else {
            room.removeParticipant(me.userId);
        }

        this.io.to(room.code).emit("user_left", {
            username: me.username,
            userId: me.userId,
            participants: room.getParticipantList()
        });

        this.broadcastRequests(room);
        this.rooms.save(room);
    }

    // ---------- playback ----------

    heartbeat({ time }) {
        const ctx = this.context();

        if (!ctx || !canControlPlayback(ctx.me.role)) {
            return;
        }

        if (
            typeof time !== "number" ||
            !Number.isFinite(time) ||
            time < 0
        ) {
            return;
        }

        ctx.room.heartbeat(time);
    }

    requestSync() {
        const ctx = this.context();

        if (ctx) {
            this.socket.emit(
                "sync_state",
                ctx.room.getSyncState()
            );
        }
    }

    control(action, payload, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                action,
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        // Role comes from the server, never from the client.
        if (!canControlPlayback(me.role)) {
            return this.deny(
                action,
                ack,
                "You do not have permission to do that"
            );
        }

        const result = this.validateAction(
            action,
            payload
        );

        if (!result.ok) {
            return this.deny(
                action,
                ack,
                result.error
            );
        }

        room.applyAction(action, result.payload);

        this.broadcastSync(room, me.userId);

        this.rooms.save(room);

        ack({ ok: true });
    }

    // Participants request playback changes instead of applying them directly.
    requestAction({ action, payload }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "request_action",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (canControlPlayback(me.role)) {
            return this.deny(
                "request_action",
                ack,
                "You can do this directly"
            );
        }

        const result = this.validateAction(
            action,
            payload
        );

        if (!result.ok) {
            return this.deny(
                "request_action",
                ack,
                result.error
            );
        }

        // Play/pause requests use the current server position.
        const keep =
            action === "play" || action === "pause"
                ? {}
                : result.payload;

        room.addRequest(me, action, keep);

        this.broadcastRequests(room);

        ack({ ok: true });
    }

    resolveRequest({ requestId, approve }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "resolve_request",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (!canControlPlayback(me.role)) {
            return this.deny(
                "resolve_request",
                ack,
                "You do not have permission to do that"
            );
        }

        const request = room.requests.get(requestId);

        if (!request) {
            return this.deny(
                "resolve_request",
                ack,
                "That request no longer exists"
            );
        }

        room.requests.delete(requestId);

        if (approve) {
            room.applyAction(
                request.action,
                request.payload
            );

            this.broadcastSync(room, me.userId);
            this.rooms.save(room);
        }

        this.io.to(room.code).emit(
            "request_resolved",
            {
                requestId,
                approved: Boolean(approve),
                userId: request.userId,
                username: request.username,
                action: request.action,
                payload: request.payload
            }
        );

        this.broadcastRequests(room);

        ack({ ok: true });
    }

    // ---------- host tools ----------

    assignRole({ userId, role }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "assign_role",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (!isHost(me.role)) {
            return this.deny(
                "assign_role",
                ack,
                "Only the host can assign roles"
            );
        }

        if (
            ![
                ROLES.MODERATOR,
                ROLES.PARTICIPANT
            ].includes(role)
        ) {
            return this.deny(
                "assign_role",
                ack,
                "Invalid role"
            );
        }

        const target = room.participants.get(userId);

        if (!target) {
            return this.deny(
                "assign_role",
                ack,
                "User not found"
            );
        }

        // Host changes only through transferHost().
        if (
            target.userId === me.userId ||
            target.role === ROLES.HOST
        ) {
            return this.deny(
                "assign_role",
                ack,
                "You cannot change the host role this way"
            );
        }

        target.role = role;

        if (role === ROLES.MODERATOR) {
            room.removeRequestsOf(target.userId);
        }

        this.io.to(room.code).emit("role_assigned", {
            userId: target.userId,
            username: target.username,
            role,
            participants: room.getParticipantList()
        });

        this.broadcastRequests(room);
        this.rooms.save(room);

        ack({ ok: true });
    }

    removeParticipant({ userId }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "remove_participant",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (!isHost(me.role)) {
            return this.deny(
                "remove_participant",
                ack,
                "Only the host can remove people"
            );
        }

        const target = room.participants.get(userId);

        if (!target) {
            return this.deny(
                "remove_participant",
                ack,
                "User not found"
            );
        }

        if (target.userId === me.userId) {
            return this.deny(
                "remove_participant",
                ack,
                "You cannot remove yourself"
            );
        }

        room.removeParticipant(target.userId);

        // Notify before removing the socket from the room.
        this.io.to(room.code).emit(
            "participant_removed",
            {
                userId: target.userId,
                username: target.username,
                participants: room.getParticipantList()
            }
        );

        const targetSocket =
            this.io.sockets.sockets.get(target.socketId);

        if (targetSocket) {
            targetSocket.leave(room.code);
            targetSocket.data = {};
        }

        this.broadcastRequests(room);
        this.rooms.save(room);

        ack({ ok: true });
    }

    transferHost({ userId }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "transfer_host",
                ack,
                "You are not in a room"
            );
        }

        const { room, me } = ctx;

        if (!isHost(me.role)) {
            return this.deny(
                "transfer_host",
                ack,
                "Only the host can transfer host"
            );
        }

        const target = room.participants.get(userId);

        if (
            !target ||
            target.userId === me.userId
        ) {
            return this.deny(
                "transfer_host",
                ack,
                "Invalid user"
            );
        }

        room.removeRequestsOf(target.userId);

        const result = room.transferHost(
            target.userId
        );

        this.io.to(room.code).emit(
            "host_transferred",
            {
                ...result,
                participants: room.getParticipantList()
            }
        );

        this.broadcastRequests(room);

        this.io
            .to(me.socketId)
            .emit("join_requests_updated", {
                joinRequests: []
            });

        this.broadcastJoinRequests(room);

        this.rooms.save(room);

        ack({ ok: true });
    }

    // ---------- chat ----------

    chatMessage({ text }, ack) {
        const ctx = this.context();

        if (!ctx) {
            return this.deny(
                "chat_message",
                ack,
                "You are not in a room"
            );
        }

        if (typeof text !== "string") {
            return this.deny("chat_message", ack, "Message is empty");
        }

        // Limit message size before saving or broadcasting.
        const clean = text.trim().slice(0, 500);

        if (!clean) {
            return this.deny("chat_message", ack, "Message is empty");
        }

        const message = ctx.room.addChat(
            ctx.me,
            clean
        );

        this.rooms.saveMessage(
            ctx.room.code,
            message
        );

        this.io
            .to(ctx.room.code)
            .emit("chat_message", message);

        ack({ ok: true });
    }
}