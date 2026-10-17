const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

// ── OAuth relay store (Google/Facebook login — no localhost) ──
// Game le state generate garcha → browser Supabase bata /auth/callback?state=X ma
// land garcha (tokens URL #fragment ma) → page le /auth/receive ma POST garcha →
// game le /auth/poll?state=X bata tokens liyincha (one-time, TTL 5 min).
const pendingAuth = new Map();
const AUTH_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (now - v.ts > AUTH_TTL_MS) pendingAuth.delete(k);
}, 60000);

const AUTH_CALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Night Ward</title>
<style>body{background:#0b070c;color:#e7d8c4;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#c43b4a;font-size:26px}p{color:#8a7a72;font-size:15px}#st{color:#c43b4a;margin-top:16px}</style></head>
<body><div class="c"><h1>&#10003; Night Ward</h1><p id="st">Completing login...</p>
<script>
(function() {
  var st = document.getElementById('st');
  var state = new URLSearchParams(location.search).get('state') || '';
  var hash = location.hash.substring(1);
  if (!hash) { st.textContent = 'No auth data. Please try again.'; return; }
  var p = new URLSearchParams(hash);
  var at = p.get('access_token') || '';
  var rt = p.get('refresh_token') || '';
  if (!at) { st.textContent = 'No access token. Please try again.'; return; }
  st.textContent = 'Logging you in...';
  fetch('/auth/receive', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({state: state, access_token: at, refresh_token: rt})
  }).then(function() {
    st.textContent = 'Login successful! Return to Night Ward.';
    try { window.location.href = 'nightward://login'; } catch (e) {}
  }).catch(function(e) {
    st.textContent = 'Error sending tokens: ' + e;
  });
})();
</script></div></body></html>`;

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
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 65536) body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const state = String(data.state || "");
        const at = String(data.access_token || "");
        if (/^[a-f0-9]{16,64}$/.test(state) && at.length > 20 && at.length < 16384) {
          pendingAuth.set(state, { at, rt: String(data.refresh_token || ""), ts: Date.now() });
          console.log("[AUTH] tokens stored for state", state.slice(0, 8));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid payload" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
    return;
  }

  if (path === "/auth/poll") {
    const state = gParams.get("state") || "";
    const entry = pendingAuth.get(state);
    if (entry) {
      pendingAuth.delete(state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: entry.at, refresh_token: entry.rt }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: true }));
    }
    return;
  }

  if (req.url === "/rooms") {
    const list = Object.entries(rooms)
      .filter(([, r]) => r.players.length < r.maxPlayers)
      .map(([code, room]) => ({
        code, name: room.roomName, players: room.players.length,
        maxPlayers: room.maxPlayers, region: room.region, mode: room.mode, host: room.hostName,
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms: list }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", rooms: Object.keys(rooms).length,
      players: Object.values(rooms).reduce((a, r) => a + r.players.length, 0),
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Server v4.5 - Running");
});

const wss = new WebSocketServer({ server });
const rooms = {};
const allClients = new Set();
// ── QUICK MATCH queue: status-based pairing of any 2 eligible searching players ──
let matchQueue = [];

function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += c[Math.floor(Math.random() * c.length)];
  return rooms[code] ? genCode() : code;
}

function broadcast(code, data, exclude) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (p.ws !== exclude && p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendToAll(code, data) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendGlobal(data) {
  const msg = JSON.stringify(data);
  allClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function playerPublic(p) {
  return { id: p.id, name: p.name, characterId: p.characterId, ready: p.ready, slot: p.slot, position: p.position, rotation: p.rotation, loginType: p.loginType || "guest" };
}

function roomPlayers(code) {
  return rooms[code].players.map(playerPublic);
}

function findPlayer(code, ws) {
  return rooms[code]?.players.find((p) => p.ws === ws);
}

function hostIdOf(room) {
  const h = room.players.find((p) => p.ws === room.host);
  return h ? h.id : (room.players[0] ? room.players[0].id : 1);
}

// Queue ma bhayeka eligible searching players lai JODIHAL — status-based
// (dukai searching + readyState=1 + queue age < 3 min). Fake player banaudaina.
function tryQuickPair(entry) {
  if (!matchQueue.includes(entry)) return; // cancel/expire bhaisakyo
  if (entry.ws.readyState !== 1) return;
  matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
  if (!matchQueue.includes(entry)) return;
  const idx = matchQueue.findIndex((q) => q.ws !== entry.ws && q.ws.readyState === 1);
  if (idx === -1) return; // kei jodi bhayena — next quick_match aayepachi feri try hunchha
  const a = matchQueue[idx];  // pahile dekhi queue ma thiyo → host
  const b = entry;
  matchQueue = matchQueue.filter((q) => q !== a && q !== b);
  const code = genCode();
  const mk = (e, id) => ({
    ws: e.ws, id, name: e.playerName, characterId: e.characterId,
    loginType: e.loginType, userId: e.userId, device: e.device,
    ready: false, slot: id, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  rooms[code] = {
    host: a.ws, hostName: a.playerName,
    roomName: "Match", region: "ASIA",
    mode: a.mode, maxPlayers: 4, loginType: a.loginType,
    players: [mk(a, 1), mk(b, 2)],
    gameStarted: true, matchmadeAt: Date.now(),
    matchLikes: {}, matchEliminated: [],
  };
  a.ws.setRoom(code);
  b.ws.setRoom(code);
  // SAME match assignment — dukai lai eutai code/mode/players + game_start
  send(a.ws, { type: "room_created", roomCode: code, roomName: "Match", region: "ASIA", mode: rooms[code].mode, playerId: 1, maxPlayers: 4, hostId: 1 });
  send(b.ws, { type: "room_joined", roomCode: code, roomName: "Match", region: "ASIA", mode: rooms[code].mode, playerId: 2, maxPlayers: 4, players: roomPlayers(code), hostId: 1 });
  broadcast(code, { type: "player_joined", player: playerPublic(rooms[code].players[1]), players: roomPlayers(code), hostId: 1 }, b.ws);
  sendToAll(code, { type: "game_start", mode: rooms[code].mode, players: roomPlayers(code) });
  console.log(`[MATCH] ${a.playerName} ↔ ${b.playerName} → ${code} mode=${rooms[code].mode}`);
}

wss.on("connection", (ws) => {
  let currentRoom = null;
  allClients.add(ws);
  // Pairing (aanu ko socket ko handler bata pani) le yo socket ko currentRoom set garna sakos.
  ws.setRoom = (code) => { currentRoom = code; };

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (currentRoom && rooms[currentRoom]) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        rooms[currentRoom].players.forEach((p) => {
          if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(buf);
        });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "create_room") {
      const code = genCode();
      rooms[code] = {
        host: ws, hostName: msg.playerName || "Host",
        roomName: msg.roomName || "Night Ward",
        region: msg.region || "ASIA",
        mode: msg.mode || "SURVIVAL",
        maxPlayers: msg.maxPlayers || 4,
        loginType: msg.loginType || "guest",
        players: [{
          ws, id: 1, name: msg.playerName || "Host",
          characterId: msg.characterId || 0,
          loginType: msg.loginType || "guest",
          userId: msg.userId || "",
          device: msg.deviceId || "",
          ready: false, slot: 1,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        }],
      };
      currentRoom = code;
      send(ws, {
        type: "room_created", roomCode: code,
        roomName: rooms[code].roomName, region: rooms[code].region,
        mode: rooms[code].mode, playerId: 1, maxPlayers: rooms[code].maxPlayers,
        hostId: 1,
      });
      console.log(`[CREATE] ${msg.playerName} (${msg.loginType || "guest"}) → ${code}`);
      return;
    }

    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: "error", message: "Room not found." }); return; }
      const room = rooms[code];
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }

      const joinLoginType = msg.loginType || "guest";
      const hostLoginType = room.loginType || "guest";
      if ((joinLoginType === "guest") !== (hostLoginType === "guest")) {
        send(ws, { type: "error", message: joinLoginType === "guest" ? "Guests can only play with other guests." : "This room only accepts logged-in players." });
        return;
      }

      const joinUserId = msg.userId || "";
      const joinDevice = msg.deviceId || "";
      // Same account: reject only when SAME device (real duplicate login).
      // Android + Mac ek account le khelna mildo — device farak chha.
      const sameDeviceAs = (p) => {
        if (!joinDevice || !p.device) return true; // purana client / device info chhaina → strict
        return p.device === joinDevice;
      };
      if (joinUserId) {
        const dupHere = room.players.find((p) => p.userId === joinUserId);
        if (dupHere && sameDeviceAs(dupHere)) {
          send(ws, { type: "error", message: "This account is already in the room." }); return;
        }
      }
      if (joinUserId) {
        for (const [rCode, r] of Object.entries(rooms)) {
          if (rCode === code) continue;
          const other = r.players.find((p) => p.userId === joinUserId);
          if (other && sameDeviceAs(other)) {
            send(ws, { type: "error", message: "This account is already in another room." }); return;
          }
        }
      }

      const pid = room.players.length + 1;
      const player = {
        ws, id: pid, name: msg.playerName || "Player",
        characterId: msg.characterId || 0,
        loginType: joinLoginType, userId: joinUserId,
        device: joinDevice,
        ready: false, slot: pid,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      room.players.push(player);
      currentRoom = code;

      send(ws, {
        type: "room_joined", roomCode: code,
        roomName: room.roomName, region: room.region,
        mode: room.mode, playerId: pid,
        maxPlayers: room.maxPlayers, players: roomPlayers(code),
        hostId: hostIdOf(room),
      });
      broadcast(code, { type: "player_joined", player: playerPublic(player), players: roomPlayers(code), hostId: hostIdOf(room) }, ws);
      console.log(`[JOIN] ${player.name} (${joinLoginType}) → ${code} as #${pid}`);
      return;
    }

    if (msg.type === "ping") { send(ws, { type: "pong", room: currentRoom }); return; }

    if (msg.type === "chat_global") {
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0) return;
      sendGlobal({ type: "chat_global", sender: msg.sender || "Player", text, ts: Date.now() });
      return;
    }

    if (msg.type === "chat_room") {
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0 || !currentRoom) return;
      broadcast(currentRoom, { type: "chat_room", sender: msg.sender || "Player", text, ts: Date.now() });
      return;
    }

    // ── QUICK MATCHMAKING — status-based pairing (2 real players, no fakes) ──
    if (msg.type === "quick_match") {
      if (matchQueue.some((q) => q.ws === ws)) return; // duplicate request guard
      // Pahile room ma thiyo bhane niskin (solo host START → matchmaking)
      if (currentRoom && rooms[currentRoom]) {
        const old = rooms[currentRoom];
        old.players = old.players.filter((p) => p.ws !== ws);
        if (old.players.length === 0) {
          delete rooms[currentRoom];
        } else {
          if (old.host === ws) { old.host = old.players[0].ws; old.hostName = old.players[0].name; }
          broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(old) });
        }
        currentRoom = null;
      }
      // Expired (>3 min) / dead entries hatau
      matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
      const entry = {
        ws, playerName: msg.playerName || "Player", characterId: msg.characterId | 0,
        mode: msg.mode || "SURVIVAL", loginType: msg.loginType || "guest",
        userId: msg.userId || "", device: msg.deviceId || "", queuedAt: Date.now(),
      };
      matchQueue.push(entry);
      // Cancel (X) pachi pair hudaina bhanera microtask ma queue re-check
      setTimeout(() => tryQuickPair(entry), 0);
      return;
    }

    if (msg.type === "quick_match_cancel") {
      const entry = matchQueue.find((q) => q.ws === ws);
      matchQueue = matchQueue.filter((q) => q.ws !== ws);
      // Cancel pachi fresh matchmade room (seal bhako <3s) ma chha → turunti nikal:
      // duplicate/fake match state bachau, arko player lai player_left janchha.
      if (entry && currentRoom && rooms[currentRoom]) {
        const r = rooms[currentRoom];
        if (r.matchmadeAt && Date.now() - r.matchmadeAt < 3000) {
          r.players = r.players.filter((p) => p.ws !== ws);
          if (r.players.length === 0) {
            delete rooms[currentRoom];
          } else {
            if (r.host === ws) { r.host = r.players[0].ws; r.hostName = r.players[0].name; }
            broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(r) });
          }
          currentRoom = null;
        }
      }
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = findPlayer(currentRoom, ws);

    if (msg.type === "check_game") {
      if (room.gameStarted) send(ws, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      return;
    }

    // Lobby self-heal: client return-to-lobby / panel open ma authoritative
    // room list magcha (stale 1/4 count fix).
    if (msg.type === "sync_room") {
      if (player) send(ws, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
      return;
    }

    if (msg.type === "set_character") {
      if (player) { player.characterId = msg.characterId; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) }); }
      return;
    }

    if (msg.type === "set_ready") {
      if (player) { player.ready = !!msg.ready; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) }); }
      return;
    }

    if (msg.type === "kick_player") {
      if (ws === room.host) {
        const target = room.players.find((p) => p.id === msg.targetId);
        if (target && target.ws !== room.host) {
          send(target.ws, { type: "kicked", reason: "Kicked by host" });
          target.ws.close();
          room.players = room.players.filter((p) => p.id !== msg.targetId);
          sendToAll(currentRoom, { type: "player_left", playerId: msg.targetId, players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
          console.log(`[KICK] ${target.name} kicked from ${currentRoom}`);
        }
      }
      return;
    }

    if (msg.type === "set_mode") {
      if (ws === room.host) { room.mode = msg.mode || room.mode; broadcast(currentRoom, { type: "mode_changed", mode: room.mode, players: roomPlayers(currentRoom) }); }
      return;
    }

    if (msg.type === "start_game") {
      if (ws === room.host) {
        room.gameStarted = true;
        room.matchLikes = {};       // naya match = naya like state
        room.matchEliminated = [];
        console.log(`[START] ${currentRoom} mode=${room.mode} players=${room.players.length}`);
        sendToAll(currentRoom, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      }
      return;
    }

    // Match pachi lobby farke: gameStarted clear (late joiner lobby ma nai aaos)
    if (msg.type === "game_ended") {
      if (room) room.gameStarted = false;
      return;
    }

    if (msg.type === "player_move") {
      if (player) {
        player.position = msg.position || player.position;
        player.rotation = msg.rotation || player.rotation;
        broadcast(currentRoom, {
          type: "player_moved", id: player.id,
          position: player.position, rotation: player.rotation,
        }, ws);
      }
      return;
    }

    if (msg.type === "ghost_move") {
      broadcast(currentRoom, {
        type: "ghost_moved",
        position: msg.position,
        rotation: msg.rotation,
        state: msg.state,
      }, ws);
      return;
    }

    if (msg.type === "door_sync") {
      broadcast(currentRoom, {
        type: "door_update",
        doorId: msg.doorId,
        isOpen: msg.isOpen,
        playerId: player?.id,
      }, ws);
      return;
    }

    if (msg.type === "emote") {
      if (player) broadcast(currentRoom, { type: "emote", playerId: player.id, anim: msg.anim }, ws);
      return;
    }

    if (msg.type === "entry_anim") {
      if (player) broadcast(currentRoom, { type: "entry_anim", playerId: player.id, anim: msg.anim }, ws);
      return;
    }

    if (msg.type === "ghost_jumpscare") {
      broadcast(currentRoom, { type: "ghost_jumpscare", targetPlayerId: msg.targetPlayerId | 0 }, ws);
      return;
    }

    if (msg.type === "player_hit") {
      broadcast(currentRoom, { type: "player_hit", targetPlayerId: msg.targetPlayerId | 0 }, ws);
      return;
    }

    if (msg.type === "ritual_pickup") {
      broadcast(currentRoom, { type: "ritual_pickup", itemId: msg.itemId | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_place") {
      broadcast(currentRoom, { type: "ritual_place", itemId: msg.itemId | 0, slotIndex: msg.slotIndex | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_drop") {
      broadcast(currentRoom, { type: "ritual_drop", itemId: msg.itemId | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_win") {
      broadcast(currentRoom, { type: "ritual_win", winnerId: msg.winnerId | 0 }, ws);
      return;
    }

    // ── MUMMY VS HUMAN — generic round/hit/dead/result sync (room relay) ──
    if (msg.type === "mummy_sync") {
      if (!player || !currentRoom) return;
      broadcast(currentRoom, { type: "mummy_sync", from: player.id, data: msg.data || {} }, ws);
      return;
    }

    // ── SPECTATOR LIKE SYSTEM (server-authoritative) ──
    // 1 spectator → 1 like per player per match. 3 likes = target eliminated.
    if (msg.type === "spectate_like") {
      if (!player) return;
      const targetId = msg.targetId | 0;
      if (targetId < 1 || targetId === player.id) return;
      if (!room.players.find((p) => p.id === targetId)) return;
      if (!room.matchLikes) room.matchLikes = {};
      if (!room.matchEliminated) room.matchEliminated = [];
      if (room.matchEliminated.includes(targetId)) return;
      if (!room.matchLikes[targetId]) room.matchLikes[targetId] = { likedBy: [] };
      const entry = room.matchLikes[targetId];
      if (entry.likedBy.includes(player.id)) return; // duplicate like — server rejects
      entry.likedBy.push(player.id);
      const count = entry.likedBy.length;
      sendToAll(currentRoom, { type: "spectate_like_update", targetId, count, fromId: player.id });
      console.log(`[LIKE] #${player.id} ${player.name} → #${targetId} (${count}/3) in ${currentRoom}`);
      if (count >= 3) {
        room.matchEliminated.push(targetId);
        sendToAll(currentRoom, { type: "spectate_eliminated", targetId });
        console.log(`[ELIM] #${targetId} eliminated by 3 likes in ${currentRoom}`);
      }
      return;
    }
  });

  ws.on("close", () => {
    allClients.delete(ws);
    matchQueue = matchQueue.filter((q) => q.ws !== ws); // queue bata turunti hata
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter((p) => p.ws !== ws);
    if (room.players.length === 0) { delete rooms[currentRoom]; console.log(`[DELETE] Room ${currentRoom}`); return; }
    if (room.host === ws) {
      room.host = room.players[0].ws;
      room.hostName = room.players[0].name;
      console.log(`[HOST] ${room.hostName} → new host of ${currentRoom}`);
    }
    broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
  });
});

setInterval(() => {
  // Queue bata expired/dead entries nikal (180s timeout client-side le pani cancel garchha)
  matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
  Object.keys(rooms).forEach((code) => {
    const alive = rooms[code].players.filter((p) => p.ws.readyState === 1);
    if (alive.length === 0) delete rooms[code];
    else rooms[code].players = alive;
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Night Ward Server v4.5 on port ${PORT}`);
});
