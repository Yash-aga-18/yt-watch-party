// services/Room.js

import crypto from "node:crypto";
import Participant from "./Participant.js";
import { ROLES, canControlPlayback } from "../utils/permissions.js";

const ROLE_ORDER = {
    host: 0,
    moderator: 1,
    participant: 2
};

// Ignore heartbeat reports that are too far from the expected position.
const HEARTBEAT_MAX_DRIFT_SECONDS = 2.5;

// After this time, the next heartbeat can become the new reference.
const HEARTBEAT_VERIFIED_MS = 6000;

export default class Room {
    constructor(code) {
        this.code = code;

        // Live participants in the room.
        this.participants = new Map();

        // Users waiting for host approval.
        this.pendingJoins = new Map();

        // Playback requests from participants.
        this.requests = new Map();

        this.chat = [];
        this.lastActiveAt = Date.now();
        this.lastHeartbeatAt = 0;

        // Shared playback state.
        this.state = {
            videoId: null,
            playState: "paused",
            currentTime: 0,
            muted: false,
            rate: 1,
            captions: null,
            updatedAt: Date.now()
        };
    }

    // Create the data saved in MongoDB.
    toRecord() {
        return {
            participants: [...this.participants.values()].map((p) => ({
                userId: p.userId,
                username: p.username,
                role: p.role,
                joinedAt: p.joinedAt,
                token: p.token
            })),

            state: {
                videoId: this.state.videoId,
                currentTime: this.getCurrentTime()
            }
        };
    }

    // Rebuild a room from a MongoDB record.
    static fromRecord(record, messages = []) {
        const room = new Room(record.code);

        for (const p of record.participants || []) {
            room.participants.set(
                p.userId,
                new Participant({
                    ...p,
                    socketId: null
                })
            );
        }

        room.state = {
            videoId: record.state?.videoId || null,
            currentTime: record.state?.currentTime || 0,
            // Restored rooms always start paused.
            playState: "paused",
            muted: false,
            rate: 1,
            captions: null,
            updatedAt: Date.now()
        };

        room.chat = messages;

        return room;
    }

    // Participants
    addParticipant(participant) {
        this.participants.set(participant.userId, participant);
        this.touch();
    }

    removeParticipant(userId) {
        const participant = this.participants.get(userId);

        if (participant?.removalTimer) {
            clearTimeout(participant.removalTimer);
        }

        this.participants.delete(userId);
        this.pendingJoins.delete(userId);
        this.removeRequestsOf(userId);

        this.touch();
    }

    getHost() {
        return [...this.participants.values()].find(
            (p) => p.role === ROLES.HOST
        );
    }

    getParticipantList() {
        return [...this.participants.values()]
            .sort(
                (a, b) =>
                    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
                    a.joinedAt - b.joinedAt
            )
            .map((p) => p.toJSON());
    }

    hasConnectedParticipants() {
        return [...this.participants.values()].some(
            (p) => p.connected
        );
    }

    touch() {
        this.lastActiveAt = Date.now();
    }

    // Prefer a moderator when choosing the next host.
    pickNextHost(excludeId) {
        const candidates = [...this.participants.values()]
            .filter(
                (p) =>
                    p.connected &&
                    p.userId !== excludeId
            )
            .sort((a, b) => a.joinedAt - b.joinedAt);

        return (
            candidates.find(
                (p) => p.role === ROLES.MODERATOR
            ) ||
            candidates[0] ||
            null
        );
    }

    transferHost(newHostId) {
        const oldHost = this.getHost();
        const newHost = this.participants.get(newHostId);

        if (!newHost) return null;

        if (oldHost) {
            oldHost.role = ROLES.MODERATOR;
        }

        newHost.role = ROLES.HOST;

        return {
            oldHostId: oldHost ? oldHost.userId : null,
            newHostId
        };
    }

    // Join requests
    getJoinRequestList() {
        return [...this.pendingJoins.values()].map((request) => ({
            userId: request.userId,
            username: request.username
        }));
    }

    // Playback
    getCurrentTime() {
        const {
            playState,
            currentTime,
            updatedAt
        } = this.state;

        // Account for elapsed time while the video is playing.
        return playState === "playing"
            ? currentTime +
              ((Date.now() - updatedAt) / 1000) *
                  (this.state.rate || 1)
            : currentTime;
    }

    getSyncState() {
        return {
            playState: this.state.playState,
            currentTime: this.getCurrentTime(),
            videoId: this.state.videoId,
            muted: this.state.muted,
            rate: this.state.rate || 1,
            captions: this.state.captions || null,
            serverTime: Date.now()
        };
    }

    applyAction(action, payload = {}) {
        const now = Date.now();

        // Use the client's exact position when available.
        const exactTime =
            typeof payload.time === "number"
                ? payload.time
                : this.getCurrentTime();

        if (action === "play") {
            this.state = {
                ...this.state,
                currentTime: exactTime,
                playState: "playing",
                updatedAt: now
            };
        } else if (action === "pause") {
            this.state = {
                ...this.state,
                currentTime: exactTime,
                playState: "paused",
                updatedAt: now
            };
        } else if (action === "seek") {
            this.state = {
                ...this.state,
                currentTime: payload.time,
                updatedAt: now
            };
        } else if (action === "change_video") {
            this.state = {
                videoId: payload.videoId,
                currentTime: 0,
                playState: "playing",
                muted: this.state.muted,
                rate: this.state.rate,
                captions: this.state.captions,
                updatedAt: now
            };
        } else if (action === "mute") {
            this.state = {
                ...this.state,
                muted: true
            };
        } else if (action === "unmute") {
            this.state = {
                ...this.state,
                muted: false
            };
        } else if (action === "set_captions") {
            this.state = {
                ...this.state,
                captions: payload.captions || null
            };
        } else if (action === "set_rate") {
            // Save the current position before changing playback speed.
            this.state = {
                ...this.state,
                currentTime: this.getCurrentTime(),
                rate: payload.rate,
                updatedAt: now
            };
        }

        // Playback changes reset heartbeat verification.
        if (
            action !== "mute" &&
            action !== "unmute" &&
            action !== "set_captions"
        ) {
            this.state.actionAt = now;
        }

        this.touch();
    }

    // Controllers periodically report their actual video position.
    heartbeat(time) {
        if (
            this.state.playState !== "playing" ||
            !this.state.videoId
        ) {
            return;
        }

        const now = Date.now();

        // Ignore heartbeats immediately after a playback action.
        if (now - (this.state.actionAt || 0) < 3000) {
            return;
        }

        const verified =
            now - this.lastHeartbeatAt <
            HEARTBEAT_VERIFIED_MS;

        if (
            verified &&
            Math.abs(time - this.getCurrentTime()) >
                HEARTBEAT_MAX_DRIFT_SECONDS
        ) {
            return;
        }

        this.lastHeartbeatAt = now;

        this.state = {
            ...this.state,
            currentTime: time,
            updatedAt: now
        };
    }

    // Playback requests
    addRequest(user, action, payload) {
        // Keep only one request of the same type per user.
        for (const [id, request] of this.requests) {
            if (
                request.userId === user.userId &&
                request.action === action
            ) {
                this.requests.delete(id);
            }
        }

        const request = {
            requestId: crypto.randomUUID(),
            userId: user.userId,
            username: user.username,
            action,
            payload,
            createdAt: Date.now()
        };

        this.requests.set(request.requestId, request);

        return request;
    }

    removeRequestsOf(userId) {
        for (const [id, request] of this.requests) {
            if (request.userId === userId) {
                this.requests.delete(id);
            }
        }
    }

    // Controllers see all requests; participants see only their own.
    getRequestsFor(participant) {
        const all = [...this.requests.values()];

        return canControlPlayback(participant.role)
            ? all
            : all.filter(
                  (request) =>
                      request.userId === participant.userId
              );
    }

    // Chat
    addChat(user, text) {
        const message = {
            id: crypto.randomUUID(),
            userId: user.userId,
            username: user.username,
            text,
            ts: Date.now()
        };

        this.chat.push(message);

        // Keep only the latest 100 messages in memory.
        if (this.chat.length > 100) {
            this.chat.shift();
        }

        return message;
    }
}