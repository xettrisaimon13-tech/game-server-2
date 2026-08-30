const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const REGION_NAMES = ["Asia", "Europe", "NA", "SA", "Africa", "Oceania"];

// ── State ──────────────────────────────────────────────────────────
const players = new Map();       // ws → PlayerInfo
const rooms = new Map();         // roomId → Room
const accountSessions = new Map(); // profileId → ws (for conflict detection)
const bannedProfiles = new Map();  // profileId → { name, bannedAt, reason }
let nextPlayerId = 1;
let nextRoomId = 1;

// ── Player ─────────────────────────────────────────────────────────
class Player {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.name = "Player";
    this.region = "Asia";
    this.profileId = null;
    this.accountType = "";
    this.roomId = null;
    this.characterId = "player";
    this.isReady = false;
    this.isHost = false;
    this.isSpectating = false;
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = 0;
    this.animation = "Idle";
    this.crouching = false;
    this.flashlight = false;
    this.health = 100;
    this.lives = 3;
    this.heldItem = "";
    this.inventory = {};
    this.hidden = false;
    this.lastPing = 0;
    this.pingOutstanding = -1;
  }
}

// ── Room ───────────────────────────────────────────────────────────
class Room {
  constructor(id, name, password, teamSize, mapName, isPrivate, region, hostId) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.teamSize = teamSize;
    this.map = mapName;
    this.isPrivate = isPrivate;
    this.region = region;
    this.hostId = hostId;
    this.players = new Map();    // playerId → ws
    this.items = [];             // dropped items
    this.doors = {};             // doorPath → isOpen
    this.ghosts = [];            // ghost sync data
    this.gameStarted = false;
    this.createdAt = Date.now();
  }

  broadcast(msg, excludeWs = null) {
    const data = JSON.stringify(msg);
    for (const [pid, ws] of this.players) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  playerList() {
    const list = [];
    for (const [pid] of this.players) {
      const p = getPlayerByWs(this.players.get(pid));
      if (p) {
        list.push({
          playerId: p.id,
          name: p.name,
          characterId: p.characterId,
          isHost: p.isHost,
          isReady: p.isReady,
          isSpectating: p.isSpectating,
          // FIX: include current transform/state so a newly-joining
          // client can actually spawn every existing player's 3D model
          // in the right place. Without this, the lobby had no idea
          // where to put remote players and they just didn't appear.
          position: p.position,
          rotation: p.rotation,
          animation: p.animation,
          crouching: p.crouching,
          flashlight: p.flashlight,
          hidden: p.hidden,
        });
      }
    }
    return list;
  }
}

function getPlayerByWs(ws) {
  return players.get(ws) || null;
}

function getRoomById(id) {
  return rooms.get(id) || null;
}

function getRoomForPlayer(player) {
  if (!player || !player.roomId) return null;
  return getRoomById(player.roomId);
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws, message) {
  sendTo(ws, { type: "error", message });
}

function sendStatus(ws, text) {
  sendTo(ws, { type: "status", text });
}

// ── Online counts ──────────────────────────────────────────────────
function broadcastOnlineCounts() {
  const regionCounts = {};
  let total = 0;
  for (const [, p] of players) {
    const r = p.region || "Asia";
    regionCounts[r] = (regionCounts[r] || 0) + 1;
    total++;
  }
  const msg = {
    type: "online_count",
    region: "",
    count: 0,
    total,
    regions: regionCounts,
  };
  for (const [, p] of players) {
    msg.region = p.region;
    msg.count = regionCounts[p.region] || 0;
    sendTo(p.ws, msg);
  }
}

// ── Heartbeat (prevent idle disconnect on Render free tier) ────────
// FIX: was using `return` inside the for-loop, which aborted the ENTIRE
// heartbeat tick as soon as it hit the first dead client — every client
// after that one in iteration order never got pinged / never had isAlive
// reset that round. That left stale/ghost connections around, which is
// what was causing the weird join/host/door/sync "chaos" under load.
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    try {
      if (ws.isAlive === false) {
        ws.terminate();
        continue; // was: return
      }
      ws.isAlive = false;
      ws.ping();
    } catch (err) {
      console.error("[heartbeat] error pinging client:", err.message);
    }
  }
}, 30000);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // FIX: without this, a network hiccup on ANY client's socket emits an
  // 'error' event with no listener attached — Node throws that as an
  // uncaught exception and kills the ENTIRE server process (all rooms,
  // all players, everyone). This is almost certainly why your server
  // was randomly dying after running fine post-deploy.
  ws.on("error", (err) => {
    console.error(`[ws error] player socket error:`, err.message);
  });

  const playerId = nextPlayerId++;
  const player = new Player(ws, playerId);
  players.set(ws, player);

  sendTo(ws, {
    type: "welcome",
    playerId: playerId,
    serverTime: Date.now(),
  });

  sendStatus(ws, "Connected to server");
  broadcastOnlineCounts();

  console.log(`[+] Player ${playerId} connected (${players.size} total)`);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(ws, player, msg);
    } catch (e) {
      console.error("Parse error:", e.message);
    }
  });

  ws.on("close", () => {
    handleDisconnect(player);
    console.log(`[-] Player ${playerId} disconnected (${players.size} total)`);
  });
});

// ── Message Router ─────────────────────────────────────────────────
function handleMessage(ws, player, msg) {
  const t = msg.type || "";

  switch (t) {
    // ── Connection / Identity ─────────────────────
    case "ping":
      handlePing(ws, player, msg);
      break;
    case "identify":
      handleIdentify(ws, player, msg);
      break;
    case "set_name":
      player.name = msg.name || "Player";
      break;
    case "set_region":
      player.region = msg.region || "Asia";
      broadcastOnlineCounts();
      break;

    // ── Room Management ───────────────────────────
    case "get_rooms":
      handleGetRooms(ws, player);
      break;
    case "get_online":
      handleGetOnline(ws, player);
      break;
    case "create_room":
      handleCreateRoom(ws, player, msg);
      break;
    case "join_room":
      handleJoinRoom(ws, player, msg);
      break;
    case "quick_match":
      handleQuickMatch(ws, player);
      break;
    case "leave_room":
      handleLeaveRoom(ws, player);
      break;

    // ── Lobby ─────────────────────────────────────
    case "toggle_ready":
      handleToggleReady(ws, player);
      break;
    case "start_match":
      handleStartMatch(ws, player);
      break;
    case "transfer_host":
      handleTransferHost(ws, player, msg);
      break;
    case "kick_player":
      handleKickPlayer(ws, player, msg);
      break;
    case "ban_player":
      handleBanPlayer(ws, player, msg);
      break;
    case "unban_player":
      handleUnbanPlayer(ws, player, msg);
      break;
    case "select_skin":
      handleSelectSkin(ws, player, msg);
      break;

    // ── Sync ──────────────────────────────────────
    case "player_sync":
      handlePlayerSync(ws, player, msg);
      break;
    case "player_damage":
      handlePlayerDamage(ws, player, msg);
      break;
    case "player_lives":
      handlePlayerLives(ws, player, msg);
      break;
    case "player_died":
      handlePlayerDied(ws, player, msg);
      break;
    case "game_over_all":
      handleGameOverAll(ws, player);
      break;

    // ── World ─────────────────────────────────────
    case "door_sync":
      handleDoorSync(ws, player, msg);
      break;
    case "item_drop":
      handleItemDrop(ws, player, msg);
      break;
    case "item_pickup":
      handleItemPickup(ws, player, msg);
      break;
    case "held_item":
      handleHeldItem(ws, player, msg);
      break;

    // ── Ghosts ────────────────────────────────────
    case "ghost_sync":
      handleGhostSync(ws, player, msg);
      break;
    case "ghost_damage_relay":
      handleGhostDamageRelay(ws, player, msg);
      break;

    // ── Weapons ───────────────────────────────────
    case "weapon_sync":
      handleWeaponSync(ws, player, msg);
      break;

    // ── Social ────────────────────────────────────
    case "chat_message":
      handleChatMessage(ws, player, msg);
      break;
    case "mic_state":
      handleMicState(ws, player, msg);
      break;
    case "spectator_status":
      handleSpectatorStatus(ws, player, msg);
      break;

    // ── Voice ─────────────────────────────────────
    case "voice_join":
    case "voice_leave":
    case "voice_audio":
      handleVoice(ws, player, msg);
      break;

    default:
      break;
  }
}

// ── Ping / Pong ────────────────────────────────────────────────────
// FIX: now also tracks last-seen time server-side (useful if you ever
// want to detect/kick laggy clients from the server, not just the client
// display). The actual 0↔999ms "wraparound" you're seeing on screen is a
// CLIENT-side display bug (almost certainly something like
// `Date.now() % 1000` or `rtt % 1000` used when rendering the ping number).
// This server just echoes msg.time back untouched, which is correct —
// paste your client-side ping display code and I'll fix that part too.
function handlePing(ws, player, msg) {
  player.lastPing = Date.now();
  sendTo(ws, { type: "pong", time: msg.time, serverTime: Date.now() });
}

// ── Identity / Account Conflict ────────────────────────────────────
function handleIdentify(ws, player, msg) {
  const profileId = msg.playerId || null;
  const accountType = msg.accountType || "";
  if (!profileId) return;

  // Server-wide ban check — reject immediately if this profile is banned
  if (bannedProfiles.has(profileId)) {
    const ban = bannedProfiles.get(profileId);
    sendTo(ws, {
      type: "banned",
      message: `You are banned from this server.${ban.reason ? " Reason: " + ban.reason : ""}`,
    });
    sendError(ws, "You are banned from this server.");
    ws.close(4003, "Banned");
    return;
  }

  player.profileId = profileId;
  player.accountType = accountType;

  const existingWs = accountSessions.get(profileId);
  if (existingWs && existingWs !== ws && existingWs.readyState === 1) {
    sendTo(existingWs, {
      type: "account_conflict",
      message: "Your account has been logged in from another device.",
    });
    sendTo(existingWs, {
      type: "error",
      message: "Logged in from another device. Disconnecting.",
    });
    existingWs.close(4001, "Account conflict");
  }
  accountSessions.set(profileId, ws);
}

// ── Room Queries ───────────────────────────────────────────────────
function handleGetRooms(ws, player) {
  const region = player.region || "Asia";
  const list = [];
  for (const [, room] of rooms) {
    if (room.isPrivate) continue;
    if (room.region !== region && room.region !== "") continue;
    list.push({
      roomId: String(room.id),
      roomName: room.name,
      hostId: room.hostId,
      playerCount: room.players.size,
      teamSize: room.teamSize,
      map: room.map,
      region: room.region,
      hasPassword: room.password !== "",
      gameStarted: room.gameStarted,
    });
  }
  sendTo(ws, { type: "room_list", rooms: list });
}

function handleGetOnline(ws, player) {
  const region = player.region || "Asia";
  const regionCounts = {};
  let total = 0;
  for (const [, p] of players) {
    const r = p.region || "Asia";
    regionCounts[r] = (regionCounts[r] || 0) + 1;
    total++;
  }
  sendTo(ws, {
    type: "online_count",
    region,
    count: regionCounts[region] || 0,
    total,
    regions: regionCounts,
  });
}

// ── Create Room ────────────────────────────────────────────────────
function handleCreateRoom(ws, player, msg) {
  if (player.roomId !== null) {
    return sendError(ws, "Already in a room");
  }

  const roomId = String(nextRoomId++);
  const room = new Room(
    roomId,
    msg.roomName || "Room",
    msg.password || "",
    msg.teamSize || 4,
    msg.map || "map",
    msg.isPrivate || false,
    msg.region || player.region || "Asia",
    player.id
  );

  player.isHost = true;
  player.roomId = roomId;
  player.characterId = msg.characterId || player.characterId;
  player.isReady = false;
  room.players.set(player.id, ws);
  rooms.set(roomId, room);

  sendTo(ws, {
    type: "room_created",
    roomId: roomId,
    roomName: room.name,
    hostId: player.id,
    teamSize: room.teamSize,
    map: room.map,
    region: room.region,
    items: room.items,
    doors: room.doors,
    players: room.playerList(),
  });

  broadcastOnlineCounts();
  console.log(`[Room] ${player.name} created room ${roomId} (${room.name}) — players in room: ${room.players.size}`, room.playerList());
}

// ── Join Room ──────────────────────────────────────────────────────
function handleJoinRoom(ws, player, msg) {
  if (player.roomId !== null) {
    return sendError(ws, "Already in a room");
  }

  const roomIdentifier = msg.roomId || msg.roomName || "";
  let room = getRoomById(roomIdentifier);

  // Try by name if not found by id
  if (!room) {
    for (const [, r] of rooms) {
      if (r.name === roomIdentifier) {
        room = r;
        break;
      }
    }
  }

  if (!room) {
    return sendError(ws, "Room not found");
  }

  if (room.gameStarted) {
    return sendError(ws, "Game already started");
  }

  if (room.players.size >= (room.teamSize || 4)) {
    return sendError(ws, "Room is full");
  }

  if (room.password && room.password !== (msg.password || "")) {
    return sendError(ws, "Wrong password");
  }

  player.roomId = room.id;
  player.characterId = msg.characterId || player.characterId;
  player.isReady = false;
  player.isHost = false;
  room.players.set(player.id, ws);

  // Notify existing players
  room.broadcast({
    type: "player_joined",
    playerId: player.id,
    name: player.name,
    characterId: player.characterId,
    isHost: player.isHost,
    position: player.position,
    rotation: player.rotation,
  }, ws);

  // Send room state to joiner
  sendTo(ws, {
    type: "room_joined",
    roomId: room.id,
    roomName: room.name,
    hostId: room.hostId,
    teamSize: room.teamSize,
    map: room.map,
    region: room.region,
    items: room.items,
    players: room.playerList(),
    doors: room.doors,
  });

  broadcastOnlineCounts();
  console.log(`[Room] ${player.name} joined room ${room.id}`);
}

// ── Quick Match ────────────────────────────────────────────────────
function handleQuickMatch(ws, player) {
  if (player.roomId !== null) {
    return sendError(ws, "Already in a room");
  }

  // Find an open room in same region
  for (const [, room] of rooms) {
    if (room.region !== player.region) continue;
    if (room.gameStarted) continue;
    if (room.isPrivate) continue;
    if (room.players.size >= (room.teamSize || 4)) continue;
    if (room.password) continue;

    player.roomId = room.id;
    player.characterId = "player";
    player.isReady = false;
    player.isHost = false;
    room.players.set(player.id, ws);

    room.broadcast({
      type: "player_joined",
      playerId: player.id,
      name: player.name,
      characterId: player.characterId,
      isHost: false,
      position: player.position,
      rotation: player.rotation,
    }, ws);

    sendTo(ws, {
      type: "room_joined",
      roomId: room.id,
      roomName: room.name,
      hostId: room.hostId,
      teamSize: room.teamSize,
      map: room.map,
      region: room.region,
      items: room.items,
      players: room.playerList(),
      doors: room.doors,
    });

    broadcastOnlineCounts();
    console.log(`[Room] ${player.name} quick-matched into room ${room.id}`);
    return;
  }

  // No room found → create one
  handleCreateRoom(ws, player, {
    roomName: player.name + "'s Room",
    teamSize: 4,
    map: "map",
    region: player.region,
    characterId: "player",
  });
}

// ── Leave Room ─────────────────────────────────────────────────────
function handleLeaveRoom(ws, player) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.players.delete(player.id);
  player.roomId = null;
  player.isHost = false;
  player.isReady = false;

  room.broadcast({
    type: "player_left",
    playerId: player.id,
    name: player.name,
  });

  // Transfer host if needed
  if (room.players.size > 0 && room.hostId === player.id) {
    const [newHostWs] = room.players.values();
    const newHost = getPlayerByWs(newHostWs);
    if (newHost) {
      newHost.isHost = true;
      room.hostId = newHost.id;
      room.broadcast({
        type: "host_changed",
        hostId: newHost.id,
        name: newHost.name,
      });
    }
  } else if (room.players.size === 0) {
    rooms.delete(room.id);
    console.log(`[Room] Room ${room.id} deleted (empty)`);
  }

  broadcastOnlineCounts();
  console.log(`[Room] ${player.name} left room ${room.id}`);
}

// ── Toggle Ready ───────────────────────────────────────────────────
function handleToggleReady(ws, player) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  player.isReady = !player.isReady;
  room.broadcast({
    type: "player_ready_changed",
    playerId: player.id,
    isReady: player.isReady,
  });
}

// ── Start Match ────────────────────────────────────────────────────
function handleStartMatch(ws, player) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (room.hostId !== player.id) {
    return sendError(ws, "Only the host can start the match");
  }

  room.gameStarted = true;
  room.broadcast({
    type: "game_start",
    map: room.map,
    hostId: room.hostId,
    players: room.playerList(),
    teamSize: room.teamSize,
  });

  console.log(`[Room] Match started in room ${room.id}`);
}

// ── Transfer Host ──────────────────────────────────────────────────
function handleTransferHost(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (room.hostId !== player.id) {
    return sendError(ws, "Only the host can transfer host");
  }

  const targetId = msg.targetId;
  const targetWs = room.players.get(targetId);
  if (!targetWs) {
    return sendError(ws, "Target player not in room");
  }

  const target = getPlayerByWs(targetWs);
  if (!target) return;

  player.isHost = false;
  target.isHost = true;
  room.hostId = target.id;

  room.broadcast({
    type: "host_changed",
    hostId: target.id,
    name: target.name,
  });

  console.log(`[Room] Host transferred to ${target.name} in room ${room.id}`);
}

// ── Kick Player ────────────────────────────────────────────────────
function handleKickPlayer(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (room.hostId !== player.id) {
    return sendError(ws, "Only the host can kick players");
  }

  const targetId = msg.targetId;
  const targetWs = room.players.get(targetId);
  if (!targetWs) return;

  const target = getPlayerByWs(targetWs);
  if (!target) return;

  room.broadcast({
    type: "player_kicked",
    playerId: target.id,
    name: target.name,
  });

  room.players.delete(target.id);
  target.roomId = null;
  target.isHost = false;
  target.isReady = false;

  sendTo(targetWs, {
    type: "player_kicked",
    playerId: target.id,
    name: target.name,
  });

  sendError(targetWs, "You have been kicked from the room");

  broadcastOnlineCounts();
  console.log(`[Room] ${target.name} kicked from room ${room.id}`);
}

// ── Ban Player (server-wide) ───────────────────────────────────────
function handleBanPlayer(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (room.hostId !== player.id) {
    return sendError(ws, "Only the host can ban players");
  }

  const targetId = msg.targetId;
  const targetWs = room.players.get(targetId);
  if (!targetWs) return;

  const target = getPlayerByWs(targetWs);
  if (!target) return;

  if (!target.profileId) {
    return sendError(ws, "Cannot ban: target has no identified profile");
  }

  // Add to server-wide ban list
  bannedProfiles.set(target.profileId, {
    name: target.name,
    bannedAt: Date.now(),
    reason: msg.reason || "",
  });

  room.broadcast({
    type: "player_banned",
    playerId: target.id,
    name: target.name,
  });

  // Remove from room immediately
  room.players.delete(target.id);
  target.roomId = null;
  target.isHost = false;
  target.isReady = false;

  sendTo(targetWs, {
    type: "player_banned",
    playerId: target.id,
    name: target.name,
  });
  sendTo(targetWs, {
    type: "banned",
    message: `You have been banned from this server.${msg.reason ? " Reason: " + msg.reason : ""}`,
  });
  targetWs.close(4003, "Banned");

  broadcastOnlineCounts();
  console.log(`[Ban] ${target.name} (${target.profileId}) banned by ${player.name} in room ${room.id}`);
}

// ── Unban Player (server-wide) ─────────────────────────────────────
// Call this without a room requirement — pass profileId directly.
// Wire this to a host/admin-only command in your client as needed.
function handleUnbanPlayer(ws, player, msg) {
  const profileId = msg.profileId;
  if (!profileId) return sendError(ws, "profileId required to unban");

  if (!bannedProfiles.has(profileId)) {
    return sendError(ws, "That profile is not banned");
  }

  bannedProfiles.delete(profileId);
  sendStatus(ws, `Unbanned profile ${profileId}`);
  console.log(`[Ban] ${profileId} unbanned by ${player.name}`);
}

// ── Select Skin (remote skin sync) ──────────────────────────────────
// 8 slots supported (1-8). Player picks a skin → everyone else in the
// room sees that skin on that player's remote model.
function handleSelectSkin(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const skinId = msg.skinId;
  if (skinId === undefined || skinId === null) return;

  // Optional slot validation (8 slots: 1-8). Skip check if you pass
  // string skin IDs instead of numeric slots — this only guards numbers.
  if (typeof skinId === "number" && (skinId < 1 || skinId > 8)) {
    return sendError(ws, "Invalid skin slot (must be 1-8)");
  }

  player.characterId = skinId;

  room.broadcast({
    type: "skin_changed",
    playerId: player.id,
    skinId: skinId,
  }, ws);
}

// ── Player Sync ────────────────────────────────────────────────────
function handlePlayerSync(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  if (msg.position) player.position = msg.position;
  if (msg.rotation !== undefined) player.rotation = msg.rotation;
  if (msg.animation) player.animation = msg.animation;
  if (msg.crouching !== undefined) player.crouching = msg.crouching;
  if (msg.flashlight !== undefined) player.flashlight = msg.flashlight;
  if (msg.health !== undefined) player.health = msg.health;
  if (msg.heldItem !== undefined) player.heldItem = msg.heldItem;
  if (msg.inventory) player.inventory = msg.inventory;
  if (msg.hidden !== undefined) player.hidden = msg.hidden;
  if (msg.characterId) player.characterId = msg.characterId;

  const sync = {
    type: "player_sync",
    playerId: player.id,
    name: player.name,
    position: player.position,
    rotation: player.rotation,
    animation: player.animation,
    crouching: player.crouching,
    flashlight: player.flashlight,
    health: player.health,
    heldItem: player.heldItem,
    inventory: player.inventory,
    hidden: player.hidden,
    characterId: player.characterId,
  };

  if (msg.doorEvent && Object.keys(msg.doorEvent).length > 0) {
    sync.doorEvent = msg.doorEvent;
    room.doors[msg.doorEvent.doorPath] = msg.doorEvent.isOpen;
  }

  room.broadcast(sync, ws);
}

// ── Player Damage ──────────────────────────────────────────────────
function handlePlayerDamage(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const targetWs = room.players.get(msg.targetId);
  if (!targetWs) return;

  sendTo(targetWs, {
    type: "player_damage",
    playerId: player.id,
    damage: msg.damage || 0,
  });
}

// ── Player Lives ───────────────────────────────────────────────────
function handlePlayerLives(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  player.lives = msg.lives || 0;
  player.health = msg.health || 0;

  room.broadcast({
    type: "player_lives",
    playerId: player.id,
    lives: player.lives,
    health: player.health,
  }, ws);
}

// ── Player Died ────────────────────────────────────────────────────
function handlePlayerDied(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.broadcast({
    type: "player_death",
    playerId: player.id,
    deadId: msg.deadId || player.id,
    deadName: msg.deadName || player.name,
  }, ws);
}

// ── Game Over ──────────────────────────────────────────────────────
function handleGameOverAll(ws, player) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (room.hostId !== player.id) return;

  room.gameStarted = false;
  room.broadcast({ type: "game_over_all" });

  // Reset ready states
  for (const [pid] of room.players) {
    const p = getPlayerByWs(room.players.get(pid));
    if (p) p.isReady = false;
  }
}

// ── Door Sync ──────────────────────────────────────────────────────
function handleDoorSync(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const doorPath = msg.doorPath || "";
  const isOpen = msg.isOpen || false;
  room.doors[doorPath] = isOpen;

  room.broadcast({
    type: "door_sync",
    playerId: player.id,
    doorPath: doorPath,
    isOpen: isOpen,
  }, ws);
}

// ── Item Drop ──────────────────────────────────────────────────────
function handleItemDrop(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const item = {
    id: msg.id || crypto.randomUUID(),
    itemType: msg.itemType || "unknown",
    position: msg.position || { x: 0, y: 0, z: 0 },
    droppedBy: player.id,
  };
  room.items.push(item);

  room.broadcast({
    type: "item_drop",
    playerId: player.id,
    id: item.id,
    itemType: item.itemType,
    position: item.position,
  }, ws);
}

// ── Item Pickup ────────────────────────────────────────────────────
function handleItemPickup(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const itemId = msg.id || "";
  room.items = room.items.filter((i) => i.id !== itemId);

  room.broadcast({
    type: "item_pickup",
    playerId: player.id,
    id: itemId,
  }, ws);
}

// ── Held Item ──────────────────────────────────────────────────────
function handleHeldItem(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  player.heldItem = msg.item || "";
  room.broadcast({
    type: "player_sync",
    playerId: player.id,
    heldItem: player.heldItem,
  }, ws);
}

// ── Ghost Sync ─────────────────────────────────────────────────────
function handleGhostSync(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.ghosts = msg.ghosts || [];
  room.broadcast({
    type: "ghost_sync",
    playerId: player.id,
    ghosts: room.ghosts,
  }, ws);
}

function handleGhostDamageRelay(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.broadcast({
    type: "ghost_damage",
    playerId: player.id,
    targetId: msg.targetId,
    damage: msg.damage || 0,
  }, ws);
}

// ── Weapon Sync ────────────────────────────────────────────────────
function handleWeaponSync(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.broadcast({
    type: "weapon_sync",
    playerId: player.id,
    data: msg.data || {},
  }, ws);
}

// ── Chat ───────────────────────────────────────────────────────────
function handleChatMessage(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  const text = (msg.text || "").substring(0, 200);
  if (!text) return;

  room.broadcast({
    type: "chat_message",
    playerId: player.id,
    name: player.name,
    text: text,
  });
}

// ── Mic State ──────────────────────────────────────────────────────
function handleMicState(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  room.broadcast({
    type: "mic_state",
    playerId: player.id,
    on: msg.on || false,
  }, ws);
}

// ── Spectator ──────────────────────────────────────────────────────
function handleSpectatorStatus(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  player.isSpectating = msg.spectating || false;
  room.broadcast({
    type: "spectator_status",
    playerId: player.id,
    spectating: player.isSpectating,
  }, ws);
}

// ── Voice (relay to room) ─────────────────────────────────────────
function handleVoice(ws, player, msg) {
  const room = getRoomForPlayer(player);
  if (!room) return;

  msg.playerId = player.id;
  room.broadcast(msg, ws);
}

// ── Disconnect ─────────────────────────────────────────────────────
function handleDisconnect(player) {
  if (player.profileId && accountSessions.get(player.profileId) === player.ws) {
    accountSessions.delete(player.profileId);
  }

  const room = getRoomForPlayer(player);
  if (room) {
    room.players.delete(player.id);

    room.broadcast({
      type: "player_left",
      playerId: player.id,
      name: player.name,
    });

    if (room.players.size > 0 && room.hostId === player.id) {
      const [newHostWs] = room.players.values();
      const newHost = getPlayerByWs(newHostWs);
      if (newHost) {
        newHost.isHost = true;
        room.hostId = newHost.id;
        room.broadcast({
          type: "host_changed",
          hostId: newHost.id,
          name: newHost.name,
        });
      }
    } else if (room.players.size === 0) {
      rooms.delete(room.id);
    }
  }

  players.delete(player.ws);
  broadcastOnlineCounts();
}

// ── HTTP Health ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    game: "Dark Ward",
    players: players.size,
    rooms: rooms.size,
    uptime: process.uptime(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ── Start ──────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`====================================`);
  console.log(`  Dark Ward Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`====================================`);
});

// FIX: catch server/wss-level errors (e.g. malformed handshake, EADDRINUSE)
// so they get logged instead of silently/violently crashing the process.
server.on("error", (err) => {
  console.error("[http server error]", err);
});

wss.on("error", (err) => {
  console.error("[wss error]", err);
});

// FIX: last-resort safety net. Without these, ANY uncaught error anywhere
// in the app (a bad message, a null reference, a third-party lib throwing)
// kills the whole Node process instantly — every player disconnected,
// every room wiped. Logging and staying alive is far better for a game
// server than a hard crash. (Ideally you also fix the root cause using
// these logs, but this stops one bad player/message from taking down
// everyone else.)
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Server stayed alive, but fix this:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Server stayed alive, but fix this:", reason);
});

// ── Cleanup on exit ────────────────────────────────────────────────
process.on("SIGTERM", () => {
  clearInterval(heartbeatInterval);
  wss.close();
  server.close();
  process.exit(0);
});
