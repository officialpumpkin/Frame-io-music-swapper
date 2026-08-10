// Exercises the Frame.io proxy allowlist. The point of the change is what it
// refuses, so most of these assert that nothing reached Frame.io at all.
import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.FRAMEIO_TOKEN = "test-token";
delete process.env.ALLOWED_ORIGIN;
delete process.env.FRAMEIO_ACCOUNT_ID;

const ACCOUNT = "acct-1234";
const FILE    = "6f1e2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";

let upstream = [];
globalThis.fetch = async (url) => {
  upstream.push(String(url));
  if (String(url).endsWith("/accounts")) {
    return { ok: true, status: 200, json: async () => ({ data: [{ id: ACCOUNT }] }) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: FILE } }) };
};

const proxy  = await import(pathToFileURL(`${ROOT}/api/frameio/[...path].js`).href);
const expand = await import(pathToFileURL(`${ROOT}/api/expand.js`).href);

function call(mod, method, url) {
  upstream = [];
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  const [pathname, qs] = url.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  return mod.default({ method, url, query }, res).then(() => res);
}

const fio = (method, url) => call(proxy, method, url);
const P   = "/api/frameio";

// ── What must still work ────────────────────────────────────────────────────

let r = await fio("GET", `${P}/accounts`);
assert.strictEqual(r.statusCode, 200);
assert.deepStrictEqual(r.body, { data: [{ id: ACCOUNT }] });
console.log("ok  /accounts        → answers with the id only");

r = await fio("GET", `${P}/accounts/${ACCOUNT}/files/${FILE}?include=media_links.original`);
assert.strictEqual(r.statusCode, 200);
assert.ok(upstream.some(u => u.includes(`/v4/accounts/${ACCOUNT}/files/${FILE}`)), "file GET forwarded");
assert.ok(upstream.some(u => u.includes("include=media_links.original")), "include preserved");
console.log("ok  file by id       → forwarded, include preserved");

r = await fio("GET", `${P}/accounts/${ACCOUNT}/files/${FILE}/children?type=file&page=1&page_size=40&include=x`);
assert.strictEqual(r.statusCode, 200);
assert.ok(upstream.some(u => u.includes("/children?")), "children GET forwarded");
console.log("ok  children         → forwarded");

// ── What must be refused, without the token ever leaving ────────────────────

for (const method of ["DELETE", "POST", "PUT", "PATCH"]) {
  r = await fio(method, `${P}/accounts/${ACCOUNT}/files/${FILE}`);
  assert.strictEqual(r.statusCode, 405, `${method} refused`);
  assert.deepStrictEqual(upstream, [], `${method} reached Frame.io`);
}
console.log("ok  writes           → 405, nothing reaches Frame.io");

const forbidden = [
  `${P}/accounts/${ACCOUNT}/projects`,
  `${P}/accounts/${ACCOUNT}/workspaces`,
  `${P}/accounts/${ACCOUNT}/files/${FILE}/comments`,
  `${P}/accounts/${ACCOUNT}/review_links/${FILE}`,
  `${P}/accounts/${ACCOUNT}/files`,
  `${P}/me`,
  `${P}/accounts/${ACCOUNT}/files/not-a-uuid`,
  `${P}/accounts/${ACCOUNT}/files/${FILE}/../../projects`,
];
for (const url of forbidden) {
  r = await fio("GET", url);
  assert.strictEqual(r.statusCode, 404, `expected 404 for ${url}, got ${r.statusCode}`);
  assert.deepStrictEqual(upstream, [], `${url} reached Frame.io`);
}
console.log("ok  other endpoints  → 404, nothing reaches Frame.io");

r = await fio("GET", `${P}/accounts/someone-elses-account/files/${FILE}`);
assert.strictEqual(r.statusCode, 403);
assert.deepStrictEqual(upstream, [], "foreign account reached Frame.io");
console.log("ok  foreign account  → 403");

// Unknown query parameters are dropped rather than forwarded.
r = await fio("GET", `${P}/accounts/${ACCOUNT}/files/${FILE}?include=ok&filter[]=x&sort=created`);
assert.ok(upstream.some(u => u.includes("include=ok")), "include kept");
assert.ok(!upstream.some(u => /sort=|filter/.test(u)), "unknown params forwarded");
console.log("ok  query params     → unknown ones dropped");

// No wildcard CORS unless ALLOWED_ORIGIN is set deliberately.
r = await fio("GET", `${P}/accounts`);
assert.strictEqual(r.headers["Access-Control-Allow-Origin"], undefined);
console.log("ok  CORS             → no wildcard grant");

// ── Shortlink expander ──────────────────────────────────────────────────────

assert.strictEqual(expand.isAllowedTarget("https://f.io/xBPEGDdI"), true);
assert.strictEqual(expand.isAllowedTarget("https://next.frame.io/x"), true);
assert.strictEqual(expand.isAllowedTarget("http://f.io/x"), false, "plain http allowed");
assert.strictEqual(expand.isAllowedTarget("https://evil.example/x"), false);
assert.strictEqual(expand.isAllowedTarget("http://169.254.169.254/latest/meta-data/"), false);
assert.strictEqual(expand.isAllowedTarget("https://f.io.evil.example/x"), false, "suffix confusion");
console.log("ok  expand allowlist → only Frame.io hosts, https only");

r = await call(expand, "GET", "/api/expand?url=" + encodeURIComponent("http://169.254.169.254/"));
assert.strictEqual(r.statusCode, 400);
assert.deepStrictEqual(upstream, [], "SSRF target was fetched");
console.log("ok  expand SSRF      → 400, nothing fetched");

// A shortlink that redirects off Frame.io is rejected on the way back.
globalThis.fetch = async () => ({ url: "https://evil.example/landed" });
r = await call(expand, "GET", "/api/expand?url=" + encodeURIComponent("https://f.io/abc"));
assert.strictEqual(r.statusCode, 502);
console.log("ok  expand redirect  → off-Frame.io destination refused");

console.log("\nall proxy tests passed");
