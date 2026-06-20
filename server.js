const WebSocket = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = {};
let nextId = 1;

wss.on("connection", (ws) => {
    const id = nextId++;
    players[id] = ws;

    console.log("Player joined:", id);

    // send welcome + existing players
    ws.send(JSON.stringify({
        type: "welcome",
        id: id,
        players: Object.keys(players).map(x => parseInt(x))
    }));

    broadcast({
        type: "player_joined",
        id: id
    }, id);

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);

            broadcast({
                type: "data",
                from: id,
                payload: data
            }, id);

        } catch (e) {}
    });

    ws.on("close", () => {
        delete players[id];

        broadcast({
            type: "player_left",
            id: id
        });
    });
});

function broadcast(data, exclude = null) {
    const msg = JSON.stringify(data);

    for (const id in players) {
        if (exclude && id == exclude) continue;

        const c = players[id];
        if (c && c.readyState === WebSocket.OPEN) {
            c.send(msg);
        }
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server running"));
