# YouTube Watch Party

Watch YouTube videos together, in sync. One person hosts and controls the video (play, pause,
seek, change video); everybody else follows along in real time.

Built with JavaScript only — React on the frontend, Node/Express + Socket.IO on the backend,
MongoDB for storage.

**Live URL:**https://yt-watch-party-omega.vercel.app/

---

## Features

- **Rooms** — create a room with a short code (like `K7M2QP`), or join with a code or a full link.
- **Roles** — Host, Moderator, Participant. Enforced on the server, not just hidden in the UI.
- **Synced playback** — play, pause, seek, change video, mute, playback speed and subtitles all
  follow whoever is allowed to control the room, host and moderators alike.
- **Late joiners** — someone joining mid-video starts at the right position, not at 0:00.
- **Moderation** — the host can promote someone to Moderator, remove people, or transfer the host role.
- **Playback requests** — a Participant cannot control the video, so their controls send a request
  the host or a moderator can approve.
- **Chat** — simple room chat, saved to MongoDB.
- **Survives a refresh** — reconnecting keeps your seat and your role (there is a 30 second grace
  period, so a page reload does not cost you the host role).
- **A room is never left without a host** — if the host leaves for good, the role passes to a
  connected moderator, then to whoever has been waiting longest. If somebody is still waiting to be
  let in, the room goes to them, so nobody is ever stranded on the waiting screen.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS 4, socket.io-client, React Router |
| Backend | Node.js, Express, Socket.IO |
| Database | MongoDB (Mongoose) |
| Video | YouTube IFrame Player API |

## Architecture

```
React client (browser)
      │
      │  Socket.IO (WebSocket)
      ▼
Node.js + Express server
      │
      ├── RoomManager   live rooms in memory
      ├── Room          participants, playback state, chat
      ├── permissions.js  who is allowed to do what
      └── event handlers  validate, update, broadcast
      │
      ▼
MongoDB  (rooms + chat messages, so they survive a restart)
```

**The server owns the video state.** The browser never tells other browsers what to do — it asks the
server, the server checks permissions, updates the room, and broadcasts the result:

```
Host presses Play
      │  play { time }
      ▼
Server: is this socket in a room? is their role host/moderator?
      │  yes → update room.state → playState = "playing"
      ▼
Room broadcasts sync_state to everybody
      │
      ├── Participant A → player.playVideo()
      ├── Participant B → player.playVideo()
      └── Participant C → player.playVideo()
```

Rooms live in **memory** while the server runs (fast, no database read on every event) and are
**saved to MongoDB** shortly after each change, so a restart does not lose them.

## Roles

| Action | Host | Moderator | Participant |
|---|:--:|:--:|:--:|
| Play / pause / seek / change video | ✅ | ✅ | ❌ |
| Mute, speed, subtitles | ✅ | ✅ | ❌ |
| Approve playback requests | ✅ | ✅ | ❌ |
| Let people into the room | ✅ | ❌ | ❌ |
| Assign roles | ✅ | ❌ | ❌ |
| Remove participants | ✅ | ❌ | ❌ |
| Transfer host | ✅ | ❌ | ❌ |
| Chat | ✅ | ✅ | ✅ |

**How this is enforced.** The backend ignores any role sent by the browser. Every protected event
looks up the sender like this (`backend/src/sockets/socket.room.js`):

```js
// the room this socket is in and the person it belongs to (or null)
context() {
  const { roomId, userId } = this.socket.data;      // set by the server when they joined
  const room = this.rooms.getLoadedRoom(roomId);
  const me = room && room.participants.get(userId);
  return room && me ? { room, me } : null;
}
```

The role comes from `room.participants` — the server's own copy. A Participant who opens devtools and
emits `change_video` by hand is rejected before any state changes and gets no broadcast:

```js
if (!canControlPlayback(me.role)) return this.deny(action, ack, 'You do not have permission to do that');
```

**Proving who you are.** Because user ids are visible in the participant list, a browser could try to
reconnect using someone else's id. To stop that, the server gives each participant a secret `token`
when they join and only lets them back into that seat if they send it back. Without a matching token,
the browser is treated as a brand new joiner. The token is only ever sent to its owner.

## WebSocket API

### Client → Server

| Event | Payload | Who may send it |
|---|---|---|
| `create_room` | `{ username, userId }` | anyone |
| `join_room` | `{ roomId, username, userId, token }` | anyone |
| `leave_room` | — | anyone |
| `request_sync` | — | anyone |
| `play` / `pause` | `{ time }` | host, moderator |
| `seek` | `{ time }` | host, moderator |
| `change_video` | `{ videoId }` | host, moderator |
| `mute` / `unmute` | — | host, moderator |
| `set_rate` | `{ rate }` (0.25–2) | host, moderator |
| `set_captions` | `{ lang, kind }` | host, moderator |
| `heartbeat` | `{ time }` | host, moderator |
| `request_action` | `{ action, payload }` | participant |
| `resolve_request` | `{ requestId, approve }` | host, moderator |
| `resolve_join` | `{ userId, approve }` | host |
| `assign_role` | `{ userId, role }` | host |
| `remove_participant` | `{ userId }` | host |
| `transfer_host` | `{ userId }` | host |
| `chat_message` | `{ text }` | anyone in the room |

Every event that changes something takes a callback, so the client gets `{ ok: true }` or
`{ ok: false, error: '...' }`.

### Server → Client

| Event | Payload |
|---|---|
| `sync_state` | `{ videoId, playState, currentTime, muted, rate, captions, serverTime, updatedBy? }` |
| `user_joined` / `user_left` | `{ username, userId, role?, participants }` |
| `role_assigned` | `{ userId, username, role, participants }` |
| `participant_removed` | `{ userId, username, participants }` |
| `host_transferred` | `{ oldHostId, newHostId, participants }` |
| `requests_updated` | `{ requests }` (each person only sees what they may see) |
| `request_resolved` | `{ requestId, approved, userId, username, action, payload }` |
| `join_requests_updated` | `{ joinRequests }` (host only) |
| `join_approved` / `join_rejected` | full room payload / `{ message }` |
| `chat_message` | `{ id, userId, username, text, ts }` |
| `error_message` | `{ event, message }` |

### Staying in sync

- The server stores `currentTime` plus **when** it was recorded. A client adds the time that has
  passed since it received the message, so it never has to compare two computers' clocks.
- **Hosts and moderators** send a `heartbeat` every 2 seconds with their real player position. The
  server uses those reports to keep its clock matching the real video, so buffering and stalls do
  not drag everyone to a wrong position. A report that is far away from what the server already
  expects is a player that stalled or is still loading, so it is ignored — otherwise a second
  controller would pull the whole room to its own position.
- The room clock is the **one reference for everybody**, including the host and the moderators.
  Anyone who drifts more than ~1.5s behind (or ~4s ahead) is brought back to it. Nobody is treated
  as "the reference" any more: with two controllers that only let the host and a moderator drift
  apart, each trusting only their own player.
- **Subtitles are room state**, like mute and speed: whoever changes them (host or moderator),
  everybody else follows. A client only ever reports a subtitle change it made itself, so two
  controllers cannot undo each other's choice in a loop.
- Every client also asks for a fresh `sync_state` every 15 seconds.

### Avoiding event loops

When a client applies a change that came *from the server*, it sets an "ignore" flag first, so
YouTube's own `onStateChange` event does not get mistaken for the user pressing a button and echoed
back. This is what stops `play → server → play → server → ...`.

### Noticing what the user did in YouTube's player

YouTube's API has no "the user seeked" event, so the client polls its own player every 500ms:

- A jump away from where the video should be means the seek bar was dragged. That check runs before
  the mute / speed / subtitle checks and never ends the tick early, so a seek cannot be missed.
- YouTube also pauses the video for a moment while the seek bar is being dragged. That pause is not
  a real pause, so it is only reported when the position has not moved since the press.

## Running it locally

### 1. Requirements

- Node.js 18 or newer
- MongoDB — optional. Without it the server keeps rooms in memory and everything still works; you
  just lose the rooms when the process restarts. Use a local server or a free
  [MongoDB Atlas](https://www.mongodb.com/atlas) cluster if you want them to persist.

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env      # then edit .env (or leave MONGODB_URI blank to run in memory)
npm run dev               # http://localhost:3001
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

Open `http://localhost:5173`, create a room, then open the room link in a **second browser tab** —
each tab is a different person, so you can be the host in one and a participant in the other.

### Running it the way it is deployed

The deployment serves the built frontend from the backend, so there is a single origin and no
Vite proxy. To reproduce that locally:

```bash
npm run build --prefix frontend     # writes frontend/dist
npm start --prefix backend          # now serves the app AND the WebSocket on one port
```

Then open `http://localhost:3001` (or whatever `PORT` is set to). `/health` should return
`{"ok":true}`.

### 4. Test the role checks

1. Create a room in tab A. You are the **host**.
2. Join in tab B with the room code. The host lets you in; you are a **participant**.
3. In tab B, press play inside the player. It snaps back and sends a request instead — a participant
   cannot change the room. (Try `socket.emit('change_video', { videoId: 'dQw4w9WgXcQ' })` in the tab B
   console: the server answers `{ ok: false, error: 'You do not have permission to do that' }` and the
   video does not change.)
4. In tab A, promote tab B to **moderator**. Now tab B can control playback.
5. Try to remove someone or assign a role from tab B — both are rejected.

## Environment variables

### `backend/.env`

| Variable | Example | Notes |
|---|---|---|
| `PORT` | `3001` | Render sets this automatically; the server falls back to 5000. |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/yt-watch-party` | Or an Atlas `mongodb+srv://` string. Optional — if it is unset, or set but unreachable, the server logs a warning and keeps rooms in memory instead of exiting. |
| `CLIENT_ORIGIN` | `*` | Allowed browser origin for CORS and Socket.IO. `*` is fine when the backend serves the frontend too; set it to your real URL if you host the frontend separately. |

### `frontend/.env`

| Variable | Example | Notes |
|---|---|---|
| `VITE_SERVER_URL` | _(empty)_ | Leave empty when the backend also serves the frontend. Set it (e.g. `https://your-api.onrender.com`) only if the frontend is hosted separately. |

`.env` files are gitignored. `.env.example` files show what is needed — never commit real secrets.

## MongoDB

Two collections, kept deliberately simple:

**`rooms`** — one document per room, holding the code, the participants (with their roles) and the
last known video state. The live playback state stays in memory while the server runs; only the
snapshot is saved.

```js
{
  code: "K7M2QP",
  participants: [{ userId, username, role, joinedAt, token }],
  state: { videoId: "dQw4w9WgXcQ", currentTime: 83.4 }
}
```

**`messages`** — one document per chat message (`roomCode`, `userId`, `username`, `text`, `ts`).

Rooms with nobody connected for 5 minutes are dropped from memory (not from MongoDB) and loaded
again on demand. Writes are debounced, so a burst of changes becomes one save.

## Known limitations

Worth knowing about, and worth being able to explain:

- **One server instance only.** Rooms live in memory, so two server processes would each hold
  their own copy of a room. Scaling out would need a shared layer (Redis + the Socket.IO Redis
  adapter) so every instance publishes to the same room. For a single instance this is not a
  problem, which is why the deployment below uses one service.
- **Chat history is capped at 100 messages per room** in memory and on load. Older messages stay
  in MongoDB but are not shown.
- **Subtitles use YouTube's undocumented caption API** (`loadModule` / `setOption`). They work
  today, but YouTube can change this without notice, so it is best-effort.
- **Removed people are only removed from the room, not banned.** They can knock again (through the
  approval gate) unless the host removes them again.
- **A room with nobody connected is dropped from memory after 5 minutes**, but is not deleted from
  MongoDB — it is loaded back the next time somebody opens it.

## Deployment

The backend must be hosted somewhere that keeps a **long-running process**, because Socket.IO needs
a real WebSocket connection. Render and Railway work. Vercel and Netlify serverless functions are
not suitable for the backend — they can host the frontend only.

### Render (single service, recommended)

The repo already contains `render.yaml`:

1. Push the project to GitHub.
2. In Render: **New → Blueprint**, pick the repo.
3. Set `MONGODB_URI` to your MongoDB Atlas connection string. Render asks for it because it is
   marked `sync: false`. It is optional — leave it blank and the service still runs, in memory only.
4. Deploy. The build command installs both apps and builds the frontend; the backend serves
   `frontend/dist` itself, so the page and the WebSocket share one origin and there is no CORS
   configuration to worry about.
5. Render polls `/health` to decide the service is up, and that route is part of the server.
6. If you use a custom domain, set `CLIENT_ORIGIN` to it. Otherwise leave it as `*`.
7. Copy the service URL into the **Live URL** line at the top of this README.

Checklist once the deploy is green — these should all work on the public URL:

- `https://<your-service>.onrender.com/health` returns `{"ok":true}`.
- The home page loads at `https://<your-service>.onrender.com/`.
- Creating a room gives a code, and the room link (e.g. `/room/K7M2QP`) opens directly — that
  deep link is handled by the server's SPA fallback, so a refresh on it works too.
- Two browsers in the same room: the host's play/pause/seek/mute/subtitles reach the other one.
- A participant's play attempt is refused, and asks the host instead.

### Frontend on Vercel/Netlify + backend on Render

Build the frontend with `VITE_SERVER_URL` set to the backend URL, and set the backend's
`CLIENT_ORIGIN` to the frontend URL.

### MongoDB Atlas

Create a free cluster, add a database user, and allow access from anywhere (`0.0.0.0/0`) or from
your host's IPs. Copy the connection string into `MONGODB_URI`:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/yt-watch-party
```

## Project structure

```
backend/
  src/
    config/       database.js (MongoDB connection, skipped when unavailable)
    middleware/   error.middleware.js (last-resort Express error handler)
    models/       room.model.js, message.model.js
    services/     Room.js, Participant.js, RoomManager.js
    sockets/      socket.index.js (setup), socket.room.js (all event handlers)
    utils/        permissions.js (role rules), youtube.js (video id parsing)
    server.js     Express + Socket.IO + serves the built frontend
  .env.example    copy to .env
frontend/
  src/
    pages/        HomePage.jsx, RoomPage.jsx
    components/   VideoPlayer.jsx, ParticipantList.jsx, RequestsPanel.jsx,
                  ChatPanel.jsx, VideoLinkForm.jsx, Toasts.jsx
    hooks/        useRoom.js (socket connection + all room state)
    utils/        identity.js (who am I), format.js
    App.jsx, main.jsx, socket.js, index.css
render.yaml       one-service deploy blueprint
```
