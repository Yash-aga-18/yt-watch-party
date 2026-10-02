// pages/RoomPage.jsx

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import useRoom from '../hooks/useRoom.js';
import { getUsername, setUsername as saveUsername } from '../utils/identity.js';
import VideoPlayer from '../components/VideoPlayer.jsx';
import VideoLinkForm from '../components/VideoLinkForm.jsx';
import ParticipantList from '../components/ParticipantList.jsx';
import RequestsPanel from '../components/RequestsPanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import Toasts from '../components/Toasts.jsx';

// Shown when someone opens an invite link and has not entered a name yet
// It is a small local form: type a name and hand it up to the room page.
function NameForm({ code, onSubmit }) {
  const [name, setName] = useState('');
  function handleSubmit(e) {
    e.preventDefault();
    // Only continue when the trimmed name is not empty.
    if (name.trim()) onSubmit(name.trim());
  }
  return (
    <div className="mx-auto max-w-sm p-4 pt-16">
      <form onSubmit={handleSubmit} className="card space-y-3">
        {/* Shows which room the invite link points at. */}
        <h1 className="text-lg font-bold">Join room {code}</h1>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={30} />
        <button className="btn">Continue</button>
      </form>
    </div>
  );
}

// Small reusable box for plain status messages (errors, waiting, rejected).
// showHome controls whether the "Back to home" link is shown.
function Message({ children, showHome = true }) {
  return (
    <div className="mx-auto max-w-sm p-4 pt-16">
      <div className="card space-y-3">
        <p>{children}</p>
        {showHome && <Link to="/" className="btn-light inline-block">Back to home</Link>}
      </div>
    </div>
  );
}

export default function RoomPage() {
  // Read the ":code" piece out of the URL, e.g. /room/ABC123 -> "ABC123".
  // Uppercase it so the code matches no matter how the link was typed.
  const { code: rawCode } = useParams();
  const code = rawCode.toUpperCase();
  const location = useLocation();
  const navigate = useNavigate();

  // The name can be empty here when a friend opens the invite link fresh.
  const [username, setUsername] = useState(getUsername());
  const [tab, setTab] = useState('people'); // people, requests or chat
  // How many chat messages had been read the last time the chat tab was open.
  const [seenChat, setSeenChat] = useState(0);

  // A ref (not state) telling the socket handlers whether the chat tab is currently open,
  // so incoming messages can be toasted only when the user is not already looking at chat.
  const chatOpenRef = useRef(false);

  // Use the answer from the home page only if it is for this room
  // location.state survives a navigate() but a plain refresh clears it, so this is
  // undefined on reload. The check guards against showing the wrong room's data.
  const joinResult = location.state?.joinResult;
  const initialJoin = joinResult && joinResult.roomId === code ? joinResult : null;

  // useRoom owns the socket and all room data (participants, sync state, chat, ...).
  const room = useRoom(code, username, initialJoin, chatOpenRef);

  // Removed by the host: go back home.
  // replace: true matters - without it the Back button would return to the room
  // this person was just thrown out of.
  // We pass a message so the home page can explain why we are suddenly back there.
  useEffect(() => {
    if (room.removed) navigate('/', { replace: true, state: { message: 'The host removed you from the room.' } });
  }, [room.removed, navigate]);

  // Chat: mark messages as read while the chat tab is open
  // chatOpenRef is kept in sync (read by socket handlers), and seenChat is bumped to the
  // current message count so the unread badge resets when you are on the chat tab.
  useEffect(() => {
    chatOpenRef.current = tab === 'chat';
    if (tab === 'chat') setSeenChat(room.chat.length);
  }, [tab, room.chat.length]);

  // No name yet (fresh invite link): ask for one. Saving it lets the room hook start joining.
  if (!username) {
    return <NameForm code={code} onSubmit={(name) => { saveUsername(name); setUsername(name); }} />;
  }
  // The room hook tells us which of these simple screens to show.
  if (room.status === 'error') return <Message>{room.error}</Message>;
  if (room.status === 'rejected') return <Message>The host did not let you in.</Message>;
  // Waiting for the server's answer. The "Back to home" link stays visible on purpose:
  // if the server is unreachable the socket keeps retrying and this screen would
  // otherwise sit here forever with no way out.
  if (room.status === 'joining') return <Message>Joining room...</Message>;
  // Waiting for host approval: show a cancel button that leaves and goes home.
  if (room.status === 'waiting') {
    return (
      <div className="mx-auto max-w-sm p-4 pt-16">
        <div className="card space-y-3">
          <p className="font-bold">Room {code}</p>
          <p>Waiting for the host to let you in...</p>
          <button
            className="btn-light"
            onClick={() => {
              room.leave();
              navigate('/');
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Build the invite link from the current origin, copy it, and give feedback either way.
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${code}`);
      room.addToast('Link copied', 'success');
    } catch {
      // Clipboard can fail (permissions, non-HTTPS); tell the user to copy it manually.
      room.addToast('Could not copy. Copy the address from the browser bar.', 'error');
    }
  }

  // Role facts used to drive the UI below.
  const isHost = room.role === 'host';
  // How many things need a controller's attention: playback requests plus join requests (host only).
  const waitingCount = (room.isController ? room.requests.length : 0) + (isHost ? room.joinRequests.length : 0);
  // Unread chat: count other people's messages newer than the last seen index. Zero while on chat.
  const unreadChat = tab === 'chat' ? 0 : room.chat.slice(seenChat).filter((m) => m.userId !== room.userId).length;

  // The three side-panel tabs, with live counts baked into the labels.
  const tabs = [
    { id: 'people', label: `People (${room.participants.length})` },
    { id: 'requests', label: waitingCount > 0 ? `Requests (${waitingCount})` : 'Requests' },
    { id: 'chat', label: unreadChat > 0 ? `Chat (${unreadChat})` : 'Chat' },
  ];

  return (
    <div>
      {/* Floating status messages (someone joined, a request was approved, ...). */}
      <Toasts toasts={room.toasts} />

      {/* Top bar: room identity on the left, who you are and Leave on the right. */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-300 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-bold">Watch Party</span>
          <span>Room code: <b>{code}</b></span>
          <button className="btn-light" onClick={copyInvite}>Copy link</button>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* Shows your name and the role the server gave you. */}
          <span>{username} ({room.role})</span>
          <button
            className="btn-light"
            onClick={() => {
              room.leave();
              navigate('/');
            }}
          >
            Leave
          </button>
        </div>
      </header>

      {/* Socket dropped: warn the user; socket.io will retry and re-join automatically. */}
      {!room.connected && <p className="bg-gray-200 p-2 text-center text-sm">Connection lost. Reconnecting...</p>}

      {/* Two-column layout on wide screens: player + link form on the left, side panel right. */}
      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-4">
          <VideoPlayer syncState={room.syncState} role={room.role} onAction={room.perform} />
          <VideoLinkForm role={room.role} onAction={room.perform} />
        </section>

        <aside className="card flex h-120 flex-col p-0 lg:h-[calc(100vh-7rem)]">
          {/* Tab buttons. The active one is dark; the rest are light. */}
          <div className="flex border-b border-gray-300">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 px-2 py-2 text-sm ${tab === t.id ? 'bg-gray-900 text-white' : 'bg-white hover:bg-gray-100'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Only the selected tab's panel is rendered. */}
          <div className="min-h-0 flex-1">
            {tab === 'people' && (
              <ParticipantList
                participants={room.participants}
                myId={room.userId}
                myRole={room.role}
                onAssignRole={room.assignRole}
                onTransferHost={room.transferHost}
                onRemove={room.removeParticipant}
              />
            )}
            {tab === 'requests' && (
              <RequestsPanel
                role={room.role}
                myId={room.userId}
                requests={room.requests}
                joinRequests={room.joinRequests}
                history={room.history}
                onResolve={room.resolveRequest}
                onResolveJoin={room.resolveJoin}
              />
            )}
            {/* Chat is the only tab that marks messages as read; the other tabs show an unread count. */}
            {tab === 'chat' && <ChatPanel messages={room.chat} myId={room.userId} onSend={room.sendChat} />}
          </div>
        </aside>
      </main>
    </div>
  );
}
