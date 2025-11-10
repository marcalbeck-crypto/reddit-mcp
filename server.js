// server.js — Reddit MCP + Render-Gateway mit /healthz und optional x-api-key

// ---------- MCP SDK ----------
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as StreamableMod from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as SseMod from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";

// Transport dynamisch finden (verschiedene SDK-Exporte möglich)
function pickHttpTransport() {
  const candidates = [
    ["streamableHttp", StreamableMod, [
      "StreamableHttpServerTransport",
      "StreamableHttpTransport",
      "HttpServerTransport",
      "default",
    ]],
    ["sse", SseMod, [
      "SseServerTransport",
      "SSEServerTransport",
      "HttpServerTransport",
      "SseTransport",
      "default",
    ]],
  ];
  for (const [kind, mod, names] of candidates) {
    if (!mod) continue;
    for (const n of names) {
      const ctor = mod?.[n];
      if (typeof ctor === "function") return { ctor, kind };
    }
    for (const k of Object.keys(mod)) {
      const v = mod[k];
      if (typeof v === "function") return { ctor: v, kind };
    }
  }
  throw new Error("Kein HTTP/SSE-Transport im SDK gefunden.");
}

const { ctor: HttpLikeTransport, kind: transportKind } = pickHttpTransport();

// ---------- Reddit OAuth ----------
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET    = process.env.REDDIT_SECRET;
const REDDIT_USER      = process.env.REDDIT_USER;
const REDDIT_PASS      = process.env.REDDIT_PASS;
const API_KEY          = process.env.API_KEY || ""; // optionaler Schutz für Gateway

for (const [k, v] of Object.entries({
  REDDIT_CLIENT_ID, REDDIT_SECRET, REDDIT_USER, REDDIT_PASS
})) {
  if (!v) { console.error(`❌ .env fehlt: ${k}`); process.exit(1); }
}

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
      "Authorization": `Basic ${auth}`,
      "User-Agent": `zive-reddit-mcp/1.0 by ${REDDIT_USER}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body
  });
  if (!res.ok) throw new Error(`Reddit Token fehlgeschlagen: ${res.status} ${await res.text().catch(()=> "")}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("Kein access_token in Reddit-Antwort.");
  return json.access_token;
}

async function redditGet(path) {
  const token = await getRedditToken();
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent": "zive-reddit-mcp/1.0"
    }
  });
  if (!res.ok) throw new Error(`Reddit API Fehler: ${res.status} ${await res.text().catch(()=> "")}`);
  return res.json();
}

// ---------- MCP-Server + Tools ----------
const server = new Server(
  { name: "zive-reddit-mcp", version: "0.1.0" },
  {
    tools: {
      "reddit.topPosts": {
        description: "Hole Top-Posts aus einem Subreddit.",
        inputSchema: {
          type: "object",
          properties: {
            subreddit: { type: "string", description: "ohne r/, z. B. 'technology'" },
            time: { type: "string", enum: ["hour","day","week","month","year","all"], default: "day" },
            limit: { type: "number", default: 5 }
          },
          required: ["subreddit"]
        },
        execute: async ({ subreddit, time="day", limit=5 }) => {
          const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 100);
          const data = await redditGet(`/r/${subreddit}/top.json?t=${time}&limit=${safeLimit}`);
          const items = (data?.data?.children || []).map(c => ({
            title: c?.data?.title,
            url: c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
            score: c?.data?.score,
            author: c?.data?.author,
            comments: c?.data?.num_comments,
          }));
          return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        }
      },
      "reddit.search": {
        description: "Suche Posts auf Reddit (optional Subreddit begrenzen).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            subreddit: { type: "string" },
            limit: { type: "number", default: 5 }
          },
          required: ["query"]
        },
        execute: async ({ query, subreddit, limit=5 }) => {
          const q = encodeURIComponent(query);
          const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 100);
          const path = subreddit
            ? `/r/${subreddit}/search.json?q=${q}&restrict_sr=on&limit=${safeLimit}&sort=relevance`
            : `/search.json?q=${q}&limit=${safeLimit}&sort=relevance`;
          const data = await redditGet(path);
          const items = (data?.data?.children || []).map(c => ({
            title: c?.data?.title,
            url: c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
            score: c?.data?.score,
            subreddit: c?.data?.subreddit,
          }));
          return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        }
      }
    }
  }
);

// ---------- Upstream MCP starten ----------
const upstreamPort = 8787; // interner Port
const upstream = new HttpLikeTransport({ port: upstreamPort });
await server.connect(upstream);
// einige SDKs starten intern selbst; falls vorhanden, start() nur versuchen:
if (typeof upstream.start === "function") {
  try { await upstream.start(); } catch { /* already started */ }
}
console.log(`✅ MCP Upstream läuft auf :${upstreamPort} (Transport: ${transportKind})`);

// ---------- Öffentliches Gateway (Render) ----------
const publicPort = Number(process.env.PORT || 10000);

// Mini-Wartezeit, damit der Upstream sicher lauscht
await new Promise(r => setTimeout(r, 800));

const gateway = http.createServer((req, res) => {
  // Health-Check
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Root: kleine Info statt Proxy (verhindert Bad Gateway im Browser)
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Reddit MCP up. Use /mcp.");
    return;
  }

  // Nur /mcp (und Unterpfade) werden an den Upstream geleitet
  if (!req.url.startsWith("/mcp")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Optionaler Token-Schutz
  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
  }

  // Proxy zu Upstream (SSE-fähig)
  const opts = {
    hostname: "localhost",            // robuster als 127.0.0.1 bei manchen Bindings
    port: upstreamPort,
    method: req.method,
    path: req.url,                    // erwartet /mcp…
    headers: req.headers,
  };

  const p = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });

  p.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad gateway: " + e.message);
  });

  req.pipe(p);
});

await new Promise((resolve) => gateway.listen(publicPort, resolve));
console.log(`✅ Gateway läuft auf :${publicPort}`);
console.log(`   Health:  GET /healthz -> 200 OK`);
console.log(`   Info:    GET /        -> 'Reddit MCP up. Use /mcp.'`);
console.log(`   Proxy:   /mcp*  -> Upstream :${upstreamPort}`);
