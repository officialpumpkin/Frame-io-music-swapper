// api/frameio/[...path].js
//
// Vercel catch-all serverless function.
// Proxies /api/frameio/* → https://api.frame.io/v4/*
// Adds x-frameio-legacy-token-auth: true so developer tokens work with V4.

const UPSTREAM_BASE = "https://api.frame.io/v4";

// Work out which Frame.io endpoint was asked for.
//
// Vercel normally fills req.query.path from the [...path] filename, but a rewrite
// whose destination omits the capture group leaves it empty — which silently
// collapsed every request down to a bare https://api.frame.io/v4/ and made the
// upstream answer "no route found for GET /v4" no matter what was requested.
// Fall back to the raw URL so the proxy works under either routing behaviour.
export function resolveSubPath(req) {
  const raw = req.query?.path;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const fromQuery = segments.join("/").replace(/^\/+/, "");
  if (fromQuery) return fromQuery;

  const pathname = String(req.url || "").split("?")[0];
  const match = pathname.match(/^\/api\/frameio\/(.+)$/);
  if (!match) return "";

  const candidate = decodeURIComponent(match[1]).replace(/^\/+/, "");
  // Guard against an un-substituted rewrite destination literal ("[...path]").
  return candidate.startsWith("[") ? "" : candidate;
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
      received: { url: req.url, queryPath: req.query?.path ?? null },
    });
  }

  const { path: _p, ...forwardedParams } = req.query || {};
  const qs = new URLSearchParams(forwardedParams).toString();

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
