const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

// ── OAuth relay store ──
const pendingAuth = new Map();
const pollingQueue = []; // Track who is polling in order

const AUTH_TTL_MS = 20 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (now - v.ts > AUTH_TTL_MS) pendingAuth.delete(k);
}, 60000);

const AUTH_CALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FLAME STRIKE AUTH</title>
<style>body{background:#0b070c;color:#e7d8c4;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#ff7a1a;font-size:30px;letter-spacing:4px;margin:0 0 16px}p{color:#8a7a72;font-size:15px}#st{color:#c43b4a;margin-top:16px}button{background:#ff7a1a;border:none;color:white;padding:10px 20px;font-size:16px;cursor:pointer;margin-top:20px;border-radius:5px;display:none}</style></head>
<body><div class="c"><h1>&#10003; FLAME STRIKE</h1><p id="st">Completing login...</p>
<button id="btn" onclick="sendTokens()">Manual Send Tokens</button>
<script>
(function() {
  var st = document.getElementById('st');
  var btn = document.getElementById('btn');
  var state = new URLSearchParams(location.search).get('state') || 'fallback_state';
  var hash = location.hash.substring(1);
  if (!hash) { st.textContent = 'No auth data found in URL.'; btn.style.display='inline-block'; return; }
  var p = new URLSearchParams(hash);
  var at = p.get('access_token') || 'none';
  var rt = p.get('refresh_token') || '';

  window.sendTokens = function() {
    st.textContent = 'Sending tokens...';
    fetch('/auth/receive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({state: state, access_token: at, refresh_token: rt})
    }).then(function(res) {
      if(res.ok) {
        st.textContent = 'SUCCESS! Return to FLAME STRIKE.';
        try { window.location.href = 'nightward://login'; } catch (e) {}
      } else {
        st.textContent = 'Server rejected tokens.';
      }
    }).catch(function(e) {
      st.textContent = 'Network Error: ' + e;
    });
  };

  st.textContent = 'Logging you in...';
  sendTokens();
  setTimeout(function() {
    if (st.textContent === 'Logging you in...') {
      st.textContent = 'Automatic login is taking too long...';
      btn.style.display = 'inline-block';
    }
  }, 5000);
})();
</script></div></body></html>`;

const SERVERS = [
  { id: "ASIA", name: "Server 1 (ASIA)", countries: ["Nepal", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Myanmar", "Cambodia", "Vietnam"] },
  { id: "ASIA 2", name: "Server 2 (ASIA 2)", countries: ["China", "Japan", "Korea", "Taiwan", "Hong Kong", "Malaysia", "Philippines", "Indonesia", "Thailand"] },
  { id: "EUROPE", name: "Server 3 (EUROPE)", countries: ["UK", "Ireland", "Germany", "France", "Italy", "Spain", "Netherlands", "Poland", "Sweden", "Ukraine"] },
  { id: "AFRICA", name: "Server 4 (AFRICA)", countries: ["South Africa", "Nigeria", "Kenya", "Egypt", "Morocco", "Ghana", "Tanzania", "Uganda"] },
  { id: "OCEANIA", name: "Server 5 (OCEANIA)", countries: ["Australia", "New Zealand", "Fiji", "Papua New Guinea", "Samoa"] },
  { id: "NORTH AMERICA", name: "Server 6 (NORTH AMERICA)", countries: ["USA", "Canada", "Mexico", "Guatemala", "Costa Rica", "Panama"] },
  { id: "SOUTH AMERICA", name: "Server 7 (SOUTH AMERICA)", countries: ["Brazil", "Argentina", "Colombia", "Chile", "Peru", "Venezuela"] },
  { id: "MIDDLE EAST", name: "Server 8 (MIDDLE EAST)", countries: ["UAE", "Saudi Arabia", "Qatar", "Kuwait", "Oman", "Bahrain", "Jordan", "Lebanon", "Iran", "Iraq"] },
];
const DEFAULT_SERVER_ID = SERVERS[0].id;
const serverById = (id) => SERVERS.find((sv) => sv.id === id) || null;
const MAX_PLAYERS = Math.max(10, Number(process.env.MAX_PLAYERS) || 400);
const DISABLED_SERVERS = new Set((process.env.DISABLED_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean));

const BACKEND_HOSTS = { "dark-ward-sever.onrender.com": "ASIA", "darkward-asia2.onrender.com": "ASIA 2", "darkward-europe.onrender.com": "EUROPE", "darkwrad-afcria.onrender.com": "AFRICA", "ocenina-darkward.onrender.com": "OCEANIA", "north-amecria-ward.onrender.com": "NORTH AMERICA", "south-america-ward.onrender.com": "SOUTH AMERICA", "middle-east-ward.onrender.com": "MIDDLE EAST" };
const BACKEND_URLS = { "ASIA": "https://dark-ward-sever.onrender.com", "ASIA 2": "https://darkward-asia2.onrender.com", "EUROPE": "https://darkward-europe.onrender.com", "AFRICA": "https://darkwrad-afcria.onrender.com", "OCEANIA": "https://ocenina-darkward.onrender.com", "NORTH AMERICA": "https://north-amecria-ward.onrender.com", "SOUTH AMERICA": "https://south-america-ward.onrender.com", "MIDDLE EAST": "https://middle-east-ward.onrender.com" };
const POOL_OF = { "ASIA": "GLOBAL", "ASIA 2": "GLOBAL", "EUROPE": "GLOBAL", "AFRICA": "GLOBAL", "OCEANIA": "GLOBAL", "NORTH AMERICA": "GLOBAL", "SOUTH AMERICA": "GLOBAL", "MIDDLE EAST": "GLOBAL" };

let SELF_ID = (process.env.SERVER_ID || DEFAULT_SERVER_ID).trim();
let SELF_URL = (process.env.PUBLIC_URL || "").trim();
let PEERS = [];
let ENV_PEERS = [];

function rebuildPeers() {
  if (ENV_PEERS.length) { PEERS = ENV_PEERS; return; }
  const myPool = POOL_OF[SELF_ID] || SELF_ID;
  PEERS = Object.keys(BACKEND_URLS).filter((id) => (POOL_OF[id] || id) === myPool && id !== SELF_ID).map((id) => ({ id, url: BACKEND_URLS[id] })).filter((p) => p.url);
}

function detectSelf(host) {
  if (!host) return;
  const h = String(host).toLowerCase().split(":")[0].trim();
  const found = BACKEND_HOSTS[h];
  if (!found || SELF_ID === found) return;
  SELF_ID = found;
  if (!SELF_URL) SELF_URL = "https://" + h;
  rebuildPeers();
}

if (process.env.SERVER_ID) {
  SELF_ID = process.env.SERVER_ID.trim();
  if (process.env.PUBLIC_URL) SELF_URL = process.env.PUBLIC_URL.trim();
  ENV_PEERS = (process.env.PEERS || "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf("=");
      if (i < 0) return null;
      return { id: p.slice(0, i).trim(), url: p.slice(i + 1).trim() };
    }).filter(Boolean);
}
rebuildPeers();

function httpPostJson(url, path, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(path, url); } catch { return resolve(null); }
    const payload = JSON.stringify(bodyObj || {});
    const mod = target.protocol === "http:" ? require("http") : require("https");
    const req = mod.request({
      hostname: target.hostname, port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: target.pathname + (target.search || ""), method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: timeoutMs || 4000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

const presence = new Map();
const PRESENCE_TTL = 90000;

const server = http.createServer((req, res) => {
  detectSelf(req.headers && req.headers.host);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const qIdx = req.url.indexOf("?");
  const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const gParams = new URLSearchParams(qIdx === -1 ? "" : req.url.slice(qIdx + 1));

  if (path === "/auth/callback") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(AUTH_CALLBACK_HTML);
    return;
  }

  if (path === "/auth/receive" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const state = String(data.state || "unknown");
        const at = String(data.access_token || "none");
        
        console.log(`[AUTH-RECEIVE] Received Tokens. State: ${state}`);

        // UNIFIED FIX: Store tokens under the requested state AND the first person in the polling queue
        pendingAuth.set(state, { at, rt: String(data.refresh_token || ""), ts: Date.now() });
        
        if (pollingQueue.length > 0) {
          const firstPollingState = pollingQueue[0];
          pendingAuth.set(firstPollingState, { at, rt: String(data.refresh_token || ""), ts: Date.now() });
          console.log(`[AUTH-UNIFIED] Also linked to first polling state: ${firstPollingState}`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
    return;
  }

  if (path === "/auth/poll") {
    const state = gParams.get("state") || "";
    
    // Add to polling queue if not already there
    if (!pollingQueue.includes(state)) {
      pollingQueue.push(state);
      if (pollingQueue.length > 10) pollingQueue.shift(); // keep it small
    }

    console.log(`[AUTH-POLL] Polling state: ${state}`);
    const entry = pendingAuth.get(state);
    if (entry) {
      console.log(`[AUTH-POLL-HIT] Found tokens for ${state}`);
      pendingAuth.delete(state);
      // Clean up polling queue
      const idx = pollingQueue.indexOf(state);
      if (idx > -1) pollingQueue.splice(idx, 1);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: entry.at, refresh_token: entry.rt }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: true }));
    }
    return;
  }

  if (path === "/servers/ping" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const sid = String(data.serverId || "");
        const pid = String(data.playerId || "");
        if (serverById(sid) && pid) presence.set(pid, { serverId: sid, ts: Date.now() });
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === "/servers") {
    const list = SERVERS.map((sv) => {
      let connected = 0;
      for (const w of allClients) if (w.readyState === 1 && w.__serverId === sv.id) connected++;
      const disabled = DISABLED_SERVERS.has(sv.id);
      return { id: sv.id, name: sv.name, countries: sv.countries || [], online: !disabled, status: disabled ? "offline" : "online", players: connected, connected, queued: 0, browsing: 0, capacity: MAX_PLAYERS, load: 0, full: connected >= MAX_PLAYERS };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servers: list, poolLive: 0, poolCapacity: 0 }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", serverId: SELF_ID }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Server v4.5");
});

const wss = new WebSocketServer({ server });
const rooms = {};
const allClients = new Set();
let matchQueue = [];

wss.on("connection", (ws, req) => {
  detectSelf(req.headers.host);
  ws.__serverId = SELF_ID;
  ws.chatProfileId = "";
  ws.chatName = "";
  allClients.add(ws);
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "auth") {
        ws.chatProfileId = String(data.profileId);
        ws.chatName = String(data.name || "Player");
        send(ws, { type: "auth_ok", profileId: ws.chatProfileId });
      }
    } catch {}
  });
  ws.on("close", () => allClients.delete(ws));
});

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

server.listen(PORT, () => {
  console.log(`Night Ward Server Live on port ${PORT} (${SELF_ID})`);
});
