// services/Participant.js

import crypto from "node:crypto";
import { ROLES } from "../utils/permissions.js";

export default class Participant {
    constructor({
        userId,
        username,
        socketId = null,
        role = ROLES.PARTICIPANT,
        joinedAt = Date.now(),
        token = null
    }) {
        this.userId = userId;
        this.username = username;
        this.socketId = socketId;
        this.role = role;
        this.connected = socketId !== null;
        this.joinedAt = joinedAt;
        this.removalTimer = null;
        this.token = token || crypto.randomUUID();
    }

    toJSON() {
        return {
            userId: this.userId,
            username: this.username,
            role: this.role,
            connected: this.connected
        };
    }
}