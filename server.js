// server.js — Reddit MCP (ein Server, kein Proxy) + /healthz + optional x-api-key
// Stabil auf Render / Node 22

// ---------- Imports ----------
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as StreamableMod from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as SseMod from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";

// ---------- Transport ermitteln (robust, ohne fragile Named-Imports) ----------
function pickHttpTransport() {
  const candidates = [
    ["streamableHttp", StreamableMod, [
      "StreamableHttpServerTransport","StreamableHttpTransport",
      "HttpServerTransport","default"
    ]],
    ["sse", SseMod, [
      "SseServerTransport","SSEServerTransport",
      "HttpServerTransport","SseTransport","default"
    ]],
  ];
  for (const [kind, mod, names] of candidates) {
    if (!mod) continue;
    for (const n of names) {
      const v = mod?.[n];
      if (typeof v === "function") return { ctor: v, kind };
    }
    for (const k of Object.keys(mod)) {
      const v = mod[k];
      if (typeof v === "function") return { ctor: v, kind };
    }
  }
  throw new Error("Kein HTTP/SSE-Transport im MCP-SDK gefunden.");
}
const { ctor: HttpTransport, kind: transportKind } = pickHttpTransport();

// ---------- Env ----------
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET    = process.env.REDDIT_SECRET;
const REDDIT_USER      = process.env.REDDIT_USER;
const REDDIT_PASS      = process.env.REDDIT_PASS;
const API_KEY          = process.env.API_KEY || ""; // optionaler Gateway-Header x-api-key

for (const [k,v] of Object.entries({REDDIT_CLIENT_ID,REDDIT_SECRET,REDDIT_USER,REDDIT_PASS})) {
  if (!v) { console.error(`❌ .env fehlt: ${k}`); process.exit(1); }
}

// ---------- Reddit OAuth + Helper (Node 22: global fetch vorhanden) ----------
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

// ---------- MCP-Server + Tools ----------
const mcp = new Server(
  { name:"zive-reddit-mcp", version:"0.1.0" },
  {
    tools: {
      "reddit.topPosts": {
        description: "Hole Top-Posts aus einem Subreddit.",
        inputSchema: {
          type:"object",
          properties:{
            subreddit:{ type:"string", description:"ohne r/, z. B. 'technology'"},
            time:{ type:"string", enum:["hour","day","week","month","year","all"], default:"day"},
            limit:{ type:"number", default:5 }
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
            limit:{ type:"number", default:5 }
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

// ---------- EIN gemeinsamer HTTP-Server (Render-Port) ----------
const publicPort = Number(process.env.PORT || 10000);
const app = http.createServer();

// Nur Health-Check + Root-Info selbst beantworten; alles andere lässt
// der MCP-Transport auf dem gleichen Server/Port (Pfad /mcp) beantworten.
app.on("request", (req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type":"text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type":"text/plain" });
    res.end("Reddit MCP up. Use /mcp.");
    return;
  }
  // Optionaler API-Key – nur für MCP-Pfad relevant
  if (API_KEY && req.url?.startsWith("/mcp")) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      res.writeHead(401, { "content-type":"text/plain" });
      res.end("Unauthorized");
      return;
    }
  }
  // sonst: nichts tun -> der MCP-Transport antwortet (auf /mcp)
});

// MCP-Transport direkt an DIESEN Server hängen (Pfad /mcp)
const transport = new HttpTransport({ server: app, path: "/mcp" });
await mcp.connect(transport);
if (typeof transport.start === "function") {
  try { await transport.start(); } catch {/* already started */}
}

// Server starten
await new Promise(resolve => app.listen(publicPort, resolve));
console.log(`✅ MCP läuft auf Port :${publicPort} (Transport: ${transportKind}) unter Pfad /mcp`);
console.log(`   Health:  GET /healthz -> 200 OK`);
console.log(`   Info:    GET /        -> 'Reddit MCP up. Use /mcp.'`);
