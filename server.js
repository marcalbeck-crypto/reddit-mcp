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

// ---- EIN gemeinsamer öffentlicher HTTP-Server (Render-Port) ----
const publicPort = Number(process.env.PORT || 10000);
const app = http.createServer((req, res) => {
  // Health-Check für Render
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type":"text/plain" });
    res.end("ok");
    return;
  }
  // Optionaler API-Key
  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      res.writeHead(401, { "content-type":"text/plain" });
      res.end("Unauthorized");
      return;
    }
  }
  // Alles Weitere überlässt dieser Server dem MCP-Transport (SSE unter /mcp)
  // Der Transport hängt sich mit path:'/mcp' an DIESEN Server.
  res.writeHead(404, { "content-type":"text/plain" });
  res.end("Not found");
});

// MCP-Transport direkt an den öffentlichen Server hängen
// Viele SDK-Builds akzeptieren { server, path }; falls nicht, nutzen wir den Port direkt.
let transport;
try {
  transport = new HttpTransport({ server: app, path: "/mcp" });
} catch {
  // Fallback: direkt auf dem Port lauschen (dann bitte in Render Health-Check /healthz lassen)
  transport = new HttpTransport({ port: publicPort, path: "/mcp" });
}

// Server starten (falls wir ihn selbst verwalten)
await new Promise(resolve => app.listen(publicPort, resolve)).catch(()=>{ /* wenn Transport schon Port bindet */ });

// MCP verbinden
await server.connect(transport);
// einige SDKs brauchen ein explizites start()
if (typeof transport.start === "function") {
  try { await transport.start(); } catch { /* already started */ }
}

console.log(`✅ MCP läuft (Transport: ${transportKind}) auf :${publicPort} unter Pfad /mcp`);
console.log(`   Health:  GET /healthz -> 200 OK`);
