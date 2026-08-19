// Exercises the bug-report endpoint. It is an unauthenticated write endpoint,
// so most of this asserts what it refuses and what it never forwards.
import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
delete process.env.BUG_GITHUB_TOKEN;
delete process.env.ALLOWED_ORIGIN;
process.env.BUG_GITHUB_REPO = "acme/widgets";

let sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return {
    ok: true, status: 201,
    text: async () => JSON.stringify({ html_url: "https://github.com/acme/widgets/issues/7", number: 7 }),
  };
};

const bug = await import(pathToFileURL(`${ROOT}/api/bug.js`).href);

const HOST = "swapper.example";

function call(method, body, headers = {}) {
  sent = [];
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  const req = { method, url: "/api/bug", query: {}, body, headers: { host: HOST, ...headers } };
  return bug.default(req, res).then(() => res);
}

const good = { summary: "Export made no file", doing: "placed two clips", happened: "returned to idle" };

// ── What must be refused ────────────────────────────────────────────────────

let r = await call("GET");
assert.strictEqual(r.statusCode, 405);
assert.strictEqual(sent.length, 0);
console.log("ok  GET               → 405, nothing sent to GitHub");

r = await call("POST", good);
assert.strictEqual(r.statusCode, 503);
assert.strictEqual(sent.length, 0);
console.log("ok  no token          → 503, nothing sent to GitHub");

process.env.BUG_GITHUB_TOKEN = "test-token";

r = await call("POST", good, { origin: "https://evil.example" });
assert.strictEqual(r.statusCode, 403);
assert.strictEqual(sent.length, 0);
console.log("ok  cross-origin      → 403, nothing sent to GitHub");

r = await call("POST", { summary: "  ", happened: "" });
assert.strictEqual(r.statusCode, 400);
assert.strictEqual(sent.length, 0);
console.log("ok  empty report      → 400, nothing sent to GitHub");

r = await call("POST", JSON.stringify({ summary: "x".repeat(70_000) }));
assert.strictEqual(r.statusCode, 413);
assert.strictEqual(sent.length, 0);
console.log("ok  oversized body    → 413, nothing sent to GitHub");

// ── What must work ──────────────────────────────────────────────────────────

r = await call("POST", good, { origin: `https://${HOST}` });
assert.strictEqual(r.statusCode, 201);
assert.deepStrictEqual(r.body, { url: "https://github.com/acme/widgets/issues/7", number: 7 });
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].url, "https://api.github.com/repos/acme/widgets/issues");
assert.strictEqual(sent[0].init.method, "POST");
assert.strictEqual(sent[0].init.headers.Authorization, "Bearer test-token");

const issue = JSON.parse(sent[0].init.body);
assert.strictEqual(issue.title, "[bug] Export made no file");
assert.ok(issue.body.includes("placed two clips"), "the 'doing' text is carried");
assert.ok(issue.body.includes("returned to idle"), "the 'happened' text is carried");
console.log("ok  same-origin post  → issue filed on the configured repo");

// The token must never come back to the caller, whatever else does.
assert.ok(!JSON.stringify(r.body).includes("test-token"));
console.log("ok  response          → carries no token");

// ── Text handling ───────────────────────────────────────────────────────────

// A report containing a fence must not be able to close the block it sits in
// and restructure the issue around it.
const fence = bug.fenced("```js\nalert(1)\n```");
assert.ok(fence.startsWith("````"), "fence outgrows the content");
assert.ok(fence.trimEnd().endsWith("````"));
console.log("ok  fenced()          → outgrows backticks in the report");

// A title is one line, so a newline-stuffed summary cannot forge issue body.
assert.strictEqual(bug.issueTitle("line one\nline two"), "[bug] line one");
assert.strictEqual(bug.issueTitle(""), "[bug] Unlabelled report from the app");
console.log("ok  issueTitle()      → single line, always labelled");

// An @mention in a report must not notify a real person.
const body = bug.buildIssueBody({ doing: "@officialpumpkin look", happened: "x", diagnostics: "y" });
assert.ok(body.includes("```\n@officialpumpkin look\n```"), "mention stays inside a fence");
console.log("ok  buildIssueBody()  → mentions stay inert inside a fence");

// ── Rate limit ──────────────────────────────────────────────────────────────
// Six are allowed per window; one has already been spent by the success above.

let limited = null;
for (let i = 0; i < 8 && limited === null; i++) {
  const res = await call("POST", good);
  if (res.statusCode === 429) limited = i;
}
assert.notStrictEqual(limited, null, "the endpoint eventually rate limits");
assert.strictEqual(sent.length, 0, "a limited request never reaches GitHub");
console.log(`ok  rate limit        → 429 after the window fills, nothing forwarded`);

console.log("\nAll bug-report tests passed.");
