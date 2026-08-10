// api/expand.js
//
// Expands an f.io shortlink by following its redirect, so the client can read
// the asset ID out of the full URL.
//
// Both the URL asked for and the URL it lands on are checked against a host
// allowlist. Without that, this is a server-side request forgery: anyone could
// hand it any address and have Vercel fetch it — including hosts only reachable
// from inside the platform — and read back where it ended up.

const ALLOWED_HOSTS = new Set(["f.io", "frame.io", "www.frame.io", "app.frame.io", "next.frame.io"]);

export function isAllowedTarget(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.has(host) || host.endsWith(".frame.io");
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  if (!isAllowedTarget(url)) {
    return res.status(400).json({ error: "Only Frame.io links can be expanded." });
  }

  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });

    // A redirect can point anywhere, so the destination is checked too.
    if (!isAllowedTarget(response.url)) {
      return res.status(502).json({ error: "That link redirects off Frame.io." });
    }

    res.status(200).json({ expandedUrl: response.url });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}
