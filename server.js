const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = {};       // id -> { ws, gameId }
let bannedIds = new Set();
let nextId = 1;

function generateGameId() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 4; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

wss.on('connection', (ws) => {
    const playerId = nextId++;
    const gameId = generateGameId();

    players[playerId] = { ws: ws, gameId: gameId };

    console.log(`Player ${playerId} (${gameId}) joined. Total: ${Object.keys(players).length}`);

    const existingPlayers = Object.keys(players)
        .map(id => parseInt(id))
        .filter(id => id !== playerId)
        .map(id => ({ id: id, gameId: players[id].gameId }));

    ws.send(JSON.stringify({
        type: "welcome",
        id: playerId,
        gameId: gameId,
        existing_players: existingPlayers
    }));

    broadcast({ type: "player_joined", id: playerId, gameId: gameId }, playerId);

    ws.on('message', (msg) => {
        let data;
        try {
            data = JSON.parse(msg);
        } catch (e) {
            return;
        }

        if (data.type === "ban_request") {
            const targetGameId = data.target_game_id;
            const targetEntry = Object.entries(players).find(([id, p]) => p.gameId === targetGameId);

            if (targetEntry) {
                const targetId = targetEntry[0];
                const targetPlayer = targetEntry[1];
                bannedIds.add(targetGameId);
                console.log(`Player ${targetGameId} banned by ${gameId}`);

                targetPlayer.ws.send(JSON.stringify({ type: "you_were_banned" }));
                targetPlayer.ws.close();

                broadcast({ type: "player_banned", id: parseInt(targetId), gameId: targetGameId });
            }
            return;
        }

        broadcast({ type: "data", from: playerId, payload: data }, playerId);
    });

    ws.on('close', () => {
        delete players[playerId];
        broadcast({ type: "player_left", id: playerId }, playerId);
        console.log(`Player ${playerId} left. Total: ${Object.keys(players).length}`);
    });
});

function broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const id in players) {
        if (id != excludeId && players[id].ws.readyState === WebSocket.OPEN) {
            players[id].ws.send(msg);
        }
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

func handle_message(data):
	match data["type"]:
		"welcome":
			my_id = data.get("id", -1)
			my_game_id = data.get("gameId", "----")
			existing_players = data.get("existing_players", [])
			print("My Game ID: ", my_game_id)
			connected_to_server.emit()
		"player_joined":
			player_joined.emit(data.get("id", -1), data.get("gameId", "----"))
		"player_left":
			player_left.emit(data.get("id", -1))
		"player_banned":
			player_banned.emit(data.get("id", -1), data.get("gameId", "----"))
		"you_were_banned":
			you_were_banned.emit()
		"data":
			data_received.emit(data.get("from", -1), data.get("payload", {}))
