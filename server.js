const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

const server = http.createServer((req, res) => {
  if (req.url === "/rooms") {
    const list = Object.entries(rooms).map(([code, room]) => ({
      code,
      name: room.roomName,
      players: room.players.length,
      maxPlayers: 4,
      region: room.region || "ASIA",
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Server - Running");
});

const wss = new WebSocketServer({ server });
const rooms = {};

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function broadcast(roomCode, data, excludeWs = null) {
  if (!rooms[roomCode]) return;
  const msg = JSON.stringify(data);
  rooms[roomCode].players.forEach((p) => {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  });
}

// ... connection handler with create_room, join_room, set_ready, set_character, start_game, list_rooms
// ... cleanup on disconnect
