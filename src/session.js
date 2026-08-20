// src/session.js
//
// A spotting session — which cut, and which tracks to offer against it — encoded
// into the link itself.
//
// It lives in the URL fragment rather than a datastore on purpose. There is
// nothing to provision, nothing to expire, and nothing anyone has to prune
// later. It also keeps the security model the proxy already established: the
// link is the credential, and it grants no more than the assets it names, all
// of which sit behind the same allowlist as before. A fragment never reaches
// the server, so these IDs stay out of request logs.
//
// The cost is a long URL. That is the trade, and it is the right way round for
// a tool where sessions are made constantly and kept briefly.

const VERSION = 1;

// btoa/atob exist in browsers and in Node, so this module is testable without a
// DOM. The payload is hex and punctuation only, so there is no Unicode to
// mishandle.
function toBase64Url(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the fragment for a session. `folderId` is what makes this one API call
 * instead of one per track: the app lists the folder once and picks out the
 * chosen IDs, so adding a fifth track costs nothing but its ID in the link.
 */
export function encodeSession({ folderId, videoId, trackIds = [] }) {
  if (!videoId || !UUID.test(videoId)) throw new Error("A session needs the video's asset ID.");
  const tracks = trackIds.filter(id => UUID.test(id));
  const payload = { n: VERSION, v: videoId, t: tracks };
  if (folderId && UUID.test(folderId)) payload.f = folderId;
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Read a session back. Accepts a bare payload, a "#s=…" fragment, or a whole
 * URL, because all three get pasted in practice.
 *
 * Returns null rather than throwing for anything unreadable: a mangled link
 * should leave the app in its ordinary empty state with the paste box, not on
 * an error screen. A truncated link — mail clients wrap long URLs — is the
 * expected failure here, not a rare one.
 */
export function decodeSession(input) {
  if (!input || typeof input !== "string") return null;

  let raw = input.trim();
  const marker = raw.indexOf("s=");
  if (marker !== -1) raw = raw.slice(marker + 2);
  raw = raw.replace(/^#/, "").split("&")[0];
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.n !== VERSION) return null;
  if (!parsed.v || !UUID.test(parsed.v)) return null;

  return {
    folderId: UUID.test(parsed.f || "") ? parsed.f : null,
    videoId:  parsed.v,
    trackIds: Array.isArray(parsed.t) ? parsed.t.filter(id => UUID.test(id)) : [],
  };
}

/** The full link an editor copies. */
export function sessionURL(origin, session) {
  return `${origin.replace(/\/+$/, "")}/#s=${encodeSession(session)}`;
}

/** The session named by the current address bar, or null. */
export function sessionFromLocation(loc = window.location) {
  return decodeSession(loc.hash || "");
}
