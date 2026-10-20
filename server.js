const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

// ── OAuth relay store (Google/Facebook login — no localhost) ──
// Game le state generate garcha → browser Supabase bata /auth/callback?state=X ma
// land garcha (tokens URL #fragment ma) → page le /auth/receive ma POST garcha →
// game le /auth/poll?state=X bata tokens liyincha (one-time, TTL 5 min).
const pendingAuth = new Map();
const AUTH_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (now - v.ts > AUTH_TTL_MS) pendingAuth.delete(k);
}, 60000);

const AUTH_CALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Night Ward</title>
<style>body{background:#0b070c;color:#e7d8c4;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#c43b4a;font-size:26px}p{color:#8a7a72;font-size:15px}#st{color:#c43b4a;margin-top:16px}</style></head>
<body><div class="c"><h1>&#10003; Night Ward</h1><p id="st">Completing login...</p>
<script>
(function() {
  var st = document.getElementById('st');
  var state = new URLSearchParams(location.search).get('state') || '';
  var hash = location.hash.substring(1);
  if (!hash) { st.textContent = 'No auth data. Please try again.'; return; }
  var p = new URLSearchParams(hash);
  var at = p.get('access_token') || '';
  var rt = p.get('refresh_token') || '';
  if (!at) { st.textContent = 'No access token. Please try again.'; return; }
  st.textContent = 'Logging you in...';
  fetch('/auth/receive', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({state: state, access_token: at, refresh_token: rt})
  }).then(function() {
    st.textContent = 'Login successful! Return to Night Ward.';
    try { window.location.href = 'nightward://login'; } catch (e) {}
  }).catch(function(e) {
    st.textContent = 'Error sending tokens: ' + e;
  });
})();
</script></div></body></html>`;

// ── SERVER REGISTRY ───────────────────────────────────────
// 5 logical match servers. Each client picks one; matchmaking NEVER pairs
// players from different servers. `id` is what the client sends in every
// request; `name` is the display label shown in the UI.
const SERVERS = [
  { id: "ASIA", name: "Server 1 (ASIA)" },
  { id: "ASIA 2", name: "Server 2 (ASIA 2)" },  // backend: https://darkward-asia2.onrender.com
  { id: "EUROPE", name: "Server 3 (EUROPE)" },  // backend: https://darkward-europe.onrender.com
  { id: "AFRICA", name: "Server 4 (AFRICA)" },  // backend: https://darkwrad-afcria.onrender.com
  { id: "OCEANIA", name: "Server 5 (OCEANIA)" },
  { id: "NORTH AMERICA", name: "Server 6 (NORTH AMERICA)" },  // backend: https://darkward-na.onrender.com
  { id: "SOUTH AMERICA", name: "Server 7 (SOUTH AMERICA)" },  // backend: https://darkward-sa.onrender.com
  { id: "MIDDLE EAST", name: "Server 7 (MIDDLE EAST)" },  // backend: https://darkwrad-middle.onrender.com
];
const DEFAULT_SERVER_ID = SERVERS[0].id;
const serverById = (id) => SERVERS.find((sv) => sv.id === id) || null;
// Operator can take a server offline without a redeploy.
const DISABLED_SERVERS = new Set(
  (process.env.DISABLED_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

// ── ONLINE PRESENCE ───────────────────────────────────────
// Lobby ma basayera server dekhnay player le ping pathauncha → real
// "online players" count (na bhaye connected socket matra).
const presence = new Map();      // playerKey -> { serverId, ts }
const PRESENCE_TTL = 90000;      // 90s ma purana presence discard

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const qIdx = req.url.indexOf("?");
  const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const gParams = new URLSearchParams(qIdx === -1 ? "" : req.url.slice(qIdx + 1));

  if (path === "/auth/callback") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(AUTH_CALLBACK_HTML);
    return;
  }

  if (path === "/auth/receive" && req.method === "POST") {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 65536) body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const state = String(data.state || "");
        const at = String(data.access_token || "");
        if (/^[a-f0-9]{16,64}$/.test(state) && at.length > 20 && at.length < 16384) {
          pendingAuth.set(state, { at, rt: String(data.refresh_token || ""), ts: Date.now() });
          console.log("[AUTH] tokens stored for state", state.slice(0, 8));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid payload" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
    return;
  }

  if (path === "/auth/poll") {
    const state = gParams.get("state") || "";
    const entry = pendingAuth.get(state);
    if (entry) {
      pendingAuth.delete(state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: entry.at, refresh_token: entry.rt }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: true }));
    }
    return;
  }

  // ── PRESENCE PING (client le "ma online chu" batauncha) ──
  if (path === "/servers/ping" && req.method === "POST") {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 8192) body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const sid = String(data.serverId || "");
        const pid = String(data.playerId || "");
        if (serverById(sid) && pid) {
          presence.set(pid, { serverId: sid, ts: Date.now() });
        }
      } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── SERVER LIST (real status + real online counts) ──
  if (path === "/servers") {
    const list = SERVERS.map((sv) => {
      let connected = 0;
      let queued = 0;
      for (const w of allClients) {
        if (w.readyState === 1 && w.__serverId === sv.id) connected++;
      }
      for (const q of matchQueue) {
        if (q.ws.readyState === 1 && q.serverId === sv.id) queued++;
      }
      // Lobby ma online (presence ping banya) players
      const now = Date.now();
      let browsing = 0;
      for (const [pid, p] of presence) {
        if (p.serverId === sv.id && now - p.ts < PRESENCE_TTL) browsing++;
        else if (now - p.ts >= PRESENCE_TTL) presence.delete(pid);
      }
      const disabled = DISABLED_SERVERS.has(sv.id);
      return {
        id: sv.id,
        name: sv.name,
        online: !disabled,
        status: disabled ? "offline" : "online",
        players: connected + queued + browsing,   // real clients on this server
        connected,
        queued,
        browsing,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servers: list }));
    return;
  }

  if (req.url === "/rooms") {
    const list = Object.entries(rooms)
      .filter(([, r]) => r.players.length < r.maxPlayers)
      .map(([code, room]) => ({
        code, name: room.roomName, players: room.players.length,
        maxPlayers: room.maxPlayers, region: room.region, mode: room.mode, host: room.hostName,
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms: list }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", rooms: Object.keys(rooms).length,
      players: Object.values(rooms).reduce((a, r) => a + r.players.length, 0),
    }));
    return;
  }

  // ── LIVEKIT VOICE TOKEN (same service — client yahii "/livekit-token" maagcha) ──
  if (path === "/livekit-token" && req.method === "POST") {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 8192) body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const { room, identity, name } = JSON.parse(body || "{}");
        if (!room || !identity) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "room and identity required" }));
          return;
        }
        const { AccessToken } = require("livekit-server-sdk");
        const at = new AccessToken(
          process.env.LIVEKIT_API_KEY || "APIGiBWgPVPk83s",
          process.env.LIVEKIT_API_SECRET || "PzAp9nDJODsgi5MehfqBaLwjhyYaotJYeomslGvRDdOB",
          { identity: String(identity), name: name || String(identity), ttl: 86400 },
        );
        at.addGrant({
          roomJoin: true, room: String(room),
          canPublish: true, canSubscribe: true, canPublishData: true,
        });
        const token = await at.toJwt();
        console.log("[LIVEKIT] token issued: identity=" + identity + " room=" + room);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, url: process.env.LIVEKIT_URL || "wss://night-ward-tz4q970d.livekit.cloud" }));
      } catch (e) {
        console.error("[LIVEKIT] token error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "token generation failed" }));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Night Ward Server v4.5 - Running");
});

const wss = new WebSocketServer({ server });
const rooms = {};
const allClients = new Set();
// ── QUICK MATCH queue: status-based pairing of any 2 eligible searching players ──
let matchQueue = [];

function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += c[Math.floor(Math.random() * c.length)];
  return rooms[code] ? genCode() : code;
}

function broadcast(code, data, exclude) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (p.ws !== exclude && p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendToAll(code, data) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendGlobal(data) {
  const msg = JSON.stringify(data);
  allClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ═══════════════════════════════════════════════════════════
// WORLD CHAT ROOMS — player le afnai room create garcha
// ═══════════════════════════════════════════════════════════
const chatRooms = new Map();   // roomId -> { id, name, ownerId, ownerName, members:Set(ws), createdAt }

function chatRoomListPayload() {
  const list = [];
  for (const r of chatRooms.values()) {
    // Room bhitra ko player names (slots) — world chat row ma dekhau.
    // Slot position stable rahe (creator slot 0, joiners le "+" click gareko slot).
    const slots = [];
    for (let i = 0; i < 4; i++) {
      const w = r.slots ? r.slots[i] : null;
      if (w && w.readyState === 1) {
        slots.push({ slot: i, playerName: w.chatName || "Player", playerId: w.chatProfileId || "" });
      } else {
        slots.push({});
      }
    }
    list.push({
      id: r.id,
      name: r.name,
      ownerName: r.ownerName,
      ownerProfileId: r.ownerProfileId,
      members: r.members.size,
      slots,
    });
  }
  return list;
}

function broadcastChatRooms() {
  sendGlobal({ type: "chatroom_list", rooms: chatRoomListPayload() });
}

function sendChatRoomMembers(room) {
  const members = [];
  for (const w of room.members) {
    if (w.readyState === 1) {
      members.push({
        name: w.chatName || "Player",
        profileId: w.chatProfileId || "",
        isOwner: (w === room.ownerWs),
      });
    }
  }
  for (const w of room.members) {
    send(w, { type: "chatroom_members", roomId: room.id, members, ownerProfileId: room.ownerId || "" });
  }
}

function leaveChatRoom(ws) {
  const room = chatRooms.get(ws.chatRoomId);
  if (!room) return;
  room.members.delete(ws);
  if (room.slots) {
    const si = room.slots.indexOf(ws);
    if (si >= 0) room.slots[si] = null;
  }
  ws.chatRoomId = null;
  // Khali room → delete
  if (room.members.size === 0) {
    chatRooms.delete(room.id);
  } else {
    // Owner gayo bhaye → bache ko RANDOM leader banau
    if (room.ownerId && !room.members.has(room.ownerWs)) {
      const rest = [...room.members].filter((w) => w.readyState === 1);
      if (rest.length > 0) {
        const newOwner = rest[Math.floor(Math.random() * rest.length)];
        room.ownerWs = newOwner;
        room.ownerId = newOwner.chatProfileId || "";
        room.ownerName = newOwner.chatName || "Player";
        for (const w of room.members) {
          send(w, { type: "chatroom_owner", roomId: room.id, ownerProfileId: room.ownerId, ownerName: room.ownerName });
        }
      }
    }
    sendChatRoomMembers(room);
  }
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function playerPublic(p) {
  return { id: p.id, name: p.name, characterId: p.characterId, ready: p.ready, slot: p.slot, position: p.position, rotation: p.rotation, loginType: p.loginType || "guest", groupId: p.groupId || "", region: p.region || "" };
}

function roomPlayers(code) {
  return rooms[code].players.map(playerPublic);
}

function findPlayer(code, ws) {
  return rooms[code]?.players.find((p) => p.ws === ws);
}

function hostIdOf(room) {
  const h = room.players.find((p) => p.ws === room.host);
  return h ? h.id : (room.players[0] ? room.players[0].id : 1);
}

// profile_id ("google_<uuid>") → online player (all rooms).
// Exact profileId match first; fallback derives provider+uuid for older
// clients that don't send profileId yet.
function findPlayerByProfileId(profileId) {
  if (!profileId) return null;
  for (const room of Object.values(rooms)) {
    for (const p of room.players) {
      if (p.profileId && p.profileId === profileId) return p;
    }
  }
  const idx = profileId.lastIndexOf("_");
  if (idx > 0) {
    const prov = profileId.slice(0, idx);
    const uid = profileId.slice(idx + 1);
    for (const room of Object.values(rooms)) {
      for (const p of room.players) {
        if (p.userId === uid && (p.loginType === prov || p.loginType === "guest")) return p;
      }
    }
  }
  return null;
}

// Same-GROUP players ekai team ma paraina banaune order.
// Group members lai round-robin le banaucha → half-split (slice) ma
// ekai group ko 2 player ekai side ma paraina.
function interleaveGroups(players) {
  const buckets = new Map();
  for (const p of players) {
    const g = p.groupId || "";
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(p);
  }
  // Badi group pahile (spread garna best), tar baki
  const lists = [...buckets.values()].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (out.length < players.length) {
    let pushed = false;
    for (const l of lists) {
      if (i < l.length) { out.push(l[i]); pushed = true; }
    }
    if (!pushed) break;
    i++;
  }
  return out;
}

// Queue ko same mode+teamSize wala haru lai progress count pathau
// (client counter: 1/0 → 2/0 → … → X/X). Count required vanda badi garnaudaina.
function progressTo(mode, teamSize, serverId) {
  const required = 2 * teamSize;
  // Server isolation: queue ma same SERVER ko players matra.
  const same = matchQueue.filter((q) => q.ws.readyState === 1 && q.mode === mode
    && q.teamSize === teamSize && q.serverId === serverId);
  const count = Math.min(same.length, required);
  same.forEach((q) => send(q.ws, { type: "match_progress", count, required }));
  return same;
}

// Queue ma bhayeka eligible searching players lai JODIHAL — status-based
// (dukai searching + readyState=1 + queue age < 3 min). Fake player banaudaina.
// Team size respect garchha: 2 × teamSize pugyo bhane matra match start
// (solo 1/1 → 2p, duo 2/2 → 4p, 3/3 → 6p, 4/4 → 8p).
function tryQuickPair(entry) {
  if (!matchQueue.includes(entry)) return; // cancel/expire bhaisakyo
  if (entry.ws.readyState !== 1) return;
  matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
  if (!matchQueue.includes(entry)) return;
  const same = progressTo(entry.mode, entry.teamSize, entry.serverId); // X/X pugyo ki nai herna agadi nai count pathau
  const required = 2 * entry.teamSize;
  if (same.length < required) return; // ajhai partner chahincha — next join aayepachi feri try
  const picked = same.slice(0, required); // pahile queue ma thiye → host order
  // Same-group players ekai team ma naparaina banaune order ma halcha
  const group = interleaveGroups(picked);
  matchQueue = matchQueue.filter((q) => !picked.includes(q));
  const code = genCode();
  const mk = (e, id) => ({
    ws: e.ws, id, name: e.playerName, characterId: e.characterId,
    loginType: e.loginType, userId: e.userId, profileId: e.profileId || "",
    groupId: e.groupId || "", device: e.device, region: e.region || "ASIA",
    ready: false, slot: id, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  rooms[code] = {
    host: group[0].ws, hostName: group[0].playerName,
    roomName: "Match", region: "GLOBAL",
    mode: group[0].mode, maxPlayers: required, loginType: group[0].loginType,
    players: group.map((e, i) => mk(e, i + 1)),
    gameStarted: true, matchmadeAt: Date.now(),
    matchLikes: {}, matchEliminated: [],
  };
  // SAME match assignment — sabailai eutai code/mode/players + game_start
  group.forEach((e, i) => {
    e.ws.setRoom(code);
    if (i === 0) {
      send(e.ws, { type: "room_created", roomCode: code, roomName: "Match", region: "GLOBAL", mode: rooms[code].mode, playerId: 1, maxPlayers: required, hostId: 1 });
    } else {
      send(e.ws, { type: "room_joined", roomCode: code, roomName: "Match", region: "GLOBAL", mode: rooms[code].mode, playerId: i + 1, maxPlayers: required, players: roomPlayers(code), hostId: 1 });
    }
  });
  for (let i = 1; i < required; i++) {
    broadcast(code, { type: "player_joined", player: playerPublic(rooms[code].players[i]), players: roomPlayers(code), hostId: 1 }, group[i].ws);
  }
  sendToAll(code, { type: "game_start", mode: rooms[code].mode, players: roomPlayers(code) });
  console.log(`[MATCH] ${group.map((e) => e.playerName).join(" vs ")} → ${code} mode=${rooms[code].mode} ${required}p`);
}

wss.on("connection", (ws) => {
  let currentRoom = null;
  allClients.add(ws);
  // Pairing (aanu ko socket ko handler bata pani) le yo socket ko currentRoom set garna sakos.
  ws.setRoom = (code) => { currentRoom = code; };
  // ── WORLD CHAT identity (online players list + join target) ──
  ws.chatName = "";
  ws.chatProfileId = "";
  ws.chatRoomId = null;
  // Which match server this client is on (live player counts)
  ws.__serverId = null;

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (currentRoom && rooms[currentRoom]) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        rooms[currentRoom].players.forEach((p) => {
          if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(buf);
        });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── create_room DISABLED ────────────────────────────────────────────
    // Free Fire style: game room manual create garna banned.
    // Room/group banaune kaam WORLD CHAT (chatroom) bata,
    // khelne ko QUICK MATCH (matchmaking) matra.
    if (msg.type === "create_room") {
      send(ws, { type: "error", message: "Room creation is disabled. Use QUICK MATCH or create a group in World Chat." });
      return;
    }

    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: "error", message: "Room not found." }); return; }
      const room = rooms[code];
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }

      const joinLoginType = msg.loginType || "guest";
      const hostLoginType = room.loginType || "guest";
      if ((joinLoginType === "guest") !== (hostLoginType === "guest")) {
        send(ws, { type: "error", message: joinLoginType === "guest" ? "Guests can only play with other guests." : "This room only accepts logged-in players." });
        return;
      }

      const joinUserId = msg.userId || "";
      const joinDevice = msg.deviceId || "";
      // Same account: reject only when SAME device (real duplicate login).
      // Android + Mac ek account le khelna mildo — device farak chha.
      const sameDeviceAs = (p) => {
        if (!joinDevice || !p.device) return true; // purana client / device info chhaina → strict
        return p.device === joinDevice;
      };
      if (joinUserId) {
        const dupHere = room.players.find((p) => p.userId === joinUserId);
        if (dupHere && sameDeviceAs(dupHere)) {
          send(ws, { type: "error", message: "This account is already in the room." }); return;
        }
      }
      if (joinUserId) {
        for (const [rCode, r] of Object.entries(rooms)) {
          if (rCode === code) continue;
          const other = r.players.find((p) => p.userId === joinUserId);
          if (other && sameDeviceAs(other)) {
            send(ws, { type: "error", message: "This account is already in another room." }); return;
          }
        }
      }

      const pid = room.players.length + 1;
      const player = {
        ws, id: pid, name: msg.playerName || "Player",
        characterId: msg.characterId || 0,
        loginType: joinLoginType, userId: joinUserId,
        profileId: msg.profileId || "",
        device: joinDevice,
        ready: false, slot: pid,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      room.players.push(player);
      currentRoom = code;

      send(ws, {
        type: "room_joined", roomCode: code,
        roomName: room.roomName, region: room.region,
        mode: room.mode, playerId: pid,
        maxPlayers: room.maxPlayers, players: roomPlayers(code),
        hostId: hostIdOf(room),
      });
      broadcast(code, { type: "player_joined", player: playerPublic(player), players: roomPlayers(code), hostId: hostIdOf(room) }, ws);
      console.log(`[JOIN] ${player.name} (${joinLoginType}) → ${code} as #${pid}`);
      return;
    }

    if (msg.type === "ping") { send(ws, { type: "pong", room: currentRoom }); return; }

    // ── WORLD CHAT ──
    // hello: client le afno name + profileId pathauncha (online list + join target)
    if (msg.type === "world_chat_hello") {
      ws.chatName = String(msg.name || "Player").substring(0, 40);
      ws.chatProfileId = String(msg.profileId || "");
      return;
    }

    // dm: direct message — target player lai matra (sender lai pani dekhauncha)
    if (msg.type === "chat_dm") {
      const targetId = String(msg.targetProfileId || "").trim();
      const text = String(msg.text || "").substring(0, 200);
      if (!targetId || text.length === 0) return;
      let target = null;
      for (const w of allClients) {
        if (w.readyState === 1 && w.chatProfileId && w.chatProfileId === targetId) { target = w; break; }
      }
      if (!target) {
        send(ws, { type: "error", message: "That player is not online." });
        return;
      }
      const dm = {
        type: "chat_dm",
        sender: ws.chatName || "Player",
        senderProfileId: ws.chatProfileId || "",
        text,
        ts: Date.now(),
      };
      send(target, dm);
      send(ws, dm);
      return;
    }

    // ── WORLD CHAT ROOMS ──
    // list: open rooms (sabai connected players lai live update)
    if (msg.type === "chatroom_list") {
      send(ws, { type: "chatroom_list", rooms: chatRoomListPayload() });
      return;
    }

    // create: naya room (creator ko name = room name), creator join huncha
    if (msg.type === "chatroom_create") {
      const name = String(msg.name || ws.chatName || "Player").substring(0, 32);
      // Creator ko name update (slots/list ma yo name dekhaunxa)
      if (msg.name) ws.chatName = name;
      if (msg.profileId) ws.chatProfileId = String(msg.profileId);
      leaveChatRoom(ws);
      const room = {
        id: genCode(),
        name,
        ownerId: ws.chatProfileId || "",
        ownerWs: ws,
        ownerName: name,
        ownerProfileId: ws.chatProfileId || "",
        members: new Set(),
        slots: [null, null, null, null],   // 4 slots — creator slot 0
        createdAt: Date.now(),
      };
      room.members.add(ws);
      room.slots[0] = ws;
      chatRooms.set(room.id, room);
      ws.chatRoomId = room.id;
      send(ws, { type: "chatroom_joined", roomId: room.id, roomName: room.name, owner: true });
      broadcastChatRooms();
      // Naya room banaayo bhaye sabai lai batau → client le world chat room
      // list ma "NEW ROOM" system line dekhau.
      sendGlobal({ type: "chatroom_created", roomId: room.id, roomName: room.name, ownerName: room.ownerName, ts: Date.now() });
      sendChatRoomMembers(room);
      console.log(`[CHATROOM] ${name} created ${room.id}`);
      return;
    }

    // join: room ma join
    if (msg.type === "chatroom_join") {
      const id = String(msg.roomId || "");
      const room = chatRooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "That room no longer exists." });
        return;
      }
      // Joiner ko naam update (slots/list ma yo name dekhaunxa)
      if (msg.name) ws.chatName = String(msg.name).substring(0, 40);
      if (msg.profileId) ws.chatProfileId = String(msg.profileId);
      // Slot select: client le "+" jaba click gareko slot index pathauncha.
      let slot = Number(msg.slotIndex);
      if (!(slot >= 0 && slot < 4)) slot = -1;
      if (slot >= 0 && room.slots && room.slots[slot] && room.slots[slot] !== ws) {
        send(ws, { type: "error", message: "That slot is already taken." });
        return;
      }
      leaveChatRoom(ws);
      room.members.add(ws);
      if (!room.slots) room.slots = [null, null, null, null];
      if (slot < 0) {
        // Slot diya chaina → first free slot
        slot = room.slots.findIndex((x) => x === null);
        if (slot < 0) slot = 0;
      }
      room.slots[slot] = ws;
      ws.chatRoomId = room.id;
      send(ws, { type: "chatroom_joined", roomId: room.id, roomName: room.name, owner: false });
      broadcastChatRooms();
      sendChatRoomMembers(room);
      return;
    }

    // leave: room bata nikal
    if (msg.type === "chatroom_leave") {
      leaveChatRoom(ws);
      broadcastChatRooms();
      return;
    }

    // msg: room bhitra message (members lai matra)
    if (msg.type === "chatroom_msg") {
      const room = chatRooms.get(ws.chatRoomId);
      if (!room) return;
      const text = String(msg.text || "").substring(0, 200);
      if (text.length === 0) return;
      const payload = {
        type: "chatroom_msg",
        roomId: room.id,
        sender: ws.chatName || "Player",
        senderProfileId: ws.chatProfileId || "",
        text,
        ts: Date.now(),
      };
      for (const w of room.members) send(w, payload);
      return;
    }

    if (msg.type === "chat_global") {
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0) return;
      sendGlobal({ type: "chat_global", sender: msg.sender || "Player", text, ts: Date.now() });
      return;
    }

    if (msg.type === "chat_room") {
      const text = (msg.text || "").substring(0, 200);
      if (text.length === 0 || !currentRoom) return;
      broadcast(currentRoom, { type: "chat_room", sender: msg.sender || "Player", text, ts: Date.now() });
      return;
    }

    // ── ROOM INVITE (friends drawer "+" button) ──
    if (msg.type === "room_invite") {
      const targetProfileId = (msg.targetProfileId || "").trim();
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!targetProfileId || !code || !rooms[code]) {
        send(ws, { type: "error", message: "Invite failed — no room." });
        return;
      }
      const room = rooms[code];
      if (!room.players.some((p) => p.ws === ws)) {
        send(ws, { type: "error", message: "Invite failed — you are not in a room." });
        return;
      }
      const target = findPlayerByProfileId(targetProfileId);
      if (!target) {
        send(ws, { type: "error", message: "That friend is not online." });
        return;
      }
      if (target.ws === ws) {
        send(ws, { type: "error", message: "You cannot invite yourself." });
        return;
      }
      if (room.players.length >= room.maxPlayers) {
        send(ws, { type: "error", message: "Room is full." });
        return;
      }
      const fromName = (room.players.find((p) => p.ws === ws) || {}).name || "Player";
      send(target.ws, {
        type: "room_invite",
        roomCode: code,
        roomName: room.roomName,
        fromName,
        fromProfileId: msg.fromProfileId || "",
        ts: Date.now(),
      });
      console.log(`[INVITE] ${fromName} → ${target.name} (room ${code})`);
      return;
    }

    // ── QUICK MATCHMAKING — status-based pairing (2 real players, no fakes) ──
    if (msg.type === "quick_match") {
      if (matchQueue.some((q) => q.ws === ws)) return; // duplicate request guard
      // Pahile room ma thiyo bhane niskin (solo host START → matchmaking)
      if (currentRoom && rooms[currentRoom]) {
        const old = rooms[currentRoom];
        old.players = old.players.filter((p) => p.ws !== ws);
        if (old.players.length === 0) {
          delete rooms[currentRoom];
        } else {
          if (old.host === ws) { old.host = old.players[0].ws; old.hostName = old.players[0].name; }
          broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(old) });
        }
        currentRoom = null;
      }
      // Expired (>3 min) / dead entries hatau
      matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
      const entry = {
        ws, playerName: msg.playerName || "Player", characterId: msg.characterId | 0,
        mode: msg.mode || "SURVIVAL", loginType: msg.loginType || "guest",
        userId: msg.userId || "", profileId: msg.profileId || "",
        groupId: String(msg.groupId || ""),
        device: msg.deviceId || "", region: msg.region || DEFAULT_SERVER_ID,
        serverId: msg.serverId || msg.region || DEFAULT_SERVER_ID,
        queuedAt: Date.now(),
        teamSize: (Number(msg.teamSize) >= 1 ? Math.min(4, Number(msg.teamSize)) : 2),
      };
      matchQueue.push(entry);
      // Cancel (X) pachi pair hudaina bhanera microtask ma queue re-check
      setTimeout(() => tryQuickPair(entry), 0);
      return;
    }

    // Player le server select gare (lobby ma) → live count ra live status
    if (msg.type === "set_server") {
      const sid = String(msg.serverId || "");
      if (serverById(sid)) {
        ws.__serverId = sid;
        console.log(`[SERVER] client on ${sid}`);
      }
      return;
    }

    if (msg.type === "quick_match_cancel") {
      const entry = matchQueue.find((q) => q.ws === ws);
      matchQueue = matchQueue.filter((q) => q.ws !== ws);
      // Baki queue members ko count refresh (1/0 → … counter nai satik rahanos)
      if (entry) progressTo(entry.mode, entry.teamSize);
      // Cancel pachi fresh matchmade room (seal bhako <3s) ma chha → turunti nikal:
      // duplicate/fake match state bachau, arko player lai player_left janchha.
      if (entry && currentRoom && rooms[currentRoom]) {
        const r = rooms[currentRoom];
        if (r.matchmadeAt && Date.now() - r.matchmadeAt < 3000) {
          r.players = r.players.filter((p) => p.ws !== ws);
          if (r.players.length === 0) {
            delete rooms[currentRoom];
          } else {
            if (r.host === ws) { r.host = r.players[0].ws; r.hostName = r.players[0].name; }
            broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(r) });
          }
          currentRoom = null;
        }
      }
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = findPlayer(currentRoom, ws);

    if (msg.type === "check_game") {
      if (room.gameStarted) send(ws, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      return;
    }

    // Lobby self-heal: client return-to-lobby / panel open ma authoritative
    // room list magcha (stale 1/4 count fix).
    if (msg.type === "sync_room") {
      if (player) send(ws, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
      return;
    }

    if (msg.type === "set_character") {
      if (player) { player.characterId = msg.characterId; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) }); }
      return;
    }

    if (msg.type === "set_ready") {
      if (player) { player.ready = !!msg.ready; broadcast(currentRoom, { type: "lobby_update", players: roomPlayers(currentRoom), hostId: hostIdOf(room) }); }
      return;
    }

    if (msg.type === "kick_player") {
      if (ws === room.host) {
        const target = room.players.find((p) => p.id === msg.targetId);
        if (target && target.ws !== room.host) {
          send(target.ws, { type: "kicked", reason: "Kicked by host" });
          target.ws.close();
          room.players = room.players.filter((p) => p.id !== msg.targetId);
          sendToAll(currentRoom, { type: "player_left", playerId: msg.targetId, players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
          console.log(`[KICK] ${target.name} kicked from ${currentRoom}`);
        }
      }
      return;
    }

    if (msg.type === "set_mode") {
      if (ws === room.host) { room.mode = msg.mode || room.mode; broadcast(currentRoom, { type: "mode_changed", mode: room.mode, players: roomPlayers(currentRoom) }); }
      return;
    }

    if (msg.type === "start_game") {
      if (ws === room.host) {
        room.gameStarted = true;
        room.matchLikes = {};       // naya match = naya like state
        room.matchEliminated = [];
        console.log(`[START] ${currentRoom} mode=${room.mode} players=${room.players.length}`);
        sendToAll(currentRoom, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      }
      return;
    }

    // Match pachi lobby farke: gameStarted clear (late joiner lobby ma nai aaos)
    if (msg.type === "game_ended") {
      if (room) room.gameStarted = false;
      return;
    }

    if (msg.type === "player_move") {
      if (player) {
        player.position = msg.position || player.position;
        player.rotation = msg.rotation || player.rotation;
        broadcast(currentRoom, {
          type: "player_moved", id: player.id,
          position: player.position, rotation: player.rotation,
        }, ws);
      }
      return;
    }

    if (msg.type === "ghost_move") {
      broadcast(currentRoom, {
        type: "ghost_moved",
        position: msg.position,
        rotation: msg.rotation,
        state: msg.state,
      }, ws);
      return;
    }

    if (msg.type === "door_sync") {
      broadcast(currentRoom, {
        type: "door_update",
        doorId: msg.doorId,
        isOpen: msg.isOpen,
        playerId: player?.id,
      }, ws);
      return;
    }

    if (msg.type === "emote") {
      if (player) broadcast(currentRoom, { type: "emote", playerId: player.id, anim: msg.anim }, ws);
      return;
    }

    if (msg.type === "entry_anim") {
      if (player) broadcast(currentRoom, { type: "entry_anim", playerId: player.id, anim: msg.anim }, ws);
      return;
    }

    if (msg.type === "ghost_jumpscare") {
      broadcast(currentRoom, { type: "ghost_jumpscare", targetPlayerId: msg.targetPlayerId | 0 }, ws);
      return;
    }

    if (msg.type === "player_hit") {
      broadcast(currentRoom, { type: "player_hit", targetPlayerId: msg.targetPlayerId | 0 }, ws);
      return;
    }

    if (msg.type === "ritual_pickup") {
      broadcast(currentRoom, { type: "ritual_pickup", itemId: msg.itemId | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_place") {
      broadcast(currentRoom, { type: "ritual_place", itemId: msg.itemId | 0, slotIndex: msg.slotIndex | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_drop") {
      broadcast(currentRoom, { type: "ritual_drop", itemId: msg.itemId | 0, playerId: player ? player.id : null }, ws);
      return;
    }

    if (msg.type === "ritual_win") {
      broadcast(currentRoom, { type: "ritual_win", winnerId: msg.winnerId | 0 }, ws);
      return;
    }

    // ── MUMMY VS HUMAN — generic round/hit/dead/result sync (room relay) ──
    if (msg.type === "mummy_sync") {
      if (!player || !currentRoom) return;
      broadcast(currentRoom, { type: "mummy_sync", from: player.id, data: msg.data || {} }, ws);
      return;
    }

    // ── SPECTATOR LIKE SYSTEM (server-authoritative) ──
    // 1 spectator → 1 like per player per match. 3 likes = target eliminated.
    if (msg.type === "spectate_like") {
      if (!player) return;
      const targetId = msg.targetId | 0;
      if (targetId < 1 || targetId === player.id) return;
      if (!room.players.find((p) => p.id === targetId)) return;
      if (!room.matchLikes) room.matchLikes = {};
      if (!room.matchEliminated) room.matchEliminated = [];
      if (room.matchEliminated.includes(targetId)) return;
      if (!room.matchLikes[targetId]) room.matchLikes[targetId] = { likedBy: [] };
      const entry = room.matchLikes[targetId];
      if (entry.likedBy.includes(player.id)) return; // duplicate like — server rejects
      entry.likedBy.push(player.id);
      const count = entry.likedBy.length;
      sendToAll(currentRoom, { type: "spectate_like_update", targetId, count, fromId: player.id });
      console.log(`[LIKE] #${player.id} ${player.name} → #${targetId} (${count}/3) in ${currentRoom}`);
      if (count >= 3) {
        room.matchEliminated.push(targetId);
        sendToAll(currentRoom, { type: "spectate_eliminated", targetId });
        console.log(`[ELIM] #${targetId} eliminated by 3 likes in ${currentRoom}`);
      }
      return;
    }
  });

  ws.on("close", () => {
    leaveChatRoom(ws);
    broadcastChatRooms();
    allClients.delete(ws);
    matchQueue = matchQueue.filter((q) => q.ws !== ws); // queue bata turunti hata
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter((p) => p.ws !== ws);
    if (room.players.length === 0) { delete rooms[currentRoom]; console.log(`[DELETE] Room ${currentRoom}`); return; }
    if (room.host === ws) {
      room.host = room.players[0].ws;
      room.hostName = room.players[0].name;
      console.log(`[HOST] ${room.hostName} → new host of ${currentRoom}`);
    }
    broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
  });
});

setInterval(() => {
  // Stale presence (client gayo) nikal
  const nowP = Date.now();
  for (const [pid, p] of presence) {
    if (nowP - p.ts >= PRESENCE_TTL) presence.delete(pid);
  }
  // Queue bata expired/dead entries nikal (180s timeout client-side le pani cancel garchha)
  matchQueue = matchQueue.filter((q) => q.ws.readyState === 1 && Date.now() - q.queuedAt < 180000);
  Object.keys(rooms).forEach((code) => {
    const alive = rooms[code].players.filter((p) => p.ws.readyState === 1);
    if (alive.length === 0) delete rooms[code];
    else rooms[code].players = alive;
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Night Ward Server v4.5 on port ${PORT}`);
});
