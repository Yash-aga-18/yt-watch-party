// server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

import connectDB from "./config/database.js";
import { registerSockets } from "./sockets/socket.index.js";
import errorHandler from "./middleware/error.middleware.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Allowed browser origin. "*" locally, the real URL in production. Only matters when the
// frontend is hosted separately: in the single-service deployment below the page and the
// WebSocket share one origin, so the browser sends no cross-origin request at all.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

connectDB();

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// Render (and most hosts) poll this to decide whether the service is healthy.
// Without it the deploy is marked unhealthy and the app is never reachable.
app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
    res.json({ ok: true, service: "watch-party" });
});

// --- serve the built frontend ---
// The single-service deployment builds frontend/dist and this same process serves it,
// so the page and its WebSocket share one origin (no CORS, no second URL to configure).
// In development this folder may not exist yet; the Vite dev server handles the UI instead.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../frontend/dist");

if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));

    // Client-side routes such as /room/ABC123 are not files, so hand those to React.
    // A path that DOES name a file (anything with an extension) that express.static did
    // not find is genuinely missing, so let it 404 - answering with HTML there would make
    // a missing script or stylesheet look like a React crash. Testing the extension is
    // what decides this, not the Accept header: a plain "Accept: */*" also accepts HTML.
    app.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (path.extname(req.path)) return next();
        res.sendFile(path.join(clientDist, "index.html"));
    });
} else {
    console.warn(
        `No built frontend found at ${clientDist}. Run "npm run build" to create it, ` +
        "or use the Vite dev server while developing."
    );
}

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN
    }
});

registerSockets(io);

// Registered last so it catches errors from the routes above.
app.use(errorHandler);

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
