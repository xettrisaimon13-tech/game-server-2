const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

const server = http.createServer((req, res) => {
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

wss.on("connection", (ws) => {
  let currentRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === "create_room") {
      const code = generateCode();
      rooms[code] = {
        host: ws,
        roomName: msg.roomName || "Night Ward",
        players: [
          {
            ws,
            id: 1,
            name: msg.playerName || "Host",
            characterId: msg.characterId || 0,
            ready: false,
            slot: 1,
          },
        ],
      };
      currentRoom = code;
      ws.send(
        JSON.stringify({
          type: "room_created",
          roomCode: code,
          roomName: rooms[code].roomName,
          playerId: 1,
        })
      );
      console.log(`Room created: ${code} by ${msg.playerName}`);
    }

    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
        return;
      }
      const room = rooms[code];
      if (room.players.length >= 4) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full." }));
        return;
      }
      const playerId = room.players.length + 1;
      const player = {
        ws,
        id: playerId,
        name: msg.playerName || "Player",
        characterId: msg.characterId || 0,
        ready: false,
        slot: playerId,
      };
      room.players.push(player);
      currentRoom = code;

      ws.send(
        JSON.stringify({
          type: "room_joined",
          roomCode: code,
          roomName: room.roomName,
          playerId: playerId,
          players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            characterId: p.characterId,
            ready: p.ready,
            slot: p.slot,
          })),
        })
      );

      broadcast(
        code,
        {
          type: "player_joined",
          player: {
            id: playerId,
            name: player.name,
            characterId: player.characterId,
            slot: playerId,
          },
          players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            characterId: p.characterId,
            ready: p.ready,
            slot: p.slot,
          })),
        },
        ws
      );

      console.log(`Player ${playerName} joined room ${code} as #${playerId}`);
    }

    if (msg.type === "set_ready") {
      if (!currentRoom || !rooms[currentRoom]) return;
      const room = rooms[currentRoom];
      const player = room.players.find((p) => p.ws === ws);
      if (player) {
        player.ready = msg.ready;
        broadcast(currentRoom, {
          type: "lobby_update",
          players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            characterId: p.characterId,
            ready: p.ready,
            slot: p.slot,
          })),
        });
      }
    }

    if (msg.type === "set_character") {
      if (!currentRoom || !rooms[currentRoom]) return;
      const room = rooms[currentRoom];
      const player = room.players.find((p) => p.ws === ws);
      if (player) {
        player.characterId = msg.characterId;
        broadcast(currentRoom, {
          type: "lobby_update",
          players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            characterId: p.characterId,
            ready: p.ready,
            slot: p.slot,
          })),
        });
      }
    }

    if (msg.type === "start_game") {
      if (!currentRoom || !rooms[currentRoom]) return;
      broadcast(currentRoom, { type: "game_start" });
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter((p) => p.ws !== ws);
    if (room.players.length === 0) {
      delete rooms[currentRoom];
      console.log(`Room ${currentRoom} deleted (empty).`);
    } else {
      broadcast(currentRoom, {
        type: "player_left",
        players: room.players.map((p) => ({
          id: p.id,
          name: p.name,
          characterId: p.characterId,
          ready: p.ready,
          slot: p.slot,
        })),
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Night Ward server running on port ${PORT}`);
});
