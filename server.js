const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 7001;
const server = http.createServer((req, res) => {
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
            rooms: roomInfo
        }, null, 2));
        return;
    }
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
    do {
        id = 1000 + Math.floor(Math.random() * 9000);
    } while (usedRoomIds.has(id));
    usedRoomIds.add(id);
    return id;
}

function findRoomPlayer(room, playerId) {
    return room.players.find(p => p.id === playerId);
}

function broadcastToRoom(roomId, message, excludeWs = null) {
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
        const hostPlayer = findRoomPlayer(room, room.hostPlayerId);
        list.push({
            id: id,
            roomId: id,
            name: room.name,
            hostName: hostPlayer ? hostPlayer.name : 'Unknown',
            players: room.players.length,
            maxPlayers: room.teamSize,
            map: room.map,
            inGame: room.inGame,
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
    if (!room) {
        player.roomId = null;
        player.ready = false;
        return null;
    }

    room.players = room.players.filter(p => p.id !== player.id);
    const leftRoomId = player.roomId;
    const wasHost = room.hostPlayerId === player.id;

    broadcastToRoom(leftRoomId, {
        type: 'player_left',
        playerId: player.id,
        name: player.name
    }, player.ws);

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
        broadcastToRoom(leftRoomId, {
            type: 'host_changed',
            newHostId: newHost.id,
            newHostName: newHost.name
        });
    }

    return leftRoomId;
}

function joinRoom(player, room, roomId) {
    if (player.roomId) {
        removePlayerFromRoom(player);
    }

    player.roomId = roomId;
    player.ready = false;
    room.players.push(player);
    if (!player.name || player.name.trim() === '') {
        player.name = 'Player ' + room.players.length;
    }

    sendTo(player.ws, {
        type: 'room_joined',
        roomId: roomId,
        roomName: room.name,
        teamSize: room.teamSize,
        map: room.map,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            ready: p.ready || false
        })),
        hostId: room.hostPlayerId
    });

    broadcastToRoom(roomId, {
        type: 'player_joined',
        playerId: player.id,
        name: player.name
    }, player.ws);
}

function checkAllReady(room) {
    if (room.inGame) return false;
    if (room.players.length < 2) return false;
    return room.players.every(p => p.ready);
}

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    players.set(playerId, {
        ws,
        id: playerId,
        name: 'Player' + playerId,
        roomId: null,
        ready: false,
        position: null,
        rotation: null,
        animation: null,
        crouching: false,
        flashlight: false,
        health: 100
    });

    sendTo(ws, { type: 'welcome', playerId: playerId });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }

        const player = players.get(playerId);
        if (!player) return;

        switch (msg.type) {

            case 'set_name': {
                const newName = (msg.name || '').trim() || 'Player' + playerId;
                if (player.roomId) {
                    const room = rooms.get(player.roomId);
                    if (room) {
                        const nameTaken = room.players.some(op => op.id !== playerId && op.name === newName);
                        if (nameTaken) {
                            player.name = newName + '_' + Math.floor(Math.random() * 100);
                        } else {
                            player.name = newName;
                        }
                    } else {
                        player.name = newName;
                    }
                } else {
                    player.name = newName;
                }
                break;
            }

            case 'get_rooms':
                sendTo(ws, { type: 'room_list', rooms: getRoomList() });
                break;

            case 'create_room': {
                if (player.roomId) {
                    removePlayerFromRoom(player);
                }
                console.log('[CREATE] Player ' + playerId + ' (' + player.name + ') creating room "' + (msg.roomName || 'Room') + '"');

                const roomId = generateRoomId();
                const room = {
                    id: roomId,
                    name: msg.roomName || 'Room',
                    hostPlayerId: playerId,
                    password: msg.password || '',
                    isPrivate: !!msg.isPrivate,
                    players: [],
                    map: msg.map || 'Hospital',
                    teamSize: msg.teamSize || 2,
                    inGame: false,
                    doorStates: {},
                    createdAt: Date.now()
                };
                player.roomId = roomId;
                player.ready = false;
                room.players.push(player);
                if (!player.name || player.name.trim() === '') {
                    player.name = 'Player ' + room.players.length;
                }
                rooms.set(roomId, room);

                sendTo(ws, {
                    type: 'room_created',
                    roomId: roomId,
                    roomName: room.name,
                    teamSize: room.teamSize,
                    map: room.map,
                    hasPassword: room.password !== ''
                });

                sendTo(ws, {
                    type: 'room_joined',
                    roomId: roomId,
                    roomName: room.name,
                    teamSize: room.teamSize,
                    map: room.map,
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        ready: p.ready || false
                    })),
                    hostId: room.hostPlayerId
                });
                break;
            }

            case 'join_room': {
                const targetRoomId = msg.roomId ? Number(msg.roomId) : null;
                const roomName = msg.roomName || '';
                const password = msg.password || '';
                console.log('[JOIN] Player ' + playerId + ' (' + player.name + ') attempting to join roomId=' + targetRoomId + ' name="' + roomName + '"');
                let targetRoom = null;
                let foundRoomId = null;
                let existingRoomInGame = false;

                if (targetRoomId && rooms.has(targetRoomId)) {
                    const candidate = rooms.get(targetRoomId);
                    if (!candidate.inGame) {
                        targetRoom = candidate;
                        foundRoomId = targetRoomId;
                    } else {
                        existingRoomInGame = true;
                    }
                }
                if (!targetRoom) {
                    rooms.forEach((room, rid) => {
                        if (room.name === roomName) {
                            if (room.inGame) {
                                existingRoomInGame = true;
                                return;
                            }
                            if (room.password && room.password !== password) return;
                            if (room.players.length >= room.teamSize) return;
                            targetRoom = room;
                            foundRoomId = rid;
                        }
                    });
                }

                if (existingRoomInGame && !targetRoom) {
                    sendError(ws, 'Room is already in a match');
                    break;
                }
                if (!targetRoom) {
                    sendError(ws, 'Room does not exist');
                    break;
                }

                if (targetRoom.password && targetRoom.password !== password) {
                    sendError(ws, 'Wrong password');
                    break;
                }

                if (targetRoom.players.length >= targetRoom.teamSize) {
                    sendError(ws, 'Room is full');
                    break;
                }

                joinRoom(player, targetRoom, foundRoomId);
                console.log('[JOIN OK] Player ' + playerId + ' (' + player.name + ') joined room ' + foundRoomId + '. Room now has ' + targetRoom.players.length + '/' + targetRoom.teamSize + ' players: ' + targetRoom.players.map(p => p.name).join(', '));
                break;
            }

            case 'quick_match': {
                let found = false;
                rooms.forEach((room, rid) => {
                    if (!found && !room.inGame && !room.isPrivate && !room.password &&
                        room.players.length < room.teamSize) {
                        joinRoom(player, room, rid);
                        found = true;
                    }
                });

                if (!found) {
                    const roomId = generateRoomId();
                    const room = {
                        id: roomId,
                        name: 'Quick Match',
                        hostPlayerId: playerId,
                        password: '',
                        isPrivate: false,
                        players: [],
                        map: 'Hospital',
                        teamSize: 2,
                        inGame: false,
                        doorStates: {},
                        createdAt: Date.now()
                    };

                    player.roomId = roomId;
                    player.ready = false;
                    room.players.push(player);
                    rooms.set(roomId, room);

                    sendTo(ws, {
                        type: 'room_joined',
                        roomId: roomId,
                        roomName: room.name,
                        teamSize: room.teamSize,
                        map: room.map,
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            ready: p.ready || false
                        })),
                        hostId: room.hostPlayerId
                    });

                    sendStatus(ws, 'Waiting for players...');
                }
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

                var syncMsg = {
                    type: 'player_sync',
                    playerId: playerId,
                    name: player.name,
                    position: player.position,
                    rotation: player.rotation,
                    animation: player.animation,
                    crouching: player.crouching,
                    flashlight: player.flashlight,
                    health: player.health
                };
                if (msg.doorEvent) {
                    syncMsg.doorEvent = msg.doorEvent;
                }
                broadcastToRoom(player.roomId, syncMsg, ws);
                break;
            }

            case 'player_damage': {
                if (!player.roomId) break;
                broadcastToRoom(player.roomId, {
                    type: 'player_damage',
                    playerId: msg.targetId,
                    damage: msg.damage,
                    sourceId: playerId
                });
                break;
            }

            case 'door_sync': {
                if (!player.roomId) break;
                const dRoom = rooms.get(player.roomId);
                if (!dRoom) break;
                if (!dRoom.doorStates) dRoom.doorStates = {};
                dRoom.doorStates[msg.doorPath] = msg.isOpen;
                broadcastToRoom(player.roomId, {
                    type: 'door_sync',
                    doorPath: msg.doorPath,
                    isOpen: msg.isOpen
                }, ws);
                break;
            }

            case 'toggle_ready': {
                if (!player.roomId) {
                    sendError(ws, 'You are not in a room');
                    break;
                }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.inGame) {
                    sendError(ws, 'Game already started');
                    break;
                }
                player.ready = !player.ready;
                broadcastToRoom(player.roomId, {
                    type: 'player_ready_changed',
                    playerId: playerId,
                    ready: player.ready
                });
                break;
            }

            case 'start_match': {
                if (!player.roomId) {
                    sendError(ws, 'You are not in a room');
                    break;
                }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.hostPlayerId !== playerId) {
                    sendError(ws, 'Only the host can start the match');
                    break;
                }
                if (room.inGame) {
                    sendError(ws, 'Game already started');
                    break;
                }
                room.inGame = true;
                room.doorStates = {};
                broadcastToRoom(player.roomId, {
                    type: 'game_start',
                    players: room.players.map(p => ({
                        id: p.id,
                        name: p.name
                    })),
                    map: room.map,
                    teamSize: room.teamSize
                });
                break;
            }

            case 'kick_player': {
                if (!player.roomId) {
                    sendError(ws, 'You are not in a room');
                    break;
                }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.hostPlayerId !== playerId) {
                    sendError(ws, 'Only the host can kick players');
                    break;
                }
                const targetId = msg.targetId;
                if (targetId === playerId) {
                    sendError(ws, 'You cannot kick yourself');
                    break;
                }
                const targetPlayer = players.get(targetId);
                if (!targetPlayer || targetPlayer.roomId !== player.roomId) {
                    sendError(ws, 'Player not found in your room');
                    break;
                }
                broadcastToRoom(player.roomId, {
                    type: 'player_kicked',
                    playerId: targetId
                });
                removePlayerFromRoom(targetPlayer);
                break;
            }

            case 'transfer_host': {
                if (!player.roomId) {
                    sendError(ws, 'You are not in a room');
                    break;
                }
                const room = rooms.get(player.roomId);
                if (!room) break;
                if (room.hostPlayerId !== playerId) {
                    sendError(ws, 'Only the host can transfer host');
                    break;
                }
                const newHostId = msg.targetId;
                if (newHostId === playerId) {
                    sendError(ws, 'You are already the host');
                    break;
                }
                const newHost = players.get(newHostId);
                if (!newHost || newHost.roomId !== player.roomId) {
                    sendError(ws, 'Player not found in your room');
                    break;
                }
                room.hostPlayerId = newHostId;
                broadcastToRoom(player.roomId, {
                    type: 'host_changed',
                    newHostId: newHostId,
                    newHostName: newHost.name
                });
                break;
            }
        }
    });

    ws.on('close', () => {
        const pl = players.get(playerId);
        if (pl) {
            if (pl.roomId) {
                removePlayerFromRoom(pl);
            }
            players.delete(playerId);
        }
    });

    ws.on('error', () => {
        const pl = players.get(playerId);
        if (pl) {
            if (pl.roomId) {
                removePlayerFromRoom(pl);
            }
            players.delete(playerId);
        }
    });
});

server.listen(PORT, () => {
    console.log('DARK WARD Server running on port ' + PORT);
    console.log('WebSocket server ready');
});
