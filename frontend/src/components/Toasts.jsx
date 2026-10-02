// components/Toasts.jsx

// Each toast type gets its own border and background colour, so the user can tell
// at a glance whether a message is just information, a success or a failure.
const COLORS = {
  info: 'border-gray-500 bg-white',
  success: 'border-green-700 bg-green-50',
  error: 'border-red-700 bg-red-50',
};

// Small pop-up messages in the top right corner
export default function Toasts({ toasts }) {
  return (
    // fixed + top/right keeps the stack in the corner no matter where the page is scrolled.
    // pointer-events-none lets clicks pass through the empty area so the toasts never block the app.
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-72 flex-col gap-2">
      {/* one box per toast, newest at the bottom; the id is used as the React key.
          The fallback keeps an unexpected type from becoming the literal class "undefined". */}
      {toasts.map((t) => (
        <div key={t.id} className={`border px-3 py-2 text-sm shadow ${COLORS[t.type] || COLORS.info}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
