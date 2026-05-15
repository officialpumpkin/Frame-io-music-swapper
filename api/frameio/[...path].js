// api/frameio/[...path].js
//
// Vercel catch-all serverless function.
// Proxies any request from /api/frameio/* → https://api.frame.io/v2/*
// The Frame.io token lives in Vercel's environment variables, never the browser.

export default async function handler(req, res) {

  // ── CORS headers ─────────────────────────────────────────────────────────
  // Allow the Music Layer component to call this from any origin.
  // In production you'd lock this down to your specific domain:
  //   res.setHeader("Access-Control-Allow-Origin", "https://your-domain.com");
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Preflight request — browser sends this before the real request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── Token check ───────────────────────────────────────────────────────────
  const TOKEN = process.env.FRAMEIO_TOKEN;

  if (!TOKEN) {
    return res.status(500).json({
      error:   "Configuration error",
      message: "FRAMEIO_TOKEN environment variable is not set. " +
               "Add it in your Vercel project → Settings → Environment Variables.",
    });
  }

  // ── Build Frame.io URL ────────────────────────────────────────────────────
  // req.query.path is the catch-all — an array of path segments.
  // e.g. /api/frameio/assets/abc-123/comments → ["assets", "abc-123", "comments"]
  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : [req.query.path].filter(Boolean);

  // Remove "path" from query params, pass everything else through to Frame.io
  // e.g. /api/frameio/assets/abc/children?page=1&page_size=40
  const { path: _p, ...forwardedParams } = req.query;
  const qs = new URLSearchParams(forwardedParams).toString();

  const frameioURL = `https://api.frame.io/v2/${segments.join("/")}${qs ? `?${qs}` : ""}`;

  // ── Proxy the request ─────────────────────────────────────────────────────
  try {
    const upstream = await fetch(frameioURL, {
      method: req.method,
      headers: {
        Authorization:  `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
      // Only attach a body for methods that expect one
      body: ["POST", "PUT", "PATCH"].includes(req.method)
        ? JSON.stringify(req.body)
        : undefined,
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);

  } catch (err) {
    return res.status(502).json({
      error:   "Upstream error",
      message: err.message,
    });
  }
}
