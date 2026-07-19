const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 7001;

function log(tag, msg) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + '] [' + tag + '] ' + msg);
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/status') {
        let activePlayers = 0;
        let roomInfo = [];
        rooms.forEach((room, id) => {
            activePlayers += room.players.length;
            roomInfo.push({ roomId: id, name: room.name, players: room.players.length + '/' + room.teamSize, inGame: room.inGame, isNightMode: room.isNightMode, playerNames: room.players.map(p => p.name) });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', totalConnectedPlayers: players.size, totalActiveInRooms: activePlayers, totalRooms: rooms.size, rooms: roomInfo }, null, 2));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DARK WARD GAME Server\n/status');
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

function broadcastToRoom(roomId, message, excludeWs) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    room.players.forEach(p => { if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(data); });
}

function sendTo(ws, message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function sendError(ws, message) { sendTo(ws, { type: 'error', message }); }
function sendStatus(ws, text) { sendTo(ws, { type: 'status', text }); }

function getRoomList() {
    const list = [];
    rooms.forEach((room, id) => {
        const host = room.players.find(p => p.id === room.hostPlayerId);
        list.push({
            id: id, roomId: id, name: room.name,
            hostName: host ? host.name : 'Unknown',
            players: room.players.length, maxPlayers: room.teamSize,
            map: room.map, inGame: room.inGame,
            hasPassword: !!(room.password && room.password !== ''),
            isPrivate: !!room.isPrivate,
            isNightMode: room.isNightMode !== undefined ? room.isNightMode : true,
            playerNames: room.players.map(p => p.name),
            playerCount: room.players.length
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
    const dropItems = player.inventory || {};
    const dropPos = player.position || null;
    log('LEAVE', player.name + ' left room ' + leftRoomId + ' (' + room.players.length + '/' + room.teamSize + ' remaining)');
    broadcastToRoom(leftRoomId, { type: 'player_left', playerId: player.id, name: player.name, inventory: dropItems, position: dropPos }, player.ws);
    player.roomId = null; player.ready = false;
    if (room.players.length === 0) {
        log('ROOM', 'Room ' + leftRoomId + ' destroyed (empty)');
        rooms.delete(leftRoomId); usedRoomIds.delete(leftRoomId); return null;
    }
    if (wasHost) {
        const nh = room.players[0];
        room.hostPlayerId = nh.id;
        log('HOST', 'Host transferred to ' + nh.name + ' (id=' + nh.id + ') in room ' + leftRoomId);
        broadcastToRoom(leftRoomId, { type: 'host_changed', newHostId: nh.id, newHostName: nh.name });
    }
    return leftRoomId;
}

function joinRoom(player, room, roomId) {
    if (player.roomId) removePlayerFromRoom(player);
    player.roomId = roomId; player.ready = false;
    room.players.push(player);
    if (!player.name || player.name.trim() === '') player.name = 'Player ' + room.players.length;
    log('JOIN', player.name + ' joined room ' + roomId + ' (' + room.players.length + '/' + room.teamSize + ')');
    sendTo(player.ws, {
        type: 'room_joined', roomId: roomId, roomName: room.name,
        teamSize: room.teamSize, map: room.map,
        isNightMode: room.isNightMode !== undefined ? room.isNightMode : true,
        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
        hostId: room.hostPlayerId, items: Object.values(room.items || {})
    });
    broadcastToRoom(roomId, { type: 'player_joined', playerId: player.id, name: player.name }, player.ws);
}

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    players.set(playerId, { ws, id: playerId, name: 'Player' + playerId, roomId: null, ready: false, position: null, rotation: null, animation: null, crouching: false, flashlight: false, health: 100, inventory: {} });
    log('CONNECT', 'Player connected -> ' + 'Player' + playerId + ' (id=' + playerId + ')');
    sendTo(ws, { type: 'welcome', playerId: playerId });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        const player = players.get(playerId);
        if (!player) return;

        switch (msg.type) {
            case 'set_name': {
                const nn = (msg.name || '').trim() || 'Player' + playerId;
                if (player.roomId) {
                    const room = rooms.get(player.roomId);
                    if (room) {
                        const taken = room.players.some(op => op.id !== playerId && op.name === nn);
                        player.name = taken ? nn + '_' + Math.floor(Math.random() * 100) : nn;
                    }
                } else {
                    player.name = nn;
                }
                log('NAME', 'Player ' + playerId + ' set name to "' + player.name + '"');
                break;
            }
            case 'get_rooms': sendTo(ws, { type: 'room_list', rooms: getRoomList() }); break;

            case 'create_room': {
                if (player.roomId) removePlayerFromRoom(player);
                const roomName = msg.roomName || 'Room';
                const rid = generateRoomId();
                const isNightMode = msg.isNightMode !== undefined ? msg.isNightMode : true;
                const room = {
                    id: rid, name: roomName, hostPlayerId: playerId,
                    password: msg.password || '', isPrivate: !!msg.isPrivate,
                    players: [], map: msg.map || 'Hospital',
                    teamSize: msg.teamSize || 2, inGame: false,
                    doorStates: {}, items: {},
                    isNightMode: isNightMode,
                    createdAt: Date.now()
                };
                player.roomId = rid; player.ready = false;
                room.players.push(player);
                if (!player.name || player.name.trim() === '') player.name = 'Player ' + room.players.length;
                rooms.set(rid, room);
                log('CREATE', player.name + ' created room "' + roomName + '" (id=' + rid + ', night=' + isNightMode + ', max=' + room.teamSize + ')');
                sendTo(ws, { type: 'room_created', roomId: rid, roomName: room.name, teamSize: room.teamSize, map: room.map, hasPassword: room.password !== '' });
                sendTo(ws, {
                    type: 'room_joined', roomId: rid, roomName: room.name,
                    teamSize: room.teamSize, map: room.map,
                    isNightMode: isNightMode,
                    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
                    hostId: room.hostPlayerId, items: Object.values(room.items || {})
                });
                break;
            }

            case 'join_room': {
                const targetRoomId = msg.roomId ? Number(msg.roomId) : null;
                const roomName = msg.roomName || '';
                const pwd = msg.password || '';
                let targetRoom = null, foundRoomId = null, existingRoomInGame = false;
                if (targetRoomId && rooms.has(targetRoomId)) {
                    const cand = rooms.get(targetRoomId);
                    if (!cand.inGame) { targetRoom = cand; foundRoomId = targetRoomId; }
                    else existingRoomInGame = true;
                }
                if (!targetRoom) {
                    rooms.forEach((room, rid) => {
                        if (room.name === roomName) {
                            if (room.inGame) { existingRoomInGame = true; return; }
                            if (room.password && room.password !== pwd) return;
                            if (room.players.length >= room.teamSize) return;
                            targetRoom = room; foundRoomId = rid;
                        }
                    });
                }
                if (existingRoomInGame && !targetRoom) { sendError(ws, 'Room is already in a match'); break; }
                if (!targetRoom) { sendError(ws, 'Room does not exist'); break; }
                if (targetRoom.password && targetRoom.password !== pwd) { sendError(ws, 'Wrong password'); break; }
                if (targetRoom.players.length >= targetRoom.teamSize) { sendError(ws, 'Room is full'); break; }
                joinRoom(player, targetRoom, foundRoomId);
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
                    const rid = generateRoomId();
                    const room = {
                        id: rid, name: 'Quick Match', hostPlayerId: playerId,
                        password: '', isPrivate: false, players: [],
                        map: 'Hospital', teamSize: 2, inGame: false,
                        doorStates: {}, items: {}, isNightMode: true,
                        createdAt: Date.now()
                    };
                    player.roomId = rid; player.ready = false;
                    room.players.push(player); rooms.set(rid, room);
                    sendTo(player.ws, {
                        type: 'room_joined', roomId: rid, roomName: room.name,
                        teamSize: room.teamSize, map: room.map,
                        isNightMode: true,
                        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false })),
                        hostId: room.hostPlayerId, items: Object.values(room.items || {})
                    });
                    sendStatus(ws, 'Waiting for players...');
                }
                log('QUICK', player.name + ' quick match');
                break;
            }

            case 'leave_room': {
                if (player.roomId) {
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
                if (msg.heldItem !== undefined) player.heldItem = msg.heldItem;
                if (msg.inventory !== undefined) player.inventory = msg.inventory;
                const syncMsg = {
                    type: 'player_sync', playerId, name: player.name,
                    position: player.position, rotation: player.rotation,
                    animation: player.animation, crouching: player.crouching,
                    flashlight: player.flashlight, health: player.health,
                    heldItem: player.heldItem || ''
                };
                if (msg.doorEvent) syncMsg.doorEvent = msg.doorEvent;
                broadcastToRoom(player.roomId, syncMsg, ws);
                break;
            }

            case 'player_damage': {
                if (!player.roomId) break;
                log('COMBAT', player.name + ' dealt ' + msg.damage + ' damage to target ' + msg.targetId);
                broadcastToRoom(player.roomId, { type: 'player_damage', playerId: msg.targetId, damage: msg.damage, sourceId: playerId }, ws);
                break;
            }

            case 'door_sync': {
                if (!player.roomId) break;
                const dr = rooms.get(player.roomId);
                if (!dr) break;
                if (!dr.doorStates) dr.doorStates = {};
                dr.doorStates[msg.doorPath] = msg.isOpen;
                broadcastToRoom(player.roomId, { type: 'door_sync', doorPath: msg.doorPath, isOpen: msg.isOpen }, ws);
                break;
            }

            case 'item_drop': {
                if (!player.roomId) break;
                const ir = rooms.get(player.roomId);
                if (!ir) break;
                const id = (msg.id != null) ? String(msg.id) : ('' + Date.now());
                const item = { id: id, type: msg.itemType || 'flashlight', position: msg.position || { x: 0, y: 0, z: 0 } };
                if (!ir.items) ir.items = {};
                ir.items[id] = item;
                broadcastToRoom(player.roomId, { type: 'item_drop', id: id, itemType: item.type, position: item.position }, ws);
                break;
            }

            case 'item_pickup': {
                if (!player.roomId) break;
                const pr = rooms.get(player.roomId);
                if (pr && pr.items) { delete pr.items[String(msg.id)]; }
                broadcastToRoom(player.roomId, { type: 'item_pickup', id: String(msg.id) }, ws);
                break;
            }

            case 'toggle_ready': {
                if (!player.roomId) { sendError(ws, 'You are not in a room'); break; }
                const room = rooms.get(player.roomId);
                if (!room || room.inGame) { sendError(ws, 'Cannot ready now'); break; }
                player.ready = !player.ready;
                log('READY', player.name + (player.ready ? ' READY' : ' CANCELLED READY'));
                broadcastToRoom(player.roomId, { type: 'player_ready_changed', playerId, ready: player.ready });
                break;
            }

            case 'start_match': {
                if (!player.roomId) { sendError(ws, 'You are not in a room'); break; }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.hostPlayerId !== playerId) { sendError(ws, 'Only host can start'); break; }
                if (room.inGame) { sendError(ws, 'Game already started'); break; }
                room.inGame = true;
                room.doorStates = {};
                const isNightMode = msg.isNightMode !== undefined ? msg.isNightMode : room.isNightMode;
                room.isNightMode = isNightMode;
                log('MATCH', '=== MATCH START === Room ' + player.roomId + ' (' + room.name + ') | Players: ' + room.players.length + '/' + room.teamSize + ' | Night: ' + isNightMode + ' | Map: ' + room.map);
                room.players.forEach(p => {
                    log('PLAYER', '  -> ' + p.name + ' (id=' + p.id + ') IN MATCH');
                });
                broadcastToRoom(player.roomId, {
                    type: 'game_start',
                    players: room.players.map(p => ({ id: p.id, name: p.name })),
                    map: room.map, teamSize: room.teamSize,
                    isNightMode: isNightMode
                });
                break;
            }

            case 'kick_player': {
                if (!player.roomId) break;
                const room = rooms.get(player.roomId);
                if (!room || room.hostPlayerId !== playerId) break;
                const tp = players.get(msg.targetId);
                if (tp && tp.roomId === player.roomId) {
                    log('KICK', player.name + ' kicked ' + tp.name + ' from room ' + player.roomId);
                    broadcastToRoom(player.roomId, { type: 'player_kicked', playerId: msg.targetId });
                    removePlayerFromRoom(tp);
                }
                break;
            }

            case 'transfer_host': {
                if (!player.roomId) break;
                const room = rooms.get(player.roomId);
                if (!room || room.hostPlayerId !== playerId) break;
                const nh = players.get(msg.targetId);
                if (nh && nh.roomId === player.roomId) {
                    room.hostPlayerId = nh.id;
                    log('HOST', player.name + ' transferred host to ' + nh.name + ' in room ' + player.roomId);
                    broadcastToRoom(player.roomId, { type: 'host_changed', newHostId: nh.id, newHostName: nh.name });
                }
                break;
            }

            case 'audio_data': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'audio_data', playerId: playerId, data: msg.data }, ws);
                break;
            }

            case 'mic_state': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'mic_state', playerId: playerId, on: msg.on }, ws);
                break;
            }
        }
    });

    ws.on('close', () => {
        const pl = players.get(playerId);
        if (pl) {
            log('DISCONNECT', pl.name + ' disconnected (id=' + playerId + ')' + (pl.roomId ? ' from room ' + pl.roomId : ''));
            if (pl.roomId) removePlayerFromRoom(pl);
            players.delete(playerId);
        }
    });

    ws.on('error', (err) => {
        log('ERROR', 'WS error id=' + playerId + ': ' + err.message);
        const pl = players.get(playerId);
        if (pl) {
            if (pl.roomId) removePlayerFromRoom(pl);
            players.delete(playerId);
        }
    });
});

server.listen(PORT, () => {
    log('SERVER', '=========================================');
    log('SERVER', 'DARK WARD GAME Server running');
    log('SERVER', 'Port: ' + PORT);
    log('SERVER', 'Game WS: ws://0.0.0.0:' + PORT);
    log('SERVER', 'Status: http://0.0.0.0:' + PORT + '/status');
    log('SERVER', '=========================================');
});
