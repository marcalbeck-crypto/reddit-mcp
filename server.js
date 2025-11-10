// server.js — Reddit MCP (direkt auf Render-Port) + /healthz + optional x-api-key

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as StreamableMod from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as SseMod from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";

// ---- Transport ermitteln ----
function pickHttpTransport() {
  const cands = [
    ["streamable", StreamableMod, ["StreamableHttpServerTransport","HttpServerTransport","default"]],
    ["sse",        SseMod,        ["SseServerTransport","HttpServerTransport","default"]],
  ];
  for (const [kind, mod, names] of cands) {
    if (!mod) continue;
    for (const n of names) {
      const v = mod?.[n];
      if (typeof v === "function") return { ctor: v, kind };
    }
    for (const k of Object.keys(mod)) if (typeof mod[k] === "function") return { ctor: mod[k], kind };
  }
  throw new Error("Kein HTTP/SSE-Transport gefunden.");
}
const { ctor: HttpTransport, kind: transportKind } = pickHttpTransport();

// ---- Env ----
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET    = process.env.REDDIT_SECRET;
const REDDIT_USER      = process.env.REDDIT_USER;
const REDDIT_PASS      = process.env.REDDIT_PASS;
const API_KEY          = process.env.API_KEY || ""; // optional
for (const [k,v] of Object.entries({REDDIT_CLIENT_ID,REDDIT_SECRET,REDDIT_USER,REDDIT_PASS})) {
  if (!v) { console.error(`❌ .env fehlt: ${k}`); process.exit(1); }
}

// ---- Reddit OAuth + Helper ----
async function getRedditToken() {
  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type:"password", username:REDDIT_USER, password:REDDIT_PASS });
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method:"POST",
    headers:{
      "Authorization":`Basic ${auth}`,
      "User-Agent":`zive-reddit-mcp/1.0 by ${REDDIT_USER}`,
      "Content-Type":"application/x-www-form-urlencoded",
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
    headers:{ "Authorization":`Bearer ${token}`, "User-Agent":"zive-reddit-mcp/1.0" }
  });
  if (!res.ok) throw new Error(`Reddit API Fehler: ${res.status} ${await res.text().catch(()=> "")}`);
  return res.json();
}

// ---- MCP-Server + Tools ----
const server = new Server(
  { name:"zive-reddit-mcp", version:"0.1.0" },
  {
    tools: {
      "reddit.topPosts": {
        description: "Hole Top-Posts aus einem Subreddit.",
        inputSchema: {
          type:"object",
          properties:{
            subreddit:{ type:"string", description:"ohne r/, z.B. 'technology'"},
            time:{ type:"string", enum:["hour","day","week","month","year","all"], default:"day"},
            limit:{ type:"number", default:5 },
          },
          required:["subreddit"]
        },
        execute: async ({ subreddit, time="day", limit=5 }) => {
          const safe = Math.min(Math.max(Number(limit)||5,1),100);
          const data = await redditGet(`/r/${subreddit}/top.json?t=${time}&limit=${safe}`);
          const items = (data?.data?.children||[]).map(c=>({
            title:c?.data?.title,
            url:c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
            score:c?.data?.score,
            author:c?.data?.author,
            comments:c?.data?.num_comments,
          }));
          return { content:[{ type:"text", text: JSON.stringify(items,null,2) }] };
        }
      },
      "reddit.search": {
        description: "Suche Posts auf Reddit (optional Subreddit begrenzen).",
        inputSchema: {
          type:"object",
          properties:{
            query:{ type:"string" },
            subreddit:{ type:"string" },
            limit:{ type:"number", default:5 },
          },
          required:["query"]
        },
        execute: async ({ query, subreddit, limit=5 }) => {
          const q = encodeURIComponent(query);
          const safe = Math.min(Math.max(Number(limit)||5,1),100);
          const path = subreddit
            ? `/r/${subreddit}/search.json?q=${q}&restrict_sr=on&limit=${safe}&sort=relevance`
            : `/search.json?q=${q}&limit=${safe}&sort=relevance`;
          const data = await redditGet(path);
          const items = (data?.data?.children||[]).map(c=>({
            title:c?.data?.title,
            url:c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
            score:c?.data?.score,
            subreddit:c?.data?.subreddit,
          }));
          return { content:[{ type:"text", text: JSON.stringify(items,null,2) }] };
        }
      }
    }
  }
);

// ---------- Öffentliches Gateway (Render) ----------
const publicPort = Number(process.env.PORT || 10000);

// 3s warten, damit der Upstream sicher ready ist
await new Promise(r => setTimeout(r, 3000));

const gateway = http.createServer((req, res) => {
  // Health-Check
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Info-Seite für Root
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Reddit MCP up. Use /mcp.");
    return;
  }

  // Nur /mcp (und Unterpfade) sind erlaubt
  if (!req.url.startsWith("/mcp")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Optionaler API-Key
  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
  }

  // *** HART auf IPv4 und richtiger Pfad /mcp proxen ***
  const opts = {
    hostname: "127.0.0.1",           // KEIN ::1, KEIN localhost
    port: upstreamPort,              // 8787
    method: req.method,
    path: req.url,                   // /mcp...
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
console.log(`   Proxy:   /mcp*  -> 127.0.0.1:${upstreamPort}/mcp`);
