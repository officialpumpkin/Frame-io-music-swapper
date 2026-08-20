// The session codec carries the whole feature — an editor's generated link is
// worthless if this round-trips wrong, and the failure would show up as an app
// that silently ignores the link.
import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const { encodeSession, decodeSession, sessionURL } =
  await import(pathToFileURL(`${ROOT}/src/session.js`).href);

const FOLDER = "6f1e2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";
const VIDEO  = "11112222-3333-4444-5555-666677778888";
const T1     = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const T2     = "99998888-7777-6666-5555-444433332222";

// ── Round trip ──────────────────────────────────────────────────────────────

let s = decodeSession(encodeSession({ folderId: FOLDER, videoId: VIDEO, trackIds: [T1, T2] }));
assert.strictEqual(s.folderId, FOLDER);
assert.strictEqual(s.videoId, VIDEO);
assert.deepStrictEqual(s.trackIds, [T1, T2]);
console.log("ok  round trip        → folder, video and track order preserved");

// Track order is the order they appear in the app, and 1-9 selects by position,
// so a reordering here would silently remap every keyboard shortcut.
s = decodeSession(encodeSession({ folderId: FOLDER, videoId: VIDEO, trackIds: [T2, T1] }));
assert.deepStrictEqual(s.trackIds, [T2, T1]);
console.log("ok  track order       → reversed input stays reversed");

// ── The shapes that actually get pasted ─────────────────────────────────────

const payload = encodeSession({ videoId: VIDEO, trackIds: [T1] });
for (const [label, input] of [
  ["bare payload", payload],
  ["fragment",     `#s=${payload}`],
  ["full URL",     `https://frame-io-music-swapper.vercel.app/#s=${payload}`],
]) {
  assert.strictEqual(decodeSession(input)?.videoId, VIDEO, label);
}
console.log("ok  accepted forms    → payload, #s=… fragment, and whole URL");

// ── A session with no folder still names its video ──────────────────────────

s = decodeSession(encodeSession({ videoId: VIDEO }));
assert.strictEqual(s.folderId, null);
assert.deepStrictEqual(s.trackIds, []);
console.log("ok  video only        → decodes with no folder and no tracks");

// ── Bad input returns null, never throws ────────────────────────────────────
// The app falls back to its ordinary empty state on null. A throw here would
// put a blank page in front of anyone whose mail client wrapped the link.

for (const bad of [
  "", null, undefined, "#s=", "#s=not-base64!!", "#", "nonsense",
  toB64('{"n":1,"v":"not-a-uuid"}'),        // right shape, wrong id
  toB64('{"n":99,"v":"' + VIDEO + '"}'),    // a version this build cannot read
  toB64("{broken json"),
  payload.slice(0, payload.length - 12),    // truncated, as mail clients do
]) {
  assert.strictEqual(decodeSession(bad), null, `expected null for ${String(bad).slice(0, 24)}`);
}
console.log("ok  unreadable links  → null, never a throw");

// A track ID that is not a UUID is dropped rather than passed to the proxy,
// which would refuse it anyway.
s = decodeSession(toB64(JSON.stringify({ n: 1, v: VIDEO, t: [T1, "../../etc/passwd", 42] })));
assert.deepStrictEqual(s.trackIds, [T1]);
console.log("ok  junk track ids    → dropped before they can reach the proxy");

// ── The link an editor copies ───────────────────────────────────────────────

const url = sessionURL("https://frame-io-music-swapper.vercel.app/", { videoId: VIDEO, trackIds: [T1] });
assert.ok(url.startsWith("https://frame-io-music-swapper.vercel.app/#s="), "no doubled slash");
assert.strictEqual(decodeSession(url).videoId, VIDEO);
// URL-safe alphabet only: + / = would all need escaping when pasted.
assert.ok(!/[+/=]/.test(url.split("#s=")[1]), "payload is base64url, not base64");
console.log("ok  sessionURL()      → url-safe payload, decodes from the link");

assert.throws(() => encodeSession({ videoId: "nope" }), /video/i);
console.log("ok  encode guard      → refuses a session with no valid video");

function toB64(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

console.log("\nAll session tests passed.");
