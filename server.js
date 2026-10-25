const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

// ── OAuth relay store ──
const pendingAuth = new Map();
const AUTH_TTL_MS = 30 * 60 * 1000; // 30 mins
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
  { id: "ASIA", name: "Server 1 (ASIA)" },
  { id: "ASIA 2", name: "Server 2 (ASIA 2)" },
  { id: "EUROPE", name: "Server 3 (EUROPE)" },
  { id: "AFRICA", name: "Server 4 (AFRICA)" },
  { id: "OCEANIA", name: "Server 5 (OCEANIA)" },
  { id: "NORTH AMERICA", name: "Server 6 (NORTH AMERICA)" },
  { id: "SOUTH AMERICA", name: "Server 7 (SOUTH AMERICA)" },
  { id: "MIDDLE EAST", name: "Server 8 (MIDDLE EAST)" },
];
const BACKEND_URLS = { 
  "ASIA": "https://dark-ward-sever.onrender.com", 
  "ASIA 2": "https://darkward-asia2.onrender.com", 
  "EUROPE": "https://darkward-europe.onrender.com", 
  "AFRICA": "https://darkwrad-afcria.onrender.com", 
  "OCEANIA": "https://ocenina-darkward.onrender.com", 
  "NORTH AMERICA": "https://north-amecria-ward.onrender.com", 
  "SOUTH AMERICA": "https://south-america-ward.onrender.com", 
  "MIDDLE EAST": "https://middle-east-ward.onrender.com" 
};

let SELF_ID = (process.env.SERVER_ID || "ASIA").trim();
let PEERS = Object.keys(BACKEND_URLS).filter(id => id !== SELF_ID).map(id => ({ id, url: BACKEND_URLS[id] }));

function httpPostJson(url, path, bodyObj) {
  return new Promise((resolve) => {
    try {
      const target = new URL(path, url);
      const payload = JSON.stringify(bodyObj || {});
      const mod = target.protocol === "http:" ? require("http") : require("https");
      const req = mod.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + (target.search || ""),
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 2000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.write(payload);
      req.end();
    } catch { resolve(null); }
  });
}

const server = http.createServer((req, res) => {
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
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const state = String(data.state || "unknown");
        const at = String(data.access_token || "none");
        const rt = String(data.refresh_token || "");
        
        console.log(`[AUTH-SYNC] Token received for state: ${state}. Syncing to all servers...`);
        
        // Store locally
        pendingAuth.set(state, { at, rt, ts: Date.now() });
        
        // SYNC: Tell every other server about this token
        for (const peer of PEERS) {
          httpPostJson(peer.url, "/auth/sync", { state, at, rt });
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

  // Internal endpoint for servers to talk to each other
  if (path === "/auth/sync" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        pendingAuth.set(data.state, { at: data.at, rt: data.rt, ts: Date.now() });
        console.log(`[AUTH-SYNC-RECV] Synced state: ${data.state}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  if (path === "/auth/poll") {
    const state = gParams.get("state") || "";
    console.log(`[AUTH-POLL] Checking state: ${state}`);
    const entry = pendingAuth.get(state);
    if (entry) {
      console.log(`[AUTH-POLL-HIT] Success for ${state}`);
      pendingAuth.delete(state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: entry.at, refresh_token: entry.rt }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: true }));
    }
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", serverId: SELF_ID }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Sync Server Live");
});

server.listen(PORT, () => {
  console.log(`Night Ward Sync Server Live on port ${PORT} (${SELF_ID})`);
});
