const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = {};
let nextId = 1;

wss.on('connection', (ws) => {
    const playerId = nextId++;
    players[playerId] = ws;

    console.log(`Player ${playerId} joined. Total: ${Object.keys(players).length}`);

    ws.send(JSON.stringify({ type: "welcome", id: playerId }));

    // sabai lai naya total count pathaune
    broadcastPlayerCount();
    broadcast({ type: "player_joined", id: playerId }, playerId);

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        broadcast({ type: "data", from: playerId, payload: data }, playerId);
    });

    ws.on('close', () => {
        delete players[playerId];
        broadcast({ type: "player_left", id: playerId }, playerId);
        broadcastPlayerCount();
        console.log(`Player ${playerId} left. Total: ${Object.keys(players).length}`);
    });
});

function broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const id in players) {
        if (id != excludeId && players[id].readyState === WebSocket.OPEN) {
            players[id].send(msg);
        }
    }
}

function broadcastPlayerCount() {
    const count = Object.keys(players).length;
    const msg = JSON.stringify({ type: "player_count", count: count });
    for (const id in players) {
        if (players[id].readyState === WebSocket.OPEN) {
            players[id].send(msg);
        }
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
