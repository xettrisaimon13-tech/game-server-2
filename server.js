const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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
  res.end("Night Ward Server v2.0 - Running");
});

const wss = new WebSocketServer({ server });
const rooms = {};

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

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function playerPublic(p) {
  return {
    id: p.id, name: p.name, characterId: p.characterId,
    ready: p.ready, slot: p.slot, position: p.position, rotation: p.rotation,
  };
}

function roomPlayers(code) {
  return rooms[code].players.map(playerPublic);
}

function findPlayer(code, ws) {
  return rooms[code]?.players.find((p) => p.ws === ws);
}

wss.on("connection", (ws) => {
  let currentRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create_room") {
      const code = genCode();
      rooms[code] = {
        host: ws, hostName: msg.playerName || "Host",
        roomName: msg.roomName || "Night Ward",
        region: msg.region || "ASIA", mode: msg.mode || "SURVIVAL",
        maxPlayers: msg.maxPlayers || 4,
        players: [{
          ws, id: 1, name: msg.playerName || "Host",
          characterId: msg.characterId || 0, ready: false, slot: 1,
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        }],
      };
      currentRoom = code;
      send(ws, {
        type: "room_created", roomCode: code, roomName: rooms[code].roomName,
        region: rooms[code].region, mode: rooms[code].mode,
        playerId: 1, maxPlayers: rooms[code].maxPlayers,
      });
      console.log(`[CREATE] ${msg.playerName} -> ${code}`);
    }

    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: "error", message: "Room not found." }); return; }
      const room = rooms[code];
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }
      const pid = room.players.length + 1;
      const player = {
        ws, id: pid, name: msg.playerName || "Player",
        characterId: msg.characterId || 0, ready: false, slot: pid,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      room.players.push(player);
      currentRoom = code;
      send(ws, {
        type: "room_joined", roomCode: code, roomName: room.roomName,
        region: room.region, mode: room.mode, playerId: pid,
        maxPlayers: room.maxPlayers, players: roomPlayers(code),
      });
      broadcast(code, {
        type: "player_joined", player: playerPublic(player), players: roomPlayers(code),
      }, ws);
      console.log(`[JOIN] ${player.name} -> ${code} #${pid}`);
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = findPlayer(currentRoom, ws);

    if (msg.type === "set_character" && player) {
      player.characterId = msg.characterId;
      broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom) });
    }

    if (msg.type === "set_ready" && player) {
      player.ready = !!msg.ready;
      broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom) });
    }

    if (msg.type === "set_mode" && ws === room.host?.ws) {
      room.mode = msg.mode || room.mode;
      broadcast(currentRoom, { type: "mode_changed", mode: room.mode, players: roomPlayers(currentRoom) });
    }

    if (msg.type === "start_game" && ws === room.host?.ws) {
      broadcast(currentRoom, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      console.log(`[START] ${currentRoom}`);
    }

    if (msg.type === "player_move" && player) {
      player.position = msg.position || player.position;
      player.rotation = msg.rotation || player.rotation;
      broadcast(currentRoom, {
        type: "player_moved", id: player.id,
        position: player.position, rotation: player.rotation,
      }, ws);
    }

    if (msg.type === "door_sync") {
      broadcast(currentRoom, {
        type: "door_update", doorId: msg.doorId, isOpen: msg.isOpen, playerId: player?.id,
      }, ws);
    }

    ws.on("close", () => {
      if (!currentRoom || !rooms[currentRoom]) return;
      const room = rooms[currentRoom];
      room.players = room.players.filter((p) => p.ws !== ws);
      if (room.players.length === 0) {
        delete rooms[currentRoom];
        console.log(`[DELETE] ${currentRoom}`);
      } else {
        broadcast(currentRoom, { type: "player_left", playerId: player?.id, players: roomPlayers(currentRoom) });
        console.log(`[LEFT] ${player?.name} from ${currentRoom}`);
      }
    });
  });
});

setInterval(() => {
  Object.keys(rooms).forEach((code) => {
    const alive = rooms[code].players.filter((p) => p.ws.readyState === 1);
    if (alive.length === 0) { delete rooms[code]; }
    else { rooms[code].players = alive; }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Night Ward Server v2.0 on port ${PORT}`);
});
