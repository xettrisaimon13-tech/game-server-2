const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'devsecret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://your-livekit-server.com';

const PORT = process.env.PORT || 7001;

function log(tag, msg) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + '] [' + tag + '] ' + msg);
}

// ============================================================
// JWT Token Generator (no deps, pure crypto)
// ============================================================
function base64url(data) {
    return Buffer.from(data).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createToken(identity, roomName, ttl) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: LIVEKIT_API_KEY,
        sub: identity,
        iat: now,
        nbf: now,
        exp: now + (ttl || 86400),
        name: identity,
        video: {
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        }
    };
    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', LIVEKIT_API_SECRET)
        .update(headerB64 + '.' + payloadB64)
        .digest('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return headerB64 + '.' + payloadB64 + '.' + signature;
}

// ============================================================
// HTTP Server (health + voice token)
// ============================================================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Voice token endpoint
    if (req.url && req.url.startsWith('/token')) {
        const url = new URL(req.url, 'http://localhost');
        const identity = url.searchParams.get('name') || url.searchParams.get('identity') || ('player_' + Math.random().toString(36).substr(2, 6));
        const room = url.searchParams.get('room') || 'dark-ward-default';
        const token = createToken(identity, room);
        log('VOICE', 'Token issued -> identity=' + identity + ' room=' + room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: token, url: LIVEKIT_URL, identity: identity, room: room }));
        return;
    }

    // Voice status endpoint - show connected voice users
    if (req.url === '/voice_status') {
        const voiceList = [];
        voiceUsers.forEach((v, id) => {
            voiceList.push({ id: id, name: v.name, mic: v.micOn, connected: v.connected });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ voiceUsers: voiceList, total: voiceUsers.size }));
        return;
    }

    // Game server status
    if (req.url === '/status') {
        let activePlayers = 0;
        let roomInfo = [];
        rooms.forEach((room, id) => {
            activePlayers += room.players.length;
            roomInfo.push({
                roomId: id,
                name: room.name,
                players: room.players.length + '/' + room.teamSize,
                inGame: room.inGame,
                playerNames: room.players.map(p => p.name)
            });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'OK',
            totalConnectedPlayers: players.size,
            totalActiveInRooms: activePlayers,
            totalRooms: rooms.size,
            totalVoiceUsers: voiceUsers.size,
            rooms: roomInfo
        }, null, 2));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DARK WARD Server\n/status - game status\n/voice_status - voice status\n/token - get livekit token');
});

// ============================================================
// WebSocket Server (game + voice in one)
// ============================================================
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const players = new Map();
const usedRoomIds = new Set();
const voiceUsers = new Map();

let nextPlayerId = 1;

function generateRoomId() {
    let id;
    do {
        id = 1000 + Math.floor(Math.random() * 9000);
    } while (usedRoomIds.has(id));
    usedRoomIds.add(id);
    return id;
}

function broadcastToRoom(roomId, message, excludeWs) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    room.players.forEach((player) => {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(data);
        }
    });
}

function sendTo(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function sendError(ws, message) {
    sendTo(ws, { type: 'error', message });
}

function sendStatus(ws, text) {
    sendTo(ws, { type: 'status', text });
}

function getRoomList() {
    const list = [];
    rooms.forEach((room, id) => {
        const hostPlayer = room.players.find(p => p.id === room.hostPlayerId);
        list.push({
            id: id, roomId: id, name: room.name,
            hostName: hostPlayer ? hostPlayer.name : 'Unknown',
            players: room.players.length, maxPlayers: room.teamSize,
            map: room.map, inGame: room.inGame,
            hasPassword: !!(room.password && room.password !== ''),
            isPrivate: !!room.isPrivate,
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
    player.roomId = null;
    player.ready = false;

    if (room.players.length === 0) {
        rooms.delete(leftRoomId);
        usedRoomIds.delete(leftRoomId);
        return null;
    }
    if (wasHost) {
        const newHost = room.players[0];
        room.hostPlayerId = newHost.id;
        broadcastToRoom(leftRoomId, { type: 'host_changed', newHostId: newHost.id, newHostName: newHost.name });
    }
    return leftRoomId;
}

function joinRoom(player, room, roomId) {
    if (player.roomId) removePlayerFromRoom(player);
    player.roomId = roomId;
    player.ready = false;
    room.players.push(player);
    if (!player.name || player.name.trim() === '') player.name = 'Player ' + room.players.length;

    sendTo(player.ws, {
        type: 'room_joined', roomId: roomId, roomName: room.name,
        teamSize: room.teamSize, map: room.map,
        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
        hostId: room.hostPlayerId,
        items: Object.values(room.items || {})
    });
    broadcastToRoom(roomId, { type: 'player_joined', playerId: player.id, name: player.name }, player.ws);
}

// ============================================================
// Connection Handler
// ============================================================
wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    players.set(playerId, {
        ws, id: playerId, name: 'Player' + playerId,
        roomId: null, ready: false,
        position: null, rotation: null, animation: null,
        crouching: false, flashlight: false, health: 100
    });

    log('GAME', 'Player connected -> id=' + playerId);
    sendTo(ws, { type: 'welcome', playerId: playerId });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        const player = players.get(playerId);
        if (!player) return;

        switch (msg.type) {

            // ---- VOICE EVENTS ----
            case 'voice_connect': {
                const vName = msg.name || player.name;
                voiceUsers.set(playerId, { name: vName, micOn: false, connected: true, ws: ws });
                log('VOICE', 'CONNECTED -> ' + vName + ' (id=' + playerId + ') | Total voice: ' + voiceUsers.size);
                sendStatus(ws, 'Voice connected');
                break;
            }
            case 'voice_disconnect': {
                const vUser = voiceUsers.get(playerId);
                if (vUser) {
                    log('VOICE', 'DISCONNECTED -> ' + vUser.name + ' (id=' + playerId + ') | Total voice: ' + (voiceUsers.size - 1));
                    voiceUsers.delete(playerId);
                }
                break;
            }
            case 'mic_on': {
                const vu = voiceUsers.get(playerId);
                if (vu) { vu.micOn = true; log('VOICE', 'MIC ON -> ' + vu.name + ' (id=' + playerId + ')'); }
                break;
            }
            case 'mic_off': {
                const vu2 = voiceUsers.get(playerId);
                if (vu2) { vu2.micOn = false; log('VOICE', 'MIC OFF -> ' + vu2.name + ' (id=' + playerId + ')'); }
                break;
            }
            case 'speaker_on': {
                log('VOICE', 'SPEAKER ON -> ' + player.name + ' (id=' + playerId + ')');
                break;
            }
            case 'speaker_off': {
                log('VOICE', 'SPEAKER OFF -> ' + player.name + ' (id=' + playerId + ')');
                break;
            }

            // ---- GAME EVENTS ----
            case 'set_name': {
                const newName = (msg.name || '').trim() || 'Player' + playerId;
                if (player.roomId) {
                    const room = rooms.get(player.roomId);
                    if (room) {
                        const nameTaken = room.players.some(op => op.id !== playerId && op.name === newName);
                        player.name = nameTaken ? newName + '_' + Math.floor(Math.random() * 100) : newName;
                    } else { player.name = newName; }
                } else { player.name = newName; }
                break;
            }

            case 'get_rooms':
                sendTo(ws, { type: 'room_list', rooms: getRoomList() });
                break;

            case 'create_room': {
                if (player.roomId) removePlayerFromRoom(player);
                log('GAME', player.name + ' created room "' + (msg.roomName || 'Room') + '"');
                const roomId = generateRoomId();
                const room = {
                    id: roomId, name: msg.roomName || 'Room', hostPlayerId: playerId,
                    password: msg.password || '', isPrivate: !!msg.isPrivate,
                    players: [], map: msg.map || 'Hospital',
                    teamSize: msg.teamSize || 2, inGame: false,
                    doorStates: {}, items: {}, createdAt: Date.now()
                };
                player.roomId = roomId; player.ready = false;
                room.players.push(player);
                if (!player.name || player.name.trim() === '') player.name = 'Player ' + room.players.length;
                rooms.set(roomId, room);

                sendTo(ws, { type: 'room_created', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map, hasPassword: room.password !== '' });
                sendTo(ws, {
                    type: 'room_joined', roomId, roomName: room.name, teamSize: room.teamSize, map: room.map,
                    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
                    hostId: room.hostPlayerId,
                    items: Object.values(room.items || {})
                });
                break;
            }

            case 'join_room': {
                const targetRoomId = msg.roomId ? Number(msg.roomId) : null;
                const roomName = msg.roomName || '';
                const password = msg.password || '';
                log('GAME', player.name + ' joining room id=' + targetRoomId + ' name="' + roomName + '"');
                let targetRoom = null;
                let foundRoomId = null;
                let existingRoomInGame = false;

                if (targetRoomId && rooms.has(targetRoomId)) {
                    const candidate = rooms.get(targetRoomId);
                    if (!candidate.inGame) { targetRoom = candidate; foundRoomId = targetRoomId; }
                    else { existingRoomInGame = true; }
                }
                if (!targetRoom) {
                    rooms.forEach((room, rid) => {
                        if (room.name === roomName) {
                            if (room.inGame) { existingRoomInGame = true; return; }
                            if (room.password && room.password !== password) return;
                            if (room.players.length >= room.teamSize) return;
                            targetRoom = room; foundRoomId = rid;
                        }
                    });
                }
                if (existingRoomInGame && !targetRoom) { sendError(ws, 'Room is already in a match'); break; }
                if (!targetRoom) { sendError(ws, 'Room does not exist'); break; }
                if (targetRoom.password && targetRoom.password !== password) { sendError(ws, 'Wrong password'); break; }
                if (targetRoom.players.length >= targetRoom.teamSize) { sendError(ws, 'Room is full'); break; }

                joinRoom(player, targetRoom, foundRoomId);
                log('GAME', player.name + ' joined room ' + foundRoomId + ' (' + targetRoom.players.length + '/' + targetRoom.teamSize + ')');
                break;
            }

            case 'quick_match': {
                let found = false;
                rooms.forEach((room, rid) => {
                    if (!found && !room.inGame && !room.isPrivate && !room.password && room.players.length < room.teamSize) {
                        joinRoom(player, room, rid); found = true;
                    }
                });
                if (!found) {
                    const roomId = generateRoomId();
                    const room = {
                        id: roomId, name: 'Quick Match', hostPlayerId: playerId,
                        password: '', isPrivate: false, players: [],
                        map: 'Hospital', teamSize: 2, inGame: false,
                        doorStates: {}, items: {}, createdAt: Date.now()
                    };
                    player.roomId = roomId; player.ready = false;
                    room.players.push(player); rooms.set(roomId, room);
                    sendTo(player.ws, {
                        type: 'room_joined', roomId, roomName: room.name,
                        teamSize: room.teamSize, map: room.map,
                        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
                        hostId: room.hostPlayerId,
                        items: Object.values(room.items || {})
                    });
                    sendStatus(ws, 'Waiting for players...');
                }
                log('GAME', player.name + ' quick match');
                break;
            }

            case 'leave_room': {
                if (player.roomId) {
                    log('GAME', player.name + ' left room ' + player.roomId);
                    removePlayerFromRoom(player);
                }
                break;
            }

            case 'player_sync': {
                if (!player.roomId) break;
                player.position = msg.position || player.position;
                player.rotation = msg.rotation || player.rotation;
                player.animation = msg.animation || player.animation;
                if (msg.crouching !== undefined) player.crouching = msg.crouching;
                if (msg.flashlight !== undefined) player.flashlight = msg.flashlight;
                if (msg.health !== undefined) player.health = msg.health;
                var syncMsg = {
                    type: 'player_sync', playerId, name: player.name,
                    position: player.position, rotation: player.rotation,
                    animation: player.animation, crouching: player.crouching,
                    flashlight: player.flashlight, health: player.health
                };
                if (msg.doorEvent) syncMsg.doorEvent = msg.doorEvent;
                broadcastToRoom(player.roomId, syncMsg, ws);
                break;
            }

            case 'player_damage': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'player_damage', playerId: msg.targetId, damage: msg.damage, sourceId: playerId });
                break;
            }

            case 'door_sync': {
                if (!player.roomId) break;
                const dRoom = rooms.get(player.roomId);
                if (!dRoom) break;
                if (!dRoom.doorStates) dRoom.doorStates = {};
                dRoom.doorStates[msg.doorPath] = msg.isOpen;
                broadcastToRoom(player.roomId, { type: 'door_sync', doorPath: msg.doorPath, isOpen: msg.isOpen }, ws);
                break;
            }

            case 'item_drop': {
                if (!player.roomId) break;
                const iRoom = rooms.get(player.roomId);
                if (!iRoom) break;
                const id = (msg.id != null) ? String(msg.id) : ('' + Date.now());
                const item = {
                    id: id,
                    type: msg.itemType || 'flashlight',
                    position: msg.position || { x: 0, y: 0, z: 0 }
                };
                if (!iRoom.items) iRoom.items = {};
                iRoom.items[id] = item;
                broadcastToRoom(player.roomId, { type: 'item_drop', id: id, itemType: item.type, position: item.position }, ws);
                break;
            }

            case 'item_pickup': {
                if (!player.roomId) break;
                const pRoom = rooms.get(player.roomId);
                if (!pRoom || !pRoom.items) break;
                const id = String(msg.id);
                if (pRoom.items[id]) {
                    delete pRoom.items[id];
                    broadcastToRoom(player.roomId, { type: 'item_pickup', id: id }, ws);
                }
                break;
            }

            case 'audio_data': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'audio_data', playerId, data: msg.data }, ws);
                break;
            }

            case 'mic_state': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'mic_state', playerId, on: msg.on }, ws);
                break;
            }

            case 'toggle_ready': {
                if (!player.roomId) { sendError(ws, 'You are not in a room'); break; }
                const room = rooms.get(player.roomId);
                if (!room || room.inGame) { sendError(ws, 'Cannot ready now'); break; }
                player.ready = !player.ready;
                log('GAME', player.name + (player.ready ? ' READY' : ' NOT READY'));
                broadcastToRoom(player.roomId, { type: 'player_ready_changed', playerId, ready: player.ready });
                break;
            }

            case 'start_match': {
                if (!player.roomId) { sendError(ws, 'You are not in a room'); break; }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.hostPlayerId !== playerId) { sendError(ws, 'Only host can start'); break; }
                if (room.inGame) { sendError(ws, 'Game already started'); break; }
                room.inGame = true; room.doorStates = {};
                log('GAME', 'MATCH START in room ' + player.roomId + ' with ' + room.players.length + ' players');
                broadcastToRoom(player.roomId, {
                    type: 'game_start',
                    players: room.players.map(p => ({ id: p.id, name: p.name })),
                    map: room.map, teamSize: room.teamSize
                });
                break;
            }

            case 'kick_player': {
                if (!player.roomId) break;
                const room = rooms.get(player.roomId);
                if (!room || room.hostPlayerId !== playerId) break;
                const targetPlayer = players.get(msg.targetId);
                if (targetPlayer && targetPlayer.roomId === player.roomId) {
                    log('GAME', player.name + ' kicked ' + targetPlayer.name);
                    broadcastToRoom(player.roomId, { type: 'player_kicked', playerId: msg.targetId });
                    removePlayerFromRoom(targetPlayer);
                }
                break;
            }

            case 'transfer_host': {
                if (!player.roomId) break;
                const room = rooms.get(player.roomId);
                if (!room || room.hostPlayerId !== playerId) break;
                const newHost = players.get(msg.targetId);
                if (newHost && newHost.roomId === player.roomId) {
                    room.hostPlayerId = newHost.id;
                    log('GAME', player.name + ' transferred host to ' + newHost.name);
                    broadcastToRoom(player.roomId, { type: 'host_changed', newHostId: newHost.id, newHostName: newHost.name });
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        const pl = players.get(playerId);
        if (pl) {
            log('GAME', 'Player disconnected -> ' + pl.name + ' (id=' + playerId + ')');
            if (pl.roomId) removePlayerFromRoom(pl);
            players.delete(playerId);
        }
        const vu = voiceUsers.get(playerId);
        if (vu) {
            log('VOICE', 'DISCONNECTED (socket close) -> ' + vu.name + ' (id=' + playerId + ')');
            voiceUsers.delete(playerId);
        }
    });

    ws.on('error', (err) => {
        log('ERROR', 'WebSocket error id=' + playerId + ': ' + err.message);
        const pl = players.get(playerId);
        if (pl) {
            if (pl.roomId) removePlayerFromRoom(pl);
            players.delete(playerId);
        }
        voiceUsers.delete(playerId);
    });
});

// ============================================================
// Server Start
// ============================================================
server.listen(PORT, () => {
    log('SERVER', 'DARK WARD Server running on port ' + PORT);
    log('SERVER', 'Game WebSocket: ws://0.0.0.0:' + PORT);
    log('SERVER', 'Voice token: http://0.0.0.0:' + PORT + '/token');
    log('SERVER', 'Status: http://0.0.0.0:' + PORT + '/status');
    log('SERVER', 'Voice status: http://0.0.0.0:' + PORT + '/voice_status');
    log('SERVER', 'LiveKit URL: ' + LIVEKIT_URL);
});
