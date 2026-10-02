// components/RequestsPanel.jsx

import { formatTime } from "../utils/format.js";

function describeAction(item) {
  const payload = item.payload || {};

  if (item.action === "play") return "Play the video";
  if (item.action === "pause") return "Pause the video";

  if (item.action === "set_captions") {
    return payload.captions
      ? `Turn on subtitles (${payload.captions.lang})`
      : "Turn off subtitles";
  }

  if (item.action === "set_rate") {
    return `Set speed to ${payload.rate}x`;
  }

  if (item.action === "mute") return "Mute the video";
  if (item.action === "unmute") return "Unmute the video";

  if (item.action === "seek") {
    return `Go to ${formatTime(payload.time)}`;
  }

  if (item.action === "change_video") {
    return `Play another video (${payload.videoId})`;
  }

  return item.action;
}

function SectionTitle({ children }) {
  return (
    <p className="bg-gray-100 px-3 py-2 text-xs font-bold text-gray-600">
      {children}
    </p>
  );
}

export default function RequestsPanel({
  role,
  myId,
  requests,
  joinRequests,
  history,
  onResolve,
  onResolveJoin,
}) {
  const isHost = role === "host";
  const canResolve = role === "host" || role === "moderator";

  const newestFirst = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

  // Controllers see all requests; participants see only their own.
  const pending = (
    canResolve
      ? requests
      : requests.filter((request) => request.userId === myId)
  )
    .slice()
    .sort(newestFirst);

  const waiting = isHost ? joinRequests.slice().reverse() : [];

  const done = canResolve
    ? history
    : history.filter((item) => item.userId === myId);

  if (pending.length === 0 && waiting.length === 0 && done.length === 0) {
    return <p className="p-4 text-sm text-gray-600">Nothing yet.</p>;
  }

  return (
    <div className="h-full overflow-y-auto">
      {waiting.length > 0 && (
        <div>
          <SectionTitle>People waiting to join</SectionTitle>

          {waiting.map((request) => (
            <div
              key={request.userId}
              className="border-b border-gray-200 p-3 text-sm"
            >
              <p>{request.username} wants to join</p>

              <div className="mt-2 flex gap-2">
                <button
                  className="btn px-3! py-1!"
                  onClick={() => onResolveJoin(request.userId, true)}
                >
                  Let in
                </button>

                <button
                  className="btn-light px-3! py-1!"
                  onClick={() => onResolveJoin(request.userId, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div>
          <SectionTitle>Waiting for a decision</SectionTitle>

          {pending.map((request) => (
            <div
              key={request.requestId}
              className="border-b border-gray-200 p-3 text-sm"
            >
              {canResolve ? (
                <>
                  <p>
                    {request.username} asks: {describeAction(request)}
                  </p>

                  <div className="mt-2 flex gap-2">
                    <button
                      className="btn px-3! py-1!"
                      onClick={() => onResolve(request.requestId, true)}
                    >
                      Approve
                    </button>

                    <button
                      className="btn-light px-3! py-1!"
                      onClick={() => onResolve(request.requestId, false)}
                    >
                      Reject
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  {describeAction(request)}{" "}
                  <span className="text-gray-500">(waiting)</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <SectionTitle>Earlier</SectionTitle>

          {done.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-2 border-b border-gray-100 px-3 py-2 text-xs text-gray-500"
            >
              <span>
                {item.kind === "join"
                  ? `${item.username} asked to join`
                  : canResolve
                    ? `${item.username}: ${describeAction(item)}`
                    : describeAction(item)}
              </span>

              <span
                className={item.approved ? "text-green-700" : "text-red-700"}
              >
                {item.kind === "join"
                  ? item.approved
                    ? "Let in"
                    : "Denied"
                  : item.approved
                    ? "Approved"
                    : "Rejected"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
