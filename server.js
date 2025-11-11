// server.js
import { Server } from "@modelcontextprotocol/sdk/server";
import { StreamableHttpServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fetch from "node-fetch";
import http from "node:http";

// Reddit OAuth (Script App)
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET = process.env.REDDIT_SECRET;
const REDDIT_USER = process.env.REDDIT_USER;
const REDDIT_PASS = process.env.REDDIT_PASS;

// Holt ein kurzes OAuth-Token
async function getRedditToken() {
  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: REDDIT_USER,
    password: REDDIT_PASS,
  });

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "User-Agent": "RedditMCP/1.0 by Marc",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await res.json();
  return data.access_token;
}

// Holt Beispiel-Daten von Reddit
async function fetchRedditPosts(subreddit = "javascript") {
  const token = await getRedditToken();
  const res = await fetch(`https://oauth.reddit.com/r/${subreddit}/hot?limit=5`, {
    headers: { Authorization: `bearer ${token}`, "User-Agent": "RedditMCP/1.0 by Marc" },
  });
  const data = await res.json();
  return data.data.children.map((p) => p.data.title);
}

// MCP-Server
const server = new Server({ name: "reddit-mcp", version: "1.0.0" });

server.tool("reddit-hot", "Fetch top posts from a subreddit", async (ctx) => {
  const subreddit = ctx?.params?.subreddit || "javascript";
  const posts = await fetchRedditPosts(subreddit);
  return { posts };
});

// 🚀 Ports definieren (wichtig!)
const upstreamPort = 8787; // MCP läuft intern hier
const publicPort = Number(process.env.PORT || 10000); // Render hört hier

// MCP-Upstream starten
const transport = new StreamableHttpServerTransport({ port: upstreamPort });
await server.connect(transport);
console.log(`✅ MCP Upstream läuft auf :${upstreamPort} (Transport: streamableHttp)`);

// 🧩 Mini-Gateway für Render
const gateway = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Nur Weiterleitung für / und /mcp
  if (req.url === "/" || req.url.startsWith("/mcp")) {
    const targetUrl = `http://127.0.0.1:${upstreamPort}${req.url}`;
    try {
      const proxyRes = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : req,
      });
      res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers.entries()));
      proxyRes.body.pipe(res);
    } catch (err) {
      console.error("Proxy error:", err);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad gateway");
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

gateway.listen(publicPort, () => {
  console.log(`✅ Gateway läuft auf :${publicPort}`);
  console.log(`   Health:  GET /healthz -> 200 OK`);
  console.log(`   Proxy:   /  und /mcp*  -> Upstream :${upstreamPort}`);
  console.log("🚀 Bereit für Render Deployment!");
});

// Verhindert, dass Node beendet wird
await new Promise(() => {});
