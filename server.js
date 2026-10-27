const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. OAUTH TOKEN MEMORY STORE
// ==========================================
const oauthTokens = new Map();

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: "online",
        service: "Flame Strike Game Server",
        timestamp: new Date().toISOString()
    });
});

// OAuth Callback from Supabase / Google
app.get('/auth/callback', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Logging in...</title>
    <style>
        body { background: #0b0f19; color: #38bdf8; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { text-align: center; background: #131d31; padding: 30px; border-radius: 12px; border: 1px solid #1e293b; }
    </style>
</head>
<body>
    <div class="box">
        <h2>Flame Strike Authentication</h2>
        <p>Logging in, please return to your game...</p>
        <p id="debug" style="font-size: 12px; color: #666;"></p>
    </div>
    <script>
        const hash = window.location.hash.substring(1);
        const search = window.location.search.substring(1);
        const params = new URLSearchParams(hash || search);
        
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        const state = params.get('state');
        
        document.getElementById('debug').innerText = 'State: ' + (state || 'none') + ' | Token: ' + (accessToken ? 'found' : 'missing');
        
        if (accessToken) {
            const finalState = state || 'global_fallback';
            
            fetch('/auth/save-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: finalState, access_token: accessToken, refresh_token: refreshToken })
            }).then(() => {
                document.querySelector('p').innerText = "Logged in successfully! You can switch back to the game.";
                setTimeout(() => window.close(), 1500);
            }).catch(err => {
                document.querySelector('p').innerText = "Error: " + err.message;
            });
        } else {
            document.querySelector('p').innerText = "No token found. Please try again.";
        }
    </script>
</body>
</html>
    `);
});

// Internal endpoint to store extracted token
app.post('/auth/save-token', (req, res) => {
    const { state, access_token, refresh_token } = req.body;
    console.log('[AUTH] Save-token called. State:', state, 'Token present:', !!access_token);
    
    if (access_token) {
        const finalState = state || 'global_fallback';
        oauthTokens.set(finalState, {
            access_token,
            refresh_token,
            created_at: Date.now()
        });
        oauthTokens.set('global_fallback', {
            access_token,
            refresh_token,
            created_at: Date.now()
        });
        setTimeout(() => {
            oauthTokens.delete(finalState);
            oauthTokens.delete('global_fallback');
        }, 5 * 60 * 1000);
        console.log('[AUTH] Token saved successfully for state:', finalState);
        return res.json({ success: true });
    }
    res.status(400).json({ error: "Missing token" });
});

// Godot polls this endpoint during login
app.get('/auth/poll', (req, res) => {
    const state = req.query.state;
    if (!state) {
        return res.status(400).json({ error: "Missing state query param" });
    }

    if (oauthTokens.has(state)) {
        const tokenData = oauthTokens.get(state);
        oauthTokens.delete(state);
        return res.json({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    if (oauthTokens.has('global_fallback')) {
        const tokenData = oauthTokens.get('global_fallback');
        oauthTokens.delete('global_fallback');
        return res.json({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    res.json({ pending: true });
});

// ==========================================
// 2. WEBSOCKET REAL-TIME MATCHMAKING
// ==========================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const queues = {
    "MUMMY_VS_HUMAN": [],
    "ZOMBIE_ECLIPSE": []
};

const matches = new Map();
let matchCounter = 1000;

function removeFromAllQueues(ws) {
    for (const mode of Object.keys(queues)) {
        const idx = queues[mode].findIndex(p => p.ws === ws);
        if (idx !== -1) {
            queues[mode].splice(idx, 1);
            console.log(`[QUEUE] Player removed from ${mode}. Queue size: ${queues[mode].length}`);
        }
    }
}

wss.on('connection', (ws) => {
    console.log('[WS] New player connected');
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            handleClientMessage(ws, data);
        } catch (err) {
            console.error('[WS ERROR] Failed to parse message:', err);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Player disconnected');
        removeFromAllQueues(ws);

        if (ws.matchId && matches.has(ws.matchId)) {
            const match = matches.get(ws.matchId);
            for (const otherWs of match.players) {
                if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
                    otherWs.send(JSON.stringify({ type: "player_disconnected" }));
                }
            }
            matches.delete(ws.matchId);
        }
    });
});

function handleClientMessage(ws, data) {
    const type = data.type;

    switch (type) {
        case 'quick_match': {
            const mode = data.mode || "MUMMY_VS_HUMAN";
            const teamSize = data.team_size || 1;
            const characterId = data.character_id || 1;
            const username = data.username || "Player";
            const playerUid = data.player_uid || "";

            if (!queues[mode]) {
                queues[mode] = [];
            }

            removeFromAllQueues(ws);

            queues[mode].push({ ws, teamSize, characterId, username, playerUid });
            console.log(`[QUEUE] Player joined ${mode} queue. Current waiting: ${queues[mode].length}`);

            if (queues[mode].length >= 2) {
                const player1 = queues[mode].shift();
                const player2 = queues[mode].shift();

                const matchId = `match_${matchCounter++}`;
                player1.ws.matchId = matchId;
                player2.ws.matchId = matchId;

                matches.set(matchId, {
                    players: [player1.ws, player2.ws],
                    mode: mode
                });

                console.log(`[MATCH FOUND] Paired 2 players for ${mode} in ${matchId}!`);

                if (player1.ws.readyState === WebSocket.OPEN) {
                    player1.ws.send(JSON.stringify({
                        type: "match_found",
                        mode: mode,
                        spawn_index: 0,
                        match_id: matchId,
                        total_players: 2,
                        opponent: {
                            character_id: player2.characterId,
                            username: player2.username,
                            player_uid: player2.playerUid,
                            spawn_index: 1
                        }
                    }));
                }

                if (player2.ws.readyState === WebSocket.OPEN) {
                    player2.ws.send(JSON.stringify({
                        type: "match_found",
                        mode: mode,
                        spawn_index: 1,
                        match_id: matchId,
                        total_players: 2,
                        opponent: {
                            character_id: player1.characterId,
                            username: player1.username,
                            player_uid: player1.playerUid,
                            spawn_index: 0
                        }
                    }));
                }
            } else {
                ws.send(JSON.stringify({
                    type: "player_joined",
                    player_count: 1,
                    required_players: 2
                }));
            }
            break;
        }

        case 'quick_match_cancel': {
            removeFromAllQueues(ws);
            ws.send(JSON.stringify({ type: "match_cancelled" }));
            break;
        }

        case 'player_move':
        case 'player_action':
        case 'player_anim': {
            if (ws.matchId && matches.has(ws.matchId)) {
                const match = matches.get(ws.matchId);
                for (const otherWs of match.players) {
                    if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
                        otherWs.send(JSON.stringify(data));
                    }
                }
            }
            break;
        }

        default:
            console.log('[WS] Unknown message type:', type);
    }
}

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 25000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Flame Strike Server listening on port ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`===========================================`);
});
