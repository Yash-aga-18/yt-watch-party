// pages/HomePage.jsx


import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import socket from '../socket.js';
import { getRoomToken, getUserId, getUsername, saveRoomToken, setUsername } from '../utils/identity.js';

// Accepts "ABC123" or a full link like "https://site.com/room/ABC123"
// Returns just the uppercase room code in both cases, or '' if it cannot tell.
function extractRoomCode(text) {
  const trimmed = text.trim();
  // Try to pull the code out of a pasted link by matching the "/room/XXX" part.
  const match = trimmed.match(/\/room\/([^/?#\s]+)/);
  if (match) return match[1].toUpperCase();
  // A link we do not recognise (a YouTube link, the site root, a typo). Returning ''
  // lets the form say "enter a room code or link" instead of sending the whole URL
  // to the server and getting a confusing "Room not found".
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('/')) return '';
  // Otherwise treat the whole input as the code.
  // Uppercase so "abc123" and "ABC123" are the same room.
  return trimmed.toUpperCase();
}

export default function HomePage() {
  const navigate = useNavigate();
  // location.state carries an optional message set by the room page, e.g. after a removal.
  const location = useLocation();
  // Pre-fill the name field from the remembered name (localStorage).
  const [name, setName] = useState(getUsername());
  const [joinInput, setJoinInput] = useState('');
  const [error, setError] = useState('');
  // True while waiting for the server, used to disable the buttons and avoid double submits.
  const [busy, setBusy] = useState(false);

  // Message from the room page, for example "you were removed".
  // It is copied into state once, then cleared from the history entry, so pressing
  // Back to this page later does not show the same message all over again.
  const [notice] = useState(() => location.state?.message || '');
  useEffect(() => {
    if (location.state?.message) navigate('.', { replace: true, state: null });
  }, [location.state, navigate]);

  // Used by both Create and Join: send the event, wait for the answer, open the room
  // event is the socket event name ("create_room" or "join_room") and extra carries
  // whatever that event needs (the room code for join, nothing for create).
  function submit(event, extra) {
    const username = name.trim();
    // A name is required before we talk to the server. Show a friendly message instead.
    if (!username) {
      setError('Please enter your name.');
      return;
    }
    setError('');
    // Remember the name for next time, then lock the buttons while we wait.
    setUsername(username);
    setBusy(true);

    // The connection is lazy (autoConnect: false), so open it if it is not already open.
    if (!socket.connected) socket.connect();
    // Joining a room we were already in? Send the token so we get our role back.
    // The token is the per-room secret that proves this browser owns its seat.
    const joiningRoomId = extra.roomId || '';
    const payload = { ...extra, username, userId: getUserId(), token: joiningRoomId ? getRoomToken(joiningRoomId) : '' };

    // timeout(8000) makes the acknowledgement fail after 8s instead of hanging, so a
    // dead server cannot leave the button stuck on "busy" forever.
    socket.timeout(8000).emit(event, payload, (err, res) => {
      setBusy(false);
      // err means the server never answered in time.
      if (err) return setError('Could not reach the server.');
      // The server rejected the request and told us why.
      if (!res.ok) return setError(res.error || 'Something went wrong.');
      // Remember the token, so the room page can prove who we are.
      // This must happen before navigating, otherwise the socket handlers that read the
      // token after a refresh would find nothing.
      if (res.you) saveRoomToken(res.roomId, res.you.token);
      // Open the room. We pass the server's answer through navigation state so the room
      // page can show the first render instantly instead of asking the server again.
      navigate(`/room/${res.roomId}`, { state: { joinResult: res } });
    });
  }

  // Handles the join form. Create uses submit directly from the button.
  function handleJoin(e) {
    e.preventDefault();
    const code = extractRoomCode(joinInput);
    if (!code) {
      setError('Enter a room code or link.');
      return;
    }
    submit('join_room', { roomId: code });
  }

  return (
    <div className="mx-auto max-w-md p-4 pt-16">
      <h1 className="mb-1 text-2xl font-bold">Watch Party</h1>
      <p className="mb-6 text-sm text-gray-600">Watch YouTube videos together with your friends.</p>

      {/* Optional message handed over from the room page (for example, you were removed). */}
      {notice && <p className="mb-4 border border-gray-400 bg-white p-3 text-sm">{notice}</p>}

      <div className="card space-y-4">
        <div>
          <label className="mb-1 block text-sm">Your name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
          />
        </div>

        {/* Create flow: one click, no input needed. */}
        <div>
          <p className="mb-1 text-sm font-bold">Start a new room</p>
          <button className="btn" onClick={() => submit('create_room', {})} disabled={busy}>
            Create room
          </button>
        </div>

        {/* Join flow: wrapped in a form so Enter also submits it. */}
        <form onSubmit={handleJoin}>
          <p className="mb-1 text-sm font-bold">Join a room</p>
          <div className="flex gap-2">
            <input
              className="input"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              placeholder="Room code or link"
            />
            <button className="btn" disabled={busy}>Join</button>
          </div>
          {/* Explains why the flow is not instant: the host must approve. */}
          <p className="mt-1 text-xs text-gray-600">The host has to let you in.</p>
        </form>

        {/* Validation or connection errors shown in red. */}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    </div>
  );
}
