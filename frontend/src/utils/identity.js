// utils/identity.js


const USER_ID_KEY = 'ywp_userId';
const USERNAME_KEY = 'ywp_username';

// A random id saved for this browser TAB. The server uses it to recognise you after a refresh.
// It is per tab on purpose: two tabs are two different people, so you can test a host and a
// participant side by side. (With one shared id, both tabs would be the host.)
//
// sessionStorage (not localStorage) is the key detail: it is scoped to one tab and is
// wiped when that tab closes, which is exactly the "two tabs = two people" behaviour.
export function getUserId() {
  let id = sessionStorage.getItem(USER_ID_KEY);
  if (!id) {
    // First time in this tab: make a random id. crypto.randomUUID is the modern
    // browser API; the fallback covers older browsers that do not have it.
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

// The server may give us a different id (for example if the one we asked for is taken).
// We overwrite the stored id so every later request uses the id the server knows us by.
export function saveUserId(id) {
  if (id) sessionStorage.setItem(USER_ID_KEY, id);
}

// A secret the server gives you when you join a room. Sending it back is the only way
// to prove that a reconnecting browser is really you, so nobody can take over your role
// by copying your userId. Kept per room, and only in this tab.
//
// The key includes the roomId so the same tab can hold a separate secret for each room.
export function getRoomToken(roomId) {
  return sessionStorage.getItem(`ywp_token_${roomId}`) || '';
}

// Stores the secret the server issued for this room. Both values must exist before we
// save, so a missing id or token can never overwrite a real one with an empty string.
export function saveRoomToken(roomId, token) {
  if (roomId && token) sessionStorage.setItem(`ywp_token_${roomId}`, token);
}

// The display name lives in localStorage (not sessionStorage) on purpose: it is shared
// across all tabs of this browser, so opening the app in a second tab remembers your
// name and you do not have to retype it. The id is per tab, the name is not.
export function getUsername() {
  return localStorage.getItem(USERNAME_KEY) || '';
}

// Saves the name typed by the user so it is remembered next time (across tabs).
export function setUsername(name) {
  localStorage.setItem(USERNAME_KEY, name);
}
