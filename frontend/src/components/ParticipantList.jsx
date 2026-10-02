// components/ParticipantList.jsx

const ROLE_LABELS = {
  host: "Host",
  moderator: "Moderator",
  participant: "Participant",
};

export default function ParticipantList({
  participants,
  myId,
  myRole,
  onAssignRole,
  onTransferHost,
  onRemove,
}) {
  const iAmHost = myRole === "host";

  // Confirm actions that affect another participant.
  function handleTransfer(participant) {
    if (
      confirm(
        `Make ${participant.username} the host? You will become a moderator.`,
      )
    ) {
      onTransferHost(participant.userId);
    }
  }

  function handleRemove(participant) {
    if (confirm(`Remove ${participant.username} from the room?`)) {
      onRemove(participant.userId);
    }
  }

  return (
    <ul className="h-full overflow-y-auto">
      {participants.map((participant) => {
        const isMe = participant.userId === myId;

        return (
          <li
            key={participant.userId}
            className="border-b border-gray-200 p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={participant.connected ? "" : "text-gray-500"}>
                {participant.username}
                {isMe && " (you)"}
                {!participant.connected && " - offline"}
              </span>

              <span className="text-gray-700">
                {ROLE_LABELS[participant.role]}
              </span>
            </div>

            {/* Only the host can manage other participants. */}
            {iAmHost && !isMe && (
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  className="btn-light px-2! py-1!"
                  onClick={() =>
                    onAssignRole(
                      participant.userId,
                      participant.role === "moderator"
                        ? "participant"
                        : "moderator",
                    )
                  }
                >
                  {participant.role === "moderator"
                    ? "Make participant"
                    : "Make moderator"}
                </button>

                <button
                  className="btn-light px-2! py-1!"
                  onClick={() => handleTransfer(participant)}
                >
                  Make host
                </button>

                <button
                  className="btn-light px-2! py-1!"
                  onClick={() => handleRemove(participant)}
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
