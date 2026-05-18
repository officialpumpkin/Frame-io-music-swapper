// api/frameio/[...path].js
//
// Vercel catch-all serverless function.
// Proxies /api/frameio/* → https://api.frame.io/v4/*
// Adds x-frameio-legacy-token-auth: true so developer tokens work with V4.

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

  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : [req.query.path].filter(Boolean);

  const { path: _p, ...forwardedParams } = req.query;
  const qs = new URLSearchParams(forwardedParams).toString();

  // ── V4 base URL ───────────────────────────────────────────────────────────
  const frameioURL = `https://api.frame.io/v4/${segments.join("/")}${qs ? `?${qs}` : ""}`;

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

    const data = await upstream.json();
    return res.status(upstream.status).json(data);

  } catch (err) {
    return res.status(502).json({
      error:   "Upstream error",
      message: err.message,
    });
  }
}