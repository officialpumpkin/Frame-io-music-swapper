// api/frameio/[...path].js
//
// Vercel catch-all serverless function.
// Proxies /api/frameio/* → https://api.frame.io/v4/*, attaching Brightworks'
// own FRAMEIO_TOKEN and the x-frameio-legacy-token-auth header developer
// tokens need on V4.
//
// ── Why this function is an allowlist ────────────────────────────────────────
// The token is account-wide and cannot be narrowed. Frame.io V4 ignores the
// resource scopes you can tick when minting a developer token — per Frame.io,
// those are exclusive to the V2 legacy API — so there is no read-only token to
// issue, and scoping by user would mean provisioning a Frame.io user per job.
//
// Containment happens here instead. Only the two GETs the app actually makes
// are forwarded, and both require a file ID the caller must already know.
// Nothing here lists, searches or enumerates, so there is no way to discover an
// ID you were not given. Reaching this endpoint therefore grants no more than
// the Frame.io link the client was already sent — which is the right target.
//
// Anything that widens what the app requests must be added to ALLOWED_PATH
// deliberately. Do not relax it to "any /accounts/** GET" for convenience.

const UPSTREAM_BASE = "https://api.frame.io/v4";

// accounts/<account>/files/<uuid>[/children] — nothing else.
const ALLOWED_PATH =
  /^accounts\/([^/]+)\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/children)?$/i;

// The query parameters the app sends. Others are dropped rather than forwarded.
const ALLOWED_PARAMS = new Set(["include", "type", "page", "page_size"]);

// Vercel names a catch-all route param after the raw bracket contents, so this
// file's param arrives as req.query["...path"] — dots included — and never as
// req.query.path. Reading the wrong key left the path empty, which collapsed
// every request to a bare https://api.frame.io/v4/ ("no route found for GET
// /v4"). Both keys are checked below, but the raw URL is preferred since it is
// the one source Vercel does not decorate with route params.
const ROUTE_PARAM_KEYS = ["path", "...path"];

// Work out which Frame.io endpoint was asked for.
export function resolveSubPath(req) {
  const pathname = String(req.url || "").split("?")[0];
  const match = pathname.match(/^\/api\/frameio\/(.+)$/);
  if (match) {
    const candidate = decodeURIComponent(match[1]).replace(/^\/+/, "").replace(/\/+$/, "");
    // Guard against an un-substituted rewrite destination literal ("[...path]").
    if (candidate && !candidate.startsWith("[")) return candidate;
  }

  for (const key of ROUTE_PARAM_KEYS) {
    const raw = req.query?.[key];
    const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const joined = segments.join("/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (joined) return joined;
  }
  return "";
}

// Build the query string to forward upstream, keeping only known parameters.
//
// req.query carries Vercel's injected route param alongside the real ones, and
// forwarding it made Frame.io reject the call outright ("Unexpected field:
// ...path"). Prefer the raw URL's query string, which contains only what the
// caller actually sent.
export function resolveQuery(req) {
  const rawQuery = String(req.url || "").split("?").slice(1).join("?");
  const params = new URLSearchParams(rawQuery);
  if ([...params.keys()].length === 0 && req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) value.forEach(v => params.append(key, v));
      else if (value != null) params.append(key, value);
    }
  }
  for (const key of [...params.keys()]) {
    if (!ALLOWED_PARAMS.has(key)) params.delete(key);
  }
  return params.toString();
}

function upstreamHeaders(token) {
  return {
    Authorization:                 `Bearer ${token}`,
    Accept:                        "application/json",
    "x-frameio-legacy-token-auth": "true",   // Required for developer tokens on V4
  };
}

// The account ID is a constant for this deployment. Set FRAMEIO_ACCOUNT_ID to
// skip the lookup; otherwise it is resolved once and held for the life of the
// warm instance. Either way the raw /accounts payload never leaves this
// function — callers only ever see the ID, so the listing is not an entry
// point for enumerating the account.
let cachedAccountId = process.env.FRAMEIO_ACCOUNT_ID || null;

async function getAccountId(token) {
  if (cachedAccountId) return cachedAccountId;
  const r = await fetch(`${UPSTREAM_BASE}/accounts`, { headers: upstreamHeaders(token) });
  if (!r.ok) throw new Error(`Could not resolve the Frame.io account (${r.status}).`);
  const body = await r.json();
  const list = Array.isArray(body) ? body : (body?.data || []);
  cachedAccountId = list[0]?.id || null;
  if (!cachedAccountId) throw new Error("No Frame.io account is visible to this token.");
  return cachedAccountId;
}

export default async function handler(req, res) {
  // The app is served from the same origin as this function, so it needs no
  // CORS grant at all. A wildcard here would let any page on the internet
  // script the proxy through a visitor's browser. Set ALLOWED_ORIGIN only if
  // the front end is ever hosted somewhere else.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Read-only by construction: the token is never attached to anything else.
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", message: "This proxy serves GET only." });
  }

  const TOKEN = process.env.FRAMEIO_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({
      error:   "Configuration error",
      message: "FRAMEIO_TOKEN environment variable is not set in Vercel.",
    });
  }

  const subPath = resolveSubPath(req);
  if (!subPath) {
    // Fail loudly here rather than sending a pathless request upstream.
    return res.status(400).json({
      error:   "Bad request",
      message: "Could not determine the Frame.io endpoint from the request path.",
    });
  }

  // The app asks for this on mount purely to learn the account ID. Answer it
  // here so the real listing is never proxied.
  if (subPath === "accounts") {
    try {
      return res.status(200).json({ data: [{ id: await getAccountId(TOKEN) }] });
    } catch (err) {
      return res.status(502).json({ error: "Upstream error", message: err.message });
    }
  }

  const match = ALLOWED_PATH.exec(subPath);
  if (!match) {
    return res.status(404).json({
      error:   "Not found",
      message: "This proxy serves a single Frame.io file, or that file's children, by ID.",
    });
  }

  let accountId;
  try {
    accountId = await getAccountId(TOKEN);
  } catch (err) {
    return res.status(502).json({ error: "Upstream error", message: err.message });
  }
  if (match[1] !== accountId) {
    return res.status(403).json({ error: "Forbidden", message: "Unknown Frame.io account." });
  }

  const qs = resolveQuery(req);
  const frameioURL = `${UPSTREAM_BASE}/${subPath}${qs ? `?${qs}` : ""}`;
  res.setHeader("x-proxy-upstream", frameioURL);

  try {
    const upstream = await fetch(frameioURL, { method: "GET", headers: upstreamHeaders(TOKEN) });

    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Upstream returned something that isn't JSON (HTML error page, etc.)
      return res.status(upstream.status).json({
        error:    "Upstream returned non-JSON",
        message:  text.slice(0, 500),
        upstream: frameioURL,
      });
    }
    return res.status(upstream.status).json(data);

  } catch (err) {
    return res.status(502).json({
      error:    "Upstream error",
      message:  err.message,
      upstream: frameioURL,
    });
  }
}
