// components/ChatPanel.jsx

import { useEffect, useRef, useState } from "react";

export default function ChatPanel({ messages, myId, onSend }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  // Keep the latest message visible.
  useEffect(() => {
    const element = listRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  function handleSubmit(e) {
    e.preventDefault();

    const value = text.trim();

    if (!value) return;

    onSend(value);
    setText("");
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-gray-600">No messages yet.</p>
        )}

        {messages.map((message) => (
          <div key={message.id} className="text-sm">
            <b>{message.userId === myId ? "You" : message.username}</b>

            <span className="ml-2 text-xs text-gray-500">
              {new Date(message.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>

            <p className="wrap-break-word">{message.text}</p>
          </div>
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex gap-2 border-t border-gray-300 p-2"
      >
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message"
          maxLength={500}
        />

        <button className="btn">Send</button>
      </form>
    </div>
  );
}
