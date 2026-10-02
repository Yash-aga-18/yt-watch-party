// utils/format.js

// 83 becomes "1:23"
// Turns a number of seconds into a clock string for the video position.
export function formatTime(totalSeconds) {
  // Guard against null/negative values, and drop any fraction of a second.
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  // Break the total seconds into hours, minutes and seconds.
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  // padStart(2, '0') makes "7" become "07", so seconds always show two digits.
  const seconds = String(s % 60).padStart(2, '0');
  // Only show the hours part when there is one, and pad minutes there too so
  // "1:02:03" lines up. Otherwise show a plain "1:23".
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}
