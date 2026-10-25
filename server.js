const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

// ── OAuth Relay Store (Zero-State) ──
let currentGlobalLogin = null; 
const AUTH_TTL_MS = 20 * 60 * 1000;
setInterval(() => {
  if (currentGlobalLogin && (Date.now() - currentGlobalLogin.ts > AUTH_TTL_MS)) {
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
      } else { st.textContent = 'Server rejected tokens.'; }
    }).catch(function(e) { st.textContent = 'Network Error: ' + e; });
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
        currentGlobalLogin = { at: String(data.access_token), rt: String(data.refresh_token || ""), ts: Date.now() };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400).end(); }
    });
    return;
  }

  if (path === "/auth/poll") {
    if (currentGlobalLogin) {
      const token = currentGlobalLogin;
      currentGlobalLogin = null; 
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
  res.end("Flame Strike Lobby Server Live");
});

const wss = new WebSocketServer({ server });
const rooms = {}; // { roomCode: { players: [], mode: "" } }
const allClients = new Set();

function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += c[Math.floor(Math.random() * c.length)];
  return rooms[code] ? genCode() : code;
}

function broadcast(code, data) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.chatProfileId = "";
  ws.chatName = "";
  ws.currentRoom = null;
  allClients.add(ws);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      const { type } = data;

      if (type === "auth") {
        ws.chatProfileId = String(data.profileId);
        ws.chatName = String(data.name || "Player");
        send(ws, { type: "auth_ok", profileId: ws.chatProfileId });
      } 
      
      else if (type === "join_lobby") {
        // 1. Find an existing room with space (max 4 players)
        let roomCode = null;
        for (const [code, room] of Object.entries(rooms)) {
          if (room.mode === data.mode && room.players.length < 4) {
            roomCode = code;
            break;
          }
        }
        
        // 2. If no room found, create new one
        if (!roomCode) {
          roomCode = genCode();
          rooms[roomCode] = { players: [], mode: data.mode };
        }

        ws.currentRoom = roomCode;
        const playerObj = { ws, id: rooms[roomCode].players.length + 1, name: ws.chatName, profileId: ws.chatProfileId };
        rooms[roomCode].players.push(playerObj);

        // Notify the player they joined
        send(ws, { type: "lobby_joined", roomCode: roomCode, mode: data.mode });
        
        // Notify everyone in the lobby that a new player joined
        broadcast(roomCode, { type: "player_joined", player: playerObj, total: rooms[roomCode].players.length });
      }

      else if (type === "start_game") {
        const roomCode = ws.currentRoom;
        if (!roomCode || !rooms[roomCode]) return;
        
        // Only the first player (Host) can start the game
        const room = rooms[roomCode];
        if (room.players[0].ws === ws) {
          console.log(`Room ${roomCode} starting game...`);
          
          // Determine scene based on mode
          const scene = room.mode === "MUMMY_VS_HUMAN" ? "res://mumuy_vs_human.tscn" : "res://main_scene.tscn";
          
          broadcast(roomCode, { type: "game_start", scene: scene });
          
          // Delete room after starting
          delete rooms[roomCode];
          room.players.forEach(p => { p.ws.currentRoom = null; });
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ws.currentRoom) {
      const room = rooms[ws.currentRoom];
      if (room) {
        room.players = room.players.filter(p => p.ws !== ws);
        broadcast(ws.currentRoom, { type: "player_left", total: room.players.length });
        if (room.players.length === 0) delete rooms[ws.currentRoom];
      }
    }
    allClients.delete(ws);
  });
});

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

server.listen(PORT, () => {
  console.log(`Flame Strike Lobby Server Live on port ${PORT}`);
});
