// server.js – MCP Reddit (erzwingt HTTP/SSE; kein STDIO-Fallback)

// --- MCP-SDK ---------------------------------------------------------------
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Die beiden HTTP-Varianten (in deiner SDK gibt’s mind. eine davon):
import * as StreamableMod from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as SseMod from "@modelcontextprotocol/sdk/server/sse.js";

// Hilfsfunktion: wähle Export anhand bekannter Kandidaten oder erster brauchbarer Klasse
function pickHttpTransport() {
  const prefer = [
    // Streamable HTTP (neuere Builds)
    ["streamableHttp", StreamableMod, [
      "StreamableHttpServerTransport",
      "StreamableHttpTransport",
      "HttpServerTransport",
      "default"
    ]],
    // SSE (oft vorhanden – deine SDK hat sse.js)
    ["sse", SseMod, [
      "SseServerTransport",
      "SSEServerTransport",
      "HttpServerTransport",
      "SseTransport",
      "default"
    ]],
  ];

  for (const [kind, mod, names] of prefer) {
    if (!mod || Object.keys(mod).length === 0) continue;

    // 1) Versuche Kandidatennamen
    for (const n of names) {
      const ctor = mod?.[n];
      if (typeof ctor === "function") return { ctor, kind };
    }
    // 2) Fallback: nimm den ersten Funktions-/Klasse-Export
    for (const k of Object.keys(mod)) {
      const v = mod[k];
      if (typeof v === "function") return { ctor: v, kind };
    }
  }

  console.error("❌ Kein HTTP/SSE-Transport gefunden.");
  console.error("   Verfügbare Exporte streamableHttp.js:", Object.keys(StreamableMod));
  console.error("   Verfügbare Exporte sse.js:", Object.keys(SseMod));
  process.exit(1);
}

const { ctor: HttpLikeTransport, kind: transportKind } = pickHttpTransport();

// --- Reddit OAuth (Script App) --------------------------------------------
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET    = process.env.REDDIT_SECRET;
const REDDIT_USER      = process.env.REDDIT_USER;
const REDDIT_PASS      = process.env.REDDIT_PASS;

function assertEnv(name, value) {
  if (!value) {
    console.error(`❌ Umgebungsvariable ${name} fehlt. Bitte in .env setzen.`);
    process.exit(1);
  }
}
assertEnv("REDDIT_CLIENT_ID", REDDIT_CLIENT_ID);
assertEnv("REDDIT_SECRET", REDDIT_SECRET);
assertEnv("REDDIT_USER", REDDIT_USER);
assertEnv("REDDIT_PASS", REDDIT_PASS);

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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit Token fehlgeschlagen: ${res.status} ${text}`);
  }
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit API Fehler: ${res.status} ${text}`);
  }
  return res.json();
}

// --- MCP-Server + Tools ----------------------------------------------------
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

// --- HTTP/SSE Transport starten -------------------------------------------
const port = Number(process.env.PORT || 8787);
const transport = new HttpLikeTransport({ port }); // KEIN path und KEIN start() mehr

// Viele SDKs starten den Transport bereits in connect()
await server.connect(transport);

console.log(`✅ MCP Server läuft auf Port ${port} (Transport: ${transportKind})`);
console.log(`ℹ️  Hinweis: Der MCP-Endpunkt antwortet nur auf MCP/SSE-Anfragen, ein normaler Browser-GET kann 404/leer sein.`);

// Prozess offen halten
await new Promise(() => {}); // läuft weiter