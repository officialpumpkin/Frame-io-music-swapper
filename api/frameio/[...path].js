// api/frameio/[...path].js
//
// Vercel catch-all serverless function.
// Proxies /api/frameio/* → https://api.frame.io/v4/*
// Adds x-frameio-legacy-token-auth: true so developer tokens work with V4.

const UPSTREAM_BASE = "https://api.frame.io/v4";

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
    const candidate = decodeURIComponent(match[1]).replace(/^\/+/, "");
    // Guard against an un-substituted rewrite destination literal ("[...path]").
    if (candidate && !candidate.startsWith("[")) return candidate;
  }

  for (const key of ROUTE_PARAM_KEYS) {
    const raw = req.query?.[key];
    const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const joined = segments.join("/").replace(/^\/+/, "");
    if (joined) return joined;
  }
  return "";
}

// Build the query string to forward upstream.
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
    if (ROUTE_PARAM_KEYS.includes(key)) params.delete(key);
  }
  return params.toString();
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

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
      received: { url: req.url, query: req.query ?? null },
    });
  }

  const qs = resolveQuery(req);
  const frameioURL = `${UPSTREAM_BASE}/${subPath}${qs ? `?${qs}` : ""}`;
  res.setHeader("x-proxy-upstream", frameioURL);

  try {
    const upstream = await fetch(frameioURL, {
      method: req.method,
      headers: {
        Authorization:                 `Bearer ${TOKEN}`,
        "Content-Type":                "application/json",
        Accept:                        "application/json",
        "x-frameio-legacy-token-auth": "true",   // Required for developer tokens on V4
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method)
        ? JSON.stringify(req.body)
        : undefined,
    });

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
