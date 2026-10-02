// hooks/useRoom.js

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../socket.js';
import { getUserId, getRoomToken, saveRoomToken, saveUserId } from '../utils/identity.js';

// Remember WHEN a sync_state arrived. The player uses this to work out how far the
// video has moved since then (we never compare the clocks of two computers).
function withReceivedAt(state) {
  return state ? { ...state, receivedAt: Date.now() } : null;
}

// Turns a request action into words, so toasts read "asks to seek the video"
// instead of "asks to seek".
function describeRequest(r) {
  if (r.action === 'seek') return 'seek the video';
  if (r.action === 'change_video') return 'change the video';
  if (r.action === 'set_rate') return 'change the speed';
  if (r.action === 'set_captions') return 'change the subtitles';
  if (r.action === 'mute') return 'mute the video';
  if (r.action === 'unmute') return 'unmute the video';
  return r.action + ' the video';
}

/**
 * Owns the socket connection and ALL room data.
 * This is the only place that talks to the server; the pages and components just
 * read the values returned here and call the actions returned here.
 *
 * status is one of: joining, waiting (for host approval), joined, rejected, error
 */
export default function useRoom(roomId, username, initialJoin, chatOpenRef) {
  // The server can hand out a new id if the one we asked for is already taken,
  // so this is state we may update, not a constant.
  const [userId, setUserId] = useState(getUserId);

  // If the home page already gave us the server's answer, start from it instead of
  // showing a spinner for a room we have already joined. That is what initialJoin is.
  const [status, setStatus] = useState(initialJoin ? (initialJoin.pending ? 'waiting' : 'joined') : 'joining');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(socket.connected);
  // Set when the host removes us, so the page can show the "you were removed" screen.
  const [removed, setRemoved] = useState(false);
  const [participants, setParticipants] = useState(initialJoin?.participants ?? []);
  const [syncState, setSyncState] = useState(withReceivedAt(initialJoin?.state));
  const [requests, setRequests] = useState(initialJoin?.requests ?? []);
  const [joinRequests, setJoinRequests] = useState(initialJoin?.joinRequests ?? []); // host only
  const [chat, setChat] = useState(initialJoin?.chat ?? []);
  const [history, setHistory] = useState([]); // decided requests, newest first
  const [toasts, setToasts] = useState([]);

  const nextToastId = useRef(1);
  const seenRequestIds = useRef(new Set()); // so a request only pops up once
  const seenJoinIds = useRef(new Set());

  // My role always comes from the participants list, so it updates live when the
  // host promotes or demotes me - no separate "myRole" state to keep in sync.
  const me = participants.find((p) => p.userId === userId);
  const role = me ? me.role : 'participant';
  const isController = role === 'host' || role === 'moderator';
  // Socket handlers are set up once and would otherwise read a stale role,
  // so the current role is mirrored into a ref for them to read.
  const roleRef = useRef(role);
  roleRef.current = role;
  // The join callback below is created once and would otherwise read the status from
  // whenever the effect ran, so the current one is mirrored into a ref as well.
  const statusRef = useRef(status);
  statusRef.current = status;

  // Small pop-up message. Removed automatically after 4 seconds.
  const addToast = useCallback((message, type = 'info') => {
    const id = nextToastId.current++;
    setToasts((list) => [...list, { id, message, type }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
  }, []);

  // ---- join the room and listen to every server event ----
  useEffect(() => {
    if (!username) return; // nothing to do until we know who the user is

    // Fill in the room from the server's answer.
    // Used on a successful join AND when the host lets us in.
    function applyJoin(res) {
      // The server decides who we are. It also gives us the secret token that lets
      // this browser come back to the same seat (and role) after a refresh.
      if (res.you) {
        setUserId(res.you.userId);   // may differ from the id we asked for
        saveUserId(res.you.userId);  // remember it for the next request
        saveRoomToken(roomId, res.you.token); // the proof that this seat is ours
      }
      setParticipants(res.participants);
      setSyncState(withReceivedAt(res.state)); // stamp it so the player can count elapsed time
      setRequests(res.requests);
      setJoinRequests(res.joinRequests || []);
      setChat(res.chat);
      // Remember what we have already seen, so being let in does not replay a
      // toast for every request that was already there.
      res.requests.forEach((r) => seenRequestIds.current.add(r.requestId));
      (res.joinRequests || []).forEach((j) => seenJoinIds.current.add(j.userId));
      setStatus('joined');
    }

    // A failed join is only worth leaving the room screen over if we never got in.
    // This runs again after every reconnect, and by then we are already watching: one
    // slow round trip must not throw away a working session. socket.io keeps retrying
    // on its own, and the next "connect" calls join() again.
    function failJoin(message) {
      if (statusRef.current === 'joined' || statusRef.current === 'waiting') return;
      setStatus('error');
      setError(message);
    }

    // Used on first load AND after every reconnect. The token proves a known id is ours.
    function join() {
      // timeout(8000) matters here: without it a server that never answers would leave
      // the page stuck on "Joining room..." forever, with no way out.
      socket.timeout(8000).emit('join_room', { roomId, username, userId, token: getRoomToken(roomId) }, (err, res) => {
        if (err) {
          failJoin('Could not reach the server.');
        } else if (!res.ok) {
          failJoin(res.error || 'Could not join the room');
        } else if (res.pending) {
          // Waiting for the host to let us in. The page shows the waiting screen.
          setStatus('waiting');
        } else {
          applyJoin(res);
        }
      });
    }

    // Every message the server can send us. Keeping them in one object makes it easy
    // to see at a glance what this screen reacts to, and lets the cleanup below
    // remove exactly the same set.
    const handlers = {
      connect: () => {
        setConnected(true);
        join(); // a reconnect must rejoin, which is what restores the seat and role
      },
      disconnect: () => setConnected(false),

      join_approved: (res) => applyJoin(res), // the host let us in
      join_rejected: () => setStatus('rejected'), // the host said no
      join_requests_updated: (data) => {
        setJoinRequests(data.joinRequests);
        // Toast once per new person waiting. The host is the only one who gets this event.
        data.joinRequests.forEach((j) => {
          if (!seenJoinIds.current.has(j.userId)) {
            seenJoinIds.current.add(j.userId);
            addToast(`${j.username} wants to join the room`);
          }
        });
      },

      sync_state: (state) => setSyncState(withReceivedAt(state)), // the player follows this

      // These five all carry the full participant list, so each one just replaces it.
      user_joined: (data) => {
        setParticipants(data.participants);
        addToast(`${data.username} joined`);
      },
      user_left: (data) => {
        setParticipants(data.participants);
        addToast(`${data.username} left`);
      },
      role_assigned: (data) => {
        setParticipants(data.participants);
        addToast(`${data.username} is now a ${data.role}`);
      },
      participant_removed: (data) => {
        setParticipants(data.participants);
        // If the removed person is me, the page switches to the removed screen.
        if (data.userId === userId) setRemoved(true);
        else addToast(`${data.username} was removed`);
      },
      host_transferred: (data) => {
        setParticipants(data.participants);
        const newHost = data.participants.find((p) => p.userId === data.newHostId);
        addToast(`${newHost ? newHost.username : 'Someone'} is now the host`);
      },

      // The server sends each person a list filtered for them: controllers see all
      // requests, a participant sees only their own. So no filtering is needed here.
      requests_updated: (data) => {
        setRequests(data.requests);
        const isBoss = roleRef.current === 'host' || roleRef.current === 'moderator';
        data.requests.forEach((r) => {
          if (!seenRequestIds.current.has(r.requestId)) {
            seenRequestIds.current.add(r.requestId);
            // Only tell the controllers, and never about their own request.
            if (isBoss && r.userId !== userId) addToast(`${r.username} asks to ${describeRequest(r)}`);
          }
        });
      },
      request_resolved: (data) => {
        // Keep a short history of decisions for the "Earlier" section of the panel.
        setHistory((list) =>
          [{ id: data.requestId, kind: 'playback', ...data, ts: Date.now() }, ...list].slice(0, 30)
        );
        if (data.userId !== userId) return; // only the person who asked needs the answer
        addToast(
          `Your request to ${describeRequest(data)} was ${data.approved ? 'approved' : 'rejected'}`,
          data.approved ? 'success' : 'error'
        );
      },

      chat_message: (msg) => {
        setChat((list) => [...list, msg]);
        // If the chat panel is closed, show the message as a toast instead -
        // but never for our own message, which we already see in the panel.
        if (msg.userId !== userId && !chatOpenRef.current) {
          const text = msg.text.length > 60 ? msg.text.slice(0, 60) + '...' : msg.text;
          addToast(`${msg.username}: ${text}`);
        }
      },
      error_message: (data) => addToast(data.message, 'error'),
    };

    // Subscribe to everything above.
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);

    // Already connected (came from the home page)? join now. Otherwise connect, then "connect" joins.
    if (socket.connected) join();
    else socket.connect();

    // Unsubscribe when leaving the room, so a second room does not get the first
    // room's messages and handlers do not pile up.
    return () => {
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    };
  }, [roomId, username, userId, addToast, chatOpenRef]);

  // ---- every 15 seconds ask the server for the real position (fixes small drifts) ----
  useEffect(() => {
    if (status !== 'joined') return;
    const id = setInterval(() => {
      // Skip while the tab is in the background: a hidden tab does not need to
      // stay in sync, and this avoids pointless traffic.
      if (document.visibilityState === 'visible') socket.emit('request_sync');
    }, 15000);
    return () => clearInterval(id);
  }, [status]);

  // ---- actions ----

  // Host and moderator act directly. A participant sends a request instead.
  // The matching server checks are in room.socket.js: control() for the direct
  // events and requestAction() for the request ones. This function only chooses
  // which of the two to use - it is not what enforces the rule.
  function perform(action, payload = {}) {
    // a quiet report of the real position, only from host and moderator
    if (action === 'heartbeat') {
      if (isController) socket.emit('heartbeat', { time: payload.time });
      return;
    }
    if (isController) {
      if (action === 'play') socket.emit('play', { time: payload.time });
      else if (action === 'pause') socket.emit('pause', { time: payload.time });
      else if (action === 'seek') socket.emit('seek', { time: payload.time });
      else if (action === 'change_video') socket.emit('change_video', { videoId: payload.videoId });
      else if (action === 'mute') socket.emit('mute', {});
      else if (action === 'unmute') socket.emit('unmute', {});
      else if (action === 'set_rate') socket.emit('set_rate', { rate: payload.rate });
      else if (action === 'set_captions') socket.emit('set_captions', { lang: payload.lang, kind: payload.kind });
    } else {
      // A participant cannot change anything, so the same button becomes a request.
      socket.emit('request_action', { action, payload }, (res) => {
        if (res && res.ok) addToast('Request sent. Waiting for the host or a moderator.');
      });
    }
  }

  // Everything the rest of the app needs. Note none of the host-only actions
  // (assignRole, removeParticipant, transferHost, resolveJoin) check the role here:
  // the buttons are hidden for other roles, and the server refuses them anyway.
  return {
    userId, status, error, connected, removed,
    participants, role, isController,
    syncState, requests, joinRequests, history, chat, toasts,
    addToast,
    perform,
    resolveRequest: (requestId, approve) => socket.emit('resolve_request', { requestId, approve }),
    resolveJoin: (targetId, approve) => {
      const person = joinRequests.find((j) => j.userId === targetId);
      // Forget that we have seen this person. Without this, somebody the host turned
      // away could knock a second time and the host would never be told about it.
      seenJoinIds.current.delete(targetId);
      // Record the decision in the history before the list updates, so the
      // "Earlier" section can show which name was let in or turned away.
      if (person) {
        setHistory((list) =>
          [{ id: `join-${targetId}-${Date.now()}`, kind: 'join', username: person.username, approved: approve, ts: Date.now() }, ...list].slice(0, 30)
        );
      }
      socket.emit('resolve_join', { userId: targetId, approve });
    },
    assignRole: (targetId, newRole) => socket.emit('assign_role', { userId: targetId, role: newRole }),
    removeParticipant: (targetId) => socket.emit('remove_participant', { userId: targetId }),
    transferHost: (targetId) => socket.emit('transfer_host', { userId: targetId }),
    sendChat: (text) => socket.emit('chat_message', { text }),
    leave: () => socket.emit('leave_room', { roomId }),
  };
}
