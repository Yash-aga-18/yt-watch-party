// components/VideoLinkForm.jsx

import { useState } from 'react';

// Paste a YouTube link to change the video.
// Host and moderator: it changes at once. Participant: it sends a request.
export default function VideoLinkForm({ role, onAction }) {
  // host and moderator change the video straight away; a participant's submit becomes a request
  const canControl = role === 'host' || role === 'moderator';
  const [videoInput, setVideoInput] = useState('');

  function handleSubmit(e) {
    e.preventDefault(); // keep the browser from reloading the page
    const value = videoInput.trim();
    if (!value) return; // nothing to send
    onAction('change_video', { videoId: value }); // the server decides if this is a change or a request
    setVideoInput('');
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-2">
      <div className="flex gap-2">
        <input
          className="input"
          value={videoInput}
          onChange={(e) => setVideoInput(e.target.value)}
          placeholder="Paste a YouTube link"
        />
        {/* the same form, but the label tells the user what will really happen */}
        <button className="btn whitespace-nowrap">{canControl ? 'Play this video' : 'Ask to play this'}</button>
      </div>
      {/* only participants see this explanation of the watch-only rule */}
      {!canControl && (
        <p className="text-xs text-gray-600">
          You can only watch. If you use the player controls, your player goes back and a request is sent to the host or a moderator.
        </p>
      )}
    </form>
  );
}
