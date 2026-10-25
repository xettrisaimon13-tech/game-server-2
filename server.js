const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

// ── OAuth relay store ──
// We now use a single object for the "Current Global Login" to bypass all state issues
let currentGlobalLogin = null; 

const AUTH_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  if (currentGlobalLogin && (Date.now() - currentGlobalLogin.ts > AUTH_TTL_MS)) {
    console.log("[AUTH] Global login expired.");
    currentGlobalLogin = null;
  }
}, 60000);

const AUTH_CALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FLAME STRIKE AUTH</title>
<style>body{background:#0b070c;color:#e7d8c4;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#ff7a1a;font-size:30px;letter-spacing:4px;margin:0 0 16px}p{color:#8a7a72;font-size:15px}#st{color:#c43b4a;margin-top:16px}button{background:#ff7a1a;border:none;color:white;padding:10px 20px;font-size:16px;cursor:pointer;margin-top:20px;border-radius:5px;display:none}</style></head>
<body><div class="c"><h1>&#10003; FLAME STRIKE</h1><p id="st">Completing login...</p>
<button id="btn" onclick="sendTokens()">Manual Send Tokens</button>
<script>
(function() {
  var st = document.getElementById('st');
  var btn = document.getElementById('btn');
  var hash = location.hash.substring(1);
  if (!hash) { st.textContent = 'No auth data found.'; btn.style.display='inline-block'; return; }
  var p = new URLSearchParams(hash);
  var at = p.get('access_token') || '';
  var rt = p.get('refresh_token') || '';
  if (!at) { st.textContent = 'No access token found.'; btn.style.display='inline-block'; return; }

  window.sendTokens = function() {
    st.textContent = 'Sending tokens...';
    fetch('/auth/receive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ access_token: at, refresh_token: rt })
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

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const qIdx = req.url.indexOf("?");
  const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);

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
        console.log(`[AUTH-RECEIVE] Storing Global Token...`);
        
        // Store as the ONLY active login
        currentGlobalLogin = { 
          at: String(data.access_token), 
          rt: String(data.refresh_token || ""), 
          ts: Date.now() 
        };

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
    console.log(`[AUTH-POLL] Checking for any available token...`);
    if (currentGlobalLogin) {
      console.log(`[AUTH-POLL-HIT] Found Global Token!`);
      const token = currentGlobalLogin;
      currentGlobalLogin = null; // Clear it so the next person doesn't get it
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: token.at, refresh_token: token.rt }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: true }));
    }
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Zero-State Server Live");
});

server.listen(PORT, () => {
  console.log(`Night Ward Zero-State Server Live on port ${PORT}`);
});
