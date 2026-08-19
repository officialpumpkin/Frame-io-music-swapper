// src/bugLog.js
//
// A rolling record of everything that went wrong in this session, so a tester's
// bug report carries the evidence instead of a description of it.
//
// This module is imported for its side effects and must be imported before the
// app renders — errors thrown while the video or ffmpeg is loading happen long
// before anyone thinks to open the report sheet, and they are exactly the ones
// worth having. Capturing at import time means the buffer is already filling
// when the tester finally hits the button.
//
// Everything is bounded. A page left open all afternoon must not grow a buffer
// until the tab dies, and the report itself has to stay small enough to post.

const MAX_ENTRIES = 80;    // Ring buffer; the oldest entry is dropped.
const MAX_LEN     = 400;   // Per message, before truncation.

const entries = [];
let installed = false;

// Seconds since the page loaded, which is what you actually want when reading a
// report back: "it died 4s in" beats a wall-clock time in an unknown timezone.
function stamp() {
  return Math.round(performance.now()) / 1000;
}

function truncate(text) {
  const s = String(text);
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}… (+${s.length - MAX_LEN} chars)` : s;
}

// Console arguments are arbitrary values, and an Error logged as an object
// stringifies to a useless "[object Object]" — its message and stack are the
// whole point, so those are pulled out by hand.
function describe(value) {
  if (value instanceof Error) {
    return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    // Circular structures, DOM nodes, and anything with a throwing getter.
    return String(value);
  }
}

function record(level, parts) {
  entries.push({ t: stamp(), level, text: truncate(parts.map(describe).join(" ")) });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

// A breadcrumb the app leaves deliberately — "export: muxing", "asset resolved".
// The console tells you what broke; these tell you how far it got first, which
// is the missing half when a run fails with no error at all.
export function note(message) {
  record("note", [message]);
}

export function getLog() {
  return entries.slice();
}

// Rendered for the issue body and for the "what gets sent" panel, newest last so
// it reads in the order things happened.
export function formatLog() {
  if (entries.length === 0) return "(nothing logged)";
  return entries.map(e => `[${e.t.toFixed(2)}s] ${e.level.toUpperCase()}: ${e.text}`).join("\n");
}

export function installBugLog() {
  if (installed) return;   // StrictMode double-invoke, and re-imports.
  installed = true;

  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      record(level, args);
      original(...args);   // Still goes to devtools; this observes, it doesn't swallow.
    };
  }

  // Uncaught throws never reach console.error in every browser, and a rejected
  // promise reaches it in none of them — both have to be listened for directly.
  window.addEventListener("error", (e) => {
    if (e.error) record("uncaught", [e.error]);
    else record("uncaught", [`${e.message} (${e.filename}:${e.lineno})`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    record("rejection", [e.reason]);
  });
}
