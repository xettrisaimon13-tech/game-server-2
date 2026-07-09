const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 7001;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DARK WARD Server Running');
});
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const players = new Map();
const usedRoomIds = new Set();
let nextPlayerId = 1;

function generateRoomId() {
    let id;
    do { id = 1000 + Math.floor(Math.random() * 9000); } while (usedRoomIds.has(id));
    usedRoomIds.add(id);
    return id;
}

function findRoomPlayer(room, playerId) { return room.players.find(p => p.id === playerId); }

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    room.players.forEach((player) => {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) player.ws.send(data);
    });
}

function sendTo(ws, message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function sendError(ws, message) { sendTo(ws, { type: 'error', message }); }
function sendStatus(ws, text) { sendTo(ws, { type: 'status', text }); }

function getRoomList() {
    const list = [];
    rooms.forEach((room, id) => {
        const hostPlayer = findRoomPlayer(room, room.hostPlayerId);
        list.push({
            id, roomId: id, name: room.name, hostName: hostPlayer ? hostPlayer.name : 'Unknown',
            players: room.players.length, maxPlayers: room.teamSize, map: room.map, inGame: room.inGame,
            hasPassword: !!(room.password && room.password !== ''), isPrivate: !!room.isPrivate,
            playerNames: room.players.map(p => p.name)
        });
    });
    return list;
}

function removePlayerFromRoom(player) {
    if (!player.roomId) return null;
    const room = rooms.get(player.roomId);
    if (!room) { player.roomId = null; player.ready = false; return null; }
    room.players = room.players.filter(p => p.id !== player.id);
    const leftRoomId = player.roomId;
    const wasHost = room.hostPlayerId === player.id;
    broadcastToRoom(leftRoomId, { type: 'player_left', playerId: player.id, name: player.name }, player.ws);
    player.roomId = null; player.ready = false;
    if (room.players.length === 0) { rooms.delete(leftRoomId); usedRoomIds.delete(leftRoomId); return null; }
    if (wasHost) { const newHost = room.players[0]; room.hostPlayerId = newHost.id; broadcastToRoom(leftRoomId, { type: 'host_changed', newHostId: newHost.id, newHostName: newHost.name }); }
    return leftRoomId;
}

function joinRoom(player, room, roomId) {
    if (player.roomId) removePlayerFromRoom(player);
    player.roomId = roomId; player.ready = false; room.players.push(player);
    sendTo(player.ws, {
        type: 'room_joined', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map,
        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
        hostId: room.hostPlayerId
    });
    broadcastToRoom(roomId, { type: 'player_joined', playerId: player.id, name: player.name }, player.ws);
}

function checkAllReady(room) { return room.inGame ? false : room.players.length >= 2 && room.players.every(p => p.ready); }

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    players.set(playerId, { ws, id: playerId, name: 'Player' + playerId, roomId: null, ready: false, position: null, rotation: null, animation: null, crouching: false, flashlight: false, health: 100 });
    sendTo(ws, { type: 'welcome', playerId });

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        const player = players.get(playerId); if (!player) return;

        switch (msg.type) {
            case 'set_name': {
                const newName = (msg.name || '').trim() || 'Player' + playerId;
                if (player.roomId) { const room = rooms.get(player.roomId); if (room) { const nameTaken = room.players.some(op => op.id !== playerId && op.name === newName); player.name = nameTaken ? newName + '_' + Math.floor(Math.random() * 100) : newName; } else player.name = newName; }
                else player.name = newName;
                break;
            }
            case 'get_rooms': sendTo(ws, { type: 'room_list', rooms: getRoomList() }); break;
            case 'create_room': {
                if (player.roomId) removePlayerFromRoom(player);
                const roomId = generateRoomId();
                const room = { id: roomId, name: msg.roomName || 'Room', hostPlayerId: playerId, password: msg.password || '', isPrivate: !!msg.isPrivate, players: [], map: msg.map || 'Hospital', teamSize: msg.teamSize || 2, inGame: false, createdAt: Date.now() };
                player.roomId = roomId; player.ready = false; room.players.push(player); rooms.set(roomId, room);
                sendTo(ws, { type: 'room_created', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map, hasPassword: room.password !== '' });
                sendTo(ws, { type: 'room_joined', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })), hostId: room.hostPlayerId });
                break;
            }
            case 'join_room': {
                const targetRoomId = msg.roomId ? Number(msg.roomId) : null;
                const roomName = msg.roomName || '';
                const password = msg.password || '';
                let targetRoom = null; let foundRoomId = null;
                if (targetRoomId && rooms.has(targetRoomId)) { const c = rooms.get(targetRoomId); if (!c.inGame) { targetRoom = c; foundRoomId = targetRoomId; } }
                else { rooms.forEach((room, rid) => { if (!targetRoom && !room.inGame && room.name === roomName) { if (room.password && room.password !== password) return; if (room.players.length >= room.teamSize) return; targetRoom = room; foundRoomId = rid; } }); }
                if (!targetRoom) { sendError(ws, 'Room not found'); break; }
                if (targetRoom.password && targetRoom.password !== password) { sendError(ws, 'Wrong password'); break; }
                if (targetRoom.players.length >= targetRoom.teamSize) { sendError(ws, 'Room is full'); break; }
                joinRoom(player, targetRoom, foundRoomId);
                break;
            }
            case 'quick_match': {
                let found = false;
                rooms.forEach((room, rid) => { if (!found && !room.inGame && !room.isPrivate && !room.password && room.players.length < room.teamSize) { joinRoom(player, room, rid); found = true; } });
                if (!found) { const roomId = generateRoomId(); const room = { id: roomId, name: 'Quick Match', hostPlayerId: playerId, password: '', isPrivate: false, players: [], map: 'Hospital', teamSize: 2, inGame: false, createdAt: Date.now() }; player.roomId = roomId; player.ready = false; room.players.push(player); rooms.set(roomId, room); sendTo(ws, { type: 'room_joined', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })), hostId: room.hostPlayerId }); sendStatus(ws, 'Waiting for players...'); }
                break;
            }
            case 'leave_room': if (player.roomId) removePlayerFromRoom(player); break;
            case 'player_sync': {
                if (!player.roomId) break;
                player.position = msg.position || player.position; player.rotation = msg.rotation || player.rotation; player.animation = msg.animation || player.animation;
                if (msg.crouching !== undefined) player.crouching = msg.crouching;
                if (msg.flashlight !== undefined) player.flashlight = msg.flashlight;
                if (msg.health !== undefined) player.health = msg.health;
                broadcastToRoom(player.roomId, { type: 'player_sync', playerId, name: player.name, position: player.position, rotation: player.rotation, animation: player.animation, crouching: player.crouching, flashlight: player.flashlight, health: player.health }, ws);
                break;
            }
            case 'player_damage': { if (!player.roomId) break; broadcastToRoom(player.roomId, { type: 'player_damage', playerId: msg.targetId, damage: msg.damage, sourceId: playerId }); break; }
            case 'toggle_ready': { if (!player.roomId) { sendError(ws, 'Not in room'); break; } const r = rooms.get(player.roomId); if (!r || r.inGame) { sendError(ws, 'Cannot ready'); break; } player.ready = !player.ready; broadcastToRoom(player.roomId, { type: 'player_ready_changed', playerId, ready: player.ready }); break; }
            case 'start_match': { if (!player.roomId) { sendError(ws, 'Not in room'); break; } const r = rooms.get(player.roomId); if (!r) break; if (r.hostPlayerId !== playerId) { sendError(ws, 'Only host'); break; } if (r.inGame) { sendError(ws, 'Already started'); break; } if (r.players.length < 2) { sendError(ws, 'Need 2+ players'); break; } if (!checkAllReady(r)) { sendError(ws, 'Not ready'); break; } r.inGame = true; broadcastToRoom(player.roomId, { type: 'game_start', players: r.players.map(p => ({ id: p.id, name: p.name })), map: r.map, teamSize: r.teamSize }); break; }
            case 'kick_player': { if (!player.roomId) break; const r = rooms.get(player.roomId); if (!r || r.hostPlayerId !== playerId) break; const t = players.get(msg.targetId); if (t && t.roomId === player.roomId) { broadcastToRoom(player.roomId, { type: 'player_kicked', playerId: msg.targetId }); removePlayerFromRoom(t); } break; }
            case 'transfer_host': { if (!player.roomId) break; const r = rooms.get(player.roomId); if (!r || r.hostPlayerId !== playerId) break; const h = players.get(msg.targetId); if (h && h.roomId === player.roomId) { r.hostPlayerId = msg.targetId; broadcastToRoom(player.roomId, { type: 'host_changed', newHostId: msg.targetId, newHostName: h.name }); } break; }
        }
    });

    ws.on('close', () => { const pl = players.get(playerId); if (pl) { if (pl.roomId) removePlayerFromRoom(pl); players.delete(playerId); } });
    ws.on('error', () => { const pl = players.get(playerId); if (pl) { if (pl.roomId) removePlayerFromRoom(pl); players.delete(playerId); } });
});

server.listen(PORT, () => { console.log('DARK WARD Server running on port ' + PORT); });
