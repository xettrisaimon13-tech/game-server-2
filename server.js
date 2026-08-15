const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 7001;

function log(tag, msg) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + '] [' + tag + '] ' + msg);
}

const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DARK WARD - Server Status</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a12;color:#e0e0e0;font-family:'Segoe UI',Tahoma,sans-serif;min-height:100vh}
.header{background:linear-gradient(135deg,#1a0a2e,#0d1b2a);padding:30px 40px;border-bottom:2px solid #7b2ff2}
.header h1{font-size:28px;color:#fff;letter-spacing:3px}
.header h1 span{color:#7b2ff2}
.header p{color:#8888aa;margin-top:6px;font-size:14px}
.container{max-width:900px;margin:30px auto;padding:0 20px}
.status-box{background:#12121e;border:1px solid #2a2a3a;border-radius:12px;padding:24px;margin-bottom:20px}
.status-box h2{font-size:16px;color:#7b2ff2;margin-bottom:16px;text-transform:uppercase;letter-spacing:2px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1a1a2a}
.stat-row:last-child{border-bottom:none}
.stat-label{color:#8888aa;font-size:14px}
.stat-value{font-size:18px;font-weight:700;color:#fff}
.green-dot{display:inline-block;width:10px;height:10px;background:#00e676;border-radius:50%;margin-right:8px;box-shadow:0 0 8px #00e67680;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.region-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:12px}
.region-card{background:#1a1a2a;border:1px solid #2a2a3a;border-radius:8px;padding:16px;text-align:center}
.region-card.active{border-color:#00e676}
.region-card .name{font-size:13px;color:#8888aa;text-transform:uppercase;letter-spacing:1px}
.region-card .count{font-size:28px;font-weight:700;color:#fff;margin:8px 0}
.region-card .dot{font-size:12px}
.region-card .dot .green-dot{width:8px;height:8px}
.room-list{margin-top:12px}
.room-item{background:#1a1a2a;border:1px solid #2a2a3a;border-radius:8px;padding:14px 18px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.room-item .left{display:flex;flex-direction:column;gap:4px}
.room-item .room-name{color:#fff;font-weight:600;font-size:15px}
.room-item .room-info{color:#666;font-size:12px}
.room-item .right{display:flex;align-items:center;gap:12px}
.room-item .players-badge{background:#2a2a3a;padding:4px 12px;border-radius:20px;font-size:13px;color:#e0e0e0}
.room-item .map-badge{color:#7b2ff2;font-size:12px;text-transform:uppercase}
.room-item .status-badge{padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase}
.room-item .status-badge.lobby{background:#1a3a1a;color:#00e676}
.room-item .status-badge.ingame{background:#3a1a1a;color:#ff5252}
.no-rooms{color:#444;font-size:14px;text-align:center;padding:20px}
.online-total{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.online-total .big{font-size:36px;font-weight:700;color:#00e676}
.online-total .label{color:#8888aa;font-size:14px}
.footer{text-align:center;padding:20px;color:#333;font-size:12px;margin-top:20px}
</style>
</head>
<body>
<div class="header">
<h1><span>DARK</span> WARD</h1>
<p>Multiplayer Game Server Status</p>
</div>
<div class="container">
<div class="status-box">
<h2>Server Status</h2>
<div class="online-total">
<span class="green-dot"></span>
<span class="big">__TOTAL_ONLINE__</span>
<span class="label">Players Online</span>
</div>
<div class="stat-row">
<span class="stat-label">Active Rooms</span>
<span class="stat-value">__TOTAL_ROOMS__</span>
</div>
<div class="stat-row">
<span class="stat-label">In-Match Players</span>
<span class="stat-value">__IN_MATCH__</span>
</div>
</div>
<div class="status-box">
<h2>Regions</h2>
<div class="region-grid">
__REGIONS__
</div>
</div>
<div class="status-box">
<h2>Active Rooms</h2>
<div class="room-list">
__ROOMS__
</div>
</div>
</div>
<div class="footer">DARK WARD Server v2.0</div>
</body>
</html>`;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/status' || req.url === '/') {
        let activePlayers = 0;
        let inMatchPlayers = 0;
        let roomInfo = [];
        rooms.forEach((room, id) => {
            activePlayers += room.players.length;
            if (room.inGame) inMatchPlayers += room.players.length;
            const host = room.players.find(p => p.id === room.hostPlayerId);
            roomInfo.push({
                roomId: id, name: room.name,
                players: room.players.length + '/' + room.teamSize,
                inGame: room.inGame, isNightMode: room.isNightMode,
                playerNames: room.players.map(p => p.name),
                hostName: host ? host.name : 'Unknown',
                map: room.map
            });
        });

        const regionCounts = {};
        ['Asia','Europe','North America','South America','Middle East','Africa','Oceania'].forEach(r => regionCounts[r] = 0);
        players.forEach(p => {
            const r = p.region || 'Asia';
            if (regionCounts[r] !== undefined) regionCounts[r]++;
        });

        let regionsHtml = '';
        ['Asia','Europe','North America','South America','Middle East','Africa','Oceania'].forEach(r => {
            const count = regionCounts[r];
            const isActive = count > 0;
            regionsHtml += '<div class="region-card' + (isActive ? ' active' : '') + '">' +
                '<div class="name">' + r + '</div>' +
                '<div class="count">' + count + '</div>' +
                '<div class="dot"><span class="green-dot"></span>Online</div>' +
                '</div>';
        });

        let roomsHtml = '';
        if (roomInfo.length === 0) {
            roomsHtml = '<div class="no-rooms">No active rooms</div>';
        } else {
            roomInfo.forEach(r => {
                roomsHtml += '<div class="room-item">' +
                    '<div class="left">' +
                    '<div class="room-name">' + r.name + ' (#' + r.roomId + ')</div>' +
                    '<div class="room-info">Host: ' + r.hostName + ' | ' + r.playerNames.join(', ') + '</div>' +
                    '</div>' +
                    '<div class="right">' +
                    '<span class="map-badge">' + r.map + '</span>' +
                    '<span class="players-badge">' + r.players + '</span>' +
                    '<span class="status-badge ' + (r.inGame ? 'ingame' : 'lobby') + '">' + (r.inGame ? 'In Match' : 'Lobby') + '</span>' +
                    '</div>' +
                    '</div>';
            });
        }

        let html = STATUS_HTML
            .replace('__TOTAL_ONLINE__', players.size)
            .replace('__TOTAL_ROOMS__', rooms.size)
            .replace('__IN_MATCH__', inMatchPlayers)
            .replace('__REGIONS__', regionsHtml)
            .replace('__ROOMS__', roomsHtml);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    if (req.url === '/api/status') {
        let activePlayers = 0;
        let roomInfo = [];
        rooms.forEach((room, id) => {
            activePlayers += room.players.length;
            roomInfo.push({
                roomId: id, name: room.name,
                players: room.players.length + '/' + room.teamSize,
                inGame: room.inGame, isNightMode: room.isNightMode,
                playerNames: room.players.map(p => p.name)
            });
        });
        const regionCounts = {};
        ['Asia','Europe','North America','South America','Middle East','Africa','Oceania'].forEach(r => regionCounts[r] = 0);
        players.forEach(p => {
            const r = p.region || 'Asia';
            if (regionCounts[r] !== undefined) regionCounts[r]++;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'OK',
            totalConnectedPlayers: players.size,
            totalActiveInRooms: activePlayers,
            totalRooms: rooms.size,
            regions: regionCounts,
            rooms: roomInfo
        }, null, 2));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DARK WARD Server\n/status - HTML\n/api/status - JSON');
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
    room.players.forEach(p => {
        if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(data);
        }
    });
}

function sendTo(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function sendError(ws, message) { sendTo(ws, { type: 'error', message }); }
function sendStatus(ws, text) { sendTo(ws, { type: 'status', text }); }

function getRoomList(region) {
    const list = [];
    rooms.forEach((room, id) => {
        if (region && room.region !== region) return;
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

function getOnlineByRegion(region) {
    let count = 0;
    players.forEach(p => {
        if ((p.region || 'Asia') === region) count++;
    });
    return count;
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
        if (room.ghostTimer) clearInterval(room.ghostTimer);
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
    const now = Date.now();
    sendTo(player.ws, {
        type: 'room_joined', roomId: roomId, roomName: room.name,
        teamSize: room.teamSize, map: room.map,
        isNightMode: room.isNightMode !== undefined ? room.isNightMode : true,
        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false, characterId: p.characterId || '' })),
        hostId: room.hostPlayerId,
        items: Object.values(room.items || {}),
        elapsed: now - room.createdAt
    });
    broadcastToRoom(roomId, { type: 'player_joined', playerId: player.id, name: player.name, characterId: player.characterId || '' }, player.ws);
}

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    players.set(playerId, {
        ws, id: playerId, name: 'Player' + playerId,
        roomId: null, ready: false,
        position: null, rotation: null, animation: null,
        crouching: false, flashlight: false, health: 100,
        inventory: {}, region: 'Asia'
    });
    log('CONNECT', 'Player connected -> Player' + playerId + ' (id=' + playerId + ')');
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

            case 'get_rooms': {
                const region = player.region || 'Asia';
                sendTo(ws, {
                    type: 'room_list',
                    rooms: getRoomList(region),
                    onlineCount: getOnlineByRegion(region),
                    region: region
                });
                break;
            }

            case 'get_online': {
                const region = msg.region || player.region || 'Asia';
                sendTo(ws, {
                    type: 'online_count',
                    region: region,
                    count: getOnlineByRegion(region),
                    total: players.size
                });
                break;
            }

            case 'set_region': {
                const validRegions = ['Asia', 'Europe', 'North America', 'South America', 'Middle East', 'Africa', 'Oceania'];
                if (validRegions.includes(msg.region)) {
                    player.region = msg.region;
                    log('REGION', player.name + ' set region to ' + msg.region);
                }
                break;
            }

            case 'create_room': {
                if (player.roomId) removePlayerFromRoom(player);
                const roomName = msg.roomName || 'Room';
                const rid = generateRoomId();
                const isNightMode = msg.isNightMode !== undefined ? msg.isNightMode : true;
                const room = {
                    id: rid, name: roomName, hostPlayerId: playerId,
                    password: msg.password || '', isPrivate: !!msg.isPrivate,
                    players: [], map: msg.map || 'Hospital',
                    teamSize: msg.teamSize || 6, inGame: false,
                    doorStates: {}, items: {},
                    isNightMode: isNightMode, region: msg.region || player.region || 'Asia',
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
                    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false, characterId: p.characterId || '' })),
                    hostId: room.hostPlayerId,
                    items: Object.values(room.items || {}),
                    elapsed: 0
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
                if (targetRoom.region !== (player.region || 'Asia')) { sendError(ws, 'Room is in a different server region. Change your region to ' + targetRoom.region); break; }
                joinRoom(player, targetRoom, foundRoomId);
                break;
            }

            case 'quick_match': {
                let found = false;
                rooms.forEach((room, rid) => {
                    if (room.region !== player.region) return;
                    if (!found && !room.inGame && !room.isPrivate && !room.password && room.players.length < room.teamSize) {
                        joinRoom(player, room, rid); found = true;
                    }
                });
                if (!found) {
                    const rid = generateRoomId();
                    const room = {
                        id: rid, name: 'Quick Match', hostPlayerId: playerId,
                        password: '', isPrivate: false, players: [],
                        map: 'Hospital', teamSize: 6, inGame: false,
                        doorStates: {}, items: {}, isNightMode: true,
                        region: player.region || 'Asia',
                        createdAt: Date.now()
                    };
                    player.roomId = rid; player.ready = false;
                    room.players.push(player); rooms.set(rid, room);
                    sendTo(player.ws, {
                        type: 'room_joined', roomId: rid, roomName: room.name,
                        teamSize: room.teamSize, map: room.map,
                        isNightMode: true,
                        players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready || false, characterId: p.characterId || '' })),
                        hostId: room.hostPlayerId,
                        items: Object.values(room.items || {}),
                        elapsed: 0
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
                if (msg.characterId !== undefined) player.characterId = msg.characterId;
                if (msg.hidden !== undefined) player.hidden = msg.hidden;
                const syncMsg = {
                    type: 'player_sync', playerId, name: player.name,
                    position: player.position, rotation: player.rotation,
                    animation: player.animation, crouching: player.crouching,
                    flashlight: player.flashlight, health: player.health,
                    heldItem: player.heldItem || '',
                    characterId: player.characterId || '',
                    hidden: player.hidden || false
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

            case 'player_lives': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'player_lives', playerId: playerId, lives: msg.lives, health: msg.health }, ws);
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
                const id = (msg.id != null) ? String(msg.id) : ('drop_' + Date.now() + '_' + playerId);
                const item = {
                    id: id,
                    type: msg.itemType || 'flashlight',
                    position: msg.position || { x: 0, y: 0, z: 0 },
                    droppedBy: playerId
                };
                if (!ir.items) ir.items = {};
                ir.items[id] = item;
                log('DROP', player.name + ' dropped ' + item.type + ' (id=' + id + ')');
                broadcastToRoom(player.roomId, {
                    type: 'item_drop',
                    id: id,
                    itemType: item.type,
                    position: item.position
                }, ws);
                break;
            }

            case 'item_pickup': {
                if (!player.roomId) break;
                const pr = rooms.get(player.roomId);
                if (!pr) break;
                const pickupId = String(msg.id);
                if (pr.items) {
                    const pickedItem = pr.items[pickupId];
                    if (pickedItem) {
                        log('PICKUP', player.name + ' picked up ' + pickedItem.type + ' (id=' + pickupId + ')');
                    }
                    delete pr.items[pickupId];
                }
                broadcastToRoom(player.roomId, {
                    type: 'item_pickup',
                    id: pickupId
                }, ws);
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
                room.items = {};
                const isNightMode = msg.isNightMode !== undefined ? msg.isNightMode : room.isNightMode;
                room.isNightMode = isNightMode;
                log('MATCH', '=== MATCH START === Room ' + player.roomId + ' (' + room.name + ') | Players: ' + room.players.length + '/' + room.teamSize + ' | Night: ' + isNightMode + ' | Map: ' + room.map);
                room.players.forEach(p => {
                    log('PLAYER', '  -> ' + p.name + ' (id=' + p.id + ') character=' + (p.characterId || 'none'));
                });
                broadcastToRoom(player.roomId, {
                    type: 'game_start',
                    players: room.players.map(p => ({ id: p.id, name: p.name, characterId: p.characterId || '' })),
                    map: room.map, teamSize: room.teamSize,
                    isNightMode: isNightMode
                });
                break;
            }

            case 'ping': {
                sendTo(ws, { type: 'pong', time: msg.time });
                break;
            }

            case 'kick_player': {
                if (!player.roomId) break;
                const room = rooms.get(player.roomId);
                if (!room || room.hostPlayerId !== playerId) break;
                const tp = players.get(msg.targetId);
                if (tp && tp.roomId === player.roomId) {
                    log('KICK', player.name + ' kicked ' + tp.name + ' from room ' + player.roomId);
                    broadcastToRoom(player.roomId, { type: 'player_kicked', playerId: msg.targetId, kickedByName: player.name });
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

            case 'ghost_sync': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, {
                    type: 'ghost_update',
                    ghosts: msg.ghosts || []
                }, ws);
                break;
            }

            case 'weapon_sync': {
                if (!player.roomId) break;
                const wsData = msg.data || {};
                wsData.player_id = wsData.player_id || playerId;
                log('WEAPON', player.name + ' weapon_sync: ' + (wsData.type || 'unknown'));
                broadcastToRoom(player.roomId, {
                    type: 'weapon_sync',
                    data: wsData
                }, ws);
                break;
            }

            case 'mic_state': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'mic_state', playerId: playerId, on: msg.on }, ws);
                break;
            }

            case 'chat_message': {
                if (!player.roomId) break;
                const text = (msg.text || '').trim();
                if (text.length === 0) break;
                broadcastToRoom(player.roomId, {
                    type: 'chat_message',
                    playerId: playerId,
                    name: player.name,
                    text: text
                }, ws);
                log('CHAT', '[' + player.roomId + '] ' + player.name + ': ' + text);
                break;
            }

            case 'player_death': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'player_death', playerId: playerId, name: player.name }, ws);
                log('DEATH', player.name + ' died in room ' + player.roomId);
                break;
            }

            case 'game_over_all': {
                if (!player.roomId) break;
                const room5 = rooms.get(player.roomId);
                if (room5 && room5.hostPlayerId === playerId) {
                    broadcastToRoom(player.roomId, { type: 'game_over_all' }, ws);
                    room5.inGame = false;
                    log('GAMEOVER', 'Host died - game over for room ' + player.roomId);
                }
                break;
            }

            case 'ghost_damage_relay': {
                if (!player.roomId) break;
                const room6 = rooms.get(player.roomId);
                if (!room6 || room6.hostPlayerId !== playerId) break;
                const dmgTarget = players.get(msg.targetId);
                if (dmgTarget && dmgTarget.roomId === player.roomId) {
                    sendTo(dmgTarget.ws, { type: 'ghost_damage', damage: msg.damage });
                }
                break;
            }

            case 'spectator_status': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, { type: 'spectator_status', playerId: msg.playerId, spectating: msg.spectating });
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
    log('SERVER', 'Status UI: http://0.0.0.0:' + PORT + '/status');
    log('SERVER', 'Status API: http://0.0.0.0:' + PORT + '/api/status');
    log('SERVER', '=========================================');
});
