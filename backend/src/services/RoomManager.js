// services/RoomManager.js

import crypto from "node:crypto";
import Room from "./Room.js";
import RoomModel from "../models/room.model.js";
import MessageModel from "../models/message.model.js";
import { isDbReady } from "../config/database.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const SAVE_DELAY_MS = 500;

export default class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.loading = new Map();
        this.saveTimers = new Map();

        const timer = setInterval(() => this.cleanup(), 60 * 1000);
        timer.unref();
    }

    async generateCode() {
        for (;;) {
            const code = Array.from(
                { length: 6 },
                () => ALPHABET[crypto.randomInt(ALPHABET.length)]
            ).join("");

            if (this.rooms.has(code)) continue;

            // Without a database there is nothing to collide with beyond the rooms
            // this process already holds, which the line above has just checked.
            if (!isDbReady()) return code;

            const exists = await RoomModel.exists({ code });

            if (exists) continue;

            return code;
        }
    }

    async createRoom() {
        const room = new Room(await this.generateCode());

        this.rooms.set(room.code, room);
        this.save(room);

        return room;
    }

    getLoadedRoom(code) {
        return typeof code === "string"
            ? this.rooms.get(code)
            : undefined;
    }

    async getRoom(input) {
        if (typeof input !== "string") return undefined;

        const code = input.trim().toUpperCase();

        if (this.rooms.has(code)) {
            return this.rooms.get(code);
        }

        if (!this.loading.has(code)) {
            this.loading.set(code, this.loadFromDatabase(code));
        }

        try {
            return await this.loading.get(code);
        } finally {
            this.loading.delete(code);
        }
    }

    async loadFromDatabase(code) {
        // Nothing was ever persisted without a database, so the room genuinely does
        // not exist rather than being unreachable - answer immediately, no query.
        if (!isDbReady()) return undefined;

        const record = await RoomModel.findOne({ code }).lean();

        if (!record) return undefined;

        const saved = await MessageModel.find({
            roomCode: code
        })
            .sort({ ts: -1 })
            .limit(100)
            .lean();

        const messages = saved.reverse().map((message) => ({
            id: String(message._id),
            userId: message.userId,
            username: message.username,
            text: message.text,
            ts: message.ts
        }));

        const room = Room.fromRecord(record, messages);

        this.rooms.set(code, room);

        return room;
    }

    save(room) {
        if (!isDbReady()) return;

        clearTimeout(this.saveTimers.get(room.code));

        this.saveTimers.set(
            room.code,
            setTimeout(() => {
                this.saveTimers.delete(room.code);

                RoomModel.updateOne(
                    { code: room.code },
                    { $set: room.toRecord() },
                    { upsert: true }
                ).catch((error) => {
                    console.error("Could not save room:", error.message);
                });
            }, SAVE_DELAY_MS)
        );
    }

    saveMessage(roomCode, message) {
        if (!isDbReady()) return;

        MessageModel.create({
            roomCode,
            userId: message.userId,
            username: message.username,
            text: message.text,
            ts: message.ts
        }).catch((error) => {
            console.error("Could not save message:", error.message);
        });
    }

    cleanup() {
        const now = Date.now();

        for (const room of this.rooms.values()) {
            if (
                !room.hasConnectedParticipants() &&
                now - room.lastActiveAt > EMPTY_ROOM_TTL_MS
            ) {
                this.rooms.delete(room.code);
            }
        }
    }
}

export const roomManager = new RoomManager();