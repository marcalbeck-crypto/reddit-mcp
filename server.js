// server.js - Reddit MCP Server für Render (Node 22+)
// Kompatibel mit @modelcontextprotocol/sdk ^1.14.0

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";

// ========== KONFIGURATION ==========
const PORT = Number(process.env.PORT || 10000);
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_SECRET = process.env.REDDIT_SECRET;
const REDDIT_USER = process.env.REDDIT_USER;
const REDDIT_PASS = process.env.REDDIT_PASS;
const API_KEY = process.env.API_KEY || "";

// Umgebungsvariablen validieren
const requiredEnvVars = {
  REDDIT_CLIENT_ID,
  REDDIT_SECRET,
  REDDIT_USER,
  REDDIT_PASS
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`❌ FEHLER: Umgebungsvariable ${key} fehlt!`);
    process.exit(1);
  }
}

console.log("✅ Alle Umgebungsvariablen geladen");

// ========== REDDIT API ==========
let cachedToken = null;
let tokenExpiry = 0;

async function getRedditToken() {
  // Token-Cache: nur neu holen wenn abgelaufen
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: REDDIT_USER,
    password: REDDIT_PASS
  });

  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "User-Agent": `zive-reddit-mcp/1.0 by ${REDDIT_USER}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Reddit Auth fehlgeschlagen: ${res.status} - ${text}`);
    }

    const json = await res.json();
    if (!json.access_token) {
      throw new Error("Kein access_token in Reddit-Antwort");
    }

    cachedToken = json.access_token;
    tokenExpiry = Date.now() + (50 * 60 * 1000);
    
    console.log("✅ Reddit Token erhalten");
    return cachedToken;
  } catch (error) {
    console.error("❌ Reddit Auth Fehler:", error.message);
    throw error;
  }
}

async function redditGet(path) {
  const token = await getRedditToken();
  
  try {
    const res = await fetch(`https://oauth.reddit.com${path}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": `zive-reddit-mcp/1.0 by ${REDDIT_USER}`
      }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Reddit API Fehler: ${res.status} - ${text}`);
    }

    return await res.json();
  } catch (error) {
    console.error(`❌ Reddit GET ${path} fehlgeschlagen:`, error.message);
    throw error;
  }
}

// ========== MCP SERVER SETUP ==========
const mcpServer = new Server(
  {
    name: "zive-reddit-mcp",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// ========== TOOL HANDLERS ==========

// Handler für Tool-Liste
mcpServer.setRequestHandler(
  { method: "tools/list" },
  async () => {
    return {
      tools: [
        {
          name: "reddit_top_posts",
          description: "Hole die Top-Posts aus einem Subreddit für Sentiment-Analyse und Social Buzz",
          inputSchema: {
            type: "object",
            properties: {
              subreddit: {
                type: "string",
                description: "Subreddit-Name ohne 'r/' (z.B. 'stocks', 'wallstreetbets', 'investing')"
              },
              time: {
                type: "string",
                enum: ["hour", "day", "week", "month", "year", "all"],
                default: "day",
                description: "Zeitraum für Top-Posts"
              },
              limit: {
                type: "number",
                default: 10,
                minimum: 1,
                maximum: 100,
                description: "Anzahl der Posts (1-100)"
              }
            },
            required: ["subreddit"]
          }
        },
        {
          name: "reddit_search",
          description: "Suche Posts auf Reddit (z.B. nach Ticker-Symbolen, Unternehmen). Perfekt für Aktien-Buzz.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Suchbegriff (z.B. Ticker wie 'AAPL', 'TSLA' oder Unternehmen)"
              },
              subreddit: {
                type: "string",
                description: "Optional: Suche auf ein Subreddit beschränken"
              },
              limit: {
                type: "number",
                default: 10,
                minimum: 1,
                maximum: 100,
                description: "Anzahl der Ergebnisse"
              },
              sort: {
                type: "string",
                enum: ["relevance", "hot", "top", "new"],
                default: "relevance",
                description: "Sortierung der Ergebnisse"
              }
            },
            required: ["query"]
          }
        }
      ]
    };
  }
);

// Handler für Tool-Ausführung
mcpServer.setRequestHandler(
  { method: "tools/call" },
  async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "reddit_top_posts") {
        const { subreddit, time = "day", limit = 10 } = args;
        const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
        
        console.log(`📊 Hole Top-Posts: r/${subreddit} (${time}, limit=${safeLimit})`);
        
        const data = await redditGet(`/r/${subreddit}/top.json?t=${time}&limit=${safeLimit}`);
        const posts = (data?.data?.children || []).map(c => ({
          title: c?.data?.title,
          url: c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
          score: c?.data?.score,
          upvote_ratio: c?.data?.upvote_ratio,
          author: c?.data?.author,
          num_comments: c?.data?.num_comments,
          created_utc: c?.data?.created_utc,
          selftext: c?.data?.selftext?.substring(0, 500)
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ subreddit, time, count: posts.length, posts }, null, 2)
            }
          ]
        };
      }

      if (name === "reddit_search") {
        const { query, subreddit, limit = 10, sort = "relevance" } = args;
        const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
        const q = encodeURIComponent(query);
        
        const path = subreddit
          ? `/r/${subreddit}/search.json?q=${q}&restrict_sr=on&limit=${safeLimit}&sort=${sort}`
          : `/search.json?q=${q}&limit=${safeLimit}&sort=${sort}`;
        
        console.log(`🔍 Suche: "${query}"${subreddit ? ` in r/${subreddit}` : ""}`);
        
        const data = await redditGet(path);
        const results = (data?.data?.children || []).map(c => ({
          title: c?.data?.title,
          url: c?.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : null,
          score: c?.data?.score,
          subreddit: c?.data?.subreddit,
          upvote_ratio: c?.data?.upvote_ratio,
          num_comments: c?.data?.num_comments,
          created_utc: c?.data?.created_utc,
          selftext: c?.data?.selftext?.substring(0, 300)
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query, count: results.length, results }, null, 2)
            }
          ]
        };
      }

      throw new Error(`Unbekanntes Tool: ${name}`);
    } catch (error) {
      console.error(`❌ Tool ${name} fehlgeschlagen:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Fehler: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// ========== HTTP SERVER ==========
const httpServer = http.createServer((req, res) => {
  // Health Check für Render
  if (req.url === "/healthz" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Root-Info
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      service: "ZIVE Reddit MCP Server",
      status: "running",
      version: "1.0.0",
      endpoints: {
        mcp: "/mcp",
        health: "/healthz"
      }
    }));
    return;
  }

  // API-Key Check (optional)
  if (API_KEY && req.url?.startsWith("/mcp")) {
    const providedKey = req.headers["x-api-key"];
    if (providedKey !== API_KEY) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized: Invalid API Key");
      return;
    }
  }

  // Nicht behandelte Routen
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

// ========== MCP TRANSPORT ==========
const transport = new SSEServerTransport("/mcp", httpServer);

// Server verbinden
await mcpServer.connect(transport);
console.log("✅ MCP Transport verbunden");

// ========== SERVER STARTEN ==========
httpServer.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 ZIVE REDDIT MCP SERVER GESTARTET");
  console.log("=".repeat(60));
  console.log(`📡 Port:         ${PORT}`);
  console.log(`🔗 MCP Endpoint: http://localhost:${PORT}/mcp`);
  console.log(`💚 Health Check: http://localhost:${PORT}/healthz`);
  console.log(`🔑 API Key:      ${API_KEY ? "aktiviert" : "nicht gesetzt"}`);
  console.log("=".repeat(60) + "\n");
});

// Graceful Shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM empfangen, Server wird heruntergefahren...");
  httpServer.close(() => {
    console.log("✅ Server beendet");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\n🛑 SIGINT empfangen, Server wird heruntergefahren...");
  httpServer.close(() => {
    console.log("✅ Server beendet");
    process.exit(0);
  });
});
