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
        process.exitCode = 1;
        throw err;
    }
}

const http = require('http');
const wsLib = load('ws');
const WebSocketServer = wsLib.WebSocketServer || wsLib.Server;
const WebSocket = wsLib.WebSocket;

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. OAUTH TOKEN MEMORY STORE
// ==========================================
const oauthTokens = new Map(); // state -> { access_token, refresh_token, expires_at, user }

// ---- the handful of things express was doing ----
// Written against node's own http so the only package this service needs to boot
// is ws. Every response stays permissive exactly as cors() left it, and a body is
// capped because a POST to this port can come from anywhere.
const MAX_BODY_BYTES = 64 * 1024;

function respond(res, status, type, body) {
    res.writeHead(status, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(body);
}

function respondJson(res, status, obj) {
    respond(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req, res, done) {
    let raw = '';
    let failed = false;
    req.on('data', (chunk) => {
        if (failed) return;
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
            failed = true;
            respondJson(res, 413, { error: "Body too large" });
            req.destroy();
        }
    });
    req.on('end', () => { if (!failed) done(raw); });
    req.on('error', () => {});
}

// Health check endpoint
function handleHealth(req, res) {
    respondJson(res, 200, {
        status: "online",
        service: "Flame Strike Game Server",
        timestamp: new Date().toISOString()
    });
}

// OAuth Callback from Supabase / Google
// Supabase OAuth redirects with hash fragment (#access_token=...&refresh_token=...&state=...)
// This page reads the hash and submits it back to the server
function handleCallback(req, res) {
    respond(res, 200, 'text/html; charset=utf-8', `
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
        // Check both hash and query string for tokens
        const hash = window.location.hash.substring(1);
        const search = window.location.search.substring(1);
        const params = new URLSearchParams(hash || search);
        
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        const state = params.get('state');
        
        document.getElementById('debug').innerText = 'State: ' + (state || 'none') + ' | Token: ' + (accessToken ? 'found' : 'missing');
        
        if (accessToken) {
            // If no state, use a fallback global state
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
}

// Internal endpoint to store extracted token
function handleSaveToken(req, res) {
    readBody(req, res, (raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (err) { body = {}; }
        const { state, access_token, refresh_token } = body;
        console.log('[AUTH] Save-token called. State:', state, 'Token present:', !!access_token);

        if (access_token) {
            const finalState = state || 'global_fallback';
            oauthTokens.set(finalState, {
                access_token,
                refresh_token,
                created_at: Date.now()
            });
            // Also store under global_fallback for Zero-State bridge
            oauthTokens.set('global_fallback', {
                access_token,
                refresh_token,
                created_at: Date.now()
            });
            // Auto cleanup after 5 minutes
            setTimeout(() => {
                oauthTokens.delete(finalState);
                oauthTokens.delete('global_fallback');
            }, 5 * 60 * 1000);
            console.log('[AUTH] Token saved successfully for state:', finalState);
            respondJson(res, 200, { success: true });
            return;
        }
        respondJson(res, 400, { error: "Missing token" });
    });
}

// Godot polls this endpoint during login
function handlePoll(req, res, state) {
    if (!state) {
        return respondJson(res, 400, { error: "Missing state query param" });
    }

    // Try exact state match first
    if (oauthTokens.has(state)) {
        const tokenData = oauthTokens.get(state);
        oauthTokens.delete(state); // One-time use
        return respondJson(res, 200, {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    // Zero-State fallback: if global_fallback exists, use it
    if (oauthTokens.has('global_fallback')) {
        const tokenData = oauthTokens.get('global_fallback');
        oauthTokens.delete('global_fallback'); // One-time use
        return respondJson(res, 200, {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    respondJson(res, 200, { pending: true });
}

// Everything that is not a websocket upgrade lands here: the four routes above,
// and a plain 404 for the rest.
function routeHttp(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') {
        respond(res, 204, 'text/plain; charset=utf-8', '');
        return;
    }
    if (req.method === 'GET' && path === '/') { handleHealth(req, res); return; }
    if (req.method === 'GET' && path === '/auth/callback') { handleCallback(req, res); return; }
    if (req.method === 'POST' && path === '/auth/save-token') { handleSaveToken(req, res); return; }
    if (req.method === 'GET' && path === '/auth/poll') {
        handlePoll(req, res, new URL(req.url, 'http://localhost').searchParams.get('state'));
        return;
    }
    respondJson(res, 404, { error: "Not found" });
}

// ==========================================
// 2. WEBSOCKET REAL-TIME MATCHMAKING
// ==========================================
const server = http.createServer(routeHttp);
const wss = new WebSocketServer({ server });

// Mode queues: array of { ws, uid, team_size, character_id, username, player_uid }
const queues = {
    "MUMMY_VS_HUMAN": [],
    "ZOMBIE_ECLIPSE": []
};

// Team queues: mode -> array of { teamId, slot, teamSize, members: [same shape as above] }
const teamQueues = {
    "MUMMY_VS_HUMAN": [],
    "ZOMBIE_ECLIPSE": []
};

// The team slots a search can ask for. A queue is a separate pool per
// (mode, slot), so Solo can only ever meet Solo and Squad only Squad.
const TEAM_SLOTS = [1, 2, 3, 4];

// Active match rooms: match_id -> { players: [ws1, ws2], mode }
const matches = new Map();
let matchCounter = 1000;

// A phone that drops mid-match gets this long to come back before the match is
// forfeited: mobile nets flap for seconds at a time, so an instant loss on the
// first closed socket was punishing a wobble like a rage-quit. The harness
// shortens it via RECONNECT_GRACE_MS so forfeit tests do not wait 15 real seconds.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 15000;

// ---- Authoritative team (party) state ----
const clientsByUid = new Map();   // player_uid -> ws (last connection wins)
const teams = new Map();          // team_id -> { id, leaderUid, maxSize, members: [{ws, uid, username, characterId, bundleId}] }
let teamCounter = 5000;

// Supabase hands UIDs back as floats, so the same player can arrive as
// "667336" or "667336.0". Everything is keyed on the integer form.
function uidKey(value) {
    const raw = String(value === undefined || value === null ? "" : value).trim();
    if (raw === "") return "";
    const asInt = parseInt(raw, 10);
    return isNaN(asInt) || asInt <= 0 ? "" : String(asInt);
}

function sendJson(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function bindUid(ws, data) {
    const key = uidKey(data && data.player_uid);
    if (key && key !== ws.playerUid) {
        if (ws.playerUid && clientsByUid.get(ws.playerUid) === ws) clientsByUid.delete(ws.playerUid);
        ws.playerUid = key;
        clientsByUid.set(key, ws);
    }
    return ws.playerUid || "";
}

function teamOf(ws) {
    return ws.teamId && teams.has(ws.teamId) ? teams.get(ws.teamId) : null;
}

function bundleOf(row) {
    // -1 means "wearing the character's own default look". The client maps any
    // slot it does not have to the same fallback, so an unknown number is only
    // ever cosmetic, never a crash.
    return row.bundleId === undefined || row.bundleId === null ? -1 : row.bundleId;
}

function bundleIdOf(data) {
    const v = parseInt(data && data.bundle_id, 10);
    return isNaN(v) || v < -1 ? -1 : v;
}

function memberInfo(m) {
    return {
        player_uid: m.uid,
        username: m.username,
        character_id: m.characterId,
        bundle_id: bundleOf(m)
    };
}

// ---- Bot helpers ----
function isBotPeer(ws) {
    return !!ws && ws.__bot === true;
}

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function makeBotPeer() {
    const id = "bot_" + (botCounter++);
    const peer = {
        __bot: true,
        readyState: 1,
        isAlive: true,
        playerUid: id,
        botId: id,
        matchId: null,
        matchUid: id,
        matchSpawnIndex: -1,
        teamId: null,
        send: () => {},
        close: () => {}
    };
    return peer;
}

function makeBotIdentity() {
    return {
        playerUid: "",
        username: "",
        characterId: 1,
        bundleId: -1
    };
}

function setBotIdentity(peer) {
    peer.playerUid = peer.botId;
    peer.botName = randomChoice(BOT_NAMES) + " " + peer.botId.split("_")[1];
    peer.botCharacterId = randomChoice(BOT_CHARACTERS);
    peer.botBundleId = randomChoice(BOT_BUNDLES);
}

function makeBotQueueEntry(mode, slot) {
    const peer = makeBotPeer();
    setBotIdentity(peer);
    return {
        ws: peer,
        mode: mode,
        slot: slot,
        teamSize: 1,
        characterId: peer.botCharacterId,
        bundleId: peer.botBundleId,
        username: peer.botName,
        playerUid: peer.botId,
        queuedAt: Date.now()
    };
}

function makeBotTeamGroup(mode, slot) {
    const members = [];
    for (let i = 0; i < slot; i++) {
        members.push(makeBotQueueEntry(mode, slot));
    }
    return {
        teamId: "bot_team_" + (botCounter++),
        mode: mode,
        slot: slot,
        teamSize: slot,
        isBot: true,
        queuedAt: Date.now(),
        members: members
    };
}

function botFillDelay() {
    const base = BOT_FILL_MS;
    // Tests pin the delay to a very small number; keep them deterministic.
    if (base <= 1000) return base;
    return base + Math.floor(Math.random() * BOT_FILL_JITTER_MS);
}

function spawnPointFor(mode, index) {
    if (mode === ZOMBIE_MODE) return ZOMBIE_SPAWN_POINTS[index] || { x: 0, y: 1, z: 0 };
    return MUMMY_SPAWN_POINTS[index] || { x: 0, y: 6.55, z: 0 };
}

// A bot starts on the floor the arena was measured with, not the spawn marker's
// height: that marker is where the client drops a body before gravity takes it,
// and the wire carries feet. Facing the middle of the ring is what a player does
// between rounds.
function botPlaceAtSpawn(room, entry) {
    const seat = spawnPointFor(room.mode, entry.spawnIndex);
    const arena = arenaFor(room.mode);
    let x = seat.x;
    let z = seat.z;
    let feet = botFeetAt(arena, x, z);
    if (feet === null) {
        const cell = botNearestStandableCell(arena, x, z);
        if (cell >= 0) {
            const at = botCellCentre(arena, cell);
            x = at.x;
            z = at.z;
            feet = botCellFeet(arena, cell);
        }
    }
    entry.pos = { x: x, y: feet === null ? seat.y : feet, z: z, yaw: Math.atan2(-x, -z), moving: false };
}

function initBotEntry(room, entry) {
    if (!isBotPeer(entry.ws)) return;
    entry.uid = entry.ws.botId;
    entry.username = entry.ws.botName;
    entry.characterId = entry.ws.botCharacterId;
    entry.bundleId = entry.ws.botBundleId;
    botPlaceAtSpawn(room, entry);
    entry.bot = {
        nextAttackAt: 0,
        nextMoveAt: 0,
        // Two bodies built on identical constants move in lockstep and read as
        // machines, so each one gets its own pace and a heading that drifts.
        speedMul: 0.86 + Math.random() * 0.26,
        wobble: (Math.random() - 0.5) * 0.4,
        // Navigation state: the path being walked, when it was last rebuilt and
        // the mark the stuck check measures from. Nothing else reads these.
        path: null,
        pathIndex: 0,
        pathGoal: -1,
        pathPartial: false,
        partialEnd: null,
        nextPathAt: 0,
        unstickUntil: 0,
        unstickSide: 0,
        blockedTicks: 0,
        // Progress-toward-aim stuck detection: the point the nav is heading for,
        // when it was set, and how far the body was from it last window.
        aim: null,
        aimAt: 0,
        progressAt: 0,
        progressDist: -1,
        noProgress: 0,
        reachedPartial: false,
        // Patrol state: the leg being walked and when to give up on it.
        roam: null,
        roamUntil: 0
    };
}

function resetBotPositions(room) {
    for (const e of room.entries) {
        if (!isBotPeer(e.ws)) continue;
        botPlaceAtSpawn(room, e);
        if (e.bot) {
            e.bot.nextAttackAt = 0;
            e.bot.path = null;
            e.bot.pathGoal = -1;
            e.bot.pathPartial = false;
            e.bot.partialEnd = null;
            e.bot.unstickUntil = 0;
            e.bot.blockedTicks = 0;
            e.bot.aim = null;
            e.bot.aimAt = 0;
            e.bot.progressDist = -1;
            e.bot.noProgress = 0;
            e.bot.reachedPartial = false;
            e.bot.roam = null;
            e.bot.roamUntil = 0;
        }
    }
}

function removeBotsFromQueue(mode, slot) {
    let removed = 0;
    queues[mode] = queues[mode].filter(e => {
        if (e.slot === slot && isBotPeer(e.ws)) { removed++; return false; }
        return true;
    });
    teamQueues[mode] = teamQueues[mode].filter(g => {
        if (g.slot === slot && g.isBot) { removed += g.members.length; return false; }
        return true;
    });
    return removed;
}

// A bot is only ever borrowed to finish a match a real player is waiting for.
// Once that player cancels or drops, the seat they were filling is not owed to
// anybody, so the bots go back in the box instead of pairing into a match
// nobody is watching.
function evictOrphanBots() {
    for (const mode of [MUMMY_MODE, ZOMBIE_MODE]) {
        for (const slot of TEAM_SLOTS) {
            const realWaiting = queues[mode].some(e => e.slot === slot && !isBotPeer(e.ws) && queueEntryUsable(e, mode, slot));
            const realTeam = teamQueues[mode].some(g => g.slot === slot && !g.isBot && g.members.every(m => queueEntryUsable(m, mode, slot)));
            if (!realWaiting && !realTeam) {
                if (removeBotsFromQueue(mode, slot) > 0) {
                    console.log(`[BOT] Cleared bots left waiting alone in ${mode} slot ${slot}`);
                }
            }
        }
    }
}

function countRealQueueEntries(mode, slot) {
    return queues[mode].filter(e => e.slot === slot && !isBotPeer(e.ws) && queueEntryUsable(e, mode, slot)).length;
}

function countRealTeamGroups(mode, slot) {
    return teamQueues[mode].filter(g => g.slot === slot && !g.isBot && g.members.every(m => queueEntryUsable(m, mode, slot))).length;
}

function oldestRealQueueTime(mode, slot) {
    let oldest = 0;
    for (const e of queues[mode]) {
        if (e.slot === slot && !isBotPeer(e.ws) && queueEntryUsable(e, mode, slot)) {
            if (oldest === 0 || e.queuedAt < oldest) oldest = e.queuedAt;
        }
    }
    return oldest;
}

function oldestRealTeamTime(mode, slot) {
    let oldest = 0;
    for (const g of teamQueues[mode]) {
        if (g.slot === slot && !g.isBot && g.members.every(m => queueEntryUsable(m, mode, slot))) {
            if (oldest === 0 || g.queuedAt < oldest) oldest = g.queuedAt;
        }
    }
    return oldest;
}

function fillBotsIfNeeded() {
    const now = Date.now();
    evictOrphanBots();
    for (const mode of [MUMMY_MODE, ZOMBIE_MODE]) {
        for (const slot of TEAM_SLOTS) {
            const need = slot * 2;

            // Solo queue: evict bots if real players are now enough.
            if (countRealQueueEntries(mode, slot) >= need) {
                if (removeBotsFromQueue(mode, slot) > 0) {
                    console.log(`[BOT] Evicted bots from ${mode} slot ${slot}: real players filled up`);
                }
                continue;
            }

            const realCount = countRealQueueEntries(mode, slot);
            const waiting = queues[mode].filter(e => e.slot === slot && queueEntryUsable(e, mode, slot));
            if (realCount === 0 || waiting.length >= need) continue;

            const oldest = oldestRealQueueTime(mode, slot);
            if (oldest === 0 || now - oldest < botFillDelay()) continue;

            const missing = need - realCount;
            for (let i = 0; i < missing; i++) {
                queues[mode].push(makeBotQueueEntry(mode, slot));
            }
            console.log(`[BOT] Added ${missing} bots to ${mode} slot ${slot}`);
            processSoloQueue(mode);
        }

        // Zombie and party-sized mummy modes also use the team queue.
        for (const slot of TEAM_SLOTS) {
            const realGroups = countRealTeamGroups(mode, slot);
            if (realGroups >= 2) {
                if (removeBotsFromQueue(mode, slot) > 0) {
                    console.log(`[BOT] Evicted bot team from ${mode} slot ${slot}: real teams filled up`);
                }
                continue;
            }
            const waitingGroups = teamQueues[mode].filter(g => g.slot === slot && g.members.every(m => queueEntryUsable(m, mode, slot)));
            if (realGroups === 0 || waitingGroups.length >= 2) continue;

            const oldest = oldestRealTeamTime(mode, slot);
            if (oldest === 0 || Date.now() - oldest < botFillDelay()) continue;

            teamQueues[mode].push(makeBotTeamGroup(mode, slot));
            console.log(`[BOT] Added bot team to ${mode} slot ${slot}`);
            processTeamQueue(mode);
        }
    }
}

// Clients attach their identity (UID, name, equipped character) to every team
// message, so a player who equips or buys a character while already in a party —
// or while queued — is carried with their new model instead of the one they
// registered with.
function refreshIdentity(uid, data) {
    if (!uid) return;
    const name = String(data.username || "").trim();
    const charId = parseInt(data.character_id, 10);
    const bundleId = parseInt(data.bundle_id, 10);
    const patch = (row) => {
        if (name !== "") row.username = name;
        if (!isNaN(charId) && charId > 0) row.characterId = charId;
        if (!isNaN(bundleId) && bundleId >= -1) row.bundleId = bundleId;
    };
    for (const team of teams.values()) {
        const member = team.members.find(m => m.uid === uid);
        if (member) patch(member);
    }
    for (const mode of Object.keys(queues)) {
        for (const entry of queues[mode]) {
            if (entry.playerUid === uid) patch(entry);
        }
    }
    for (const mode of Object.keys(teamQueues)) {
        for (const group of teamQueues[mode]) {
            for (const entry of group.members) {
                if (entry.playerUid === uid) patch(entry);
            }
        }
    }
}

function teamPayload(team) {
    return {
        type: "team_update",
        team_id: team.id,
        leader_uid: team.leaderUid,
        max_size: team.maxSize,
        members: team.members.map(memberInfo)
    };
}

// The "you have no team" message doubles as the lobby-clear signal client-side.
const NO_TEAM = { type: "team_update", team_id: "", leader_uid: "", max_size: 1, members: [] };

function teamError(ws, reason) {
    sendJson(ws, { type: "team_error", reason: String(reason || "") });
}

function broadcastTeam(team) {
    const payload = teamPayload(team);
    for (const m of team.members) sendJson(m.ws, payload);
}

function createTeam(ws, uid, username, characterId, bundleId, maxSize) {
    const id = "team_" + (teamCounter++);
    const team = {
        id: id,
        leaderUid: uid,
        maxSize: maxSize,
        inviters: {},
        members: [{ ws: ws, uid: uid, username: username, characterId: characterId, bundleId: bundleId }]
    };
    teams.set(id, team);
    ws.teamId = id;
    return team;
}

function removeFromTeamQueue(teamId) {
    for (const mode of Object.keys(teamQueues)) {
        teamQueues[mode] = teamQueues[mode].filter(g => g.teamId !== teamId);
    }
}

function forgetTeam(team) {
    teams.delete(team.id);
    removeFromTeamQueue(team.id);
    for (const m of team.members) {
        if (m.ws.teamId === team.id) m.ws.teamId = null;
    }
}

function disbandTeam(team) {
    const members = team.members.slice();
    forgetTeam(team);
    for (const m of members) {
        sendJson(m.ws, NO_TEAM);
        sendJson(m.ws, { type: "match_cancelled" });
    }
}

// A party of one is not a party: as soon as a team drops below two members the
// remaining player is released and may pick Solo/Duo/Squad again.
function shrinkTeam(team, leavingWs, kickedMessage) {
    const members = team.members.slice();
    team.members = team.members.filter(m => m.ws !== leavingWs);
    if (leavingWs) {
        leavingWs.teamId = null;
        if (kickedMessage) sendJson(leavingWs, kickedMessage);
        sendJson(leavingWs, NO_TEAM);
        sendJson(leavingWs, { type: "match_cancelled" });
    }

    if (team.members.length < 2) {
        forgetTeam(team);
        for (const m of team.members) {
            m.ws.teamId = null;
            sendJson(m.ws, NO_TEAM);
            sendJson(m.ws, { type: "match_cancelled" });
        }
        return;
    }

    // A queue entry must never hold a departed member, and the rest have to stop
    // searching: the roster they queued with no longer exists.
    removeFromTeamQueue(team.id);
    for (const m of team.members) sendJson(m.ws, { type: "match_cancelled" });
    broadcastTeam(team);
}

function leaveTeam(ws) {
    const team = teamOf(ws);
    if (!team) {
        sendJson(ws, NO_TEAM);
        return;
    }
    if (team.leaderUid === ws.playerUid) {
        // The leader owns the party: everyone is released, leader included.
        team.members = team.members.filter(m => m.ws !== ws);
        ws.teamId = null;
        sendJson(ws, NO_TEAM);
        disbandTeam(team);
        return;
    }
    shrinkTeam(team, ws);
}

const KICKED_MESSAGE = "The leader has removed you from the team.";

function kickMember(leaderWs, targetUid) {
    const team = teamOf(leaderWs);
    if (!team) { teamError(leaderWs, "You are not in a team"); return; }
    if (team.leaderUid !== leaderWs.playerUid) { teamError(leaderWs, "Only the team leader can remove players"); return; }
    if (targetUid === team.leaderUid) { teamError(leaderWs, "The leader cannot be removed"); return; }

    const target = team.members.find(m => m.uid === targetUid);
    if (!target) { teamError(leaderWs, "That player is not in your team"); return; }

    shrinkTeam(team, target.ws, {
        type: "team_kicked",
        team_id: team.id,
        reason: KICKED_MESSAGE
    });
    console.log(`[TEAM] leader ${leaderWs.playerUid} removed ${targetUid} from ${team.id}`);
}

function removeFromAllQueues(ws) {
    for (const mode of Object.keys(queues)) {
        const idx = queues[mode].findIndex(p => p.ws === ws);
        if (idx !== -1) {
            queues[mode].splice(idx, 1);
            console.log(`[QUEUE] Player removed from ${mode}. Queue size: ${queues[mode].length}`);
        }
    }
    for (const mode of Object.keys(teamQueues)) {
        for (const group of teamQueues[mode]) {
            group.members = group.members.filter(m => m.ws !== ws);
        }
        teamQueues[mode] = teamQueues[mode].filter(g => g.members.length > 0);
    }
}

// ==========================================
// 0. CROSS-SERVER: HUB AND RELAY
// ==========================================
// One deployment is the hub (Asia 1) and owns every team, queue and room. The
// other seven forward every player packet to it, so a player on Europe meets a
// player on Oceania exactly like two players on the same server. On the hub a
// relayed player is a plain object that mimics a socket (send/readyState), which
// is why the whole game engine below works on both without knowing which one it
// holds.
// The fleet runs this one file with no per-service configuration: each
// deployment reads its own RENDER_EXTERNAL_URL, and the service whose address is
// HUB_HOST becomes the hub while every other one links itself to it. An explicit
// HUB_URL still wins, which is how the local test harness runs eight processes
// on one machine.
const HUB_HOST = String(process.env.HUB_HOST || "dark-ward-sever.onrender.com").trim().toLowerCase();
const HUB_RECONNECT_MS = 3000;

function hostOf(url) {
    return String(url || "").trim().toLowerCase()
        .replace(/^wss?:\/\//, "").replace(/^https?:\/\//, "")
        .split("/")[0].split("@").pop();
}

// A scheme the ws client can dial, or "" - never a throw, because a typo in one
// dashboard field was enough to crash-loop a deployment out of existence.
function asWsUrl(url) {
    const raw = String(url || "").trim();
    if (raw === "") return "";
    if (/^(wss|ws):\/\//i.test(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) return raw.replace(/^http/i, "ws");
    return "";
}

const selfHost = hostOf(process.env.RENDER_EXTERNAL_URL || process.env.SERVICE_URL || "");
const autoHubUrl = (selfHost !== "" && selfHost !== HUB_HOST) ? "wss://" + HUB_HOST : "";

let HUB_URL = autoHubUrl;
if (process.env.HUB_URL !== undefined) {
    const clean = asWsUrl(process.env.HUB_URL);
    if (clean === "" && String(process.env.HUB_URL).trim() !== "") {
        // A typo in the dashboard must not split the fleet: fall back to what this
        // service's own address says its role is instead of quietly going private.
        console.warn(`[CONFIG] HUB_URL="${process.env.HUB_URL}" is not a ws(s):// address. ` +
            (autoHubUrl === "" ? "Running as the hub." : `Relaying to ${autoHubUrl} instead.`));
    } else {
        HUB_URL = clean;
    }
}
// The hub pointing at itself is a loop, not a link: a relayed packet would leave
// this process and come straight back to it.
if (HUB_URL !== "" && hostOf(HUB_URL) === selfHost) HUB_URL = "";

const REGION_ID = String(process.env.REGION_ID || selfHost ||
    ("region_" + PORT + "_" + Math.random().toString(36).slice(2, 8)));

// ---- relay mode (this process forwards its players to the hub) ----
const connsById = new Map(); // connId -> local player socket
let relayConnCounter = 0;
let hubWs = null;
let hubTimer = null;

function connectToHub() {
    if (HUB_URL === "") return;
    if (hubWs && (hubWs.readyState === WebSocket.OPEN || hubWs.readyState === WebSocket.CONNECTING)) return;
    try {
        hubWs = new WebSocket(HUB_URL);
    } catch (err) {
        console.error('[RELAY] cannot dial hub URL:', err.message);
        hubWs = null;
        clearTimeout(hubTimer);
        hubTimer = setTimeout(connectToHub, HUB_RECONNECT_MS);
        return;
    }
    hubWs.on('open', () => {
        console.log(`[RELAY] linked to hub ${HUB_URL} as ${REGION_ID}`);
        hubWs.send(JSON.stringify({ type: "hub_register", region_id: REGION_ID }));
        // Players who joined while the link was down are announced again.
        for (const ws of wss.clients) {
            if (!ws.isRegion && ws.connId) {
                hubWs.send(JSON.stringify({ type: "relay_open", conn: ws.connId }));
            }
        }
    });
    hubWs.on('message', (message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch (e) { return; }
        if (data.type === "hub_to") {
            const target = connsById.get(String(data.conn));
            if (target && target.readyState === WebSocket.OPEN) target.send(String(data.data));
        }
    });
    hubWs.on('close', () => {
        console.log('[RELAY] hub link dropped, retrying...');
        hubWs = null;
        wakeHub();
        clearTimeout(hubTimer);
        hubTimer = setTimeout(connectToHub, HUB_RECONNECT_MS);
    });
    hubWs.on('error', () => {});
}

// The hub is the one service every region depends on, and a free instance sleeps
// when nobody is knocking. A relay's own socket attempt does not wake it, so this
// plain HTTP GET to its health root does - at most once a minute.
let lastWakeAt = 0;

function wakeHub() {
    if (HUB_URL === "") return;
    const now = Date.now();
    if (now - lastWakeAt < 60000) return;
    lastWakeAt = now;
    try {
        const host = hostOf(HUB_URL);
        const req = http.get({ host: host, path: "/", timeout: 5000 }, (res) => res.resume());
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
    } catch (err) {
        console.error('[RELAY] hub wake-up failed:', err.message);
    }
}

function relayToHub(ws, data) {
    if (!hubWs || hubWs.readyState !== WebSocket.OPEN) return;
    hubWs.send(JSON.stringify({ type: "relay_msg", conn: ws.connId, data: data }));
}

// ---- hub mode (this process owns the game and hears every region) ----
const regionLinks = new Map(); // regionId -> { ws, peers: Map(connId -> peer) }
let regionCounter = 0;

function makePeer(regionId, connId) {
    const link = regionLinks.get(regionId);
    const peer = {
        __peer: true,
        regionId: regionId,
        connId: connId,
        readyState: 1, // WebSocket.OPEN
        isAlive: true,
        send: (text) => {
            const l = regionLinks.get(regionId);
            if (l && l.ws.readyState === WebSocket.OPEN) {
                l.ws.send(JSON.stringify({ type: "hub_to", conn: connId, data: text }));
            }
        }
    };
    if (link) {
        if (link.peers.has(connId)) return link.peers.get(connId);
        link.peers.set(connId, peer);
    }
    return peer;
}

function registerRegion(ws, data) {
    const regionId = String(data.region_id || ("region_" + (++regionCounter)));
    ws.isRegion = true;
    ws.regionId = regionId;
    if (regionLinks.has(regionId)) {
        // The same id linking twice means the old socket is a zombie of a
        // half-dropped link: retire it so its close handler frees nothing twice.
        try { regionLinks.get(regionId).ws.close(); } catch (e) {}
    }
    regionLinks.set(regionId, { ws: ws, peers: new Map() });
    console.log(`[HUB] region ${regionId} linked`);
}

function handleRegionControl(ws, data) {
    const link = regionLinks.get(ws.regionId);
    if (!link) return;
    if (data.type === "relay_open") {
        makePeer(ws.regionId, String(data.conn));
        console.log(`[HUB] player ${data.conn} opened on ${ws.regionId}`);
    } else if (data.type === "relay_msg") {
        const peer = link.peers.get(String(data.conn));
        if (!peer) return;
        try {
            handleClientMessage(peer, data.data);
        } catch (err) {
            console.error('[HUB] relayed message error:', err);
        }
    } else if (data.type === "relay_close") {
        const peer = link.peers.get(String(data.conn));
        if (peer) {
            link.peers.delete(String(data.conn));
            dropPeer(peer);
        }
    }
}

function dropRegionLink(ws) {
    const link = regionLinks.get(ws.regionId);
    if (!link) return;
    regionLinks.delete(ws.regionId);
    for (const peer of link.peers.values()) dropPeer(peer);
    console.log(`[HUB] region ${ws.regionId} dropped (${link.peers.size} players released)`);
}

wss.on('connection', (ws) => {
    console.log('[WS] New connection');
    ws.isAlive = true;
    ws.isRegion = false;
    ws.regionId = "";
    if (HUB_URL !== "") {
        ws.connId = "c" + (++relayConnCounter);
        connsById.set(ws.connId, ws);
    }
    let firstMsg = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error('[WS ERROR] Failed to parse message:', err);
            return;
        }
        // A relay's first frame is its handshake; anything else is a player.
        if (firstMsg) {
            firstMsg = false;
            if (HUB_URL === "" && data.type === "hub_register") {
                registerRegion(ws, data);
                return;
            }
        }
        if (ws.isRegion) { handleRegionControl(ws, data); return; }
        if (HUB_URL !== "") { relayToHub(ws, data); return; }
        handleClientMessage(ws, data);
    });

    ws.on('close', () => {
        if (ws.isRegion) { dropRegionLink(ws); return; }
        if (HUB_URL !== "") {
            connsById.delete(ws.connId);
            if (hubWs && hubWs.readyState === WebSocket.OPEN) {
                hubWs.send(JSON.stringify({ type: "relay_close", conn: ws.connId }));
            }
            return;
        }
        dropPeer(ws);
    });

    if (HUB_URL !== "" && hubWs && hubWs.readyState === WebSocket.OPEN) {
        hubWs.send(JSON.stringify({ type: "relay_open", conn: ws.connId }));
    }
});

// A player left, on a real socket or through a dropped region link: every
// queue, team and room this body was part of hears about it exactly once.
function dropPeer(ws) {
    // A bot is a server-side body: it has no socket to close, so a disconnect
    // path must never run its queue/team cleanup and free a seat out of a live
    // room.
    if (isBotPeer(ws)) return;
    console.log('[WS] Player disconnected');
    if (ws.playerUid && clientsByUid.get(ws.playerUid) === ws) {
        clientsByUid.delete(ws.playerUid);
    }
    removeFromAllQueues(ws);
    leaveTeam(ws);
    // Everyone still waiting sees their pool shrink instead of counting a
    // closed socket toward the required body count.
    broadcastAllPools();

    if (ws.matchId && matches.has(ws.matchId)) {
        const room = matches.get(ws.matchId);
        const gone = room.entries.find(e => e.ws === ws);

        if (room.game && room.game.phase !== "finished") {
            // Loaded arenas are the only way a match starts, so a player who
            // drops out beforehand releases the rest instead of freezing them.
            if (room.game.phase === "waiting") {
                cancelMummyWaiting(room);
                return;
            }
            // Walking out of a live match is a forfeit, whatever the round was
            // doing: the side still in the arena takes the match outright, so
            // nobody is left fighting a ghost until the clock runs out. But a
            // dropped phone is not necessarily a walk-out - mobile nets flap -
            // so the entry stays seated, marked gone, for RECONNECT_GRACE_MS.
            // The room forfeits only if the player never comes back.
            if (gone) {
                gone.gone = true;
                room.players = room.players.filter(other => other !== ws);
                const txt = JSON.stringify({
                    type: "player_disconnected",
                    player_uid: gone.uid,
                    spawn_index: gone.spawnIndex
                });
                for (const otherWs of room.players) {
                    if (otherWs.readyState === WebSocket.OPEN) otherWs.send(txt);
                }
                armGraceTimer(room);
                return;
            }
        }

        room.players = room.players.filter(other => other !== ws);
        room.entries = room.entries.filter(e => e.ws !== ws);
        const txt = JSON.stringify({
            type: "player_disconnected",
            player_uid: gone ? gone.uid : "",
            spawn_index: gone ? gone.spawnIndex : -1
        });
        for (const otherWs of room.players) {
            if (otherWs.readyState === WebSocket.OPEN) otherWs.send(txt);
        }
        // A shared room only closes once nobody is left in it.
        if (room.players.length === 0) matches.delete(ws.matchId);
    }
}

function makeRoom(mode, sides) {
    // One shared room for the whole opposing set: 1v1 = 2 players, 2v2 = 4,
    // 3v3 = 6, 4v4 = 8. Each side keeps a contiguous block of spawn indexes so
    // teams start on opposite sides of the arena, never stacked.
    //
    // Last line of defence: an uneven pair of sides, a closed socket or a player
    // already seated elsewhere never turns into a room, whatever the queue did.
    const sizeA = sides[0] ? sides[0].members.length : 0;
    const sizeB = sides[1] ? sides[1].members.length : 0;
    if (sizeA === 0 || sizeB === 0 || sizeA !== sizeB) {
        console.warn(`[MATCH REJECTED] uneven sides ${sizeA}v${sizeB} for ${mode}`);
        return false;
    }
    // The infection mode is written for full squads: an 8-body room is what the
    // rules, the counters and the arena's two team halves are all built on.
    if (mode === ZOMBIE_MODE && sizeA !== ZOMBIE_TEAM_SIZE) {
        console.warn(`[MATCH REJECTED] zombie rooms are ${ZOMBIE_TEAM_SIZE}v${ZOMBIE_TEAM_SIZE}, not ${sizeA}v${sizeB}`);
        return false;
    }
    const seats = sides.reduce((all, g) => all.concat(g.members), []);
    if (seats.some(m => !m.ws || m.ws.readyState !== WebSocket.OPEN)) {
        console.warn(`[MATCH REJECTED] a socket closed before the room opened for ${mode}`);
        return false;
    }
    if (new Set(seats.map(m => m.ws)).size !== seats.length) {
        console.warn(`[MATCH REJECTED] the same player was seated twice for ${mode}`);
        return false;
    }
    const matchId = `match_${matchCounter++}`;
    const entries = [];

    sides.forEach((group, sideIndex) => {
        const base = sideIndex * group.members.length;
        group.members.forEach((m, i) => {
            // The queue snapshot is a few seconds old by pairing time, while the
            // live party roster is not — so a member who equipped a different
            // character after the leader queued enters with the new one.
            const team = m.ws && m.ws.teamId ? teams.get(m.ws.teamId) : null;
            const live = team ? team.members.find(x => x.uid === m.playerUid) : null;
            entries.push({
                ws: m.ws,
                uid: m.playerUid || "",
                username: (live && live.username) || m.username || "Player",
                characterId: (live && live.characterId) || m.characterId || 1,
                bundleId: live && live.bundleId !== undefined ? live.bundleId : bundleOf(m),
                teamId: group.teamId || "",
                side: sideIndex,
                spawnIndex: base + i
            });
        });
    });

    const room = {
        players: entries.filter(e => !isBotPeer(e.ws)).map(e => e.ws),
        mode: mode,
        matchId: matchId,
        entries: entries
    };
    for (const e of entries) {
        if (isBotPeer(e.ws)) {
            initBotEntry(room, e);
            e.ws.matchId = matchId;
            e.ws.matchUid = e.uid;
            e.ws.matchSpawnIndex = e.spawnIndex;
        }
    }
    matches.set(matchId, room);
    console.log(`[MATCH FOUND] ${entries.length} bodies in ${matchId} for ${mode} (${sides.map(s => s.teamId || 'solo').join(' vs ')})`);

    for (const self of entries) {
        const enemy = entries.find(e => e.side !== self.side) || null;
        const payload = {
            type: "match_found",
            mode: mode,
            match_id: matchId,
            spawn_index: self.spawnIndex,
            total_players: entries.length,
            team_id: self.teamId,
            team_size: self.side === 0 ? sides[0].members.length : sides[1].members.length,
            players: entries.map(e => ({
                id: mummyIdOf(e),
                player_uid: e.uid,
                username: e.username,
                character_id: e.characterId,
                bundle_id: bundleOf(e),
                spawn_index: e.spawnIndex,
                team_id: e.teamId
            })),
            // Kept for the arena client, which still labels the first enemy it sees.
            opponent: enemy ? {
                character_id: enemy.characterId,
                username: enemy.username,
                player_uid: enemy.uid,
                spawn_index: enemy.spawnIndex
            } : {}
        };
        self.ws.matchId = matchId;
        self.ws.matchSpawnIndex = self.spawnIndex;
        self.ws.matchUid = self.uid;
        sendJson(self.ws, payload);
    }

    if (mode === MUMMY_MODE) initMummyMatch(room);
    else if (mode === ZOMBIE_MODE) initZombieMatch(room);
    return true;
}

// Teams queue as whole groups and only ever meet a group that asked for the
// same mode and the same slot. Sizes are never mixed: a duo can only meet
// another duo, a squad only a squad.
function processTeamQueue(mode) {
    if (!teamQueues[mode]) return;
    let paired = true;
    while (paired) {
        paired = false;
        const q = teamQueues[mode];
        for (let i = 0; i < q.length && !paired; i++) {
            for (let j = i + 1; j < q.length; j++) {
                const a = q[i];
                const b = q[j];
                // Same queue key, same selected slot, and both parties are
                // exactly as large as the slot they asked for. Anything else
                // is a mismatch and must keep waiting.
                if (a.slot !== b.slot) continue;
                if (a.members.length !== a.slot || b.members.length !== b.slot) continue;
                if (!a.members.every(m => queueEntryUsable(m, mode, a.slot))) continue;
                if (!b.members.every(m => queueEntryUsable(m, mode, b.slot))) continue;
                if (!makeRoom(mode, [a, b])) continue;
                q.splice(j, 1);
                q.splice(i, 1);
                paired = true;
                break;
            }
        }
    }
}

function queueTeam(mode, team, slot) {
    const allyUidsOf = (uid) => team.members.filter(m => m.uid !== uid).map(m => m.uid);
    const group = {
        teamId: team.id,
        mode: mode,
        slot: slot,
        teamSize: slot,
        queuedAt: Date.now(),
        members: team.members.map(m => ({
            ws: m.ws,
            mode: mode,
            slot: slot,
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
            player_count: group.members.length,
            required_players: slot * 2
        });
    }
    // Every mode meets a party of the same size: duo v duo, trio v trio, squad v squad.
    processTeamQueue(mode);
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

function broadcastPoolStatus(mode, slot) {
    if (!queues[mode]) return;
    const pool = queues[mode].filter(e => e.slot === slot);
    const required = slot * 2;
    for (const e of pool) {
        sendJson(e.ws, {
            type: "player_joined",
            mode: mode,
            team_size: slot,
            player_count: pool.length,
            required_players: required
        });
    }
}

function broadcastAllPools() {
    for (const mode of Object.keys(queues)) {
        for (const slot of TEAM_SLOTS) broadcastPoolStatus(mode, slot);
    }
}

// Solo searches pool per (mode, slot) and only a full pool of slot * 2 bodies
// starts a room: 1v1 for Solo, 2v2 for Duo, 3v3 for Trio, 4v4 for Squad.
// Everything is re-checked here, immediately before the room is built, so a
// cancel, a disconnect or a mode/slot switch can never leak into a match.
function processSoloQueue(mode) {
    if (!queues[mode]) return;
    for (const slot of TEAM_SLOTS) {
        const need = slot * 2;
        for (let guard = 0; guard < 16; guard++) {
            const ready = queues[mode].filter(e => queueEntryUsable(e, mode, slot));
            if (ready.length < need) break;
            const sockets = new Set(ready.map(e => e.ws));
            if (sockets.size !== ready.length) {
                // The same player queued twice: keep the newest entry only.
                const seen = new Set();
                queues[mode] = queues[mode].filter(e => {
                    if (e.slot !== slot) return true;
                    if (seen.has(e.ws)) return false;
                    seen.add(e.ws);
                    return true;
                });
                continue;
            }
            const group = ready.slice(0, need);
            if (!group.every(e => queueEntryUsable(e, mode, slot))) break;
            const started = makeRoom(mode, [
                { teamId: "", members: group.slice(0, slot) },
                { teamId: "", members: group.slice(slot) }
            ]);
            if (!started) break;
            for (const e of group) {
                const idx = queues[mode].indexOf(e);
                if (idx !== -1) queues[mode].splice(idx, 1);
            }
        }
    }
    broadcastAllPools();
}

// ---- Mummy vs Human: server-authoritative 1v1 / 2v2 / 3v3 / 4v4 match ----
// The clients only report proximity; every role, timer tick, knockdown, revive,
// elimination, point and the final result is decided here so all screens agree.
const MUMMY_MODE = "MUMMY_VS_HUMAN";
// The two teams are the two sides of the arena. A team wins the match, not a
// round, so the point table is indexed by side and every client draws the same
// two names from it.
const MUMMY_TEAM_NAMES = ["TEAM TIGER", "TEAM LION"];
const MUMMY_WIN_POINTS = parseInt(process.env.MUMMY_WIN_POINTS, 10) || 4;
// The knockdown bar: once downed, a Human bleeds this whole HP away over
// MUMMY_DOWN_SECONDS and is eliminated when it empties.
const MUMMY_HP = 400;
const MUMMY_DAMAGE_PER_HIT = 67;  // 6 hits to defeat (6 * 67 = 402, capped at 400)
const MUMMY_DOWN_SECONDS = parseInt(process.env.MUMMY_DOWN_SECONDS, 10) || 30;
const MUMMY_REVIVE_SECONDS = parseInt(process.env.MUMMY_REVIVE_SECONDS, 10) || 5;
const MUMMY_DOWN_MS = MUMMY_DOWN_SECONDS * 1000;
const MUMMY_REVIVE_MS = MUMMY_REVIVE_SECONDS * 1000;
// A reviver stops counting the moment its heartbeats go silent (dropped socket,
// run away, scene quit) instead of leaving a channel frozen at 4/5 seconds.
const MUMMY_REVIVE_HEARTBEAT_MS = 2000;
// The gap that lets a fully-eliminated side be confirmed before the next round.
const MUMMY_BREAK_MS = (parseInt(process.env.MUMMY_BREAK_SECONDS, 10) || 3) * 1000;

// ---- Zombie Infection mode (ZOMBIE_ECLIPSE) ----
// Strictly 4v4. Every round one player on each team wakes as a zombie; one touch
// from a zombie turns any enemy human on the spot, and every turn is +1 on the
// catcher's team counter. A round is exactly two minutes and the higher counter
// takes it; the match is eight rounds and the higher round tally takes the match.
const ZOMBIE_MODE = "ZOMBIE_ECLIPSE";
const ZOMBIE_TEAM_SIZE = 4;
const ZOMBIE_ROUNDS = parseInt(process.env.ZOMBIE_ROUNDS, 10) || 8;
const ZOMBIE_ROUND_MS = (parseInt(process.env.ZOMBIE_ROUND_SECONDS, 10) || 120) * 1000;
const ZOMBIE_BREAK_MS = (parseInt(process.env.ZOMBIE_BREAK_SECONDS, 10) || 5) * 1000;
// Mirrors ATTACK_RANGE in zombie_match.gd: the reach a zombie actually swings.
const ZOMBIE_ATTACK_RANGE = parseFloat(process.env.ZOMBIE_ATTACK_RANGE) || 2.6;
const ZOMBIE_TEAM_NAMES = ["TEAM TIGER", "TEAM LION"];

// ---- AI Bot players ----
// Bots fill a queue only after real players have been waiting long enough and
// only enough of them to complete the match. They are server-side peers: they
// have a socket-like object (readyState, send, matchId, playerUid) so the room
// engine treats them exactly like a remote player, but their movement and
// attacks are driven by the tick below instead of a network frame.
const BOT_NAMES = ["Shadow", "Viper", "Raven", "Ghost", "Frost", "Blaze"];
const BOT_CHARACTERS = [1, 2, 3];
const BOT_BUNDLES = [1, 2];
const BOT_FILL_MS = parseInt(process.env.BOT_FILL_MS, 10) || 20000;   // the wait starts here
const BOT_FILL_JITTER_MS = parseInt(process.env.BOT_FILL_JITTER_MS, 10) || 30000; // ...and lands inside 20-50s
const BOT_TICK_MS = parseInt(process.env.BOT_TICK_MS, 10) || 100;
const BOT_MOVE_BROADCAST_MS = parseInt(process.env.BOT_MOVE_BROADCAST_MS, 10) || 100;
const BOT_ATTACK_COOLDOWN_MS = parseInt(process.env.BOT_ATTACK_COOLDOWN_MS, 10) || 900;
const BOT_WALK_SPEED = parseFloat(process.env.BOT_WALK_SPEED) || 5.0;
const BOT_RUN_SPEED = parseFloat(process.env.BOT_RUN_SPEED) || 7.0;
const BOT_TURN_SPEED = parseFloat(process.env.BOT_TURN_SPEED) || 6.0; // radians/sec
const BOT_ATTACK_RANGE = parseFloat(process.env.BOT_ATTACK_RANGE) || 2.2;
const BOT_FLEE_START = parseFloat(process.env.BOT_FLEE_START) || 6.0;
const BOT_CAUTION_RANGE = parseFloat(process.env.BOT_CAUTION_RANGE) || 12.0;
// The mummy arena needs no radius: its baked table is the boundary, and the
// cells a body can stand in run all the way into the corners (measured out to
// r = 17.2 m), so a radius here could only fence the bot out of ground a real
// player walks. The zombie ring is generated as a disc, so its radius is part
// of the table itself.
const BOT_ARENA_RADIUS_ZOMBIE = parseFloat(process.env.BOT_ARENA_RADIUS_ZOMBIE) || 11.0;
// How much of a height change a body is willing to take as a step. The arena's
// stairs were authored at 0.45 m risers, so 0.5 m up clears them and 0.7 m down
// still refuses the long drop off a deck - which is what keeps a bot from
// "walking off" a floor the server would otherwise have to let it fall through.
const BOT_STEP_UP_M = parseFloat(process.env.BOT_STEP_UP_M) || 0.5;
const BOT_STEP_DOWN_M = parseFloat(process.env.BOT_STEP_DOWN_M) || 0.7;
const BOT_REPATH_MS = parseInt(process.env.BOT_REPATH_MS, 10) || 500;
// A body that commands a step and does not take it should react on the next tick,
// not a second later. The old behaviour - hold the heading until the slow stuck
// check fires, then turn a random way - is what read as "moves but keeps getting
// stuck" on the deployed build, because the coin flip can point at the next wall.
const BOT_BLOCKED_TICKS = parseInt(process.env.BOT_BLOCKED_TICKS, 10) || 2;
const BOT_SIDESTEP_MS = parseInt(process.env.BOT_SIDESTEP_MS, 10) || 700;
// Goal-progress stuck detection: a body sliding along a wall moves in metres
// but not toward what it is aiming at, so displacement alone reads it as
// healthy forever. Every BOT_PROGRESS_MS the distance to the aim point is
// compared with the previous window; two windows without closing it by at
// least BOT_PROGRESS_SLACK_M means the route is not being made and the bot
// repaths from where it stands instead of holding the line against a wall.
const BOT_PROGRESS_MS = parseInt(process.env.BOT_PROGRESS_MS, 10) || 900;
const BOT_PROGRESS_SLACK_M = parseFloat(process.env.BOT_PROGRESS_SLACK_M) || 0.3;
const BOT_FLEE_REACH_M = parseFloat(process.env.BOT_FLEE_REACH_M) || 9.0;
// A bot with nobody to chase and nobody to run from used to stop dead where the
// last body fell: a statue in one corner while the rest of the arena went unused.
// A free bot now walks a patrol leg - a standable cell this far away, reached with
// the same navigator a chase uses - so the whole floor gets used the way a player
// rotating between fights uses it.
const BOT_ROAM_MIN_M = parseFloat(process.env.BOT_ROAM_MIN_M) || 5.0;
const BOT_ROAM_MAX_M = parseFloat(process.env.BOT_ROAM_MAX_M) || 15.0;
const BOT_ROAM_TRIES = parseInt(process.env.BOT_ROAM_TRIES, 10) || 24;
const BOT_ROAM_MS = parseInt(process.env.BOT_ROAM_MS, 10) || 6000;
// One sweep of the largest table, so a route the map does have is never given up
// on. Measured on the mummy arena, a full sweep costs about half a millisecond and
// a bot only ever pays it when its goal changes cell, at most BOT_REPATH_MS apart.
const BOT_PATH_BUDGET = parseInt(process.env.BOT_PATH_BUDGET, 10) || 20000;
// How far a bot's centre keeps from anything the table calls blocked. The bake only
// promised that a 0.60 m body fits at a cell's CENTRE, and a bot's centre can be up
// to half a cell diagonal (0.18 m at this pitch) away from it, so a ring of cells
// has to be clear before a cell is used at all.
// 0.75 m was that ring until it was measured: it fenced the bots out of 1,182 of the
// 6,081 lower-floor cells, left 5 cells of the stair band instead of 37, and the run
// reads as bodies shuffling in the middle of the arena while the rim goes unused. At
// 0.5 m (two rings) the floor keeps 5,291 cells, the stair band keeps 16, and a 0.42 m
// body anywhere in a kept cell is still clear of every obstacle the bake found two
// cells away. It is tunable: BOT_BODY_CLEARANCE_M=0.25 gives back the whole rim.
const BOT_BODY_CLEARANCE_M = parseFloat(process.env.BOT_BODY_CLEARANCE_M) || 0.5;

// ---- Baked arena walkability ----
// mumuy_vs_human.tscn is fifteen trimesh colliders over three floor heights, and
// the Node process has no physics and no copy of that map. So the arena was
// measured with the real colliders - headless, by _arena_bake.gd - and is carried
// here as a table. One character per 0.25 m cell, row 0 at z = -half:
//   ' '  nothing to stand on (the ray found no floor, or the ring's outside)
//   '#'  a body would overlap a wall, a prop or a low ceiling
//   any other printable char  a cell a body can stand in, feet at (code - 48) / 5
// The bake used a body fatter than any player (0.60 m radius against the widest
// body's 0.42 m) so that a bot placed anywhere inside a standable cell - not just
// at its centre - is provably clear of the map.
const BOT_MUMMY_ARENA_ROWS = [
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "######PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "##########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#######PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#######PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "jii####PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "jjiii#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "jiii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "jiii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "jiii#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "iii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "iii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "iii#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "ii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "ii##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "ii#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "i##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "i##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "i##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "#PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPQQQ",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPQQQQQQQQ",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPQQQQQQQQQRRR",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPQQQQQQQQQRRRRRRR",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPQQQQQQQQRRRRRRRRRSSS",
    "PPPPPPPPPPPPPPPPPPPPPPPPP############################################################################",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             ###############################################",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             ###############################################",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             #######t#############################t#########",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             #tttttttttttttttttttttttttttttttttttttttttttttt",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             #tttttttttttttttttttttttttttttttttttttttttttttt",
    "PPPPPPPPPPPPPPPPPPPPPPPP#                             ##ttttttttttttttttttttttttttttttttttttttttttttt",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              ##############################################################",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPPPPPPPPPPPPPPP#              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPPP##############              #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            #kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "PPPPPPPPPP#                            ##############################################################",
    "PPPPPPPPPP#                                                                                          ",
    "PPPPPPPPPP#                                                                                          ",

];
let botCounter = 1;

// Spawn seats measured from the authored arena scenes, so bots start exactly
// where the client places a body with the same spawn_index.
const MUMMY_SPAWN_POINTS = [
    { x: -10.000, y: 6.55, z: 0.000 },
    { x: 9.239, y: 6.55, z: -3.827 },
    { x: -9.239, y: 6.55, z: -3.827 },
    { x: 7.071, y: 6.55, z: -7.071 },
    { x: -7.071, y: 6.55, z: -7.071 },
    { x: 3.827, y: 6.55, z: -9.239 },
    { x: -3.827, y: 6.55, z: -9.239 },
    { x: 0.000, y: 6.55, z: -10.000 }
];
const ZOMBIE_RING_RADIUS = 11.0;
const ZOMBIE_SPAWN_POINTS = [];
for (let i = 0; i < 8; i++) {
    const a = (i * 45) * Math.PI / 180;
    ZOMBIE_SPAWN_POINTS.push({ x: Math.cos(a) * ZOMBIE_RING_RADIUS, y: 1.0, z: Math.sin(a) * ZOMBIE_RING_RADIUS });
}

// ---- Human side ability: Holographic Clones ----
// Which character owns which ability is decided here, not in the client's CATALOG,
// so a tampered message cannot hand a player an ability they never equipped. Keep
// this table and character_manager.gd's CATALOG "ability" rows in step.
const CHARACTER_ABILITIES = { 2: "clone", 3: "aura", 4: "shield" };
const CLONE_COUNT = 2;
const CLONE_LIFETIME_MS = 10000;   // then it fades out on its own
const CLONE_MAX_HITS = 3;          // or a Mummy lands three swings first
const ABILITY_COOLDOWN_MS = 70000;
// Mirrors ATTACK_RANGE in mummy_match.gd: the reach a catcher actually swings.
const MUMMY_ATTACK_RANGE = parseFloat(process.env.MUMMY_ATTACK_RANGE) || 2.6;
// How far either side of the Human's facing a clone stands.
const CLONE_FLANK_METRES = 1.6;
// Clones then walk straight ahead like bots, so they pull the Mummy's swing.
// Both ends use these two numbers: the phone draws the body on this line, and
// the server moves its own copy down the same line, so a swing at what a player
// sees is a swing on the body the server is counting.
const CLONE_WALK_SPEED = 5.0;      // metres per second, straight ahead (a player walks at 5.5)
const CLONE_WALK_LIMIT = 20.0;     // metres from where the clone appeared
// A hologram can only be knocked once this often, however many reports arrive. A
// Mummy standing in a crowd of four Humans used to be able to spend a whole swing
// on one clone per target it reached.
const CLONE_HIT_GAP_MS = 300;
// The green aura also patches its caster up: HP is server-owned, so the trickle is
// counted here over the same 10 seconds the client draws the aura for. 120 of the
// 400 HP bar is roughly two swings' worth, slow enough to read as a heal.
const AURA_HEAL_MS = 10000;
const AURA_HEAL_TOTAL = 120;
// Mirrors aura_radius in green_aura.gd: a teammate standing inside the drawn
// circle gains the same HP trickle (HP only - the speed buff stays on the caster).
const AURA_RADIUS = 4.0;

// ---- Character 4: the green shield ----
// The dome is planted at the point it was cast and never follows its caster. Only the
// caster's own side may stand inside it; anybody else is held on the shell by the
// client, and a swing at a teammate who is inside spends itself on the dome.
// Keep SHIELD_RADIUS in step with `radius` in character4_ability.gd.
const SHIELD_LIFETIME_MS = 15000;
const SHIELD_RADIUS = 3.5;
const SHIELD_CRACK_AT = 8;      // first split opens
const SHIELD_BREAK_AT = 12;     // and the wider one
const SHIELD_DESTROY_AT = 18;   // the dome gives out
// One swing lands on one shell, however many bodies it reached: a catcher standing
// in a crowd of four used to be able to spend a single press on four hits.
const SHIELD_HIT_GAP_MS = 300;

// 1v1 runs three minutes, every team size runs five.
function mummyRoundMs(sideSize) {
    const forced = parseInt(process.env.MUMMY_ROUND_SECONDS, 10) || 0;
    if (forced > 0) return forced * 1000;
    const fromEnv = parseInt(sideSize <= 1 ? process.env.MUMMY_SOLO_ROUND_SECONDS : process.env.MUMMY_TEAM_ROUND_SECONDS, 10) || 0;
    return (fromEnv > 0 ? fromEnv : sideSize <= 1 ? 180 : 300) * 1000;
}

// Rooms are keyed on the profile UID, but a player whose profile has not bound
// yet still occupies exactly one slot, so the spawn index doubles as identity.
function mummyIdOf(entry) {
    return entry.uid !== "" ? String(entry.uid) : `slot_${entry.spawnIndex}`;
}

// The arena only starts once every seat reports the scene loaded. A bot has no
// scene to load - it is born inside the room - so it counts as ready the moment
// the room exists, otherwise the real players would wait on a seat that can
// never answer.
function markBotsReady(room) {
    const g = room.game;
    if (!g || !g.ready) return;
    for (const e of room.entries) {
        if (isBotPeer(e.ws)) g.ready.add(mummyIdOf(e));
    }
}

function initMummyMatch(room) {
    const sideSize = room.entries.filter(e => e.side === 0).length;
    room.game = {
        phase: "waiting",          // waiting -> playing -> round_break -> playing ... -> finished
        ready: new Set(),
        round: 0,
        sideSize: sideSize,
        roundMs: mummyRoundMs(sideSize),
        // One score per team, indexed by side: 0 = TEAM TIGER, 1 = TEAM LION.
        sideScore: [0, 0],
        hunterSide: 0,             // the team hunting this round; it flips every round
        winnerSide: -1,            // -1 while the match is still live
        roles: {},                 // id -> "mummy" | "human"
        combat: {},                // id -> { hp, downed, downedSince, eliminated, scored, reviveMs, revivers }
        settled: false,            // one result per round, however it ends
        roundOutcome: "",
        abilities: {},             // id -> { cooldownUntil } for the equipped character's ability
        swingSeq: {},              // mummy id -> swings so far, so sword/jab alternate on every screen
        clones: {},                // clone id -> { owner, x, y, z, hits, expiresAt }
        cloneSeq: 0,
        shields: {},               // owner id -> { hits, x, y, z, expiresAt, lastHitAt }
        endsAt: 0
    };
    resetMummyCombat(room);
    resetMummyAbilities(room);
    markBotsReady(room);
    broadcastMummyState(room, true);
}

// A fresh round, and the 1v1 respawn, both start from this same table: nobody
// carries bleed-out or revive progress across a round boundary.
function resetMummyCombat(room) {
    const g = room.game;
    g.combat = {};
    for (const e of room.entries) {
        g.combat[mummyIdOf(e)] = {
            hp: MUMMY_HP,
            downed: false,
            downedSince: 0,
            eliminated: false,
            // One player can only ever be paid out once per round, however many
            // times the bleed-out tick, a duplicate report or a reconnect lands
            // on the same elimination.
            scored: false,
            reviveMs: 0,
            reviveAt: 0,
            revivers: {}
        };
    }
}

// A fresh round also clears every clone and restarts every cooldown, so nobody
// carries a distraction or a locked button across a round boundary.
function resetMummyAbilities(room) {
    const g = room.game;
    g.abilities = {};
    g.clones = {};
    g.cloneSeq = 0;
    g.shields = {};
    for (const e of room.entries) {
        g.abilities[mummyIdOf(e)] = { cooldownUntil: 0, healUntil: 0, healAt: 0 };
    }
}

function abilityFor(entry) {
    return CHARACTER_ABILITIES[String(entry.characterId)] || "none";
}

// Ground distance only - the arena is played on one floor and a jump should not
// put a body out of reach.
function flatDistance(a, b) {
    if (!a || !b) return Infinity;
    const dx = Number(a.x) - Number(b.x);
    const dz = Number(a.z) - Number(b.z);
    return Math.sqrt(dx * dx + dz * dz);
}

// Player bodies are circles on that same floor plane, and these are the exact
// radii the arena client draws with (mummy_match.gd). Resolving the positions the
// room relays against them means no phone ever receives two bodies standing in
// each other, which is what keeps the client-side push from having to fight.
const PLAYER_RADIUS_HUMAN = 0.35;
const PLAYER_RADIUS_MUMMY = 0.42;
const PLAYER_COLLISION_SKIN = 0.02;

function playerRadius(room, entry) {
    const g = room.game;
    return (g && g.roles && g.roles[mummyIdOf(entry)] === "mummy")
        ? PLAYER_RADIUS_MUMMY : PLAYER_RADIUS_HUMAN;
}

// A body that is out of the round stops being reported, so its last position is a
// statue. Treating it as solid would hide an invisible wall where a corpse lies.
function collidesInRoom(room, entry) {
    const g = room.game;
    const c = g && g.combat ? g.combat[mummyIdOf(entry)] : null;
    return !(c && c.eliminated);
}

// Slide a reported position out of every other live body in the room. The mover
// yields: it is the only body whose owner can still correct for the move, and the
// others have already been resolved the same way on their own report.
function separateFromRoom(room, mover, x, z) {
    for (const other of room.entries) {
        if (other === mover || !other.pos || !collidesInRoom(room, other)) continue;
        const need = playerRadius(room, mover) + playerRadius(room, other) + PLAYER_COLLISION_SKIN;
        let dx = x - other.pos.x;
        let dz = z - other.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= need) continue;
        if (d < 0.0001) {
            // Dead centre has no direction of its own: step out along +x rather
            // than leaving the two bodies stacked on one metre.
            x += need;
            continue;
        }
        const scale = (need - d) / d;
        x += dx * scale;
        z += dz * scale;
    }
    return { x, z };
}

function clonePayload(g, now) {
    return Object.keys(g.clones).map(id => {
        const c = g.clones[id];
        return {
            id: id,
            owner: c.owner,
            x: c.x,
            y: c.y,
            z: c.z,
            yaw: c.yaw,
            hits: c.hits,
            seconds_left: Math.max(0, Math.ceil((c.expiresAt - now) / 1000))
        };
    });
}

function destroyMummyClones(room, ids) {
    const g = room.game;
    const live = ids.filter(id => !!g.clones[id]);
    if (live.length === 0) return false;
    for (const id of live) delete g.clones[id];
    for (const e of room.entries) {
        sendJson(e.ws, { type: "clone_destroy", match_id: room.matchId, clone_ids: live });
    }
    return true;
}

// A clone belongs to a live Human. Whatever takes that player out - the clock, a
// knockdown, a dropped socket - takes their holograms with it, so the arena never
// keeps a distraction that nobody can still be defending.
function tickMummyClones(room, now) {
    const g = room.game;
    const dead = [];
    for (const id of Object.keys(g.clones)) {
        const c = g.clones[id];
        const state = g.combat[c.owner];
        const stillHere = room.entries.some(e => mummyIdOf(e) === c.owner);
        if (c.expiresAt <= now || !stillHere || !state || state.downed || state.eliminated || g.roles[c.owner] !== "human") {
            dead.push(id);
            continue;
        }
        // Straight ahead, on the heading the clone was placed with - the phone
        // draws the same step, so the two stay on one line.
        const dt = Math.min(0.5, Math.max(0, (now - c.movedAt) / 1000));
        c.movedAt = now;
        const step = Math.min(CLONE_WALK_SPEED * dt, CLONE_WALK_LIMIT - c.walked);
        if (step > 0) {
            c.x -= Math.sin(c.yaw) * step;
            c.z -= Math.cos(c.yaw) * step;
            c.walked += step;
        }
    }
    return destroyMummyClones(room, dead);
}

function activateMummyAbility(room, entry, now) {
    const g = room.game;
    const self = mummyIdOf(entry);
    const kind = abilityFor(entry);
    if (kind === "none") return "none";
    const mine = g.abilities[self] || (g.abilities[self] = { cooldownUntil: 0 });
    if (mine.cooldownUntil > now) return "cooldown";

    // The green aura is a burst on the spot: no body to track, no countdown beyond
    // the cooldown. Everyone is told where it bloomed so the phones agree.
    if (kind === "aura") {
        const at = entry.pos || { x: 0, y: 0, z: 0, yaw: 0 };
        mine.cooldownUntil = now + ABILITY_COOLDOWN_MS;
        // The caster's HP is healed from the server's clock for the aura's whole
        // window, so every screen sees the same green climb instead of each phone
        // inventing its own.
        mine.healUntil = now + AURA_HEAL_MS;
        mine.healAt = now;
        for (const e of room.entries) {
            sendJson(e.ws, {
                type: "ability_spawn",
                match_id: room.matchId,
                player_id: self,
                ability_type: "aura",
                x: Number(at.x),
                y: Number(at.y),
                z: Number(at.z),
                yaw: Number(at.yaw) || 0
            });
        }
        console.log(`[MUMMY] ${self} burst a green aura in ${room.matchId}`);
        return "";
    }

    // The green dome is planted where it was cast and stays there: the centre is
    // stored once, at activation, so a caster who runs off leaves the shell behind
    // for the rest of its 15 seconds.
    if (kind === "shield") {
        const at = entry.pos || { x: 0, y: 0, z: 0, yaw: 0 };
        g.shields[self] = {
            hits: 0,
            lastHitAt: 0,
            expiresAt: now + SHIELD_LIFETIME_MS,
            x: Number(at.x) || 0,
            y: Number(at.y) || 0,
            z: Number(at.z) || 0
        };
        mine.cooldownUntil = now + ABILITY_COOLDOWN_MS;
        for (const e of room.entries) {
            sendJson(e.ws, {
                type: "ability_spawn",
                match_id: room.matchId,
                player_id: self,
                ability_type: "shield",
                x: Number(at.x),
                y: Number(at.y),
                z: Number(at.z),
                yaw: Number(at.yaw) || 0,
                radius: SHIELD_RADIUS,
                duration_ms: SHIELD_LIFETIME_MS,
                destroy_at: SHIELD_DESTROY_AT
            });
        }
        console.log(`[MUMMY] ${self} raised a green shield in ${room.matchId}`);
        return "";
    }

    // The holograms flank the body that cast them, turned the way that body is
    // already facing, so a clone never appears behind a player who has just
    // spun around to run.
    const at = entry.pos || { x: 0, y: 0, z: 0, yaw: 0 };
    const yaw = Number(at.yaw) || 0;
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const created = [];
    for (let i = 0; i < CLONE_COUNT; i++) {
        const side = i === 0 ? 1 : -1;
        const id = `${self}#${g.cloneSeq++}`;
        const clone = {
            owner: self,
            x: Number(at.x) + right.x * CLONE_FLANK_METRES * side,
            y: Number(at.y),
            z: Number(at.z) + right.z * CLONE_FLANK_METRES * side,
            yaw: yaw,
            hits: 0,
            lastHitAt: 0,
            walked: 0,
            movedAt: now,
            expiresAt: now + CLONE_LIFETIME_MS
        };
        g.clones[id] = clone;
        created.push({ id: id, owner: self, x: clone.x, y: clone.y, z: clone.z, yaw: yaw });
    }
    mine.cooldownUntil = now + ABILITY_COOLDOWN_MS;
    for (const e of room.entries) {
        sendJson(e.ws, {
            type: "ability_spawn",
            match_id: room.matchId,
            player_id: self,
            ability_type: "clone",
            clones: created
        });
    }
    console.log(`[MUMMY] ${self} spawned ${created.length} clones in ${room.matchId}`);
    return "";
}

// One swing landed on one hologram. The catcher reports it the same way it
// reports a hit on a body, and the server owns the count to three. A clone can
// only be knocked once every CLONE_HIT_GAP_MS, however many reports arrive, so a
// catcher swinging through a crowd cannot spend one swing on every body it
// reaches.
function landCloneHit(room, cloneId, now) {
    const g = room.game;
    const clone = g.clones[cloneId];
    if (!clone) return false;
    if (now - (clone.lastHitAt || 0) < CLONE_HIT_GAP_MS) return false;
    clone.lastHitAt = now;
    clone.hits += 1;
    for (const e of room.entries) {
        sendJson(e.ws, {
            type: "clone_hit",
            match_id: room.matchId,
            clone_id: cloneId,
            hits: clone.hits,
            hits_left: Math.max(0, CLONE_MAX_HITS - clone.hits)
        });
    }
    if (clone.hits >= CLONE_MAX_HITS) destroyMummyClones(room, [cloneId]);
    return true;
}

// The closest hologram within reach, and only if it really is closer than the
// Human the swing was aimed at - that gap is the entire distraction.
function cloneAbsorbing(room, fromPos, humanPos) {
    const g = room.game;
    const humanDistance = flatDistance(fromPos, humanPos);
    let bestId = "";
    let bestDistance = humanDistance;
    for (const id of Object.keys(g.clones)) {
        const d = flatDistance(fromPos, g.clones[id]);
        if (d <= MUMMY_ATTACK_RANGE && d < bestDistance) {
            bestDistance = d;
            bestId = id;
        }
    }
    return bestId;
}

// ---- Character 4: the green shield ----
// One dome per caster, keyed by that caster, and it does not move: the centre was
// recorded when the cast went off, so the shell stays where it was raised even if
// the caster runs away from it.
function shieldCenter(room, ownerId) {
    const s = room.game.shields[ownerId];
    return s ? { x: s.x, y: s.y, z: s.z } : null;
}

function shieldStage(hits) {
    if (hits >= SHIELD_DESTROY_AT) return 3;
    if (hits >= SHIELD_BREAK_AT) return 2;
    if (hits >= SHIELD_CRACK_AT) return 1;
    return 0;
}

function shieldPayload(room, now) {
    const g = room.game;
    return Object.keys(g.shields).map(owner => {
        const s = g.shields[owner];
        return {
            owner: owner,
            hits: s.hits,
            stage: shieldStage(s.hits),
            seconds_left: Math.max(0, Math.ceil((s.expiresAt - now) / 1000)),
            x: s.x,
            y: s.y,
            z: s.z
        };
    });
}

function destroyMummyShields(room, owners) {
    const g = room.game;
    const live = owners.filter(o => !!g.shields[o]);
    if (live.length === 0) return false;
    for (const owner of live) {
        delete g.shields[owner];
        for (const e of room.entries) {
            sendJson(e.ws, { type: "shield_destroy", match_id: room.matchId, owner_id: owner });
        }
    }
    return true;
}

// A dome belongs to its caster's team while that caster is still standing in the
// round. Whatever takes the caster out - the clock, a knockdown, a dropped socket -
// takes the dome with it, exactly as it takes a Human's holograms.
function tickMummyShields(room, now) {
    const g = room.game;
    const dead = [];
    for (const owner of Object.keys(g.shields)) {
        const s = g.shields[owner];
        const state = g.combat[owner];
        const stillHere = room.entries.some(e => mummyIdOf(e) === owner);
        if (s.expiresAt <= now || !stillHere || !state
            || state.downed || state.eliminated || g.roles[owner] !== "human") {
            dead.push(owner);
        }
    }
    return destroyMummyShields(room, dead);
}

// The dome that covers `targetId`: it has to be the target's own team's shield, and
// the target has to be inside its footprint. A catcher standing inside a dome is
// not protected by it - the shell only ever guards the team that raised it.
function shieldCovering(room, targetId) {
    const g = room.game;
    const target = room.entries.find(e => mummyIdOf(e) === targetId);
    if (!target || !target.pos) return "";
    for (const owner of Object.keys(g.shields)) {
        const holder = room.entries.find(e => mummyIdOf(e) === owner);
        if (!holder || holder.side !== target.side) continue;
        const centre = shieldCenter(room, owner);
        if (!centre) continue;
        if (flatDistance(centre, target.pos) <= SHIELD_RADIUS) return owner;
    }
    return "";
}

// One swing landed on one shell. The count is the server's, and the stage it reports
// is the only thing the cracks are drawn from, so all eight phones crack in step.
function landShieldHit(room, ownerId, now) {
    const g = room.game;
    const s = g.shields[ownerId];
    if (!s) return false;
    if (now - (s.lastHitAt || 0) < SHIELD_HIT_GAP_MS) return false;
    s.lastHitAt = now;
    s.hits += 1;
    for (const e of room.entries) {
        sendJson(e.ws, {
            type: "shield_hit",
            match_id: room.matchId,
            owner_id: ownerId,
            hits: s.hits,
            stage: shieldStage(s.hits),
            hits_left: Math.max(0, SHIELD_DESTROY_AT - s.hits)
        });
    }
    if (s.hits >= SHIELD_DESTROY_AT) destroyMummyShields(room, [ownerId]);
    return true;
}

// ---- Knockdown state, all of it decided here ----
function mummyHumanIds(room) {
    const g = room.game;
    return room.entries.map(mummyIdOf).filter(id => g.roles[id] === "human");
}

function mummyAlive(room, id) {
    const c = room.game.combat[id];
    return !!c && !c.eliminated;
}

// A downed Human is still in the round: the 30-second knockdown HP has to empty
// before the elimination is real, and a teammate can still channel a revive.
function downMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || c.downed || c.eliminated) return false;
    c.downed = true;
    c.downedSince = Date.now();
    c.hp = MUMMY_HP;
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    return true;
}

function reviveMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || !c.downed) return false;
    c.downed = false;
    c.downedSince = 0;
    c.hp = MUMMY_HP;
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    return true;
}

function eliminateMummyPlayer(room, id) {
    const c = room.game.combat[id];
    if (!c || c.eliminated) return false;
    c.downed = false;
    c.downedSince = 0;
    c.eliminated = true;
    c.hp = 0;
    c.reviveMs = 0;
    c.reviveAt = 0;
    c.revivers = {};
    // The elimination is the point: whoever went out hands a point to the team on
    // the other side of the arena, which is the team that put them there.
    awardMummyPoint(room, id);
    return true;
}

// ---- Points, and only ever one per elimination ----
// A team is a side, so the hunting side and the hunted side are always opposed:
// a point can never be paid to the eliminated player's own team, and a point can
// never be paid twice for the same body.
function awardMummyPoint(room, victimId) {
    const g = room.game;
    // Only a live round pays. A drop-out during the countdown between rounds is
    // still an exit from that round, but it must not buy a point nobody fought for.
    if (!g || g.phase !== "playing") return false;

    const c = g.combat[victimId];
    if (c && c.scored) return false;

    const entry = room.entries.find(e => mummyIdOf(e) === victimId);
    if (!entry) return false;

    if (c) c.scored = true;
    const scorer = 1 - entry.side;
    g.sideScore[scorer] += 1;
    console.log(`[MUMMY] ${MUMMY_TEAM_NAMES[scorer]} +1 (${victimId} out) -> TIGER ${g.sideScore[0]} - LION ${g.sideScore[1]}`);

    if (g.sideScore[scorer] >= MUMMY_WIN_POINTS) {
        endMummyMatch(room, scorer);
    } else {
        // Instant: every phone gets the new score on the same tick it happened.
        broadcastMummyState(room, true);
    }
    return true;
}

// The match stops where it is: no clock, no further scoring, and the sockets are
// released so the same players can queue a new match without clearing anything.
// The grace window for a dropped player just closed. If any entry is still
// marked gone the match cannot wait for it any longer; the other side takes it
// outright, the same as a walk-out.
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

function endMummyMatch(room, winningSide) {
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
            if (c.reviveAt > 0) c.reviveMs += now - c.reviveAt;
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

    // Bots start every round back on their spawn seat, so a round break cannot
    // leave them standing where the last round ended.
    resetBotPositions(room);

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
            cooldown_ms: ABILITY_COOLDOWN_MS,
            // How long this character's cast stands for, and what it takes to end it.
            duration_ms: abilityFor(self) === "shield" ? SHIELD_LIFETIME_MS : CLONE_LIFETIME_MS,
            hits_to_destroy: abilityFor(self) === "shield" ? SHIELD_DESTROY_AT : CLONE_MAX_HITS
        },
        // Every client rebuilds the holograms from this list, so a spawn or a
        // destroy that lands on one phone and not another self-corrects.
        clones: clonePayload(g, now),
        // Same idea for the green domes, one per caster, with the swing count that
        // draws their cracks.
        shields: shieldPayload(room, now),
        players: room.entries.map(e => {
            const id = mummyIdOf(e);
            const c = g.combat[id] || { hp: MUMMY_HP, downed: false, eliminated: false, reviveMs: 0, revivers: {} };
            const downLeft = c.downed ? Math.max(0, Math.ceil((c.downedSince + MUMMY_DOWN_MS - now) / 1000)) : 0;
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
    markBotsReady(room);
    broadcastZombieState(room, true);
}

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
    resetBotPositions(room);
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

// ==========================================
// 2.5 BOT AI
// ==========================================
// One 10 Hz pass over every live room. Each bot body runs a tiny state machine
// (hunt, flee, or hold ground) and steps itself with the same metres-per-second
// the arena uses, so the positions the room relays are continuous rather than
// teleporting. Movement is resolved against the baked arena table above - the
// same walls, props and floor heights the phones' physics engines are standing
// in - so a bot cannot cross a wall, climb a sheer step or sink through a deck,
// and every screen agrees on where it went.
function buildArena(rows, cell, half) {
    return { cell: cell, half: half, n: rows.length, rows: rows, scratch: null };
}

// The night-city arena is one flat floor with every map body taken out of the
// space on purpose, exactly as zombie_match.gd does to the props on every phone.
// Measured the same way as the mummy arena (a body-sized probe at a 2 m pitch out
// to 60 m): nothing solid, feet at y = 0, so its table is generated rather than
// pasted. The ring's outside is void, which is what bounds the mode.
function buildFlatArena(cell, half, feetY, radius) {
    const n = Math.round((half * 2) / cell) + 1;
    const code = String.fromCharCode(48 + Math.round(feetY * 5));
    const rows = [];
    for (let r = 0; r < n; r++) {
        const z = -half + r * cell;
        let row = "";
        for (let c = 0; c < n; c++) {
            const x = -half + c * cell;
            row += x * x + z * z <= radius * radius ? code : " ";
        }
        rows.push(row);
    }
    return buildArena(rows, cell, half);
}

// The baked table guarantees a body fits at a cell's centre, but a bot's centre can
// be anywhere in that cell, and on a wall's edge that is not the clearance the
// phone's model needs. This shaves the rim: a cell stays only while the ground
// around it is unbroken for the full clearance. Only cells are removed, never
// invented, so the baked rows stay the measured truth and everything that is left
// is floor the arena really has, with room around it to stand on.
function standableCell(arena, r, c) {
    if (r < 0 || c < 0 || r >= arena.n || c >= arena.n) return false;
    return arena.rows[r].charCodeAt(c) >= 48;
}

function erodeArena(arena, metres) {
    const rings = Math.max(0, Math.round(metres / arena.cell));
    if (!rings) return arena;
    let baked = 0;
    for (let r = 0; r < arena.n; r++) {
        for (let c = 0; c < arena.n; c++) {
            if (standableCell(arena, r, c)) baked++;
        }
    }
    const rows = [];
    for (let r = 0; r < arena.n; r++) {
        let row = "";
        for (let c = 0; c < arena.n; c++) {
            let keep = standableCell(arena, r, c);
            for (let dr = -rings; dr <= rings && keep; dr++) {
                for (let dc = -rings; dc <= rings && keep; dc++) {
                    keep = standableCell(arena, r + dr, c + dc);
                }
            }
            row += keep ? arena.rows[r][c] : " ";
        }
        rows.push(row);
    }
    const eroded = buildArena(rows, arena.cell, arena.half);
    eroded.baked = { standable: baked };
    eroded.clearance = metres;
    return eroded;
}

const BOT_ARENA_MUMMY = erodeArena(buildArena(BOT_MUMMY_ARENA_ROWS, 0.25, 12.5), BOT_BODY_CLEARANCE_M);
const BOT_ARENA_ZOMBIE = erodeArena(buildFlatArena(0.5, 13.0, 0.0, BOT_ARENA_RADIUS_ZOMBIE), BOT_BODY_CLEARANCE_M);

// A pasted table that does not cover the extent it claims would silently turn the
// arena into a wall, so the shape is checked at boot and said out loud.
function checkArena(arena, name) {
    const span = (arena.n - 1) * arena.cell;
    let standable = 0;
    for (let r = 0; r < arena.n; r++) {
        for (let c = 0; c < arena.n; c++) {
            if (arena.rows[r].charCodeAt(c) >= 48) standable++;
        }
    }
    const ok = Math.abs(span - arena.half * 2) < 0.001 && arena.rows.every(row => row.length === arena.n) && standable > 0;
    // Standable is not the same as reachable. A clearance ring that is too wide, or
    // a table that lost a stairway, both leave cells a body can never walk to, and
    // that is exactly the "bots only use the middle of the map" report - so the boot
    // line says how much of the floor the piece its centre stands on actually covers.
    const n = arena.n;
    const pieces = arenaPieces(arena);
    let middle = -1;
    let bestD = Infinity;
    for (let i = 0; i < n * n; i++) {
        const feet = botCellFeet(arena, i);
        if (feet === null) continue;
        const r = (i / n) | 0;
        const c = i % n;
        const x = -arena.half + c * arena.cell;
        const z = -arena.half + r * arena.cell;
        const d = x * x + z * z;
        if (d < bestD) { bestD = d; middle = i; }
    }
    const home = middle < 0 ? -1 : pieces.ids[middle];
    let reachable = 0;
    for (let i = 0; i < pieces.ids.length; i++) {
        if (pieces.ids[i] === home) reachable++;
    }
    const cut = arena.baked ? ` (the baked table had ${arena.baked.standable})` : "";
    console.log(`[ARENA] ${name} walkability: ${arena.n}x${arena.n} cells at ${arena.cell} m, ` +
        `${standable} standable keeping ${arena.clearance || 0} m clear of the map${cut}` +
        `, ${reachable} of them on the piece of ground its middle stands on, in ${pieces.count} piece${pieces.count === 1 ? "" : "s"}` +
        `${reachable < standable ? ` (${standable - reachable} sit behind ground no body can cross - the upper deck is one of them)` : ""}` +
        `${ok ? "" : " - TABLE MISMATCH"}`);
    if (!ok) console.error(`[ARENA] ${name} walkability table is not usable: span ${span} vs ${arena.half * 2}`);
    return ok;
}

function arenaFor(mode) {
    return mode === ZOMBIE_MODE ? BOT_ARENA_ZOMBIE : BOT_ARENA_MUMMY;
}

// -1 when the point is off the table entirely.
function botCellAt(arena, x, z) {
    const c = Math.floor((x + arena.half) / arena.cell);
    const r = Math.floor((z + arena.half) / arena.cell);
    if (c < 0 || r < 0 || c >= arena.n || r >= arena.n) return -1;
    return r * arena.n + c;
}

// Feet height of a standable cell, or null for a wall, a prop or thin air.
function botCellFeet(arena, idx) {
    if (idx < 0) return null;
    const code = arena.rows[(idx / arena.n) | 0].charCodeAt(idx % arena.n);
    return code >= 48 ? (code - 48) / 5 : null;
}

function botCellCentre(arena, idx) {
    const r = (idx / arena.n) | 0;
    const c = idx % arena.n;
    return { x: -arena.half + c * arena.cell + arena.cell / 2, z: -arena.half + r * arena.cell + arena.cell / 2 };
}

function botFeetAt(arena, x, z) {
    return botCellFeet(arena, botCellAt(arena, x, z));
}

// The floor is not one piece. The upper deck of the measured arena is standable
// ground that no stair reaches, and a strip of the rim cut by the clearance ring
// can be another, so a search across the whole table fails for a body standing
// anywhere else. Labelling the pieces once - with the same step rules a walk uses
// - lets a patrol pick a leg it can actually get to instead of setting off for an
// island, reaching the edge of its own ground, and standing there while the match
// plays out behind it.
function arenaPieces(arena) {
    if (arena.pieces) return arena.pieces;
    const n = arena.n;
    const ids = new Int32Array(n * n).fill(-1);
    const stack = [];
    let piece = 0;
    for (let start = 0; start < ids.length; start++) {
        if (ids[start] !== -1 || botCellFeet(arena, start) === null) continue;
        ids[start] = piece;
        stack.push(start);
        while (stack.length) {
            const cur = stack.pop();
            const cf = botCellFeet(arena, cur);
            const r = (cur / n) | 0;
            const c = cur % n;
            const around = [r > 0 ? cur - n : -1, r < n - 1 ? cur + n : -1,
                c > 0 ? cur - 1 : -1, c < n - 1 ? cur + 1 : -1];
            for (const nb of around) {
                if (nb < 0 || ids[nb] !== -1) continue;
                const nf = botCellFeet(arena, nb);
                if (nf === null || nf - cf > BOT_STEP_UP_M || cf - nf > BOT_STEP_DOWN_M) continue;
                ids[nb] = piece;
                stack.push(nb);
            }
        }
        piece++;
    }
    arena.pieces = { ids: ids, count: piece };
    return arena.pieces;
}

function arenaPieceAt(arena, idx) {
    if (idx < 0) return -1;
    return arenaPieces(arena).ids[idx];
}

// Enterable means the cell stands a body up at all AND the change of floor from
// where the body is now is a step, not a climb or a drop. The second half is what
// keeps a bot on its own level of the arena instead of walking off a deck.
function botCellEnterable(arena, fromY, idx) {
    const feet = botCellFeet(arena, idx);
    if (feet === null) return false;
    if (fromY === null || fromY === undefined) return true;
    return feet - fromY <= BOT_STEP_UP_M && fromY - feet <= BOT_STEP_DOWN_M;
}

function botPointEnterable(arena, fromY, x, z) {
    return botCellEnterable(arena, fromY, botCellAt(arena, x, z));
}

function botSegmentClear(arena, ax, az, ay, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.ceil(Math.sqrt(dx * dx + dz * dz) / (arena.cell * 0.5));
    if (steps <= 0) return true;
    const sx = dx / steps;
    const sz = dz / steps;
    let x = ax;
    let z = az;
    let start = botCellAt(arena, x, z);
    let prevR = start < 0 ? -1 : (start / arena.n) | 0;
    let prevC = start < 0 ? -1 : start % arena.n;
    for (let i = 1; i <= steps; i++) {
        x += sx;
        z += sz;
        const idx = botCellAt(arena, x, z);
        if (!botCellEnterable(arena, ay, idx)) return false;
        const r = (idx / arena.n) | 0;
        const c = idx % arena.n;
        // Crossing into a new row and a new column at once means the line went
        // through the corner between four cells; the two that share an edge with
        // it have to be clear too, or a body clips the point of a wall.
        if (r !== prevR && c !== prevC) {
            if (!botCellEnterable(arena, ay, prevR * arena.n + c)) return false;
            if (!botCellEnterable(arena, ay, r * arena.n + prevC)) return false;
        }
        prevR = r;
        prevC = c;
    }
    return true;
}

function botLineClear(arena, from, to) {
    return botSegmentClear(arena, from.x, from.z, from.y, to.x, to.z);
}

// The raycast of the grid world: a commanded step is walked half a cell at a
// time and ends at the last point the table says a body fits - the spot in
// front of a wall, never a point past it. A destination-only check can stride
// over a thin wall at run speed (7 m/s covers 0.7 m, almost three cells, in one
// tick); walking the line cannot, at any speed. The table itself was measured
// with capsule probes against the arena's real physics colliders, so this walk
// is the runtime half of that collision detection.
function botStepTo(arena, fromY, fromX, fromZ, toX, toZ) {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / (arena.cell * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    let x = fromX;
    let z = fromZ;
    let prev = { x: fromX, z: fromZ };
    let start = botCellAt(arena, fromX, fromZ);
    let prevR = start < 0 ? -1 : (start / arena.n) | 0;
    let prevC = start < 0 ? -1 : start % arena.n;
    for (let i = 1; i <= steps; i++) {
        x += sx;
        z += sz;
        const idx = botCellAt(arena, x, z);
        if (!botCellEnterable(arena, fromY, idx)) return prev;
        const r = (idx / arena.n) | 0;
        const c = idx % arena.n;
        // Crossing a row and a column at once means the line went through the
        // corner between four cells; the two sharing an edge with it have to be
        // clear too, or a body clips the point of a wall.
        if (r !== prevR && c !== prevC) {
            if (!botCellEnterable(arena, fromY, prevR * arena.n + c)) return prev;
            if (!botCellEnterable(arena, fromY, r * arena.n + prevC)) return prev;
        }
        prevR = r;
        prevC = c;
        prev = { x: x, z: z };
    }
    return { x: toX, z: toZ };
}

// A goal along a heading that a body can actually stand on: start at the far end
// and come back, because the open ground is usually in front of the body rather
// than two metres short of it.
function botStandableAhead(arena, pos, yaw, reach) {
    for (let d = reach; d >= 1.0; d -= arena.cell * 2) {
        const x = pos.x + Math.sin(yaw) * d;
        const z = pos.z + Math.cos(yaw) * d;
        if (botPointEnterable(arena, pos.y, x, z)) return { x: x, z: z };
    }
    return { x: pos.x + Math.sin(yaw), z: pos.z + Math.cos(yaw) };
}

// A goal that is not standable - a player who has climbed a crate - is answered
// with the closest cell that is, so the body next to them is reachable.
function botNearestStandableCell(arena, x, z) {
    const idx = botCellAt(arena, x, z);
    if (botCellFeet(arena, idx) !== null) return idx;
    const c0 = idx < 0 ? Math.round((x + arena.half) / arena.cell) : idx % arena.n;
    const r0 = idx < 0 ? Math.round((z + arena.half) / arena.cell) : (idx / arena.n) | 0;
    for (let ring = 1; ring <= 6; ring++) {
        for (let dr = -ring; dr <= ring; dr++) {
            for (let dc = -ring; dc <= ring; dc++) {
                if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
                const r = r0 + dr;
                const c = c0 + dc;
                if (r < 0 || c < 0 || r >= arena.n || c >= arena.n) continue;
                const nb = r * arena.n + c;
                if (botCellFeet(arena, nb) !== null) return nb;
            }
        }
    }
    return -1;
}

// One set of search buffers per arena, made at boot. The AI is single-threaded,
// so two searches can never overlap, and `seen` carries a generation stamp
// instead of being cleared - a repath touches the cells it walks, not 10,000.
function arenaScratch(arena) {
    if (!arena.scratch) {
        const cells = arena.n * arena.n;
        arena.scratch = {
            prev: new Int32Array(cells),
            seen: new Int32Array(cells),
            queue: new Int32Array(cells),
            gen: 0
        };
    }
    return arena.scratch;
}

function botReadPath(arena, s, goalIdx) {
    const cells = [];
    let idx = goalIdx;
    while (idx >= 0) {
        cells.push(idx);
        idx = s.prev[idx];
    }
    cells.reverse();
    const pts = [];
    // The first cell is where the body already stands, so it is not a waypoint.
    for (let i = 1; i < cells.length; i++) pts.push(botCellCentre(arena, cells[i]));
    if (!pts.length) return pts;
    // A stairway of cell centres walks like a robot. Each kept point is thrown
    // away when the body can see past it to the next, which turns a staircase of
    // waypoints into the two or three corners a player would actually turn.
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
        const top = Math.min(pts.length - 1, i + 10);
        let j = top;
        while (j > i + 1 && !botSegmentClear(arena, pts[i].x, pts[i].z,
            botCellFeet(arena, botCellAt(arena, pts[i].x, pts[i].z)), pts[j].x, pts[j].z)) j--;
        out.push(pts[j]);
        i = j;
    }
    return out;
}

// Returns the smoothed waypoint list to the goal, or - when no walkable route
// to it exists, the arena's levels being what they are - the waypoint list to
// the explored cell nearest the goal, flagged partial. Walking to the edge of
// the reachable world and stopping beats the old answer (null, then a straight
// walk into the wall in front of the goal forever).
function botPathCells(arena, startIdx, goalIdx) {
    if (startIdx < 0 || goalIdx < 0 || startIdx === goalIdx) return null;
    const s = arenaScratch(arena);
    const n = arena.n;
    s.gen++;
    const gen = s.gen;
    s.seen[startIdx] = gen;
    s.prev[startIdx] = -1;
    let head = 0;
    let tail = 0;
    let expanded = 0;
    const goalC = botCellCentre(arena, goalIdx);
    let bestIdx = startIdx;
    let bestD = Infinity;
    s.queue[tail++] = startIdx;
    while (head < tail && expanded < BOT_PATH_BUDGET) {
        const cur = s.queue[head++];
        if (cur === goalIdx) return { pts: botReadPath(arena, s, cur), partial: false };
        expanded++;
        const curC = botCellCentre(arena, cur);
        const d = (curC.x - goalC.x) * (curC.x - goalC.x) + (curC.z - goalC.z) * (curC.z - goalC.z);
        if (d < bestD) {
            bestD = d;
            bestIdx = cur;
        }
        const cf = botCellFeet(arena, cur);
        const r = (cur / n) | 0;
        const c = cur % n;
        for (let k = 0; k < 4; k++) {
            const nr = r + (k === 0 ? -1 : k === 1 ? 1 : 0);
            const nc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
            if (nr < 0 || nc < 0 || nr >= n || nc >= n) continue;
            const nb = nr * n + nc;
            if (s.seen[nb] === gen) continue;
            const nf = botCellFeet(arena, nb);
            if (nf === null) continue;
            if (nf - cf > BOT_STEP_UP_M || cf - nf > BOT_STEP_DOWN_M) continue;
            s.seen[nb] = gen;
            s.prev[nb] = cur;
            s.queue[tail++] = nb;
        }
    }
    if (bestIdx !== startIdx) return { pts: botReadPath(arena, s, bestIdx), partial: true };
    return null;
}

// The heading for this tick on the way to `goal`: straight at it when the baked
// arena says the line is clear, otherwise along the shortest walkable way around
// what is standing in it. A path is rebuilt when the goal moves to another cell
// or the cached one ages out, so a chase normally costs one line test per tick.
// A waypoint the body cannot walk - it was pushed off the smoothed line by
// another body, or the leg crosses a corner the step-walk refuses - is skipped
// for the next one instead of being rammed, and a goal with no route at all
// (the arena's deck is a separate level) is answered by walking to the nearest
// cell the search proved reachable and stopping there, facing the goal.
function botNavigatedYaw(room, entry, goal, now) {
    const arena = arenaFor(room.mode);
    const pos = entry.pos;
    const b = entry.bot;
    b.reachedPartial = false;
    if (botLineClear(arena, pos, goal)) {
        b.path = null;
        b.pathGoal = -1;
        b.pathPartial = false;
        botAimAt(b, { x: goal.x, z: goal.z }, pos, now);
        return botYawTowards(pos, goal);
    }
    const goalIdx = botNearestStandableCell(arena, goal.x, goal.z);
    if (goalIdx >= 0 && (goalIdx !== b.pathGoal || !b.path || now >= b.nextPathAt)) {
        const res = botPathCells(arena, botCellAt(arena, pos.x, pos.z), goalIdx);
        b.path = res ? res.pts : null;
        b.pathPartial = !!(res && res.partial);
        b.partialEnd = res && res.partial && res.pts.length ? res.pts[res.pts.length - 1] : null;
        b.pathIndex = 0;
        b.pathGoal = goalIdx;
        b.nextPathAt = now + BOT_REPATH_MS;
    }
    if (b.path && b.path.length) {
        while (b.pathIndex < b.path.length - 1 && flatDistance(pos, b.path[b.pathIndex]) < 0.45) {
            b.pathIndex++;
        }
        while (b.pathIndex < b.path.length - 1 && !botSegmentClear(arena, pos.x, pos.z, pos.y,
            b.path[b.pathIndex].x, b.path[b.pathIndex].z)) {
            b.pathIndex++;
        }
        if (b.pathIndex < b.path.length) {
            const wp = b.path[b.pathIndex];
            if (b.pathPartial && b.pathIndex === b.path.length - 1 && flatDistance(pos, wp) < 0.9) {
                // Standing at the edge of the reachable world: hold this spot and
                // face the goal rather than grinding into the wall before it.
                b.path = null;
                b.reachedPartial = true;
                botAimAt(b, { x: goal.x, z: goal.z }, pos, now);
                return botYawTowards(pos, goal);
            }
            botAimAt(b, { x: wp.x, z: wp.z }, pos, now);
            return botYawTowards(pos, wp);
        }
        b.path = null;
    }
    // No route at all right now. The last search's edge point, if there was
    // one, is the best walkable answer; only a goal with no standable cell at
    // all falls back to the raw heading.
    if (b.partialEnd && flatDistance(pos, b.partialEnd) > 0.9) {
        botAimAt(b, { x: b.partialEnd.x, z: b.partialEnd.z }, pos, now);
        return botYawTowards(pos, b.partialEnd);
    }
    b.reachedPartial = true;
    botAimAt(b, { x: goal.x, z: goal.z }, pos, now);
    return botYawTowards(pos, goal);
}

// The point progress-stuck detection measures against, updated whenever the
// nav hands out a new aim: the baseline distance restarts so a turn to a new
// waypoint cannot read as "no progress" against the previous one.
function botAimAt(b, point, pos, now) {
    if (!b.aim || Math.abs(b.aim.x - point.x) + Math.abs(b.aim.z - point.z) > 0.01) {
        b.aim = point;
        b.aimAt = now;
        b.progressDist = -1;
        b.noProgress = 0;
    } else {
        b.aimAt = now;
    }
}

function botYawTowards(fromPos, toPos) {
    return Math.atan2(toPos.x - fromPos.x, toPos.z - fromPos.z);
}

function botAngleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

// A body that only ever travels at exactly one speed along exactly one line is
// the walk that gives a bot away. Both costs are a multiply and an add.
function botPace(b, speed) {
    return speed * b.speedMul;
}

function botDrift(b, yaw) {
    b.wobble += (Math.random() - 0.5) * 0.12;
    if (b.wobble > 0.3) b.wobble = 0.3;
    else if (b.wobble < -0.3) b.wobble = -0.3;
    return yaw + b.wobble;
}

function botBodyAlive(room, id) {
    const g = room.game;
    if (!g) return false;
    if (g.kind === "zombie") return true;
    const c = g.combat[id];
    return !!c && !c.downed && !c.eliminated;
}

// A body the phone has never reported a position for still occupies its spawn
// seat, so it is seeded here rather than skipped: a mummy bot that could not see
// a motionless human would stand next to them forever.
function botNearest(room, entry, predicate) {
    let best = null;
    let bestDistance = Infinity;
    for (const other of room.entries) {
        if (other === entry || !predicate(other)) continue;
        const target = botPositionOf(room, other);
        if (!target) continue;
        const d = flatDistance(entry.pos, target);
        if (d < bestDistance) {
            bestDistance = d;
            best = other;
        }
    }
    return best ? { entry: best, distance: bestDistance } : null;
}

// A real player who has never sent a movement frame has no server-side position
// yet, so a bot aiming at them uses their spawn seat rather than the origin.
function botPositionOf(room, entry) {
    if (entry.pos) return entry.pos;
    if (!isBotPeer(entry.ws)) {
        entry.pos = Object.assign({}, spawnPointFor(room.mode, entry.spawnIndex));
    }
    return entry.pos;
}

// How far a heading has ground under it, in metres, sampled on the table and
// capped at a body's turn: the bot does not need to see the whole arena, only
// which of its two shoulders is not a wall.
function botGroundAhead(arena, pos, yaw) {
    const probe = arena.cell * 2;
    let clear = 0;
    for (let d = probe; d <= 3.0; d += probe) {
        if (!botPointEnterable(arena, pos.y, pos.x + Math.sin(yaw) * d, pos.z + Math.cos(yaw) * d)) break;
        clear = d;
    }
    return clear;
}

// Which way to turn when the body stops going: the shoulder with more clear ground,
// so it goes round the obstacle instead of guessing at the next wall. Both shut is a
// pocket, and out of a pocket the only way is back the way it came.
function botOpenSide(arena, pos, yaw, b) {
    const left = botGroundAhead(arena, pos, yaw - Math.PI / 2);
    const right = botGroundAhead(arena, pos, yaw + Math.PI / 2);
    if (!left && !right) return Math.PI;
    if (left !== right) return right > left ? Math.PI / 2 : -Math.PI / 2;
    return (b.unstickSide >= 0 ? -1 : 1) * Math.PI / 2;
}

function botSteer(room, entry, desiredYaw, speed, dt, now) {
    const pos = entry.pos;
    const b = entry.bot;
    const arena = arenaFor(room.mode);
    // The mummy arena's boundary is its baked table (the step-walk refuses
    // every cell past it), so only the generated zombie disc needs a radius.
    const radius = room.mode === ZOMBIE_MODE ? BOT_ARENA_RADIUS_ZOMBIE : Infinity;
    const inside = (x, z) => x * x + z * z <= radius * radius;

    // The floor the body is really standing on, straight off the table. Every
    // height test below compares a candidate against this rather than against a
    // y that may have been set by a push or by a spawn marker.
    const home = botFeetAt(arena, pos.x, pos.z);
    const wasX = pos.x;
    const wasZ = pos.z;
    let stalled = false;

    let want = desiredYaw;
    // A body whose detour window is still open walks the beside-line it chose when
    // the map stopped it, the wall-turn a player makes without thinking about it.
    if (speed > 0 && now < b.unstickUntil) want += b.unstickSide;

    const delta = botAngleDelta(pos.yaw || 0, want);
    // A body on an open detour turns at twice the running rate. The ease is what a
    // straight line needs; against a wall it is the difference between a slide and
    // half a second of feet that go nowhere, which is the pause a phone reads as
    // the bot giving up on the chase.
    const maxTurn = BOT_TURN_SPEED * dt * (now < b.unstickUntil ? 2 : 1);
    const turn = Math.abs(delta) < maxTurn ? delta : Math.sign(delta) * maxTurn;
    const yaw = (pos.yaw || 0) + turn;

    const step = speed * dt;
    let nx = pos.x;
    let nz = pos.z;

    // The commanded step is walked half a cell at a time and ends at the last
    // point the table says a body fits: the spot in front of a wall, never a point
    // past it. Refusing the whole step instead - which is what a destination-only
    // check does - is the freeze a phone sees on a body pressed along a wall face:
    // it loses that tick's metres outright, loses the next two as well, and then
    // the stuck handling throws the route away and turns around. Walking the line
    // keeps the slide a player gets for free and cannot earn a pass through the
    // wall, because it is the same half-cell sample the nav searches by.
    //
    // A body with no floor under it is the one case that gets no say at all. The
    // tick that picks it up and sets it down on measured ground runs before this
    // one, so getting here means something put it there; letting it steer without
    // the table's answer is how a body ends up walking through a wall, and it has
    // no height to compare a step against either.
    if (home !== null) {
        const walked = botStepTo(arena, home, pos.x, pos.z,
            pos.x + Math.sin(yaw) * step, pos.z + Math.cos(yaw) * step);
        // The mummy arena ends at its baked table; the generated disc is a radius,
        // so it needs saying once here rather than trusting the walk.
        if (inside(walked.x, walked.z)) {
            nx = walked.x;
            nz = walked.z;
            // Bodies are solid too: the same pass a real phone's report goes
            // through, so a bot and a player cannot occupy one spot on a screen.
            // A push the table refuses is a push through a wall, so it is dropped
            // rather than taken back out of the room's geometry.
            const separated = separateFromRoom(room, entry, nx, nz);
            if (inside(separated.x, separated.z) && botPointEnterable(arena, home, separated.x, separated.z)) {
                nx = separated.x;
                nz = separated.z;
            }
        }
    }

    pos.x = nx;
    pos.z = nz;
    pos.yaw = yaw;
    // Displacement is the evidence, not the map's answer: a step the table refuses
    // and a step a body pushes straight back look identical on a phone - the walk
    // clip running under a body that is going nowhere. Two of those and the body
    // takes the open shoulder instead of holding the line for a second until the
    // slower distance check below notices.
    if (speed > 0) {
        const gainX = pos.x - wasX;
        const gainZ = pos.z - wasZ;
        const least = step * 0.25;
        stalled = gainX * gainX + gainZ * gainZ < least * least;
        if (stalled) b.blockedTicks++;
        else b.blockedTicks = 0;
    } else {
        b.blockedTicks = 0;
    }
    // A side-step that keeps being refused is the shoulder that points into the
    // wall, and holding it for the rest of its window is the freeze a phone sees:
    // a body in the walk clip that goes nowhere. So the reaction fires again inside
    // an open window, and the second answer is to reverse and walk back out.
    if (b.blockedTicks >= BOT_BLOCKED_TICKS) {
        const insideDetour = now < b.unstickUntil;
        b.blockedTicks = 0;
        b.unstickSide = insideDetour ? Math.PI : botOpenSide(arena, pos, yaw, b);
        b.unstickUntil = now + (insideDetour ? BOT_SIDESTEP_MS / 2 : BOT_SIDESTEP_MS);
        b.path = null;
        b.pathGoal = -1;
        b.noProgress = 0;
    }
    // The wire carries feet, so the body is put down on the floor the arena was
    // measured with rather than left floating at its spawn marker.
    const feet = botFeetAt(arena, nx, nz);
    if (feet !== null) pos.y = feet;
    // A speed of 0 means "face them, do not step": the client picks its
    // locomotion clip off this flag, so a swinging bot must not look like it
    // is sprinting on the spot. A body the map refused has to say the same thing -
    // a commanded step it never took is reported as standing still, which is both
    // what the phone draws and what the stuck checks above are already doing.
    pos.moving = step > 0.0001 && !stalled;

    // Progress stuck detection: a body can slide along a wall for minutes and
    // move in metres without ever closing on the point the nav gave it - the
    // displacement check above reads that as healthy. So every window the
    // distance to the aim is compared against the previous one; two windows
    // without real approach mean the route is not being made, and the bot
    // takes the open shoulder and rebuilds its path from where it stands.
    if (speed > 0) {
        if (b.aimAt > 0 && now - b.aimAt <= BOT_PROGRESS_MS * 3 && now >= b.progressAt) {
            const dNow = flatDistance(pos, b.aim);
            if (b.progressDist >= 0) {
                if (b.progressDist - dNow < BOT_PROGRESS_SLACK_M && dNow > 0.8) b.noProgress++;
                else b.noProgress = 0;
            }
            b.progressDist = dNow;
            b.progressAt = now + BOT_PROGRESS_MS;
            if (b.noProgress >= 2) {
                b.noProgress = 0;
                b.unstickUntil = now + BOT_SIDESTEP_MS;
                b.unstickSide = botOpenSide(arena, pos, pos.yaw || 0, b);
                b.path = null;
                b.pathGoal = -1;
            }
        }
    } else {
        b.progressDist = -1;
        b.noProgress = 0;
    }
}

function botBroadcastMove(room, entry, now) {
    const b = entry.bot;
    if (now < (b.nextMoveAt || 0)) return;
    b.nextMoveAt = now + BOT_MOVE_BROADCAST_MS;
    const pos = entry.pos;
    const txt = JSON.stringify({
        type: "player_move",
        player_uid: entry.ws.matchUid || entry.uid,
        spawn_index: entry.spawnIndex,
        x: Math.round(pos.x * 1000) / 1000,
        y: pos.y,
        z: Math.round(pos.z * 1000) / 1000,
        yaw: Math.round((pos.yaw || 0) * 1000) / 1000,
        moving: !!pos.moving,
        grounded: true
    });
    pos.moving = false;
    for (const otherWs of room.players) {
        if (otherWs !== entry.ws && otherWs.readyState === WebSocket.OPEN) otherWs.send(txt);
    }
}

function botHuntTargetId(room, entry, role) {
    const g = room.game;
    // A hunter only ever goes for the enemy team: the mummy and zombie rules both
    // refuse a hit on an ally, and chasing one would make a bot look stupid.
    return botNearest(room, entry, (other) => {
        if (other.side === entry.side) return false;
        const id = mummyIdOf(other);
        return g.roles[id] !== role && botBodyAlive(room, id) && !!botPositionOf(room, other);
    });
}

function botFleeSource(room, entry) {
    const g = room.game;
    return botNearest(room, entry, (other) => {
        if (other.side === entry.side) return false;
        const id = mummyIdOf(other);
        const role = g.roles[id];
        return (role === "mummy" || role === "zombie") && botBodyAlive(room, id) && !!botPositionOf(room, other);
    });
}

function botThink(room, entry, now, dt) {
    const g = room.game;
    const role = g.roles[mummyIdOf(entry)];
    const b = entry.bot;

    botPositionOf(room, entry);
    // Feet first, before anything is aimed: the body is put on the floor the arena
    // was measured with, so a chase, a line of sight and the wire all agree on
    // the height the client is about to draw.
    // Every guard below reads the floor under the body, so a body with no floor
    // under it - one a push or a seat change left past the table's rim - steers
    // with nothing to refuse it. This is the one place that picks the body back up
    // and sets it down on measured ground, and it runs for a downed body too, so
    // the client never draws someone standing on nothing.
    const arena = arenaFor(room.mode);
    let standY = botFeetAt(arena, entry.pos.x, entry.pos.z);
    if (standY === null) {
        const seat = botNearestStandableCell(arena, entry.pos.x, entry.pos.z);
        const centre = botCellCentre(arena, seat);
        standY = botCellFeet(arena, seat);
        if (standY !== null) {
            entry.pos.x = centre.x;
            entry.pos.z = centre.z;
            if (entry.bot) {
                entry.bot.path = null;
                entry.bot.pathGoal = -1;
                entry.bot.progressDist = -1;
            }
        }
    }
    if (standY !== null) entry.pos.y = standY;
    if (!botBodyAlive(room, mummyIdOf(entry))) {
        // Downed or eliminated: stand still so the state the client draws matches
        // the seat the body was left at.
        entry.pos.moving = false;
        botBroadcastMove(room, entry, now);
        return;
    }

    if (role === "mummy" || role === "zombie") {
        const prey = botHuntTargetId(room, entry, role);
        if (prey) {
            const preyId = mummyIdOf(prey.entry);
            if (prey.distance <= BOT_ATTACK_RANGE) {
                // Face them and swing on the server's cooldown; a hit only lands
                // once the reach re-check inside the authority passes.
                botSteer(room, entry, botYawTowards(entry.pos, prey.entry.pos), 0, dt, now);
                if (now >= b.nextAttackAt) {
                    b.nextAttackAt = now + BOT_ATTACK_COOLDOWN_MS;
                    if (g.kind === "zombie") {
                        performZombieSwing(room, entry);
                        performZombieAttack(room, entry, preyId);
                    } else {
                        performMummySwing(room, entry);
                        performMummyAttack(room, entry, preyId);
                    }
                }
            } else {
                botSteer(room, entry, botDrift(b, botNavigatedYaw(room, entry, prey.entry.pos, now)),
                    b.reachedPartial ? 0 : botPace(b, BOT_RUN_SPEED), dt, now);
            }
        } else {
            // Every enemy is down or out of the world: keep hunting nothing by
            // walking the arena instead of freezing on the last kill spot.
            botRoamStep(room, entry, now, dt);
        }
        botBroadcastMove(room, entry, now);
        return;
    }

    // Human bot: keep away from the hunter, break line of sight by hugging the
    // rim, and never walk into a second body.
    const threat = botFleeSource(room, entry);
    if (threat) {
        const away = botYawTowards(threat.entry.pos, entry.pos);
        if (threat.distance <= BOT_FLEE_START) {
            // Running away is the one thing worth pathing for: a body that only
            // knows "opposite the mummy" backs itself into a corner and dies.
            const escape = botStandableAhead(arena, entry.pos,
                blendAwayFromCrowd(room, entry, away), BOT_FLEE_REACH_M);
            // and it keeps running when the search cannot find a route to the
            // point it picked: a body with a hunter at 5 m that stands still
            // because its escape lay across unreachable ground is a body that
            // died deciding. The step-walk stops it at the wall face, so pushing
            // along one is both safe and what a cornered player does.
            botSteer(room, entry, botDrift(b, botNavigatedYaw(room, entry, escape, now)),
                botPace(b, BOT_RUN_SPEED), dt, now);
        } else if (threat.distance <= BOT_CAUTION_RANGE) {
            // Not close enough to sprint, but do not stand facing them either:
            // sidestep, which is what a player does while watching a mummy.
            botSteer(room, entry, botDrift(b, blendAwayFromCrowd(room, entry, away + Math.PI / 2.4)), botPace(b, BOT_WALK_SPEED), dt, now);
        } else {
            // Far enough away to be safe: patrol the arena instead of camping, so
            // the whole floor gets walked between fights.
            botRoamStep(room, entry, now, dt);
        }
    } else {
        // Nothing is chasing this bot at all: same patrol, because a bot that
        // stands still in an empty arena is the fastest tell there is.
        botRoamStep(room, entry, now, dt);
    }
    botBroadcastMove(room, entry, now);
}

// Two bots fleeing the same mummy would otherwise stack on one line; pushing
// away from the nearest body of their own team splits them like real players
// running to different cover.
function blendAwayFromCrowd(room, entry, yaw) {
    const crowd = botNearest(room, entry, (other) => other.side === entry.side
        && botBodyAlive(room, mummyIdOf(other))
        && flatDistance(entry.pos, botPositionOf(room, other)) < 2.2);
    if (!crowd) return yaw;
    const push = botYawTowards(crowd.entry.pos, entry.pos);
    const delta = botAngleDelta(yaw, push);
    return yaw + delta * 0.5;
}

// The next place a free bot walks to. Kept until it is reached or ages out, so a
// bot commits to a leg instead of jittering on the spot; if the table offers
// nothing at patrol distance, the leg it already had is the best answer.
function botRoamGoal(room, entry, now) {
    const arena = arenaFor(room.mode);
    const b = entry.bot;
    if (b.roam && now < b.roamUntil && flatDistance(entry.pos, b.roam) > 1.0) return b.roam;
    const homePiece = arenaPieceAt(arena, botCellAt(arena, entry.pos.x, entry.pos.z));
    for (let i = 0; i < BOT_ROAM_TRIES; i++) {
        const idx = (Math.random() * arena.n * arena.n) | 0;
        const feet = botCellFeet(arena, idx);
        if (feet === null) continue;
        // A leg across a piece of ground no stair reaches is a walk that ends in
        // the middle of the arena with nothing left to do.
        if (arenaPieceAt(arena, idx) !== homePiece) continue;
        const c = botCellCentre(arena, idx);
        const d = flatDistance(entry.pos, c);
        if (d < BOT_ROAM_MIN_M || d > BOT_ROAM_MAX_M) continue;
        b.roam = { x: c.x, y: feet, z: c.z };
        b.roamUntil = now + BOT_ROAM_MS;
        return b.roam;
    }
    return b.roam || null;
}

// Walking that leg: the same navigator and the same stuck handling a chase gets,
// at walking pace, so patrolling never earns a bot a new way to clip a wall.
function botRoamStep(room, entry, now, dt) {
    const b = entry.bot;
    const goal = botRoamGoal(room, entry, now);
    if (!goal) {
        entry.pos.moving = false;
        return;
    }
    const yaw = blendAwayFromCrowd(room, entry, botNavigatedYaw(room, entry, goal, now));
    botSteer(room, entry, botDrift(b, yaw), b.reachedPartial ? 0 : botPace(b, BOT_WALK_SPEED), dt, now);
}

function tickBots() {
    const now = Date.now();
    const dt = BOT_TICK_MS / 1000;
    for (const room of matches.values()) {
        const g = room.game;
        if (!g || g.phase !== "playing" || g.settled) continue;
        for (const entry of room.entries) {
            if (!isBotPeer(entry.ws) || !entry.bot) continue;
            try {
                botThink(room, entry, now, dt);
            } catch (err) {
                console.error('[BOT] think failed:', err);
            }
        }
    }
}

// ---- shared swing / hit authority ----
// A real phone's `swing_start` and a bot's decision call exactly these four
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

    // Apply damage
    target.hp = Math.max(0, target.hp - MUMMY_DAMAGE_PER_HIT);
    console.log(`[MUMMY] ${attackerId} hit ${targetId} for ${MUMMY_DAMAGE_PER_HIT} damage, HP now ${target.hp}`);

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
                if (maxSize < 2) { teamError(ws, "Pick Duo (2) or Squad (4) before inviting"); break; }
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
            const emote = parseInt(data.emote, 10);
            if (isNaN(emote) || emote < 1 || emote > 8) break;
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
            const slot = parseInt(data.team_size, 10);
            if (!TEAM_SLOTS.includes(slot)) {
                sendJson(ws, { type: "team_size_mismatch", team_size: data.team_size });
                break;
            }
            // A zombie queue has one shape: a full Squad on each side. Any other
            // request would wait forever on the 4v4 room gate, so it is refused here.
            if (mode === ZOMBIE_MODE && slot !== ZOMBIE_TEAM_SIZE) {
                sendJson(ws, { type: "team_size_mismatch", team_size: slot, expected: ZOMBIE_TEAM_SIZE });
                break;
            }
            const characterId = data.character_id || 1;
            const bundleId = bundleIdOf(data);
            const username = data.username || "Player";
            const playerUid = uid || "";

            // The queue size is the server's roster, never the number the client
            // claims — so a party can only ever meet a party of the same size.
            const team = teamOf(ws);
            if (team && team.members.length > 1) {
                if (team.leaderUid !== playerUid) { teamError(ws, "Only the team leader can start matchmaking"); break; }
                // The slot must be the party's real size. A party cannot search
                // for a bigger or smaller lobby than the one it already has.
                if (team.members.length !== slot) {
                    sendJson(ws, {
                        type: "team_size_mismatch",
                        team_size: slot,
                        expected: team.members.length
                    });
                    break;
                }
                removeFromAllQueues(ws);
                removeFromTeamQueue(team.id);
                queueTeam(mode, team, slot);
                break;
            }

            // Re-queueing is an update, not a second seat: the old entry (and any
            // old slot/mode) is dropped before the new one is added.
            removeFromAllQueues(ws);
            // One body can never be a 4v4 side: the infection mode is party-only.
            if (mode === ZOMBIE_MODE) {
                sendJson(ws, { type: "team_size_mismatch", team_size: slot, expected: ZOMBIE_TEAM_SIZE });
                break;
            }
            queues[mode].push({
                ws,
                mode,
                slot,
                teamSize: 1,
                characterId,
                bundleId,
                username,
                playerUid,
                queuedAt: Date.now()
            });
            console.log(`[QUEUE] ${playerUid || "solo"} joined ${mode} slot ${slot}. Waiting: ${queues[mode].filter(e => e.slot === slot).length}/${slot * 2}`);
            processSoloQueue(mode);
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

        default:
            console.log('[WS] Unknown message type:', type);
    }
}

const mummyTick = setInterval(tickMummyMatches, 250);
const zombieTick = setInterval(tickZombieMatches, 250);
checkArena(BOT_ARENA_MUMMY, "mummy");
checkArena(BOT_ARENA_ZOMBIE, "zombie");
// Bot movement runs one step behind the rules tick, so a bot's position changes
// are decided by the same tables that decide a hit, but sent at the 10 Hz the
// arena interpolates at.
const botTick = setInterval(tickBots, BOT_TICK_MS);
// Waiting queues are re-checked twice a second; nothing else decides when a bot
// may step in, so a queue with a real player arriving one second later keeps
// their own match.
const botFillTick = setInterval(fillBotsIfNeeded, 2000);

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
