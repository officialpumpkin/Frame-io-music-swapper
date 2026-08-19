// api/bug.js
//
// Takes a bug report from the app's "Report a bug" sheet and opens a GitHub
// issue for it, so a tester's finding lands next to the code instead of in a
// chat message someone has to transcribe.
//
// ── What this endpoint is, security-wise ────────────────────────────────────
// It is unauthenticated, because the testers are the people we handed a link
// to and asking them to hold a credential defeats the point. That makes it a
// write endpoint anyone who finds it can reach, so the containment is:
//
//   • POST only, JSON only, with a hard cap on the body and on every field.
//   • Same-origin required when the browser declares an origin at all.
//   • A per-instance rate limit.
//   • The token is fine-grained and can do exactly one thing: open issues on
//     one repository. It is never echoed back, and no reply from GitHub is
//     forwarded verbatim beyond the issue URL and a trimmed error.
//
// None of that is authentication, and it should not be mistaken for it. The
// worst case is someone spamming issues on one repo; the fix if that ever
// happens is to revoke BUG_GITHUB_TOKEN in Vercel, which disables this endpoint
// and nothing else. That is the whole reason the token is scoped to issues on a
// single repo rather than reusing anything broader.

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "officialpumpkin/Frame-io-music-swapper";

// Caps. A real report from the sheet is a few KB; anything near these limits is
// either a runaway diagnostic or someone testing what the endpoint accepts.
const MAX_BODY_BYTES  = 64 * 1024;
const MAX_SUMMARY     = 160;
const MAX_TEXT        = 4000;
const MAX_DIAGNOSTICS = 20000;

// Best-effort rate limit. Serverless instances are per-region and recycled, so
// this bounds one warm instance rather than the endpoint as a whole — it slows
// casual abuse and does not stop a determined one. Deliberately simple: the
// alternative is a datastore this project does not otherwise need.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 6;
let rateHits = [];

function rateLimited() {
  const now = Date.now();
  rateHits = rateHits.filter(t => now - t < RATE_WINDOW_MS);
  if (rateHits.length >= RATE_MAX) return true;
  rateHits.push(now);
  return false;
}

// Trim to a cap, note that it happened, and normalise line endings so the issue
// body does not arrive full of stray carriage returns.
function clamp(value, max) {
  if (value == null) return "";
  const s = String(value).replace(/\r\n/g, "\n").trim();
  return s.length > max ? `${s.slice(0, max)}\n\n…truncated at ${max} characters.` : s;
}

// Everything the reporter typed goes into the issue inside a fence, so a stray
// "@someone" cannot notify a person and markdown cannot restructure the issue.
// The fence has to be longer than the longest backtick run in the text, or the
// content closes it early — which is the same class of bug as a backtick in the
// app's CSS template literal.
export function fenced(text, lang = "") {
  const longest = (String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text || "(not given)"}\n${fence}`;
}

// A single line, no markdown, short enough to read in a list.
export function issueTitle(summary) {
  const line = clamp(summary, MAX_SUMMARY).split("\n")[0].replace(/\s+/g, " ").trim();
  return `[bug] ${line || "Unlabelled report from the app"}`;
}

export function buildIssueBody({ doing, happened, diagnostics, reporter }) {
  return [
    "**What I was doing**",
    fenced(clamp(doing, MAX_TEXT)),
    "",
    "**What happened**",
    fenced(clamp(happened, MAX_TEXT)),
    "",
    "<details><summary>Diagnostics captured by the app</summary>",
    "",
    fenced(clamp(diagnostics, MAX_DIAGNOSTICS)),
    "",
    "</details>",
    "",
    `_Filed from the Music Swapper report sheet${reporter ? ` by ${clamp(reporter, 80)}` : ""}._`,
  ].join("\n");
}

// The browser sends Origin on a JSON POST. When it is present it must be ours;
// when it is absent the request did not come from a page, and the caps and rate
// limit are what stands in front of it.
function originAllowed(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const configured = process.env.ALLOWED_ORIGIN;
  if (configured) return origin === configured;
  const host = req.headers?.host;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  // Vercel parses JSON bodies, but only when the content type says so — the
  // raw path is still needed for anything else, and for enforcing the cap.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw new Error("too large");
    return JSON.parse(req.body);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", message: "Bug reports are POSTed." });
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Forbidden", message: "Cross-origin reports are not accepted." });
  }

  const token = process.env.BUG_GITHUB_TOKEN;
  if (!token) {
    // A distinct status so the UI can say "reporting isn't switched on" rather
    // than showing the tester a failure they cannot act on.
    return res.status(503).json({
      error:   "Reporting not configured",
      message: "BUG_GITHUB_TOKEN is not set on this deployment.",
    });
  }

  if (rateLimited()) {
    return res.status(429).json({
      error:   "Too many reports",
      message: "Several reports just arrived. Wait a minute and send this one again.",
    });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (err) {
    const tooLarge = err.message === "too large";
    return res.status(tooLarge ? 413 : 400).json({
      error:   tooLarge ? "Report too large" : "Bad request",
      message: tooLarge ? "That report is bigger than this endpoint accepts." : "Could not read the report body.",
    });
  }

  const summary = clamp(payload.summary, MAX_SUMMARY);
  const doing = clamp(payload.doing, MAX_TEXT);
  const happened = clamp(payload.happened, MAX_TEXT);
  if (!summary && !happened) {
    return res.status(400).json({
      error:   "Bad request",
      message: "Say what happened before sending.",
    });
  }

  const repo = process.env.BUG_GITHUB_REPO || DEFAULT_REPO;
  const issue = {
    title: issueTitle(summary || happened),
    body:  buildIssueBody({
      doing,
      happened,
      diagnostics: payload.diagnostics,
      reporter:    payload.reporter,
    }),
    labels: ["bug"],
  };

  const post = (payloadForGithub) => fetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method:  "POST",
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type":         "application/json",
      "User-Agent":           "brightworks-music-swapper",
    },
    body: JSON.stringify(payloadForGithub),
  });

  try {
    let upstream = await post(issue);

    // A label the repo does not define is rejected outright, which would lose a
    // real report over a cosmetic field. Drop it and file the issue anyway.
    if (upstream.status === 422) {
      const { labels, ...unlabelled } = issue;   // eslint-disable-line no-unused-vars
      upstream = await post(unlabelled);
    }

    const text = await upstream.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* handled below */ }

    if (!upstream.ok) {
      // GitHub's own message is useful to us and meaningless to a tester, so it
      // is trimmed, kept out of the UI copy, and logged for the Vercel console.
      console.error("Bug report rejected by GitHub", upstream.status, String(text).slice(0, 300));
      return res.status(502).json({
        error:   "Could not file the report",
        message: `GitHub refused the report (${upstream.status}).`,
      });
    }

    return res.status(201).json({ url: data.html_url, number: data.number });

  } catch (err) {
    console.error("Bug report failed", err);
    return res.status(502).json({ error: "Could not file the report", message: err.message });
  }
}
