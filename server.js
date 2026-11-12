// One malformed packet or a momentary network fault must not take the whole
// service down: every player on this box loses their match when it does, and a
// crash loop is what gets the deployment marked failed. Installed before the
// requires below so even a load-time failure is reported instead of exiting 1.
process.on('uncaughtException', (err) => {
    console.error('[PROCESS] uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] unhandled rejection:', reason);
});

// On Render an exit-1 with no visible reason is almost always a missing
// dependency, which happens when the service's Root Directory is not the folder
// that holds package.json, so `npm install` installed nothing. Say so plainly.
function load(name) {
    try {
        return require(name);
    } catch (err) {
        console.error(
            `[BOOT] Cannot load "${name}": ${err.message}\n` +
            `[BOOT] Fix on Render -> Settings:\n` +
            `[BOOT]   Root Directory = the folder that contains package.json\n` +
            `[BOOT]   Build Command  = npm install\n` +
            `[BOOT]   Start Command  = node server.js\n` +
            `[BOOT]   Node Version   = 18 or newer`
        );
        process.exit(1);
    }
}

const http = load('http');
const WebSocket = load('ws');

// Every deployed instance can be a matchmaker. The very first one becomes the
// hub that owns every queue, every team and every room (reached by a stable
// URL). Every later instance is a relay: it holds the players' sockets but
// forwards matchmaking, teams and game logic to that hub, so a player who lands
// on any box still enters the same queue as everyone else. Hubs talk to hubs
// too - when a region's queue sits waiting, the hub hands its roster to another
// region's hub so a match can be built across them.
//   HUB_URL            - empty => I am the hub (the first, canonical process).
//                        set   => the hub I relay to (and, for a hub, my peer).
//   REGION_ID          - this instance's name, sent as part of every handoff.
//   HUB_WAKE_URL       - URL a new relay pings to spin the sleeping hub up.
//   HUB_WAKE_INTERVAL  - ms between wake pings while the hub is still down.
const PORT = process.env.PORT || 10000;
const HUB_URL = (process.env.HUB_URL || "").trim();
const REGION_ID = (process.env.REGION_ID || process.env.RENDER_SERVICE_NAME || "region-" + PORT).trim();
const HUB_WAKE_URL = (process.env.HUB_WAKE_URL || HUB_URL).trim();
const HUB_WAKE_INTERVAL = Math.max(5000, parseInt(process.env.HUB_WAKE_INTERVAL, 10) || 15000);
const ROSTER_STALE_MS = 15000;        // a hub that stopped reporting is treated as empty
const FEDERATE_AFTER_MS = 8000;       // queue age before we look for a cross-region pair

// Data in, whatever the source: the phone, this process, or a hub on another
// continent. A send can throw on a socket that is closing, and a typed string
// is the only contract the rest of the server relies on.
function sendJson(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (_e) { /* closing socket */ }
}

function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch (_e) { return null; }
}

const server = http.createServer((req, res) => {
    // GET / -> health check for Render (it marks the deploy live once this
    // answers). Anything else closes cleanly; there is no HTTP API here.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
        const body = HUB_URL === ""
            ? `Flame Strike matchmaking hub (${REGION_ID})\n`
            : `Flame Strike matchmaking relay (${REGION_ID} -> ${HUB_URL})\n`;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(body);
        return;
    }
    res.writeHead(404);
    res.end();
});

// The actual game clients connect here. A hub also accepts its relays on the
// very same socket, so one port serves both roles with no second listener.
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

let nextMatchId = 1;
let nextRelayId = 1;
let nextTeamId = 1;
let nextRemoteId = 1;
let nextMirrorId = 1;

// The hub hands a waiting roster to a peer hub that can complete it. A
// "mirror" room is a booking the receiver keeps: a found_match has already
// been sent to every player on that side, so the moment the other side's
// booking arrives the receiver builds the real room out of both rosters and
// drops the mirrors. Nothing about this lives on the wire to a phone.
const mirrorRooms = new Map();     // mirrorId -> mirror room

// ---------------------------------------------------------------- relay -> hub
// Open only on a relay box. Every message that needs global state (teams,
// matchmaking, a live room's logic) is wrapped and sent upstream; the hub
// answers to this socket and deliverTo routes the reply back to the right
// local player. A broken link is retried with backoff, and the local maps
// never pretend to own what only the hub knows.
let hub = null;                    // WebSocket to the hub (relay side only)
let hubReady = false;
let hubRetryAt = 0;
let hubBackoff = 1000;
let hubWoke = false;

// The hub's view of every box connected to it, keyed by the relay socket.
// state.games / state.teams / state.clients are maps keyed by the remote id
// the hub minted for that player, so a reply can be routed back to the exact
// relay that owns the real socket.
const relays = new Map();          // relay ws -> { id, region, state:{games,teams,clients} }

// Hubs that announced themselves as peers. A roster we hand off travels to
// the least-loaded one that still answers, and a roster handed to us arrives
// on the same link.
const peers = new Map();           // hub-peer ws -> { region, load, rosters, reportedAt }

function wakeHub() {
    // A sleeping hub cannot accept a websocket; a plain HTTP GET is enough to
    // wake it on Render. Retried on an interval until the socket is up, and it
    // never talks to this process's own listener.
    if (HUB_URL === "" || hubReady || hubWoke || HUB_WAKE_URL === "") return;
    if (HUB_WAKE_URL.indexOf(':' + String(PORT)) !== -1) return;
    hubWoke = true;
    const ping = () => {
        if (hubReady) return;
        try {
            const u = new URL(HUB_WAKE_URL);
            const mod = u.protocol === 'https:' ? load('https') : http;
            const req = mod.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname || '/',
                timeout: 8000,
                headers: { 'User-Agent': 'FlameStrike-Relay/1.0' }
            }, (res) => { res.resume(); });
            req.on('timeout', () => req.destroy());
            req.on('error', () => {});
        } catch (_e) {}
        if (!hubReady) setTimeout(ping, HUB_WAKE_INTERVAL);
    };
    ping();
}

function connectToHub() {
    if (HUB_URL === "" || hub || Date.now() < hubRetryAt) return;
    let sock;
    try {
        sock = new WebSocket(HUB_URL);
    } catch (_e) {
        hubRetryAt = Date.now() + hubBackoff;
        hubBackoff = Math.min(hubBackoff * 2, 15000);
        return;
    }
    hub = sock;

    sock.on('open', () => {
        hubReady = true;
        hubBackoff = 1000;
        console.log(`[RELAY] linked to hub ${HUB_URL} as ${REGION_ID}`);
        // A hub that restarts loses every remote id it minted, so the relay
        // re-introduces itself and asks the hub to forget this box's ghosts.
        sendJson(sock, { type: "relay_hello", region: REGION_ID });
        // Anyone who was sitting in a queue or on a team when the hub died must
        // be told plainly: their next action is a fresh search, not a wait on a
        // room that no longer exists anywhere.
        for (const ws of wss.clients) {
            if (ws.queued || ws.teamRemote) {
                ws.queued = false;
                ws.teamRemote = null;
                sendJson(ws, { type: "match_cancelled", reason: "hub_lost" });
            }
        }
    });

    sock.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch (_e) { return; }
        handleHubMessage(msg);
    });

    const gone = () => {
        if (hub !== sock) return;
        hub = null;
        hubReady = false;
        hubRetryAt = Date.now() + hubBackoff;
        hubBackoff = Math.min(hubBackoff * 2, 15000);
        console.log(`[RELAY] hub link lost, retrying in ${Math.round((hubRetryAt - Date.now()) / 1000)}s`);
    };
    sock.on('close', gone);
    sock.on('error', () => { try { sock.terminate(); } catch (_e) {} });
}

function relaySend(obj) {
    // A relay only ever talks to its hub; when the link is down the caller is
    // responsible for telling the player, because the hub is the source of truth.
    if (!hubReady || !hub) return false;
    sendJson(hub, obj);
    return true;
}

// A reply from the hub names the remote id of the player it concerns. The
// relay maps that id to the live local socket and hands the payload over
// untouched, so the client never learns it spoke through a relay at all.
function handleHubMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const kind = msg._kind;

    if (kind === "to_client") {
        const ws = remoteClients.get(String(msg.remote || ""));
        if (ws) sendJson(ws, msg.payload || {});
        return;
    }

    // A match the hub built (possibly from a roster another hub sent). Bind
    // every local seat to the room id and tell the phone exactly what the hub
    // decided: who is on which side, which spawn, which team.
    if (kind === "room_start") {
        const roomId = String(msg.roomId || "");
        const members = Array.isArray(msg.members) ? msg.members : [];
        for (const m of members) {
            const ws = remoteClients.get(String(m.remote || ""));
            if (!ws) continue;
            ws.matchId = roomId;
            ws.matchUid = String(m.playerUid || "");
            ws.matchSpawnIndex = typeof m.spawnIndex === "number" ? m.spawnIndex : -1;
            ws.matchSide = typeof m.side === "number" ? m.side : -1;
            ws.queued = false;
        }
        // Fan the found_match out locally, but keep the relay-only "remote"
        // tag off the wire to the phone.
        for (const m of members) {
            const ws = remoteClients.get(String(m.remote || ""));
            if (!ws) continue;
            const out = Object.assign({}, msg.payload || {});
            sendJson(ws, out);
        }
        return;
    }

    // A team snapshot the hub computed for this relay's member. Cache the
    // remote team id so later team actions (invite, leave, kick) can be routed
    // back to the right group on the hub.
    if (kind === "team_state") {
        const ws = remoteClients.get(String(msg.remote || ""));
        if (!ws) return;
        const payload = msg.payload || {};
        if (payload.team && payload.team.team_id) ws.teamRemote = String(payload.team.team_id);
        else ws.teamRemote = null;
        sendJson(ws, payload);
        return;
    }
}

// ---------------------------------------------------------------- hub state --
// Only meaningful on the box that is the hub (HUB_URL empty). A relay's
// player is represented here by a "proxy" - a plain object that looks enough
// like a WebSocket (readyState, send, a couple of ids) for the existing
// room/queue/team code to treat it as a seat, while send() actually forwards
// the bytes back down the relay link.
const remoteClients = new Map();   // remoteId (relay-side key) -> local ws
// hub-side: remote id string -> proxy seat

function makeProxy(relaySock, remoteId, region) {
    return {
        readyState: WebSocket.OPEN,
        _proxy: true,
        _relay: relaySock,
        _remote: String(remoteId),
        _region: region || "relay",
        isAlive: true,
        matchId: null,
        matchUid: "",
        matchSpawnIndex: -1,
        matchSide: -1,
        queued: false,
        teamId: null,
        teamRemote: null,
        voiceKey: "",
        // The room code calls ws.send(text). Forward it to the relay that owns
        // the real socket; the relay will hand the text to the phone.
        send: function (text) {
            if (!this._relay || this._relay.readyState !== WebSocket.OPEN) return;
            sendJson(this._relay, { _kind: "to_client", remote: this._remote, payload: safeJsonParse(text) || {} });
        },
        // A proxy never pings; its liveness is the relay link itself.
        ping: function () {},
        terminate: function () {},
        close: function () {}
    };
}

// Drop every seat a relay owned: pull them out of queues, teams and rooms the
// same way a real disconnect would, so a relay that vanishes does not leave
// ghost bodies holding spots.
function dropRelay(relaySock) {
    const info = relays.get(relaySock);
    if (!info) return;
    relays.delete(relaySock);
    for (const [rid, seat] of info.state.clients.entries()) {
        // Reuse the normal close path by marking the proxy closed and running
        // the same cleanup a socket close would trigger.
        seat.readyState = WebSocket.CLOSED;
        removeFromAllQueues(seat);
        leaveTeam(seat);
        leaveVoice(seat);
        const room = seat.matchId && matches.get(seat.matchId);
        if (room) {
            room.players = room.players.filter(p => p !== seat);
            const entry = room.entries.find(e => e.ws === seat);
            if (entry) entry.ws = seat; // keep a stable reference for state builds
            // A proxy that drops mid-match is a disconnect: treat like a gone
            // socket so the grace timer / forfeit rules still apply.
            if (room.game && room.game.phase !== "finished") {
                const ent = room.entries.find(e => e.uid === seat.matchUid || e.ws === seat);
                if (ent) ent.gone = true;
                armGraceTimer(room);
            }
        }
    }
    info.state.clients.clear();
}

// ---------------------------------------------------------------- teams / queue
const teams = new Map();           // teamId -> { id, leaderUid, maxSize, mode, members:[{ws,uid,username,characterId,bundleId}], inviters:{} }
const queues = Object.create(null); // mode -> [solo entries]
const teamQueues = Object.create(null);
const MUMMY_MODE = "MUMMY_VS_HUMAN";
const ZOMBIE_MODE = "ZOMBIE_ECLIPSE";
const ZOMBIE_TEAM_SIZE = 4;
queues[MUMMY_MODE] = [];
queues[ZOMBIE_MODE] = [];
teamQueues[MUMMY_MODE] = [];
teamQueues[ZOMBIE_MODE] = [];

const TEAM_SLOTS = [1, 2, 3, 4];
const SQUAD_TEAM_SIZE = 4;
const QUEUE_STALE_MS = 120000;     // drop bodies that sat waiting longer than this
const NO_TEAM = { type: "team_update", team: null };

function uidKey(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return String(Math.trunc(n));
    return String(v || "").trim();
}

function bindUid(ws, data) {
    const uid = uidKey((data && (data.uid || data.player_uid)) || ws.uid || "");
    if (uid) ws.uid = uid;
    return uid;
}

function refreshIdentity(uid, data) {
    if (!uid) return;
    const name = String((data && data.username) || "").trim();
    const cid = data && data.character_id;
    const bid = data ? bundleIdOf(data) : undefined;
    // Keep the team roster current for a member whose profile loaded after the
    // team was formed (or who changed character in the lobby).
    for (const team of teams.values()) {
        const m = team.members.find(x => x.uid === uid);
        if (!m) continue;
        if (name) m.username = name;
        if (cid) m.characterId = cid;
        if (bid !== undefined) m.bundleId = bid;
    }
}

function bundleIdOf(obj) {
    if (!obj) return 0;
    const raw = obj.bundle_id !== undefined ? obj.bundle_id : obj.bundleId;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
}

function bundleOf(member) {
    return member ? bundleIdOf(member) : 0;
}

function teamOf(ws) {
    if (!ws || !ws.teamId) return null;
    const team = teams.get(ws.teamId);
    if (!team) { ws.teamId = null; return null; }
    return team;
}

function teamPayload(team) {
    if (!team) return null;
    return {
        team_id: team.id,
        leader_uid: team.leaderUid,
        max_size: team.maxSize,
        mode: team.mode || "",
        members: team.members.map(m => ({
            uid: m.uid,
            username: m.username,
            character_id: m.characterId,
            bundle_id: bundleOf(m)
        }))
    };
}

function broadcastTeam(team) {
    const payload = JSON.stringify({ type: "team_update", team: teamPayload(team) });
    for (const m of team.members) {
        if (m.ws && m.ws.readyState === WebSocket.OPEN) {
            try { m.ws.send(payload); } catch (_e) {}
        }
    }
}

function teamError(ws, text) {
    sendJson(ws, { type: "team_error", message: String(text || "Team action failed") });
}

function createTeam(ws, uid, username, characterId, bundleId, maxSize) {
    const id = "team-" + String(nextTeamId++);
    const team = {
        id: id,
        leaderUid: uid,
        maxSize: Math.min(4, Math.max(1, parseInt(maxSize, 10) || 1)),
        mode: "",
        inviters: Object.create(null),
        members: [{
            ws: ws,
            uid: uid,
            username: String(username || "Player"),
            characterId: characterId || 1,
            bundleId: bundleId || 0
        }]
    };
    ws.teamId = id;
    teams.set(id, team);
    return team;
}

function disbandTeam(team, reasonText) {
    if (!team) return;
    removeFromTeamQueue(team.id);
    const members = team.members.slice();
    for (const m of members) {
        if (m.ws) m.ws.teamId = null;
    }
    teams.delete(team.id);
    for (const m of members) {
        sendJson(m.ws, { type: "team_disbanded", reason: String(reasonText || "") });
        sendJson(m.ws, NO_TEAM);
    }
}

function leaveTeam(ws) {
    const team = teamOf(ws);
    if (!team) { sendJson(ws, NO_TEAM); return; }
    const uid = uidKey(ws.uid);
    const idx = team.members.findIndex(m => m.uid === uid || m.ws === ws);
    if (idx < 0) { ws.teamId = null; sendJson(ws, NO_TEAM); return; }

    // Pulling out of a party also pulls the party out of any queue it sat in:
    // a half-party cannot keep a reserved slot.
    removeFromTeamQueue(team.id);
    team.members.splice(idx, 1);
    ws.teamId = null;
    sendJson(ws, NO_TEAM);

    if (team.members.length <= 0) {
        teams.delete(team.id);
        return;
    }

    if (team.leaderUid === uid) {
        // The leader leaving dissolves the group entirely (members go back to solo),
        // which matches the lobby's "only the leader can search / own the party" model.
        disbandTeam(team, "The team leader left");
        return;
    }

    broadcastTeam(team);
}

function kickMember(ws, targetUid) {
    const team = teamOf(ws);
    if (!team) { teamError(ws, "You are not in a team"); return; }
    const uid = uidKey(ws.uid);
    if (team.leaderUid !== uid) { teamError(ws, "Only the team leader can kick"); return; }
    if (targetUid === uid) { teamError(ws, "You cannot kick yourself"); return; }
    const idx = team.members.findIndex(m => m.uid === targetUid);
    if (idx < 0) { teamError(ws, "That player is not in your team"); return; }

    removeFromTeamQueue(team.id);
    const [removed] = team.members.splice(idx, 1);
    if (removed && removed.ws) removed.ws.teamId = null;
    sendJson(removed && removed.ws, { type: "team_kicked" });
    sendJson(removed && removed.ws, NO_TEAM);

    if (team.members.length <= 1) {
        disbandTeam(team, "The team no longer has enough members");
        return;
    }
    broadcastTeam(team);
}

function removeFromTeamQueue(teamId) {
    if (!teamId) return;
    for (const mode of Object.keys(teamQueues)) {
        const before = teamQueues[mode].length;
        teamQueues[mode] = teamQueues[mode].filter(g => g.teamId !== teamId);
        if (teamQueues[mode].length !== before) broadcastPoolStatus(mode, 0); // cheap full refresh via per-slot below
    }
}

function removeFromAllQueues(ws) {
    for (const mode of Object.keys(queues)) {
        const before = queues[mode].length;
        queues[mode] = queues[mode].filter(e => e.ws !== ws);
        if (queues[mode].length !== before) {
            // We don't know every slot cheaply; refresh all slots for this mode.
            for (const s of TEAM_SLOTS) broadcastPoolStatus(mode, s);
        }
    }
    for (const mode of Object.keys(teamQueues)) {
        const before = teamQueues[mode].length;
        teamQueues[mode] = teamQueues[mode].filter(g => !g.members.some(m => m.ws === ws));
        if (teamQueues[mode].length !== before) {
            for (const s of TEAM_SLOTS) broadcastPoolStatus(mode, s);
        }
    }
}

function pruneStaleQueues() {
    const now = Date.now();
    for (const mode of Object.keys(queues)) {
        let changed = false;
        queues[mode] = queues[mode].filter(e => {
            if (!e || !e.ws || e.ws.readyState !== WebSocket.OPEN) { changed = true; return false; }
            if (e.ws.matchId && matches.has(e.ws.matchId)) { changed = true; return false; }
            if (now - (e.queuedAt || 0) > QUEUE_STALE_MS) { changed = true; sendJson(e.ws, { type: "match_cancelled", reason: "timeout" }); return false; }
            return true;
        });
        if (changed) for (const s of TEAM_SLOTS) broadcastPoolStatus(mode, s);
    }
    for (const mode of Object.keys(teamQueues)) {
        let changed = false;
        teamQueues[mode] = teamQueues[mode].filter(g => {
            if (!g || !Array.isArray(g.members) || g.members.length === 0) { changed = true; return false; }
            if (g.members.some(m => !m.ws || m.ws.readyState !== WebSocket.OPEN)) { changed = true; return false; }
            if (g.members.some(m => m.ws.matchId && matches.has(m.ws.matchId))) { changed = true; return false; }
            if (now - (g.queuedAt || 0) > QUEUE_STALE_MS) {
                changed = true;
                for (const m of g.members) sendJson(m.ws, { type: "match_cancelled", reason: "timeout" });
                return false;
            }
            return true;
        });
        if (changed) for (const s of TEAM_SLOTS) broadcastPoolStatus(mode, s);
    }
}

function roomId() {
    return "match-" + String(nextMatchId++);
}

function spawnIndexForSeat(mode, side, sideIndex, sideSize) {
    // Mummy matches place Team A on Spawn1/2/3/4 and Team B on Spawn5/6/7/8.
    // 1v1 uses (Spawn1, Spawn5), 2v2 uses (Spawn1,2, Spawn5,6), etc.
    // Zombie Eclipse stays on a full contiguous 4v4 ring (Spawn1-8) to preserve
    // existing zombie scene/placement logic.
    if (mode === ZOMBIE_MODE) {
        return side * ZOMBIE_TEAM_SIZE + sideIndex;
    }
    const base = side === 0 ? 0 : 4;
    return base + sideIndex;
}

function cloneEntryForRoom(e, teamId, allyUids) {
    return {
        ws: e.ws,
        uid: e.playerUid || uidKey(e.ws && e.ws.uid),
        username: e.username || "Player",
        characterId: e.characterId || 1,
        bundleId: bundleIdOf(e),
        spawnIndex: -1,
        side: -1,
        teamId: teamId || "",
        team: teamId ? 1 : 0,
        allies: Array.isArray(allyUids) ? allyUids.slice() : [],
        ready: false,
        gone: false,
        pos: { x: 0, y: 0, z: 0, yaw: 0 },
        lastStateSent: ""
    };
}

function makeRoom(mode, slot, sideA, sideB) {
    const id = roomId();
    const entries = [];
    const usedSpawns = new Set();
    const players = [];

    const pushSide = (sideObj, side) => {
        for (let i = 0; i < sideObj.members.length; i++) {
            const m = sideObj.members[i];
            const ent = cloneEntryForRoom(m, sideObj.teamId, m.allyUids || []);
            ent.side = side;
            ent.spawnIndex = spawnIndexForSeat(mode, side, i, sideObj.members.length);
            ent.team = side + 1;
            if (!ent.ws || ent.ws.readyState !== WebSocket.OPEN) return false;
            if (usedSpawns.has(ent.spawnIndex)) return false;
            usedSpawns.add(ent.spawnIndex);
            entries.push(ent);
            players.push(ent.ws);
        }
        return true;
    };

    if (!pushSide(sideA, 0) || !pushSide(sideB, 1)) return null;
    if (entries.length !== slot * 2) return null;

    const room = {
        matchId: id,
        mode: mode,
        slot: slot,
        sideSize: slot,
        entries: entries,
        players: players,
        game: null,
        graceTimer: null
    };
    matches.set(id, room);

    for (const e of entries) {
        e.ws.matchId = id;
        e.ws.matchUid = e.uid;
        e.ws.matchSpawnIndex = e.spawnIndex;
        e.ws.matchSide = e.side;
    }

    // Authoritative per-client match payload (team/side/spawn IDs stay in sync).
    for (const e of entries) {
        const opponent = entries.find(x => x.side !== e.side) || entries[0];
        const allies = entries.filter(x => x !== e && x.side === e.side).map(x => x.uid);
        sendJson(e.ws, {
            type: "found_match",
            match_id: id,
            mode: mode,
            team_size: slot,
            side_size: slot,
            required_players: slot * 2,
            player_id: e.uid,
            player_uid: e.uid,
            username: e.username,
            character_id: e.characterId,
            bundle_id: bundleOf(e),
            spawn_index: e.spawnIndex,
            spawn_id: e.spawnIndex + 1,
            side: e.side,
            team: e.side + 1,
            team_name: (mode === ZOMBIE_MODE ? ZOMBIE_TEAM_NAMES[e.side] : MUMMY_TEAM_NAMES[e.side]) || "",
            team_id: e.teamId || "",
            ally_uids: allies,
            opponent_id: opponent.uid,
            opponent_uid: opponent.uid,
            opponent_name: opponent.username,
            opponent_character_id: opponent.characterId,
            opponent_bundle_id: bundleOf(opponent),
            opponent_spawn_index: opponent.spawnIndex,
            players: entries.map(x => ({
                id: x.uid,
                player_uid: x.uid,
                username: x.username,
                character_id: x.characterId,
                bundle_id: bundleOf(x),
                spawn_index: x.spawnIndex,
                spawn_id: x.spawnIndex + 1,
                side: x.side,
                team: x.side + 1,
                team_name: (mode === ZOMBIE_MODE ? ZOMBIE_TEAM_NAMES[x.side] : MUMMY_TEAM_NAMES[x.side]) || ""
            }))
        });
    }

    if (mode === ZOMBIE_MODE) initZombieMatch(room);
    else initMummyMatch(room);
    console.log(`[MATCH] ${id} started (${mode}, ${slot}v${slot}, ${entries.length} players)`);
    return room;
}

// A queued body is only usable while its socket is open, it is still asking for
// this exact mode and slot, and it has not meanwhile been placed in a room.
function queueEntryUsable(entry, mode, slot) {
    return !!entry && !!entry.ws
        && entry.ws.readyState === WebSocket.OPEN
        && entry.mode === mode
        && entry.slot === slot
        && !(entry.ws.matchId && matches.has(entry.ws.matchId));
}

// Everyone searching one (mode, slot) is competing for the same seats, so the
// number a waiting phone is shown counts every body already sitting in that
// pool: the lone searchers plus the members of any party short of the slot.
function broadcastPoolStatus(mode, slot) {
    if (!queues[mode]) return;
    const pool = queues[mode].filter(e => e.slot === slot);
    const required = slot * 2;
    let bodies = pool.filter(e => queueEntryUsable(e, mode, slot)).length;
    for (const g of usableGroups(mode, slot)) bodies += g.members.length;
    for (const e of pool) {
        sendJson(e.ws, {
            type: "player_joined",
            mode: mode,
            team_size: slot,
            player_count: Math.min(bodies, required),
            required_players: required
        });
    }
}

function broadcastAllPools() {
    for (const mode of Object.keys(queues)) {
        for (const slot of TEAM_SLOTS) broadcastPoolStatus(mode, slot);
    }
}

function usableGroups(mode, slot) {
    return (teamQueues[mode] || []).filter(g =>
        g && g.mode === mode && g.slot === slot &&
        Array.isArray(g.members) && g.members.length > 0 && g.members.length <= slot &&
        g.members.every(m => queueEntryUsable(m, mode, slot))
    );
}

function sidePacks(groups, slot) {
    const packs = [];
    const n = groups.length;
    // Enumerate every subset of groups and keep those whose total size is <= slot.
    // A "side" is one such pack (whole parties only, never split) plus however
    // many solo searchers are needed to reach the slot.
    for (let mask = 1; mask < (1 << n); mask++) {
        let seats = 0;
        const chosen = [];
        for (let i = 0; i < n; i++) {
            if (!(mask & (1 << i))) continue;
            seats += groups[i].members.length;
            chosen.push(groups[i]);
        }
        if (seats > 0 && seats <= slot) {
            packs.push({ groups: chosen, seats: seats, openSeats: slot - seats });
        }
    }
    return packs;
}

function planRoom(mode, slot) {
    const groups = usableGroups(mode, slot);
    const solos = queues[mode].filter(e => e.slot === slot && queueEntryUsable(e, mode, slot));
    const packs = sidePacks(groups, slot);
    for (const a of packs) {
        for (const b of packs) {
            if (a.groups.some(g => b.groups.includes(g))) continue;
            if (a.openSeats + b.openSeats > solos.length) continue;
            const mine = solos.slice(0, a.openSeats);
            const theirs = solos.slice(a.openSeats, a.openSeats + b.openSeats);
            return {
                sides: [mixSide(a, mine), mixSide(b, theirs)],
                groups: a.groups.concat(b.groups),
                solos: mine.concat(theirs)
            };
        }
    }
    // Pure-solo fallback: enough lone searchers to build both full sides.
    if (groups.length === 0 && solos.length >= slot * 2) {
        return {
            sides: [
                { teamId: "", members: solos.slice(0, slot) },
                { teamId: "", members: solos.slice(slot, slot * 2) }
            ],
            groups: [],
            solos: solos.slice(0, slot * 2)
        };
    }
    return null;
}

function mixSide(pack, soloSlice) {
    const members = [];
    for (const g of pack.groups) {
        for (const m of g.members) members.push(m);
    }
    return {
        // A side made of more than one source belongs to nobody's party.
        teamId: pack.groups.length === 1 && soloSlice.length === 0 ? pack.groups[0].teamId : "",
        members: members.concat(soloSlice)
    };
}

function squadTargetSlot(mode, requestedSlot) {
    // Squad matchmaking (Free Fire style): Mummy matches build 4-player squads
    // by combining compatible parties/solos while keeping parties together.
    if (mode === MUMMY_MODE) return 4;
    return requestedSlot;
}

function queueTeam(mode, team, requestedSlot) {
    const slot = squadTargetSlot(mode, requestedSlot);
    const allyUidsOf = (uid) => team.members.filter(m => m.uid !== uid).map(m => m.uid);
    const group = {
        teamId: team.id,
        mode: mode,
        slot: slot,
        requestedSlot: requestedSlot,
        teamSize: slot,
        queuedAt: Date.now(),
        members: team.members.map(m => ({
            ws: m.ws,
            mode: mode,
            slot: slot,
            requestedSlot: requestedSlot,
            characterId: m.characterId,
            bundleId: bundleOf(m),
            username: m.username,
            playerUid: m.uid,
            teamId: team.id,
            allyUids: allyUidsOf(m.uid)
        }))
    };
    teamQueues[mode].push(group);
    for (const member of group.members) {
        sendJson(member.ws, {
            type: "team_searching",
            team_id: team.id,
            mode: mode,
            team_size: slot,
            preferred_team_size: requestedSlot,
            player_count: group.members.length,
            required_players: slot * 2
        });
    }
    processMatchQueue(mode);
}

function processMatchQueue(mode) {
    pruneStaleQueues();
    for (const slot of TEAM_SLOTS) {
        for (;;) {
            const plan = planRoom(mode, slot);
            if (!plan) break;

            const room = makeRoom(mode, slot, plan.sides[0], plan.sides[1]);
            if (!room) break;

            // Remove every consumed solo and every consumed group from the pools.
            const usedSolo = new Set(plan.solos.map(e => e.ws));
            const usedGroups = new Set(plan.groups.map(g => g.teamId));
            queues[mode] = queues[mode].filter(e => !usedSolo.has(e.ws));
            teamQueues[mode] = teamQueues[mode].filter(g => !usedGroups.has(g.teamId));
            broadcastPoolStatus(mode, slot);
        }
    }
}

// ---- Human side ability: Holographic Clones ----
// Which character owns which ability is decided here, not in the client's CATALOG,
// so a tampered message cannot hand a player an ability they never equipped. Keep
// this table and character_manager.gd's CATALOG "ability" rows in step.
const CHARACTER_ABILITIES = { 2: "clone", 3: "aura", 4: "shield", 5: "hp_shield" };
const CLONE_COUNT = 2;
const CLONE_LIFETIME_MS = 10000;   // then it fades out on its own
const CLONE_MAX_HITS = 3;          // or a Mummy lands three swings first
const ABILITY_COOLDOWN_MS = 70000;
// Mirrors ATTACK_RANGE in mummy_match.gd: the reach a catcher actually swings.
const MUMMY_ATTACK_RANGE = parseFloat(process.env.MUMMY_ATTACK_RANGE) || 2.6;
// The decoys step out ahead of the Human, so they lead the caster instead of
// appearing at their shoulder. A small side offset keeps the two of them apart.
const CLONE_FRONT_METRES = 1.8;
const CLONE_SPREAD_METRES = 0.55;
// Clones then walk straight ahead from where they appeared.
// Both ends use these two numbers: the phone draws the body on this line, and
// the server moves its own copy down the same line, so a swing at what a player
// sees is a swing on the body the server is counting.
const CLONE_WALK_SPEED = 1.25;     // metres per second, in a straight line
const CLONE_WALK_CAP_METRES = 8.0; // never further than this from the birth spot
// ---- Ashes Turner ability: Azure Rampart ----
// A glowing shell that rides with the caster and turns a fixed number of Mummy
// swings into a draw. Unlike the decoy the wall does not take the catcher's
// place: it simply drinks the blow, so the player inside it can still be
// surrounded but cannot be cut down while the count holds.
const SHIELD_LIFETIME_MS = 15000;
const SHIELD_RADIUS = 1.15;        // horizontal reach of the shell, body inclusive
const SHIELD_HEIGHT = 2.4;         // tall enough to read as a dome over the body
const SHIELD_DESTROY_AT = 5;       // gone on the fifth clean Mummy swing
// ---- Shadow Ranger ability: soul shield ----
// A blue extra HP bar laid over the normal one. A Mummy has to spend this bar
// before any swing can touch the body HP underneath, and the armour dissolves on
// its own after 20 seconds even if it was never fully spent.
const HP_SHIELD_LIFETIME_MS = 20000;
const HP_SHIELD_AMOUNT = 50;
// A sheet of glass still lets a body swap places with the person inside it.
// Only the two solid shells - Azure Rampart and the 50-HP soul shield - count
// as a wall nobody walks through.
function shieldBlocksPassage(g, playerId) {
    return !!(g.shields && g.shields[playerId]) || hpShieldActive(g.combat[playerId]);
}
// ---- Ashes Turner ability: Crimson Benediction ----
// A red cloud under the caster's feet that tops their whole team back up over 10
// seconds. The caster heals anywhere inside it; a teammate only while standing in
// the same cloud, so the radius is the radius the healer owns.
const AURA_LIFETIME_MS = 10000;
const AURA_COOLDOWN_MS = 120000;   // 2 minutes, separate from the other 70s abilities
const AURA_RADIUS = 2.5;           // how far the heal reaches from the caster
const AURA_HEAL_TOTAL = 100;       // spread across the full 10s, for any Human in range

function abilityFor(entry) {
    return CHARACTER_ABILITIES[entry.characterId] || "";
}

function abilityCooldownMs(kind) {
    // Benediction is a 2-minute prayer; the decoy and the rampart keep 70s.
    return kind === "aura" ? AURA_COOLDOWN_MS : ABILITY_COOLDOWN_MS;
}

function initMummyMatch(room) {
    // The roles are decided per round, not per match, because a Mummy can only
    // ever score by knocking a Human out and a Human only by lasting the clock.
    // Whoever hunts first is a coin flip, and the teams swap every round after,
    // so the same side never chases twice in a row. The match ends the moment a
    // team reaches five.
    room.game = {
        kind: "mummy",             // the ticker ignores a room that is not this kind
        phase: "waiting",          // waiting -> playing -> round_break -> ... -> finished
        ready: new Set(),
        round: 0,
        sideSize: room.entries.filter(e => e.side === 0).length,
        roundMs: 30000,
        sideScore: [0, 0],         // points per arena side (0 = Team A, 1 = Team B)
        hunterSide: 0,             // which side is the Mummy this round
        roles: {},                 // id -> "mummy" | "human", redrawn each round
        swingSeq: {},              // attacker id -> swings so far, so the punch clips alternate
        combat: {},                // id -> { hp, downed, eliminated, downedSince, reviveMs, reviveAt, revivers }
        abilities: {},             // caster id -> { cooldownUntil }
        nextCloneNum: 1,           // hands every hologram a unique, never-reused id
        clones: {},                // cloneId -> { casterId, x, z, yaw, hits, expiresAt }
        shields: {},               // caster id -> { hits, expiresAt } while a dome stands
        settled: false,
        roundOutcome: "",          // "mummy" | "human" once the round is decided
        winnerSide: -1,
        endsAt: 0
    };
    broadcastMummyState(room, true);
}

// Every Human on the board, whether they are standing, downed or already out.
// A Human is a role, not a health state, so a bleed-out never stops counting.
function mummyHumanIds(room) {
    const g = room.game;
    return room.entries
        .map(e => mummyIdOf(e))
        .filter(id => g.roles[id] === "human");
}

function mummyIdOf(entry) {
    // A stable id per seat: prefer the authenticated uid, fall back to spawn.
    const uid = uidKey(entry && entry.uid);
    if (uid) return uid;
    return "spawn:" + String(entry && entry.spawnIndex >= 0 ? entry.spawnIndex : "?");
}

const MUMMY_HP = 100;
const MUMMY_DAMAGE_PER_HIT = 34;
const MUMMY_DOWN_MS = 20000;       // how long a downed Human bleeds before they are out
const MUMMY_DOWN_SECONDS = 20;
const MUMMY_REVIVE_MS = 5000;      // held near a downed teammate to pull them back up
const MUMMY_REVIVE_SECONDS = 5;
const MUMMY_REVIVE_HEARTBEAT_MS = 600;
const MUMMY_WIN_POINTS = 5;
const MUMMY_TEAM_NAMES = ["TEAM A", "TEAM B"];
const MUMMY_BREAK_MS = 4000;       // breather between rounds, long enough to read the board
const RECONNECT_GRACE_MS = 12000;  // a dropped phone has this long to reclaim its seat

function resetMummyCombat(room) {
    const g = room.game;
    g.combat = {};
    for (const e of room.entries) {
        g.combat[mummyIdOf(e)] = {
            hp: MUMMY_HP,
            shield: 0,           // the blue over-HP bar the Shadow Ranger raises
            shieldUntil: 0,      // wall-clock time that bar dissolves on its own
            downed: false,
            eliminated: false,
            downedSince: 0,
            reviveMs: 0,
            reviveAt: 0,
            revivers: {}
        };
    }
}

function resetMummyAbilities(room) {
    const g = room.game;
    for (const e of room.entries) {
        const id = mummyIdOf(e);
        if (!g.abilities[id]) g.abilities[id] = { cooldownUntil: 0, healAt: 0, healUntil: 0 };
        g.abilities[id].healAt = 0;
        g.abilities[id].healUntil = 0;
    }
    g.nextCloneNum = 1;
    g.clones = {};
    g.shields = {};
}

function mummyAlive(room, id) {
    const c = room.game.combat[id];
    return !!c && !c.downed && !c.eliminated;
}

// A player the Mummy can meaningfully swing at: still on their feet and not a
// hologram (clones are hit through the clone_hit path, never this one).
function mummyTargetable(room, id) {
    return room.game.roles[id] === "human" && mummyAlive(room, id);
}

function downMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || c.downed || c.eliminated) return false;
    // A body that drops loses the armour it was wearing with it.
    c.shield = 0;
    c.shieldUntil = 0;
    c.hp = 0;
    c.downed = true;
    c.eliminated = false;
    c.downedSince = Date.now();
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    return true;
}

function reviveMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || !c.downed || c.eliminated) return false;
    c.hp = MUMMY_HP;
    c.downed = false;
    c.downedSince = 0;
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    return true;
}

function eliminateMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || c.eliminated) return false;
    c.shield = 0;
    c.shieldUntil = 0;
    c.hp = 0;
    c.downed = false;
    c.eliminated = true;
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    // The Human is out, so the point lands on the other side right here and the
    // board updates the same tick they fall - there is no separate "round won"
    // award, because a point is an elimination, counted once.
    const side = (room.entries.find(e => mummyIdOf(e) === id) || {}).side;
    if (side === 0 || side === 1) awardMummyPoint(room, 1 - side);
    return true;
}

function awardMummyPoint(room, winningSide) {
    const g = room.game;
    if (g.phase === "finished" || winningSide < 0 || winningSide > 1) return;
    g.sideScore[winningSide] = (g.sideScore[winningSide] || 0) + 1;
    // A side that has banked five has won the match. This is the only place the
    // match can end, so it does not matter whether the fifth came mid-round, on
    // the final bleed-out, or at the bell - it is always decided here.
    if (g.sideScore[winningSide] >= MUMMY_WIN_POINTS) {
        endMummyMatch(room, winningSide);
    }
}

// Flat ground distance: XZ only, because the catcher's reach is measured along
// the floor and a jump must not buy or lose a hit.
function flatDistance(a, b) {
    const dx = (Number(a && a.x) || 0) - (Number(b && b.x) || 0);
    const dz = (Number(a && a.z) || 0) - (Number(b && b.z) || 0);
    return Math.sqrt(dx * dx + dz * dz);
}

// A body is "inside" a dome only while it stands within the shell's ring on the
// ground; the Mummy can never be under a Human's dome, so the cover belongs to
// the caster's own side and to nobody else.
function shieldCovers(room, ownerId, targetId) {
    if (ownerId === targetId) return false;
    const g = room.game;
    if (!g.shields[ownerId]) return false;
    const owner = room.entries.find(e => mummyIdOf(e) === ownerId);
    const target = room.entries.find(e => mummyIdOf(e) === targetId);
    if (!owner || !target) return false;
    // Same side only - a catcher standing on the spot still hits the body.
    if (owner.side !== target.side) return false;
    const centre = shieldCenter(room, ownerId);
    return !!centre && flatDistance(target.pos, centre) <= SHIELD_RADIUS;
}

// The first living dome that is actually over this Human right now, or "" when
// no teammate is shielding them. One swing is one hit on one shell, so the
// server picks a single guard rather than letting a stack drink several blows.
function shieldCovering(room, targetId) {
    const g = room.game;
    if (!g.shields) return "";
    for (const ownerId of Object.keys(g.shields)) {
        if (shieldCovers(room, ownerId, targetId)) return ownerId;
    }
    return "";
}

function hpShieldActive(c) {
    return !!c && (c.shield || 0) > 0 && (c.shieldUntil || 0) > Date.now();
}

// A 20-second blue bar over the Human's own HP. It spends before the body does
// and falls off the moment the clock runs out, never carrying into the next round.
function activateHpShield(room, casterId, now) {
    const g = room.game;
    const c = g.combat[casterId];
    if (!c || c.downed || c.eliminated) return null;
    c.shield = HP_SHIELD_AMOUNT;
    c.shieldUntil = now + HP_SHIELD_LIFETIME_MS;
    g.abilities[casterId].cooldownUntil = now + ABILITY_COOLDOWN_MS;
    console.log(`[ABILITY] ${casterId} raised a ${HP_SHIELD_AMOUNT} HP shield in ${room.matchId}`);
    return casterId;
}

function tickMummyHpShields(room, now) {
    const g = room.game;
    let changed = false;
    for (const id of Object.keys(g.combat)) {
        const c = g.combat[id];
        if ((c.shield || 0) > 0 && c.shieldUntil > 0 && now >= c.shieldUntil) {
            c.shield = 0;
            c.shieldUntil = 0;
            console.log(`[ABILITY] ${id}'s shadow shield expired in ${room.matchId}`);
            changed = true;
        }
    }
    if (changed) broadcastMummyState(room, true);
}

// A clone that stood between the Mummy's swing and the Human it was aimed at,
// close enough to the line from the catcher to that body to count as "in the
// way". Ties go to the nearest decoy to the catcher, so a wall of two fakes
// still burns one at a time.
function cloneAbsorbing(room, attackerPos, targetPos) {
    const g = room.game;
    if (!g.clones || !targetPos) return "";
    const ax = Number(attackerPos && attackerPos.x) || 0;
    const az = Number(attackerPos && attackerPos.z) || 0;
    const tx = Number(targetPos.x) || 0;
    const tz = Number(targetPos.z) || 0;
    const vx = tx - ax;
    const vz = tz - az;
    const len2 = vx * vx + vz * vz;
    if (len2 < 0.0001) return "";

    let bestId = "";
    let bestDist = Infinity;
    for (const [id, clone] of Object.entries(g.clones)) {
        const cx = Number(clone.x) || 0;
        const cz = Number(clone.z) || 0;
        // Project the decoy onto the attacker->target line and keep only the
        // part that actually lies between them, not behind either body.
        let t = ((cx - ax) * vx + (cz - az) * vz) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const nx = ax + vx * t;
        const nz = az + vz * t;
        const off = Math.sqrt((cx - nx) * (cx - nx) + (cz - nz) * (cz - nz));
        if (off > 1.0) continue;
        const d = Math.sqrt((cx - ax) * (cx - ax) + (cz - az) * (cz - az));
        if (d < bestDist) {
            bestDist = d;
            bestId = id;
        }
    }
    return bestId;
}

function clonePayload(g, now) {
    const list = [];
    for (const [id, clone] of Object.entries(g.clones)) {
        const age = Math.max(0, (now - clone.spawnedAt) / 1000);
        const walked = Math.min(CLONE_WALK_CAP_METRES, age * CLONE_WALK_SPEED);
        const fx = Number(clone.fdx) || 0;
        const fz = Number(clone.fdz) || 0;
        list.push({
            id: id,
            caster_id: clone.casterId,
            // Born at (x, z) and still marching along (fdx, fdz), so every screen
            // and the hit test read the same body at the same distance.
            x: (Number(clone.x) || 0) + fx * walked,
            y: Number(clone.y) || 0,
            z: (Number(clone.z) || 0) + fz * walked,
            yaw: Number(clone.yaw) || 0,
            hits: clone.hits || 0,
            hits_left: Math.max(0, CLONE_MAX_HITS - (clone.hits || 0)),
            left_ms: Math.max(0, clone.expiresAt - now)
        });
    }
    return list;
}

function spawnClones(room, caster, now) {
    const g = room.game;
    // Drop any earlier set from this same caster so the table never carries stale
    // bodies a new press was meant to replace.
    for (const [id, clone] of Object.entries(g.clones)) {
        if (clone.casterId === mummyIdOf(caster)) delete g.clones[id];
    }
    const x = Number(caster.pos && caster.pos.x) || 0;
    const y = Number(caster.pos && caster.pos.y) || 0;
    const z = Number(caster.pos && caster.pos.z) || 0;
    const yaw = Number(caster.pos && caster.pos.yaw) || 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // The same direction every screen will walk them along.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    for (let i = 0; i < CLONE_COUNT; i++) {
        const side = i === 0 ? -1 : 1;
        const id = "clone-" + String(g.nextCloneNum++);
        g.clones[id] = {
            casterId: mummyIdOf(caster),
            x: x + fx * CLONE_FRONT_METRES + rx * CLONE_SPREAD_METRES * side,
            y: y,
            z: z + fz * CLONE_FRONT_METRES + rz * CLONE_SPREAD_METRES * side,
            yaw: yaw,
            // The line the server and every client both advance this body along.
            fdx: fx,
            fdz: fz,
            hits: 0,
            spawnedAt: now,
            expiresAt: now + CLONE_LIFETIME_MS
        };
    }
    console.log(`[ABILITY] ${mummyIdOf(caster)} spawned ${CLONE_COUNT} clones in ${room.matchId}`);
}

function activateMummyAbility(room, caster, now) {
    const kind = abilityFor(caster);
    if (kind === "") return null;
    const id = mummyIdOf(caster);
    if (!room.game.abilities[id]) room.game.abilities[id] = { cooldownUntil: 0, healAt: 0, healUntil: 0 };
    const ability = room.game.abilities[id];
    if (ability.cooldownUntil > now) return "cooldown";

    if (kind === "clone") {
        spawnClones(room, caster, now);
        ability.cooldownUntil = now + ABILITY_COOLDOWN_MS;
    } else if (kind === "shield") {
        // A dome belongs to one caster at a time, so recasting replaces the old
        // shell instead of stacking a second one on the same body.
        room.game.shields[id] = { hits: 0, expiresAt: now + SHIELD_LIFETIME_MS };
        ability.cooldownUntil = now + ABILITY_COOLDOWN_MS;
        console.log(`[ABILITY] ${id} raised a shield in ${room.matchId}`);
    } else if (kind === "aura") {
        // Mark the window the heal runs over; the tick itself drains it second by
        // second so nobody gets the whole bar in a single frame.
        ability.healAt = now;
        ability.healUntil = now + AURA_LIFETIME_MS;
        ability.cooldownUntil = now + AURA_COOLDOWN_MS;
        console.log(`[ABILITY] ${id} cast a healing aura in ${room.matchId}`);
    } else if (kind === "hp_shield") {
        activateHpShield(room, id, now);
    } else {
        // A character that owns an ability the server does not yet implement still
        // gets a clean cooldown, so the button is never a free infinite press.
        ability.cooldownUntil = now + ABILITY_COOLDOWN_MS;
    }

    broadcastMummyState(room, true);
    return kind;
}

function destroyClone(room, cloneId, reason) {
    const g = room.game;
    if (!g.clones[cloneId]) return false;
    delete g.clones[cloneId];
    console.log(`[ABILITY] clone ${cloneId} removed (${reason}) in ${room.matchId}`);
    broadcastMummyState(room, true);
    return true;
}

function landCloneHit(room, cloneId, now) {
    const g = room.game;
    const clone = g.clones[cloneId];
    if (!clone) return false;
    // A decoy can be felled by the clock and by a swing on the very same tick; the
    // one that lands first wins and the second call becomes a harmless no-op.
    if (now >= clone.expiresAt) {
        destroyClone(room, cloneId, "expired");
        return false;
    }
    clone.hits = (clone.hits || 0) + 1;
    if (clone.hits >= CLONE_MAX_HITS) {
        destroyClone(room, cloneId, "hits");
    } else {
        broadcastMummyState(room, true);
    }
    return true;
}

function tickMummyClones(room, now) {
    const g = room.game;
    let changed = false;
    for (const [id, clone] of Object.entries(g.clones)) {
        if (now >= clone.expiresAt) {
            delete g.clones[id];
            console.log(`[ABILITY] clone ${id} expired in ${room.matchId}`);
            changed = true;
        }
    }
    if (changed) broadcastMummyState(room, true);
}

// The centre of the dome is the caster's current body, so the shell follows them
// for its whole life instead of staying nailed to the spot they raised it on.
function shieldCenter(room, ownerId) {
    const owner = room.entries.find(e => mummyIdOf(e) === ownerId);
    if (!owner || !owner.pos) return null;
    return {
        x: Number(owner.pos.x) || 0,
        y: (Number(owner.pos.y) || 0) + SHIELD_HEIGHT * 0.5,
        z: Number(owner.pos.z) || 0
    };
}

function shieldPayload(room, now) {
    const g = room.game;
    const list = [];
    for (const [id, shield] of Object.entries(g.shields)) {
        const centre = shieldCenter(room, id);
        if (!centre) continue;
        const hits = shield.hits || 0;
        list.push({
            id: id,
            caster_id: id,
            x: centre.x,
            y: centre.y,
            z: centre.z,
            radius: SHIELD_RADIUS,
            height: SHIELD_HEIGHT,
            hits: hits,
            hits_left: Math.max(0, SHIELD_DESTROY_AT - hits),
            left_ms: Math.max(0, shield.expiresAt - now)
        });
    }
    return list;
}

function destroyShield(room, ownerId, reason) {
    const g = room.game;
    if (!g.shields[ownerId]) return false;
    delete g.shields[ownerId];
    console.log(`[ABILITY] shield ${ownerId} removed (${reason}) in ${room.matchId}`);
    broadcastMummyState(room, true);
    return true;
}

function landShieldHit(room, ownerId, now) {
    const g = room.game;
    const shield = g.shields[ownerId];
    if (!shield) return false;
    // A swing that lands on the very tick the shell times out is thrown away,
    // exactly the way a late hit on a faded clone is.
    if (now >= shield.expiresAt) {
        destroyShield(room, ownerId, "expired");
        return false;
    }
    shield.hits = (shield.hits || 0) + 1;
    if (shield.hits >= SHIELD_DESTROY_AT) {
        destroyShield(room, ownerId, "hits");
    } else {
        broadcastMummyState(room, true);
    }
    return true;
}

function tickMummyShields(room, now) {
    const g = room.game;
    let changed = false;
    for (const [id, shield] of Object.entries(g.shields)) {
        if (now >= shield.expiresAt) {
            delete g.shields[id];
            console.log(`[ABILITY] shield ${id} expired in ${room.matchId}`);
            changed = true;
        }
    }
    if (changed) broadcastMummyState(room, true);
}

// ---- collision / separation ----
// The bodies in the arena cannot occupy the same patch of floor. The server
// is the only place that knows every position, so it enforces a minimum
// horizontal distance between any two standing players and rejects a move that
// would push one body through another. A clone or a shield is a prop, not a
// body, so it never blocks.
const PLAYER_RADIUS = 0.55;

function collidesInRoom(room, mover) {
    if (!room || !room.entries) return false;
    const id = mummyIdOf(mover);
    for (const other of room.entries) {
        if (other === mover) continue;
        const oid = mummyIdOf(other);
        // Eliminated bodies are gone from the floor; downed ones still occupy
        // space, but a downed player cannot be the mover (input is gated).
        if (room.game && room.game.combat && room.game.combat[oid] && room.game.combat[oid].eliminated) continue;
        if (room.game && room.game.combat && room.game.combat[id] && room.game.combat[id].eliminated) continue;
        // A solid ability shell blocks passage the way another body does.
        if (room.game && shieldBlocksPassage(room.game, oid)) {
            // the dome sits on the floor at the owner's position
        }
        const d = flatDistance(mover.pos, other.pos);
        if (d < PLAYER_RADIUS * 2) return true;
    }
    return false;
}

function separateFromRoom(room, mover, x, z) {
    // Resolve overlaps by pushing the mover out along the shortest axis of each
    // collision, iterated a few times so a squeeze between two bodies settles.
    let nx = x, nz = z;
    for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (const other of room.entries) {
            if (other === mover) continue;
            const oid = mummyIdOf(other);
            if (room.game && room.game.combat && room.game.combat[oid] && room.game.combat[oid].eliminated) continue;
            const dx = nx - (Number(other.pos && other.pos.x) || 0);
            const dz = nz - (Number(other.pos && other.pos.z) || 0);
            const d = Math.sqrt(dx * dx + dz * dz);
            const minD = PLAYER_RADIUS * 2;
            if (d < minD) {
                moved = true;
                if (d < 0.0001) { nx += minD; }
                else {
                    const push = (minD - d);
                    nx += (dx / d) * push;
                    nz += (dz / d) * push;
                }
            }
        }
        if (!moved) break;
    }
    return { x: nx, z: nz };
}

const matches = new Map();         // matchId -> room

// Voice rooms are a relay-local concern: which sockets sit in which group, so
// a player list can be fanned out without the hub needing to know.
const voiceGroups = new Map();     // voiceKey -> Set<ws>
const clientsByUid = new Map();    // uid -> ws (latest socket for that player)

function sanitizeVoiceKey(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    return s.slice(0, 80);
}

function leaveVoice(ws) {
    const key = ws && ws.voiceKey;
    if (!key) return;
    const group = voiceGroups.get(key);
    if (group) {
        group.delete(ws);
        if (group.size === 0) voiceGroups.delete(key);
        else sendVoiceList(key);
    }
    ws.voiceKey = "";
}

function sendVoiceList(key) {
    const group = voiceGroups.get(key);
    if (!group) return;
    const members = [];
    for (const peer of group) {
        const uid = uidKey(peer.uid);
        if (uid) members.push(uid);
    }
    const txt = JSON.stringify({ type: "voice_members", voice_key: key, members: members });
    for (const peer of group) {
        if (peer.readyState === WebSocket.OPEN) {
            try { peer.send(txt); } catch (_e) {}
        }
    }
}

function endMummyMatch(room, winningSide) {
    if (!room || !room.game) return;
    const g = room.game;
    g.phase = "finished";
    g.settled = true;
    g.endsAt = 0;
    g.winnerSide = winningSide;
    g.roundOutcome = "match";
    console.log(`[MUMMY] match over in ${room.matchId}: ${MUMMY_TEAM_NAMES[winningSide]} wins ${g.sideScore[0]}-${g.sideScore[1]}`);
    broadcastMummyState(room, true);
    // The result has been delivered, so nobody stays parked in a dead room:
    // these sockets are free to queue again.
    for (const e of room.entries) e.ws.matchId = null;
    matches.delete(room.matchId);
}

// The Mummy side only wins once every Human is out. Downed-but-still-bleeding
// Humans count as alive, so the round never advances while one of them remains.
function mummyHumansWiped(room) {
    const humans = mummyHumanIds(room);
    return humans.length > 0 && humans.every(id => room.game.combat[id].eliminated);
}

// The aura's heal runs on wall-clock deltas rather than a fixed step, so a slow
// tick does not quietly hand out less HP than the aura promised. A downed, out or
// full-HP caster just burns its window without gaining anything.
function tickMummyAuraHeal(room, now) {
    const g = room.game;
    for (const id of Object.keys(g.abilities)) {
        const a = g.abilities[id];
        if (!a || !(a.healUntil > 0)) continue;

        const until = Math.min(a.healUntil, now);
        const dt = (until - a.healAt) / 1000;
        a.healAt = until;
        if (now >= a.healUntil) a.healUntil = 0;
        if (dt <= 0) continue;

        const caster = room.entries.find(e => mummyIdOf(e) === id);
        if (!caster) continue;

        const heal = Math.max(1, Math.round((AURA_HEAL_TOTAL / (AURA_HEAL_MS / 1000)) * dt));
        for (const e of room.entries) {
            const target = mummyIdOf(e);
            if (g.roles[target] !== "human") continue;

            const c = g.combat[target];
            if (!c || c.downed || c.eliminated) continue;
            if (c.hp >= MUMMY_HP) continue;

            // The caster always heals; a teammate only while standing in the cloud
            // the others are drawing, which is why this uses the same radius.
            const inCloud = target === id
                || (e.side === caster.side && flatDistance(e.pos, caster.pos) <= AURA_RADIUS);
            if (!inCloud) continue;

            c.hp = Math.min(MUMMY_HP, c.hp + heal);
        }
    }
}

function tickMummyCombat(room, now) {
    const g = room.game;
    tickMummyAuraHeal(room, now);
    for (const id of Object.keys(g.combat)) {
        const c = g.combat[id];
        if (!c.downed) continue;

        const holding = Object.keys(c.revivers).filter(r => now - c.revivers[r] <= MUMMY_REVIVE_HEARTBEAT_MS);
        for (const r of Object.keys(c.revivers)) {
            if (!holding.includes(r)) delete c.revivers[r];
        }
        if (holding.length > 0) {
            if (c.reviveAt > 0) {
                const held = now - c.reviveAt;
                c.reviveMs += held;
                // A teammate holding + pauses the bleed: skip this gap in the
                // knockdown clock so the HP does not drain mid-revive.
                c.downedSince += held;
            }
            c.reviveAt = now;
        } else {
            c.reviveAt = 0;
        }

        if (c.reviveMs >= MUMMY_REVIVE_MS) {
            reviveMummyPlayer(room, id);
            console.log(`[MUMMY] ${id} revived in ${room.matchId}`);
            continue;
        }

        const bled = now - c.downedSince;
        c.hp = Math.max(0, Math.ceil(MUMMY_HP * (1 - bled / MUMMY_DOWN_MS)));
        if (bled >= MUMMY_DOWN_MS) {
            eliminateMummyPlayer(room, id);
            console.log(`[MUMMY] ${id} bled out in ${room.matchId}`);
        }
    }
}

function beginMummyRound(room, roundNumber) {
    const g = room.game;

    g.round = roundNumber;
    g.settled = false;
    g.roundOutcome = "";
    g.phase = "playing";
    g.endsAt = Date.now() + g.roundMs;
    resetMummyCombat(room);
    resetMummyAbilities(room);

    // One team hunts per round, and the teams are the arena sides, so a Mummy can
    // only ever knock out a player from the other team - which is what makes
    // "elimination = +1 for the other side" true every time. Round 1's hunters are
    // a coin flip; every following round hands the hunt to the other team, so both
    // sides get the same number of turns at scoring.
    g.hunterSide = roundNumber === 1 ? (Math.random() < 0.5 ? 0 : 1) : 1 - g.hunterSide;
    g.roles = {};
    for (const e of room.entries) {
        g.roles[mummyIdOf(e)] = e.side === g.hunterSide ? "mummy" : "human";
    }

    console.log(`[MUMMY] ${room.mode} round ${roundNumber}: ${Object.entries(g.roles).map(([id, r]) => `${id}=${r}`).join(" ")}`);
    broadcastMummyState(room, true);
}

// A round only ever *stops*: the points were already paid by the eliminations
// that ended it, and the match itself ends in awardMummyPoint the moment a team
// reaches the win line. Nothing is awarded here, so a wipe can never be counted
// once per body and then once again as a round point.
function settleMummyRound(room, winner) {
    const g = room.game;
    if (g.settled || g.phase === "finished") return;
    g.settled = true;
    g.roundOutcome = winner;

    g.phase = "round_break";
    g.endsAt = Date.now() + MUMMY_BREAK_MS;
    broadcastMummyState(room, true);
}

function mummyStatePayload(room, self) {
    const g = room.game;
    const now = Date.now();
    const myId = mummyIdOf(self);
    const mine = g.abilities[myId] || { cooldownUntil: 0 };
    const cooldownLeft = Math.max(0, mine.cooldownUntil - now);
    return {
        type: "match_state",
        match_id: room.matchId,
        mode: room.mode,
        phase: g.phase,
        round: g.round,
        side_size: g.sideSize,
        round_seconds: Math.round(g.roundMs / 1000),
        remaining_seconds: g.endsAt > 0 ? Math.max(0, Math.ceil((g.endsAt - now) / 1000)) : 0,
        // The scoreboard is a team board, not a role board: names, one score per
        // team, the line to win on and which team is hunting right now.
        team_names: MUMMY_TEAM_NAMES,
        side_score: g.sideScore.slice(),
        win_points: MUMMY_WIN_POINTS,
        hunter_side: g.hunterSide,
        winner_side: g.winnerSide,
        roles: g.roles,
        hp_max: MUMMY_HP,
        down_seconds: MUMMY_DOWN_SECONDS,
        revive_seconds: MUMMY_REVIVE_SECONDS,
        round_outcome: g.roundOutcome,
        ready_count: g.ready.size,
        required_players: room.entries.length,
        self_id: myId,
        // The button on the Human's screen counts down from the server's clock, so
        // a reconnect or a laggy phone cannot invent a shorter cooldown.
        ability: {
            type: abilityFor(self),
            left_ms: cooldownLeft,
            ready: g.phase === "playing" && cooldownLeft === 0,
            cooldown_ms: abilityCooldownMs(abilityFor(self)),
            // How long this character's cast stands for, and what it takes to end it.
            duration_ms: abilityFor(self) === "hp_shield" ? HP_SHIELD_LIFETIME_MS
                : abilityFor(self) === "shield" ? SHIELD_LIFETIME_MS : CLONE_LIFETIME_MS,
            hits_to_destroy: abilityFor(self) === "shield" ? SHIELD_DESTROY_AT : CLONE_MAX_HITS,
            shield_hp: abilityFor(self) === "hp_shield" ? HP_SHIELD_AMOUNT : 0
        },
        // Every client rebuilds the holograms from this list, so a spawn or a
        // destroy that lands on one phone and not another self-corrects.
        clones: clonePayload(g, now),
        // Same idea for the green domes, one per caster, with the swing count that
        // draws their cracks.
        shields: shieldPayload(room, now),
        players: room.entries.map(e => {
            const id = mummyIdOf(e);
            const c = g.combat[id] || { hp: MUMMY_HP, shield: 0, shieldUntil: 0, downed: false, eliminated: false, reviveMs: 0, revivers: {} };
            const downLeft = c.downed ? Math.max(0, Math.ceil((c.downedSince + MUMMY_DOWN_MS - now) / 1000)) : 0;
            const shieldLeft = (c.shield || 0) > 0 && c.shieldUntil > 0
                ? Math.max(0, Math.ceil((c.shieldUntil - now) / 1000)) : 0;
            return {
                id: id,
                player_uid: e.uid,
                username: e.username,
                character_id: e.characterId,
                bundle_id: bundleOf(e),
                spawn_index: e.spawnIndex,
                side: e.side,
                role: g.roles[id] || "",
                hp: c.hp,
                shield: c.shield || 0,
                shield_max: HP_SHIELD_AMOUNT,
                shield_seconds_left: shieldLeft,
                downed: c.downed,
                eliminated: c.eliminated,
                down_seconds_left: downLeft,
                revive_seconds_left: c.downed ? Math.max(0, Math.ceil((MUMMY_REVIVE_MS - c.reviveMs) / 1000)) : 0,
                reviving: c.downed && Object.keys(c.revivers).length > 0
            };
        })
    };
}

function broadcastMummyState(room, force) {
    for (const e of room.entries) {
        const payload = JSON.stringify(mummyStatePayload(room, e));
        // Deduplicated per player, because every payload carries that player's own
        // role. The countdown only changes once a second, so every phone is not
        // sent the same bytes four times a second.
        if (!force && payload === e.lastStateSent) continue;
        e.lastStateSent = payload;
        if (e.ws.readyState === WebSocket.OPEN) e.ws.send(payload);
    }
}

function tickMummyMatches() {
    const now = Date.now();
    for (const room of matches.values()) {
        const g = room.game;
        if (!g || g.kind === "zombie") continue;

        // Holograms are on the server's clock, so their 10 seconds end on every
        // phone at the same tick even if a hit report went astray.
        if (g.phase !== "finished") tickMummyClones(room, now);
        // A dome's 15 seconds run on this clock too, so it closes on every phone at
        // the same tick whether or not the caster's own screen is still there.
        if (g.phase !== "finished") tickMummyShields(room, now);
        // The Shadow Ranger shield's 20 seconds run on the same clock.
        if (g.phase !== "finished") tickMummyHpShields(room, now);

        if (g.phase === "playing" && !g.settled) {
            tickMummyCombat(room, now);
            // The round only confirms once the whole Human side is actually out -
            // a downed Human still bleeding, or still being revived, holds it open.
            if (mummyHumansWiped(room)) {
                settleMummyRound(room, "mummy");
                continue;
            }
            if (now >= g.endsAt) {
                // The clock ran out with at least one Human still in the round.
                settleMummyRound(room, "human");
                continue;
            }
        }
        if (g.phase === "round_break" && now >= g.endsAt) {
            beginMummyRound(room, g.round + 1);
            continue;
        }
        if (g.phase !== "finished") broadcastMummyState(room, false);
    }
}

// A match that never got everyone into the arena must not sit in the lobby
// forever with the rest of the party staring at a countdown.
function cancelMummyWaiting(room) {
    for (const e of room.entries) sendJson(e.ws, { type: "match_cancelled" });
    for (const e of room.entries) e.ws.matchId = null;
    matches.delete(room.matchId);
}

function forfeitGone(room) {
    if (!matches.has(room.matchId)) return;
    clearTimeout(room.graceTimer);
    for (const e of room.entries) {
        if (!e.gone) continue;
        if (room.game.kind === "zombie") endZombieMatch(room, 1 - e.side);
        else endMummyMatch(room, 1 - e.side);
        return;
    }
}

// One timer per room, not per dropper: it re-arms whenever a socket closes so
// every still-gone entry is covered, and a rejoin only cancels it once no entry
// is gone any more (a returning player must not wipe a teammate's window).
function armGraceTimer(room) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    if (room.entries.some(e => e.gone)) {
        room.graceTimer = setTimeout(() => forfeitGone(room), RECONNECT_GRACE_MS);
    }
}

// --------------------------------------------------------------------- zombie --
// The infection mode's room: two four-player teams, one freshly woken zombie on
// each side, and every caught human joining the catcher's count the same tick.
// The room object keeps its own shape and its own ticker so the mummy rules and
// the zombie rules can never walk over each other's tables.
function initZombieMatch(room) {
    room.game = {
        kind: "zombie",            // keeps the mummy ticker off this room and vice versa
        phase: "waiting",          // waiting -> playing -> round_break -> ... -> finished
        ready: new Set(),
        round: 0,
        sideSize: room.entries.filter(e => e.side === 0).length,
        totalRounds: ZOMBIE_ROUNDS,
        roundMs: ZOMBIE_ROUND_MS,
        sideScore: [0, 0],         // infections landed this round, live on the board
        sideWins: [0, 0],          // rounds taken so far
        roles: {},                 // id -> "zombie" | "human"
        infected: {},              // id -> true once turned this round (duplicate guard)
        swingSeq: {},              // zombie id -> swings so far, so the punch clips alternate
        settled: false,
        roundOutcome: "",
        winnerSide: -1,
        endsAt: 0
    };
    broadcastZombieState(room, true);
}

const ZOMBIE_ROUNDS = parseInt(process.env.ZOMBIE_ROUNDS, 10) || 8;
const ZOMBIE_ROUND_MS = (parseInt(process.env.ZOMBIE_ROUND_SECONDS, 10) || 120) * 1000;
const ZOMBIE_BREAK_MS = (parseInt(process.env.ZOMBIE_BREAK_SECONDS, 10) || 5) * 1000;
// Mirrors ATTACK_RANGE in zombie_match.gd: the reach a zombie actually swings.
const ZOMBIE_ATTACK_RANGE = parseFloat(process.env.ZOMBIE_ATTACK_RANGE) || 2.6;
const ZOMBIE_TEAM_NAMES = ["TEAM TIGER", "TEAM LION"];

function beginZombieRound(room, roundNumber) {
    const g = room.game;
    g.round = roundNumber;
    g.settled = false;
    g.roundOutcome = "";
    g.phase = "playing";
    g.endsAt = Date.now() + ZOMBIE_ROUND_MS;
    g.sideScore = [0, 0];
    g.roles = {};
    g.infected = {};
    // One zombie per team, rolled fresh every round: nobody carries the curse
    // across a round boundary and the two starting hunters are new dice each time.
    for (let side = 0; side < 2; side++) {
        const sidePlayers = room.entries.filter(e => e.side === side);
        for (const e of sidePlayers) g.roles[mummyIdOf(e)] = "human";
        if (sidePlayers.length === 0) continue;
        const first = sidePlayers[Math.floor(Math.random() * sidePlayers.length)];
        g.roles[mummyIdOf(first)] = "zombie";
        g.infected[mummyIdOf(first)] = true;
    }
    console.log(`[ZOMBIE] ${room.matchId} round ${roundNumber}: ` +
        Object.entries(g.roles).map(([id, r]) => `${id}=${r}`).join(" "));
    broadcastZombieState(room, true);
}

// One touch turns a human, immediately and for the rest of the round. The score
// belongs to the catcher's side, and a zombie can only ever catch the enemy
// team, so "infection = +1 for that side" holds on every single turn.
function infectZombie(room, attackerId, targetId) {
    const g = room.game;
    if (g.phase !== "playing" || g.settled) return false;
    const attacker = room.entries.find(e => mummyIdOf(e) === attackerId);
    const target = room.entries.find(e => mummyIdOf(e) === targetId);
    if (!attacker || !target) return false;
    if (g.roles[attackerId] !== "zombie" || g.roles[targetId] !== "human") return false;
    if (target.side === attacker.side) return false;
    if (g.infected[targetId]) return false;
    g.roles[targetId] = "zombie";
    g.infected[targetId] = true;
    g.sideScore[attacker.side] = (g.sideScore[attacker.side] || 0) + 1;
    console.log(`[ZOMBIE] ${attackerId} infected ${targetId} in ${room.matchId} (${g.sideScore.join("-")})`);
    return true;
}

// The two minutes are up: the higher counter takes the round, a draw is a draw,
// and the tally of rounds taken decides the match after round eight.
function settleZombieRound(room) {
    const g = room.game;
    if (g.settled || g.phase === "finished") return;
    g.settled = true;
    const s0 = g.sideScore[0] || 0;
    const s1 = g.sideScore[1] || 0;
    if (s0 !== s1) {
        const winner = s0 > s1 ? 0 : 1;
        g.sideWins[winner] = (g.sideWins[winner] || 0) + 1;
        g.roundOutcome = winner === 0 ? "tiger" : "lion";
    } else {
        g.roundOutcome = "draw";
    }
    g.phase = "round_break";
    g.endsAt = Date.now() + ZOMBIE_BREAK_MS;
    broadcastZombieState(room, true);
}

function finishZombieMatch(room) {
    const g = room.game;
    g.phase = "finished";
    const w0 = g.sideWins[0] || 0;
    const w1 = g.sideWins[1] || 0;
    g.winnerSide = w0 === w1 ? -1 : (w0 > w1 ? 0 : 1);
    g.roundOutcome = "match";
    console.log(`[ZOMBIE] match over in ${room.matchId}: round wins ${w0}-${w1}`);
    broadcastZombieState(room, true);
    // The result has been delivered, so nobody stays parked in a dead room:
    // these sockets are free to queue again.
    for (const e of room.entries) e.ws.matchId = null;
    matches.delete(room.matchId);
}

// A walk-out is a forfeit: the side still standing takes the match, however many
// rounds were left. Same cleanup as a natural finish, different verdict.
function endZombieMatch(room, winnerSide) {
    const g = room.game;
    g.phase = "finished";
    g.settled = true;
    g.winnerSide = winnerSide;
    g.roundOutcome = "forfeit";
    console.log(`[ZOMBIE] match over in ${room.matchId}: forfeit to side ${winnerSide}`);
    broadcastZombieState(room, true);
    for (const e of room.entries) e.ws.matchId = null;
    matches.delete(room.matchId);
}

function zombieStatePayload(room, self) {
    const g = room.game;
    const now = Date.now();
    return {
        type: "match_state",
        match_id: room.matchId,
        mode: room.mode,
        phase: g.phase,
        round: g.round,
        total_rounds: g.totalRounds,
        side_size: g.sideSize,
        round_seconds: Math.round(g.roundMs / 1000),
        remaining_seconds: g.endsAt > 0 ? Math.max(0, Math.ceil((g.endsAt - now) / 1000)) : 0,
        team_names: ZOMBIE_TEAM_NAMES,
        side_score: g.sideScore.slice(),
        side_wins: g.sideWins.slice(),
        winner_side: g.winnerSide,
        roles: g.roles,
        round_outcome: g.roundOutcome,
        ready_count: g.ready.size,
        required_players: room.entries.length,
        self_id: mummyIdOf(self),
        players: room.entries.map(e => {
            const id = mummyIdOf(e);
            return {
                id: id,
                player_uid: e.uid,
                username: e.username,
                character_id: e.characterId,
                bundle_id: bundleOf(e),
                spawn_index: e.spawnIndex,
                side: e.side,
                role: g.roles[id] || ""
            };
        })
    };
}

function broadcastZombieState(room, force) {
    for (const e of room.entries) {
        const payload = JSON.stringify(zombieStatePayload(room, e));
        // Deduplicated per player, because every payload carries that player's own
        // role. The countdown only changes once a second, so every phone is not
        // sent the same bytes four times a second.
        if (!force && payload === e.lastStateSent) continue;
        e.lastStateSent = payload;
        if (e.ws.readyState === WebSocket.OPEN) e.ws.send(payload);
    }
}

function tickZombieMatches() {
    const now = Date.now();
    for (const room of matches.values()) {
        const g = room.game;
        if (!g || g.kind !== "zombie") continue;
        if (g.phase === "playing" && !g.settled && now >= g.endsAt) {
            settleZombieRound(room);
            continue;
        }
        if (g.phase === "round_break" && now >= g.endsAt) {
            if (g.round >= g.totalRounds) finishZombieMatch(room);
            else beginZombieRound(room, g.round + 1);
            continue;
        }
        if (g.phase !== "finished") broadcastZombieState(room, false);
    }
}

// ---- shared swing / hit authority ----
// Every `swing_start` a phone sends calls exactly these four
// functions, so one set of rules - role, alive check, shield, clone, range,
// damage - decides every hit in the game no matter who proposed it.
function performMummySwing(room, attacker) {
    const g = room.game;
    if (g.phase !== "playing" || g.settled) return false;
    const attackerId = mummyIdOf(attacker);
    if (g.roles[attackerId] !== "mummy") return false;
    if (!mummyAlive(room, attackerId)) return false;

    const swing = (g.swingSeq[attackerId] = (g.swingSeq[attackerId] || 0) + 1);
    const clip = swing % 2 === 1 ? "Sword_Attack" : "Fighting_Left_Jab";
    for (const e of room.entries) {
        sendJson(e.ws, {
            type: "attack_anim",
            match_id: room.matchId,
            player_id: attackerId,
            clip: clip
        });
    }
    return true;
}

function performMummyAttack(room, attacker, targetId) {
    const g = room.game;
    if (g.phase !== "playing" || g.settled) return false;

    const attackerId = mummyIdOf(attacker);
    if (g.roles[attackerId] !== "mummy") return false;
    if (!mummyAlive(room, attackerId)) return false;

    if (!room.entries.some(e => mummyIdOf(e) === targetId)) return false;
    if (targetId === attackerId || g.roles[targetId] !== "human") return false;

    const target = g.combat[targetId];
    if (!target || target.downed || target.eliminated) return false;

    // A dome standing over the body takes the swing first. However many
    // teammates are inside it, one press is one hit on the shell.
    const guardId = shieldCovering(room, targetId);
    if (guardId !== "") {
        landShieldHit(room, guardId, Date.now());
        console.log(`[MUMMY] ${attackerId} hit ${guardId}'s shield instead of ${targetId} in ${room.matchId}`);
        return true;
    }

    // A hologram standing between the catcher and the body it swung at
    // takes the blow. Deciding it here rather than on the catcher's phone
    // is what makes all eight screens agree on who was actually hit.
    const targetEntry = room.entries.find(e => mummyIdOf(e) === targetId);
    const baitId = cloneAbsorbing(room, attacker.pos, targetEntry ? targetEntry.pos : null);
    if (baitId !== "") {
        landCloneHit(room, baitId, Date.now());
        console.log(`[MUMMY] ${attackerId} hit clone ${baitId} instead of ${targetId} in ${room.matchId}`);
        return true;
    }

    // Apply damage: the blue shield is extra HP laid over the normal bar, so it
    // spends first and the body only starts losing HP once it is gone.
    let incoming = MUMMY_DAMAGE_PER_HIT;
    if ((target.shield || 0) > 0) {
        const absorbed = Math.min(target.shield, incoming);
        target.shield -= absorbed;
        incoming -= absorbed;
        if (target.shield <= 0) {
            target.shield = 0;
            target.shieldUntil = 0;
        }
        console.log(`[MUMMY] ${targetId}'s shadow shield absorbed ${absorbed}, ${target.shield} left`);
    }
    target.hp = Math.max(0, target.hp - incoming);
    console.log(`[MUMMY] ${attackerId} hit ${targetId} for ${incoming} damage, HP now ${target.hp}`);

    // Check if HP reached zero
    if (target.hp <= 0) {
        if (g.sideSize <= 1) {
            // 1v1: HP=0 ends the round immediately
            if (!eliminateMummyPlayer(room, targetId)) return true;
            console.log(`[MUMMY] ${attackerId} caught ${targetId} out in ${room.matchId}`);
            if (g.phase !== "finished") settleMummyRound(room, "mummy");
        } else {
            // 2v2+: HP=0 knocks down instead of eliminating
            if (!downMummyPlayer(room, targetId)) return true;
            console.log(`[MUMMY] ${attackerId} knocked ${targetId} down in ${room.matchId}`);
            broadcastMummyState(room, true);
        }
    } else {
        // Just damage, HP still > 0
        broadcastMummyState(room, true);
    }
    return true;
}

function performZombieSwing(room, attacker) {
    const g = room.game;
    if (g.kind !== "zombie" || g.phase !== "playing" || g.settled) return false;
    const attackerId = mummyIdOf(attacker);
    if (g.roles[attackerId] !== "zombie") return false;

    const swing = (g.swingSeq[attackerId] = (g.swingSeq[attackerId] || 0) + 1);
    const clip = swing % 2 === 1 ? "Sword_Attack" : "Fighting_Left_Jab";
    for (const e of room.entries) {
        sendJson(e.ws, {
            type: "attack_anim",
            match_id: room.matchId,
            player_id: attackerId,
            clip: clip
        });
    }
    return true;
}

function performZombieAttack(room, attacker, targetId) {
    const g = room.game;
    if (g.kind !== "zombie" || g.phase !== "playing" || g.settled) return false;

    const attackerId = mummyIdOf(attacker);
    if (g.roles[attackerId] !== "zombie") return false;

    const target = room.entries.find(e => mummyIdOf(e) === targetId);
    if (!target || targetId === attackerId || g.roles[targetId] !== "human") return false;

    // The server owns the metre-stick as well as the infection: a swing at
    // a body beyond arm plus a step of lag simply misses, on every screen.
    if (flatDistance(attacker.pos, target.pos) > ZOMBIE_ATTACK_RANGE + 0.5) {
        console.log(`[ZOMBIE] ${attackerId} swung at ${targetId} out of range in ${room.matchId}`);
        return true;
    }

    if (infectZombie(room, attackerId, targetId)) {
        broadcastZombieState(room, true);
    }
    return true;
}

function handleClientMessage(ws, data) {
    const type = data.type;

    switch (type) {
        case 'team_get': {
            const uid = bindUid(ws, data);
            refreshIdentity(uid, data);
            const team = teamOf(ws);
            if (team && uid) broadcastTeam(team);
            else sendJson(ws, NO_TEAM);
            break;
        }

        // Presence is "connected to this game server", which is what the lobby
        // client list actually needs: the friend list can only invite players
        // the team server can reach.
        case 'friends_presence': {
            const uid = bindUid(ws, data);
            const requested = (Array.isArray(data.uids) ? data.uids : []).slice(0, 100);
            const online = [];
            for (const raw of requested) {
                const key = uidKey(raw);
                if (key === "" || key === uid || online.includes(key)) continue;
                const peer = clientsByUid.get(key);
                if (peer && peer.readyState === WebSocket.OPEN) online.push(key);
            }
            const cleaned = [];
            for (const raw of requested) {
                const key = uidKey(raw);
                if (key === "" || cleaned.includes(key)) continue;
                cleaned.push(key);
            }
            sendJson(ws, {
                type: "friends_presence",
                requested: cleaned,
                online: online
            });
            break;
        }

        case 'team_invite': {
            const uid = bindUid(ws, data);
            const targetUid = uidKey(data.to_uid);
            let team = teamOf(ws);

            if (!uid) { teamError(ws, "Profile is still syncing"); break; }
            if (!targetUid) { teamError(ws, "That player UID is not valid"); break; }
            if (targetUid === uid) { teamError(ws, "You cannot invite yourself"); break; }

            if (!team) {
                const maxSize = Math.min(4, Math.max(1, parseInt(data.max_size, 10) || 1));
                if (maxSize < 2) { teamError(ws, "Pick team size 2, 3 or 4 before inviting"); break; }
                team = createTeam(ws, uid, data.username || "Player", data.character_id || 1, bundleIdOf(data), maxSize);
            }
            // Inviting is not a leader power: every member may bring their own
            // friends into the same group. Only the kick and the search stay the
            // leader's, and the shared seat ceiling below is what caps the party.

            if (team.members.some(m => m.uid === targetUid)) {
                broadcastTeam(team);
                teamError(ws, "That player is already in your team"); break;
            }
            if (team.members.length >= team.maxSize) { teamError(ws, "Your team is full"); break; }

            const targetWs = clientsByUid.get(targetUid);
            if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
                sendJson(ws, { type: "team_invite_failed", to_uid: targetUid, reason: "is not online" });
                break;
            }

            const targetTeam = teamOf(targetWs);
            if (targetTeam) {
                sendJson(ws, { type: "team_invite_failed", to_uid: targetUid, reason: "is already in a team" });
                break;
            }

            // Remember who asked, so a "no thanks" answers that member and not the
            // leader's phone.
            team.inviters[targetUid] = uid;
            sendJson(targetWs, {
                type: "team_invite",
                team_id: team.id,
                from_uid: uid,
                from_name: data.username || "Player",
                max_size: team.maxSize
            });
            sendJson(ws, { type: "team_invite_sent", to_uid: targetUid });
            console.log(`[TEAM] ${uid} invited ${targetUid} into ${team.id}`);
            break;
        }

        case 'team_join': {
            const uid = bindUid(ws, data);
            const team = teams.get(String(data.team_id || ""));

            if (!uid) { teamError(ws, "Profile is still syncing"); break; }
            if (!team) { teamError(ws, "That team no longer exists"); break; }

            const current = teamOf(ws);
            if (current && current.id === team.id) { broadcastTeam(team); break; }
            if (current) { teamError(ws, "You are already in a team"); break; }
            if (team.members.length >= team.maxSize) { teamError(ws, "That team is full"); break; }
            if (team.members.some(m => m.uid === uid)) { teamError(ws, "Already a member of that team"); break; }

            ws.teamId = team.id;
            team.members.push({
                ws: ws,
                uid: uid,
                username: data.username || "Player",
                characterId: data.character_id || 1,
                bundleId: bundleIdOf(data)
            });
            console.log(`[TEAM] ${uid} joined ${team.id} (${team.members.length}/${team.maxSize})`);
            if (team.inviters) delete team.inviters[String(uid)];
            broadcastTeam(team);
            break;
        }

        case 'team_decline': {
            const uid = bindUid(ws, data);
            const team = teams.get(String(data.team_id || ""));
            if (team) {
                // The member who sent the invite is the one that has to hear about
                // it; a group that lost that phone still tells the leader.
                const inviterUid = (team.inviters || {})[String(uid)];
                if (team.inviters) delete team.inviters[String(uid)];
                const hearer = team.members.find(m => m.uid === inviterUid)
                    || team.members.find(m => m.uid === team.leaderUid);
                if (hearer) {
                    sendJson(hearer.ws, {
                        type: "team_invite_declined",
                        player_uid: uid,
                        username: data.username || "Player"
                    });
                }
            }
            break;
        }

        case 'team_leave': {
            bindUid(ws, data);
            leaveTeam(ws);
            break;
        }

        case 'team_kick': {
            const uid = bindUid(ws, data);
            if (!uid) { teamError(ws, "Profile is still syncing"); break; }
            kickMember(ws, uidKey(data.to_uid));
            break;
        }

        // A lobby celebration is an event, not state: it does not belong in
        // anybody's team_update and must not be stored, because a late joiner
        // should not watch an emote that already happened. The party is the only
        // audience the lobby has, so the relay stops there.
        case 'lobby_emote': {
            const uid = bindUid(ws, data);
            const team = teamOf(ws);
            if (!team || !uid) break;
            const emote = Number(data.emote);
            if (!Number.isInteger(emote) || emote < 1 || emote > 16) break;
            const txt = JSON.stringify({
                type: "lobby_emote",
                emote: emote,
                player_uid: uid,
                username: String(data.username || "").slice(0, 24)
            });
            for (const m of team.members) {
                if (m.uid !== uid && m.ws.readyState === WebSocket.OPEN) {
                    m.ws.send(txt);
                }
            }
            break;
        }

        case 'quick_match': {
            const uid = bindUid(ws, data);
            // A socket already inside a live Mummy match is not a free body: letting
            // it queue again would put the same player in two arenas at once.
            const current = ws.matchId && matches.get(ws.matchId);
            if (current && current.game) break;

            const mode = String(data.mode || "");
            // Only the two real modes exist. An unknown string is a mismatch, not
            // a new queue we silently invent.
            if (!queues[mode] || !teamQueues[mode]) {
                sendJson(ws, { type: "mode_mismatch", mode: mode });
                break;
            }
            const requestedSlot = parseInt(data.team_size, 10);
            if (!TEAM_SLOTS.includes(requestedSlot)) {
                sendJson(ws, { type: "team_size_mismatch", team_size: data.team_size });
                break;
            }
            // A zombie room is Squad-sized on both sides and nothing else, so any
            // other slot is refused here rather than left to wait on a gate it can
            // never satisfy.
            if (mode === ZOMBIE_MODE && requestedSlot !== ZOMBIE_TEAM_SIZE) {
                sendJson(ws, { type: "team_size_mismatch", team_size: requestedSlot, expected: ZOMBIE_TEAM_SIZE });
                break;
            }
            const characterId = data.character_id || 1;
            const bundleId = bundleIdOf(data);
            const username = data.username || "Player";
            const playerUid = uid || "";
            const targetSlot = squadTargetSlot(mode, requestedSlot);

            const team = teamOf(ws);
            if (team && team.members.length > 1) {
                if (team.leaderUid !== playerUid) { teamError(ws, "Only the team leader can start matchmaking"); break; }
                // Keep invited friends together in one party/team (never split).
                // For squad-style Mummy matchmaking, target is 4-player squads.
                if (team.members.length > targetSlot) {
                    sendJson(ws, {
                        type: "team_size_mismatch",
                        team_size: requestedSlot,
                        expected: team.members.length
                    });
                    break;
                }
                removeFromAllQueues(ws);
                removeFromTeamQueue(team.id);
                queueTeam(mode, team, requestedSlot);
                break;
            }

            // Re-queueing is an update, not a second seat.
            removeFromAllQueues(ws);
            queues[mode].push({
                ws,
                mode,
                slot: targetSlot,
                requestedSlot: requestedSlot,
                teamSize: 1,
                characterId,
                bundleId,
                username,
                playerUid,
                queuedAt: Date.now()
            });
            console.log(`[QUEUE] ${playerUid || "solo"} joined ${mode} pref ${requestedSlot} -> target ${targetSlot}. Waiting: ${queues[mode].filter(e => e.slot === targetSlot).length}/${targetSlot * 2}`);
            processMatchQueue(mode);
            break;
        }

        case 'quick_match_cancel': {
            const uid = bindUid(ws, data);
            const team = teamOf(ws);
            if (team && team.members.length > 1) {
                if (team.leaderUid !== uid) { break; }
                const members = team.members.slice();
                for (const mode of Object.keys(teamQueues)) {
                    teamQueues[mode] = teamQueues[mode].filter(g => g.teamId !== team.id);
                }
                for (const m of members) sendJson(m.ws, { type: "match_cancelled" });
                broadcastAllPools();
                break;
            }
            removeFromAllQueues(ws);
            broadcastAllPools();
            ws.send(JSON.stringify({ type: "match_cancelled" }));
            break;
        }

        case 'player_move':
        case 'player_action':
        case 'player_anim': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room) break;
            let resolved = null;
            if (type === "player_move") {
                // The relay alone used to be the server's only knowledge of where
                // anybody stood. Abilities and clone hits are sized in metres, so
                // the room now keeps the last position each socket reported - and
                // resolves it against everybody else's, so the coordinates leaving
                // this process are ones no client has to argue about.
                const mover = room.entries.find(e => e.ws === ws);
                if (mover) {
                    let x = Number(data.x) || 0;
                    let z = Number(data.z) || 0;
                    if (collidesInRoom(room, mover)) {
                        const out = separateFromRoom(room, mover, x, z);
                        x = out.x;
                        z = out.z;
                    }
                    mover.pos = {
                        x: x,
                        y: Number(data.y) || 0,
                        z: z,
                        yaw: Number(data.yaw) || 0
                    };
                    resolved = mover.pos;
                }
            }
            // Tag the relay so a room of up to 8 clients can tell who moved.
            const frame = Object.assign({}, data, {
                player_uid: ws.matchUid || "",
                spawn_index: ws.matchSpawnIndex === undefined ? -1 : ws.matchSpawnIndex
            });
            if (resolved) {
                frame.x = resolved.x;
                frame.z = resolved.z;
            }
            const txt = JSON.stringify(frame);
            for (const otherWs of room.players) {
                if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
                    otherWs.send(txt);
                }
            }
            break;
        }

        // A phone that dropped mid-match comes back on a new socket: the same
        // UID plus the match id it already has re-seats it on its old entry, and
        // a forced full state repaint puts the returnee's body back on every
        // screen - its own included - so the whole room moves again.
        case 'match_rejoin': {
            const uid = bindUid(ws, data);
            const room = data.match_id ? matches.get(String(data.match_id)) : null;
            if (!room || !room.game || room.game.phase === "finished") {
                sendJson(ws, { type: "match_cancelled", reason: "no_match" });
                break;
            }
            const entry = room.entries.find(e => e.gone && uidKey(e.uid) === uid);
            if (!entry) {
                sendJson(ws, { type: "match_cancelled", reason: "no_seat" });
                break;
            }
            entry.gone = false;
            entry.ws = ws;
            ws.matchId = room.matchId;
            ws.matchUid = entry.uid;
            ws.matchSpawnIndex = entry.spawnIndex;
            if (!room.players.includes(ws)) room.players.push(ws);
            armGraceTimer(room);
            console.log(`[REJOIN] ${uid} back in ${room.matchId} (${room.game.kind})`);
            if (room.game.kind === "zombie") broadcastZombieState(room, true);
            else broadcastMummyState(room, true);
            break;
        }

        // "Everyone connected" means every socket has loaded the arena, not merely
        // opened a websocket, so the client sends this once its scene is built.
        case 'match_ready': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;
            const self = room.entries.find(e => e.ws === ws);
            if (!self) break;

            const g = room.game;
            if (g.phase !== "waiting") {
                if (g.kind === "zombie") broadcastZombieState(room, true);
                else broadcastMummyState(room, true);
                break;
            }

            g.ready.add(mummyIdOf(self));
            if (g.kind === "zombie") {
                console.log(`[ZOMBIE] ${mummyIdOf(self)} ready in ${room.matchId} (${g.ready.size}/${room.entries.length})`);
                if (g.ready.size >= room.entries.length) beginZombieRound(room, 1);
                else broadcastZombieState(room, true);
            } else {
                console.log(`[MUMMY] ${mummyIdOf(self)} ready in ${room.matchId} (${g.ready.size}/${room.entries.length})`);
                if (g.ready.size >= room.entries.length) beginMummyRound(room, 1);
                else broadcastMummyState(room, true);
            }
            break;
        }

        // Every swing is drawn on every phone. The catcher's own phone plays it the
        // moment the fist is pressed; this broadcast is what the other screens
        // follow, and the clip alternates sword / left jab so a combo reads as one.
        case 'swing_start': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;
            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            performMummySwing(room, attacker);
            break;
        }

        // Only the catcher's own proximity is trusted: the attacker comes from the
        // socket, the role from the server's table, and a Human who is already down
        // or already out cannot be knocked a second time.
        case 'mummy_attack': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;
            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            performMummyAttack(room, attacker, String(data.target_id || ""));
            break;
        }

        // Zombie infection mode: same two-message pair as the mummy, but the swing
        // is pure theatre and the touch is the whole game - one hit turns a human
        // for the rest of the round, scored to the catcher's side.
        case 'zombie_swing': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game || room.game.kind !== "zombie") break;
            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            performZombieSwing(room, attacker);
            break;
        }

        case 'zombie_attack': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game || room.game.kind !== "zombie") break;
            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            performZombieAttack(room, attacker, String(data.target_id || ""));
            break;
        }

        // Only a Human whose equipped character actually owns this ability, on a
        // live round, still standing and off cooldown, gets holograms - and the
        // server places them, numbers them and starts the clock.
        case 'ability_activate': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const g = room.game;
            if (g.phase !== "playing" || g.settled) break;

            const caster = room.entries.find(e => e.ws === ws);
            if (!caster) break;
            const casterId = mummyIdOf(caster);
            if (g.roles[casterId] !== "human") break;

            const state = g.combat[casterId];
            if (!state || state.downed || state.eliminated) break;
            if (abilityFor(caster) !== String(data.ability_type || "")) break;

            if (activateMummyAbility(room, caster, Date.now()) === "cooldown") {
                // Refused, but the phone gets the real remaining time so its
                // countdown snaps back to the server's instead of sitting on zero.
                broadcastMummyState(room, true);
            }
            break;
        }

        // The catcher reports the hologram its own reach test landed on, in the
        // same spirit as mummy_attack; the server re-checks the distance from the
        // positions both sides send and owns the count of three.
        case 'clone_hit': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const g = room.game;
            if (g.phase !== "playing" || g.settled) break;

            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            const attackerId = mummyIdOf(attacker);
            if (g.roles[attackerId] !== "mummy") break;
            if (!mummyAlive(room, attackerId)) break;

            const cloneId = String(data.clone_id || "");
            const clone = g.clones[cloneId];
            if (!clone) break;
            if (flatDistance(attacker.pos, clone) > MUMMY_ATTACK_RANGE) break;

            landCloneHit(room, cloneId, Date.now());
            break;
        }

        // A catcher beating on the shell itself, with nobody its reach can touch
        // through it. The same shape as clone_hit: the attacker comes from the
        // socket, the reach is measured by the server from both reported positions,
        // and the count lives here.
        case 'shield_hit': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const g = room.game;
            if (g.phase !== "playing" || g.settled) break;

            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            const attackerId = mummyIdOf(attacker);
            if (g.roles[attackerId] !== "mummy") break;
            if (!mummyAlive(room, attackerId)) break;

            const ownerId = String(data.shield_id || "");
            if (!g.shields[ownerId]) break;
            const owner = room.entries.find(e => mummyIdOf(e) === ownerId);
            if (!owner || owner.side === attacker.side) break;
            const centre = shieldCenter(room, ownerId);
            if (!centre) break;
            // The shell can be hit from outside it, and only from outside it.
            const d = flatDistance(attacker.pos, centre);
            if (d > SHIELD_RADIUS + MUMMY_ATTACK_RANGE || d < SHIELD_RADIUS - 0.6) break;

            landShieldHit(room, ownerId, Date.now());
            break;
        }

        // A teammate holds this heartbeat while it stands next to a downed Human.
        // The server owns the 5-second channel, so a dropped or distracted reviver
        // simply stops adding time instead of finishing the revive on its own.
        case 'revive_begin': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const g = room.game;
            if (g.phase !== "playing" || g.settled || g.sideSize <= 1) break;

            const reviver = room.entries.find(e => e.ws === ws);
            if (!reviver) break;
            const reviverId = mummyIdOf(reviver);
            const reviverState = g.combat[reviverId];
            if (g.roles[reviverId] !== "human" || !reviverState || reviverState.downed || reviverState.eliminated) break;

            const targetId = String(data.target_id || "");
            const target = g.combat[targetId];
            if (!target || !target.downed || targetId === reviverId || g.roles[targetId] !== "human") break;

            target.revivers[reviverId] = Date.now();
            broadcastMummyState(room, false);
            break;
        }

        case 'revive_end': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const reviver = room.entries.find(e => e.ws === ws);
            if (!reviver) break;
            const reviverId = mummyIdOf(reviver);
            const target = room.game.combat[String(data.target_id || "")];
            if (target && target.revivers[reviverId]) {
                delete target.revivers[reviverId];
                target.reviveAt = 0;
                broadcastMummyState(room, true);
            }
            break;
        }

        // The lobby key is "lobby_<team_id>" and match keys reuse the room id,
        // so a socket that changes rooms just re-keys. Leaving sends the rest of
        // the room a fresh member list, and a dropped socket leaves silently.
        case 'voice_join': {
            const uid = bindUid(ws, data);
            const key = sanitizeVoiceKey(data.voice_key);
            if (!key || !uid) break;
            leaveVoice(ws);
            ws.voiceKey = key;
            if (!voiceGroups.has(key)) voiceGroups.set(key, new Set());
            voiceGroups.get(key).add(ws);
            sendVoiceList(key);
            break;
        }

        case 'voice_leave': {
            leaveVoice(ws);
            break;
        }

        case 'voice_list': {
            if (ws.voiceKey) sendVoiceList(ws.voiceKey);
            break;
        }

        default:
            console.log('[WS] Unknown message type:', type);
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.uid = "";
    ws.teamId = null;
    ws.matchId = null;
    ws.matchUid = "";
    ws.matchSpawnIndex = -1;
    ws.queued = false;
    ws.teamRemote = null;
    ws.voiceKey = "";

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        const data = safeJsonParse(raw);
        if (!data || typeof data !== "object") return;

        // Track the latest socket per authenticated uid (for invites/presence/team ops).
        const uid = bindUid(ws, data);
        if (uid) {
            const prev = clientsByUid.get(uid);
            if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
                // Keep the newer socket as the reachable one for presence/invites.
                // Do not forcibly close the previous socket here.
            }
            clientsByUid.set(uid, ws);
        }

        // Hub <-> relay/peer control messages (only meaningful on hub/relay links).
        if (HUB_URL === "" && data.type === "relay_hello") {
            const region = String(data.region || "relay");
            relays.set(ws, {
                id: "relay-" + String(nextRelayId++),
                region: region,
                state: { games: new Map(), teams: new Map(), clients: new Map() }
            });
            console.log(`[HUB] relay connected (${region})`);
            return;
        }

        // A relay forwarding a client event to the hub.
        if (HUB_URL === "" && data._kind === "from_client") {
            const relayInfo = relays.get(ws);
            if (!relayInfo) return;
            const remoteId = String(data.remote || "");
            let seat = relayInfo.state.clients.get(remoteId);
            if (!seat) {
                seat = makeProxy(ws, remoteId, relayInfo.region);
                relayInfo.state.clients.set(remoteId, seat);
            }
            seat.readyState = WebSocket.OPEN;
            seat._relay = ws;
            handleClientMessage(seat, data.payload || {});
            return;
        }

        // Relay mode: forward global actions to hub; handle local-only actions locally.
        if (HUB_URL !== "" && hubReady) {
            const forwardTypes = new Set([
                'team_get','team_invite','team_join','team_decline','team_leave','team_kick','lobby_emote',
                'quick_match','quick_match_cancel',
                'match_ready','swing_start','mummy_attack','zombie_swing','zombie_attack',
                'ability_activate','clone_hit','shield_hit','revive_begin','revive_end','match_rejoin'
            ]);
            if (forwardTypes.has(data.type)) {
                if (!ws._remoteId) {
                    ws._remoteId = "c-" + String(nextRemoteId++);
                    remoteClients.set(ws._remoteId, ws);
                }
                relaySend({ _kind: "from_client", remote: ws._remoteId, payload: data });
                return;
            }
        }

        // Local handling (hub, or relay-local concerns like voice/presence/move relay in-room).
        handleClientMessage(ws, data);
    });

    ws.on('close', () => {
        // Presence map cleanup (only if this socket is the latest).
        const uid = uidKey(ws.uid);
        if (uid && clientsByUid.get(uid) === ws) clientsByUid.delete(uid);

        leaveVoice(ws);

        // Hub: relay link dropped.
        if (HUB_URL === "" && relays.has(ws)) {
            dropRelay(ws);
            return;
        }

        // Relay: tell hub this client is gone (if it had a remote seat).
        if (HUB_URL !== "" && ws._remoteId && hubReady) {
            relaySend({ _kind: "from_client", remote: ws._remoteId, payload: { type: "client_gone", uid: uidKey(ws.uid) } });
            remoteClients.delete(ws._remoteId);
        }

        removeFromAllQueues(ws);
        leaveTeam(ws);

        const room = ws.matchId && matches.get(ws.matchId);
        if (room) {
            room.players = room.players.filter(p => p !== ws);
            const entry = room.entries.find(e => e.ws === ws || uidKey(e.uid) === uid);
            if (entry && room.game && room.game.phase !== "finished") {
                entry.gone = true;
                entry.ws = ws; // keep ref; will be replaced on rejoin
            }
            if (!room.game || room.game.phase === "finished") {
                // Nothing to preserve.
            } else if (room.game.phase === "waiting") {
                cancelMummyWaiting(room);
            } else {
                armGraceTimer(room);
            }
        }

        broadcastAllPools();
    });

    ws.on('error', () => {
        try { ws.terminate(); } catch (_e) {}
    });
});

const mummyTick = setInterval(tickMummyMatches, 250);
const zombieTick = setInterval(tickZombieMatches, 250);

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
    clearInterval(mummyTick);
    clearInterval(zombieTick);
});

server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Flame Strike Server listening on port ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`Role: ${HUB_URL === "" ? "HUB (owns every queue, team and room)" : "RELAY -> " + HUB_URL}`);
    console.log(`Region id: ${REGION_ID}`);
    console.log(`===========================================`);
    if (HUB_URL !== "") {
        wakeHub();
        connectToHub();
    }
});

server.on('error', (err) => {
    console.error(`[BOOT] cannot listen on port ${PORT}: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.error('[BOOT] another process already owns this port.');
    }
});
