// server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "node:http";
import { Server } from "socket.io";

import connectDB from "./config/database.js";
import { registerSockets } from "./sockets/socket.index.js";
import errorHandler from "./middleware/error.middleware.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

connectDB();

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Watch Party Server is running");
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
    res.json({
        ok: true,
        service: "watch-party"
    });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN
    }
});

registerSockets(io);

app.use(errorHandler);

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});