const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Game Server OK');
});

const wss = new WebSocketServer({ 
    server,
    perMessageDeflate: false,
    clientTracking: true
});

const PORT = process.env.PORT || 8080;
let players = {}, queue = [];
const MATCH_SIZE = 2;

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Server on port ' + PORT);
});

wss.on('connection', (ws) => {
    let my_id = null;
    console.log('New connection!');

    ws.on('message', (raw) => {
        let msg; 
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'register') {
            my_id = msg.player_id;
            players[my_id] = { ws, name: msg.name };
            console.log('Joined: ' + msg.name + ' [' + my_id + ']');
        }

        if (msg.type === 'find_match') {
            if (!queue.includes(my_id)) queue.push(my_id);
            console.log('Queue: ' + queue.length + '/' + MATCH_SIZE);
            if (queue.length >= MATCH_SIZE) {
                const room = queue.splice(0, MATCH_SIZE);
                const room_id = Date.now().toString(36).toUpperCase();
                room.forEach(pid => {
                    players[pid]?.ws.send(JSON.stringify({
                        type: 'match_found',
                        room_id: room_id,
                        players: room
                    }));
                });
                console.log('Match! Room: ' + room_id);
            }
        }
    });

    ws.on('close', () => {
        if (my_id) {
            delete players[my_id];
            queue = queue.filter(id => id !== my_id);
            console.log('Left: ' + my_id);
        }
    });

    ws.on('error', (err) => {
        console.log('WS Error: ' + err.message);
    });
});
