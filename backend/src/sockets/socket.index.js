// sockets/socket.index.js

import RoomSocketHandler from "./socket.room.js";
import { roomManager } from "../services/RoomManager.js";

// Create a handler for each connected socket.
export function registerSockets(io) {
    io.on("connection", (socket) => {
        new RoomSocketHandler(io, roomManager, socket).register();
    });
}