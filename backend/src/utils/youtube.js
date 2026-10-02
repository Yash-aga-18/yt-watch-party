// utils/youtube.js

// YouTube video IDs are exactly 11 characters.
const ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

export function extractVideoId(input) {
    if (typeof input !== "string") return null;

    const text = input.trim();

    // Accept a video ID directly.
    if (ID_REGEX.test(text)) return text;

    let url;

    try {
        // Add https:// when the user pastes a URL without it.
        url = new URL(
            text.startsWith("http") ? text : `https://${text}`
        );
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^www\.|^m\./, "");
    let id = null;

    if (host === "youtu.be") {
        id = url.pathname.split("/")[1];
    } else if (
        host === "youtube.com" ||
        host === "music.youtube.com"
    ) {
        if (url.pathname === "/watch") {
            id = url.searchParams.get("v");
        } else {
            const [, type, value] = url.pathname.split("/");

            if (["embed", "shorts", "live", "v"].includes(type)) {
                id = value;
            }
        }
    }

    // Only return a valid YouTube video ID.
    return id && ID_REGEX.test(id) ? id : null;
}