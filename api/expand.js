// api/expand.js
export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const { url } = req.query;
    
    if (!url) return res.status(400).json({ error: "No URL provided" });
  
    try {
      // Fetch the shortlink. The server will automatically follow the redirect.
      const response = await fetch(url, { method: "HEAD", redirect: "follow" });
      
      // Return the final expanded URL
      res.status(200).json({ expandedUrl: response.url });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }