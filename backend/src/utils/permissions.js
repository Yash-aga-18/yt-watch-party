// utils/permissions.js

export const ROLES = {
    HOST: "host",
    MODERATOR: "moderator",
    PARTICIPANT: "participant"
};

export function canControlPlayback(role) {
    return role === ROLES.HOST || role === ROLES.MODERATOR;
}

export function isHost(role) {
    return role === ROLES.HOST;
}