const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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
  res.end("Night Ward Server v3.1 - Running");
});

const wss = new WebSocketServer({ server });
const rooms = {};
const allClients = new Set();

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

wss.on("connection", (ws) => {
  let currentRoom = null;
  allClients.add(ws);

  ws.on("message", (raw) => {
    // Binary = voice data, relay to room
    if (Buffer.isBuffer(raw)) {
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom].players.forEach((p) => {
          if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(raw);
        });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ROOM ─────────────────────────────
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
      });
      console.log(`[CREATE] ${msg.playerName} (${msg.loginType || "guest"}) → ${code}`);
    }

    // ── JOIN ROOM ───────────────────────────────
    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: "error", message: "Room not found." }); return; }
      const room = rooms[code];
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }

      const joinLoginType = msg.loginType || "guest";
      const hostLoginType = room.loginType || "guest";
      const joinIsGuest = (joinLoginType === "guest");
      const hostIsGuest = (hostLoginType === "guest");
      if (joinIsGuest !== hostIsGuest) {
        send(ws, { type: "error", message: joinIsGuest ? "Guests can only play with other guests." : "This room only accepts logged-in players." });
        console.log(`[JOIN] REJECTED ${msg.playerName} (${joinLoginType}) — room requires ${hostLoginType}`);
        return;
      }

      const joinUserId = msg.userId || "";
      if (joinUserId && room.players.some((p) => p.userId === joinUserId)) {
        send(ws, { type: "error", message: "This account is already in the room." });
        console.log(`[JOIN] REJECTED ${msg.playerName} — duplicate account in room`);
        return;
      }
      if (joinUserId) {
        for (const [rCode, r] of Object.entries(rooms)) {
          if (rCode !== code && r.players.some((p) => p.userId === joinUserId)) {
            send(ws, { type: "error", message: "This account is already in another room." });
            console.log(`[JOIN] REJECTED ${msg.playerName} — account in room ${rCode}`);
            return;
          }
        }
      }

      const pid = room.players.length + 1;
      const player = {
        ws, id: pid, name: msg.playerName || "Player",
        characterId: msg.characterId || 0,
        loginType: joinLoginType,
        userId: joinUserId,
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
      });
      broadcast(code, { type: "player_joined", player: playerPublic(player), players: roomPlayers(code) }, ws);
      console.log(`[JOIN] ${player.name} (${joinLoginType}) → ${code} as #${pid}`);
    }

    if (msg.type === "ping") { send(ws, { type: "pong", room: currentRoom }); return; }

    // ── GLOBAL CHAT (no room needed) ────────────
    if (msg.type === "chat_global") {
      const senderName = msg.sender || "Player";
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0) return;
      sendGlobal({ type: "chat_global", sender: senderName, text: text, ts: Date.now() });
      console.log(`[CHAT-GLOBAL] ${senderName}: ${text}`);
      return;
    }

    // ── ROOM CHAT ───────────────────────────────
    if (msg.type === "chat_room") {
      const senderName = msg.sender || "Player";
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0 || !currentRoom) return;
      broadcast(currentRoom, { type: "chat_room", sender: senderName, text: text, ts: Date.now() });
      console.log(`[CHAT-ROOM] ${currentRoom} ${senderName}: ${text}`);
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = findPlayer(currentRoom, ws);

    if (msg.type === "check_game") {
      if (room.gameStarted) send(ws, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      return;
    }

    if (msg.type === "set_character") {
      if (player) { player.characterId = msg.characterId; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom) }); }
    }

    if (msg.type === "set_ready") {
      if (player) { player.ready = !!msg.ready; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom) }); }
    }

    // ── KICK (host only) ────────────────────────
    if (msg.type === "kick_player") {
      if (ws === room.host) {
        const targetId = msg.targetId;
        const target = room.players.find((p) => p.id === targetId);
        if (target && target.ws !== room.host) {
          send(target.ws, { type: "kicked", reason: "Kicked by host" });
          target.ws.close();
          room.players = room.players.filter((p) => p.id !== targetId);
          broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom) });
          console.log(`[KICK] ${target.name} kicked from ${currentRoom}`);
        }
      }
    }

    if (msg.type === "set_mode") {
      if (ws === room.host) { room.mode = msg.mode || room.mode; broadcast(currentRoom, { type: "mode_changed", mode: room.mode, players: roomPlayers(currentRoom) }); }
    }

    if (msg.type === "start_game") {
      if (ws === room.host) {
        room.gameStarted = true;
        console.log(`[START] ${currentRoom} mode=${room.mode} players=${room.players.length}`);
        sendToAll(currentRoom, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      }
    }

    if (msg.type === "player_move") {
      if (player) { player.position = msg.position || player.position; player.rotation = msg.rotation || player.rotation; broadcast(currentRoom, { type: "player_moved", id: player.id, position: player.position, rotation: player.rotation }, ws); }
    }

    if (msg.type === "emote") {
      if (player) broadcast(currentRoom, { type: "emote", playerId: player.id, anim: msg.anim }, ws);
    }

    if (msg.type === "door_sync") {
      broadcast(currentRoom, { type: "door_update", doorId: msg.doorId, isOpen: msg.isOpen, playerId: player?.id }, ws);
    }
  });

  ws.on("close", () => {
    allClients.delete(ws);
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter((p) => p.ws !== ws);
    if (room.players.length === 0) { delete rooms[currentRoom]; console.log(`[DELETE] Room ${currentRoom} empty.`); }
    else { broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom) }); console.log(`[LEFT] Player from ${currentRoom}`); }
  });
});

setInterval(() => {
  Object.keys(rooms).forEach((code) => {
    const alive = rooms[code].players.filter((p) => p.ws.readyState === 1);
    if (alive.length === 0) { delete rooms[code]; console.log(`[GC] Room ${code} cleaned.`); }
    else rooms[code].players = alive;
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Night Ward Server v3.1 on port ${PORT}`);
});
