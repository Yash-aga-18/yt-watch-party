import { io } from 'socket.io-client';

// Empty address means "same server that served this page".
// VITE_SERVER_URL comes from an .env file read at build time. When it is blank we pass
// undefined so socket.io connects back to the page's own origin (useful in production
// when the frontend is served by the same server).
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;

// One shared connection for the whole app. We connect when it is needed.
// autoConnect: false means the socket stays idle until something calls connect()
// (for example when a room page actually needs the server), so the home page does
// not open a connection just to be loaded.
const socket = io(SERVER_URL, { autoConnect: false });

// Exported as a single instance so every file imports the SAME connection.
export default socket;
