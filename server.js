const WebSocket = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = {};
let nextId = 1;

wss.on("connection", (ws) => {
    const playerId = nextId++;
    players[playerId] = ws;

    console.log("Player joined:", playerId);

    // SEND WELCOME + SNAPSHOT
    ws.send(JSON.stringify({
        type: "welcome",
        id: playerId,
        existing_players: Object.keys(players)
            .map(id => parseInt(id))
            .filter(id => id !== playerId)
    }));

    // notify others
    broadcast({
        type: "player_joined",
        id: playerId
    }, playerId);

    broadcastPlayerCount();

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);

            broadcast({
                type: "data",
                from: playerId,
                payload: data
            }, playerId);

        } catch (e) {
            console.log("Bad message");
        }
    });

    ws.on("close", () => {
        delete players[playerId];

        broadcast({
            type: "player_left",
            id: playerId
        });

        broadcastPlayerCount();
    });
});

function broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);

    for (const id in players) {
        if (excludeId && id == excludeId) continue;

        const client = players[id];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

function broadcastPlayerCount() {
    broadcast({
        type: "player_count",
        count: Object.keys(players).length
    });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log("Server running on", PORT);
});
