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
const crypto = require('crypto');
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
        voice: !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET),
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

// ==========================================
// VOICE (LiveKit) ACCESS TOKENS
// ==========================================
// The lobby voice chat runs on a LiveKit server. A client cannot be trusted
// with the signing secret, so it asks this endpoint for a short-lived access
// token instead. The token is a plain HS256 JWT, which node's own crypto can
// sign - that keeps this service's only dependency at ws.
//
// The LiveKit server URL and its key/secret come from the environment, so the
// same build works for LiveKit Cloud or a self-hosted box:
//   LIVEKIT_URL         wss://xxxxx.livekit.cloud
//   LIVEKIT_API_KEY     the project's API key
//   LIVEKIT_API_SECRET  the project's API secret
// Until those are set, /voice/token answers 503 and the game keeps voice off.
const VOICE_TOKEN_TTL_SECONDS = 6 * 60 * 60;

function base64url(input) {
    return Buffer.from(input).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Keeps an identity/room name to safe characters so it cannot smuggle
// separators or grow without bound.
function sanitizeId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

function makeLiveKitToken(apiKey, apiSecret, identity, room) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        iss: apiKey,
        sub: identity,
        name: identity,
        nbf: now - 5,
        exp: now + VOICE_TOKEN_TTL_SECONDS,
        video: {
            room: room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        }
    };
    const body = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', apiSecret).update(body).digest();
    return body + '.' + base64url(sig);
}

function handleVoiceToken(req, res) {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
        return respondJson(res, 503, { error: "Voice not configured" });
    }
    const params = new URL(req.url, 'http://localhost').searchParams;
    const identity = sanitizeId(params.get('identity'))
        || ('guest-' + Math.random().toString(36).slice(2, 10));
    const room = sanitizeId(params.get('room')) || 'lobby';
    const token = makeLiveKitToken(apiKey, apiSecret, identity, room);
    console.log('[VOICE] token issued for', identity, 'in room', room);
    respondJson(res, 200, {
        token: token,
        url: process.env.LIVEKIT_URL || '',
        room: room,
        identity: identity
    });
}

// Everything that is not a websocket upgrade lands here: the routes above,
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
    if (req.method === 'GET' && path === '/voice/token') { handleVoiceToken(req, res); return; }
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
    hubWs.on('message', (message, isBinary) => {
        if (isBinary) {
            // Voice relay from the hub: [0x59][1-byte len][connId][voice frame].
            if (message.length > 3 && message[0] === 0x59) {
                const len = message[1];
                if (2 + len <= message.length) {
                    const target = connsById.get(message.subarray(2, 2 + len).toString("utf8"));
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(message.subarray(2 + len));
                    }
                }
            }
            return;
        }
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
        },
        sendBinary: (buf) => {
            const l = regionLinks.get(regionId);
            if (l && l.ws.readyState === WebSocket.OPEN) {
                l.ws.send(makeVoiceRelay(connId, buf));
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

// ---- voice relay ------------------------------------------------------------
// Android phones run voice over the game socket instead of the LiveKit plugin
// (its native layer SIGSEGVs there). A voice room is just a sanitized key the
// hub groups sockets under: every 0x56 PCM frame a member sends is relayed to
// the other members only. Regions never see the key, they only ferry frames.

const voiceGroups = new Map(); // voiceKey -> Set of member bodies (socket or peer)
const VOICE_FRAME_MAX = 4096;

// Lobby and match keys are short ids, so a whitelist is the whole sanitizer.
function sanitizeVoiceKey(raw) {
    return String(raw || "").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 64);
}

function leaveVoice(ws) {
    const key = ws.voiceKey;
    if (!key) return;
    ws.voiceKey = "";
    const set = voiceGroups.get(key);
    if (set && set.delete(ws)) {
        if (set.size === 0) voiceGroups.delete(key);
        else sendVoiceList(key);
    }
}

function sendVoiceList(key) {
    const set = voiceGroups.get(key);
    if (!set) return;
    const uids = [];
    for (const body of set) {
        if (body.playerUid && body.readyState === WebSocket.OPEN) uids.push(body.playerUid);
    }
    const txt = JSON.stringify({ type: "voice_list", voice_key: key, uids: uids });
    for (const body of set) body.send(txt);
}

// A player's own frame: [0x56][16-byte uid][int16 LE PCM]. The uid rides along
// so clients can mute per player without trusting the relay's routing.
function relayVoice(ws, frame) {
    const set = ws.voiceKey ? voiceGroups.get(ws.voiceKey) : null;
    if (!set) return;
    for (const body of set) {
        if (body === ws) continue;
        if (body.sendBinary) body.sendBinary(frame);
        else body.send(frame);
    }
}

// Region -> hub voice framing: [0x59][1-byte len][connId][voice frame]. The
// connId is variable length, hence the length byte.
function makeVoiceRelay(connId, frame) {
    const id = Buffer.from(String(connId), "utf8");
    const out = Buffer.alloc(2 + id.length + frame.length);
    out[0] = 0x59;
    out[1] = id.length;
    id.copy(out, 2);
    frame.copy(out, 2 + id.length);
    return out;
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

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // 0x59 from a linked region is a member's voice frame; 0x56 from a
            // player socket is the member itself. Anything else is ignored.
            if (message.length > 3 && message[0] === 0x59) {
                if (ws.isRegion) {
                    const link = regionLinks.get(ws.regionId);
                    const len = message[1];
                    if (link && 2 + len <= message.length) {
                        const peer = link.peers.get(message.subarray(2, 2 + len).toString("utf8"));
                        if (peer) relayVoice(peer, message.subarray(2 + len));
                    }
                }
                return;
            }
            if (message[0] === 0x56 && message.length >= 19 && message.length <= VOICE_FRAME_MAX) {
                if (HUB_URL !== "") {
                    if (hubWs && hubWs.readyState === WebSocket.OPEN) {
                        hubWs.send(makeVoiceRelay(ws.connId, message));
                    }
                } else {
                    relayVoice(ws, message);
                }
            }
            return;
        }
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
    console.log('[WS] Player disconnected');
    leaveVoice(ws);
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

function spawnIndexForSeat(mode, sideIndex, seatIndex, slotSize) {
    // Team spawn layout (Spawn 1..8 markers in Godot, 0-based indices here):
    // 1v1: A=Spawn1, B=Spawn5
    // 2v2: A=Spawn1,2, B=Spawn5,6
    // 3v3: A=Spawn1,2,3, B=Spawn5,6,7
    // 4v4: A=Spawn1,2,3,4, B=Spawn5,6,7,8
    // Zombie Eclipse is authored/ring-mapped as 4v4 using contiguous 0..7.
    if (mode === ZOMBIE_MODE) {
        return sideIndex * slotSize + seatIndex;
    }
    const teamABase = 0; // Spawn 1
    const teamBBase = 4; // Spawn 5
    const base = sideIndex === 0 ? teamABase : teamBBase;
    return base + seatIndex;
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

    const slotSize = sizeA;
    const usedSpawns = new Set();
    const matchId = `match_${matchCounter++}`;
    const entries = [];

    sides.forEach((group, sideIndex) => {
        group.members.forEach((m, i) => {
            // The queue snapshot is a few seconds old by pairing time, while the
            // live party roster is not — so a member who equipped a different
            // character after the leader queued enters with the new one.
            const team = m.ws && m.ws.teamId ? teams.get(m.ws.teamId) : null;
            const live = team ? team.members.find(x => x.uid === m.playerUid) : null;
            const spawnIndex = spawnIndexForSeat(mode, sideIndex, i, slotSize);
            if (usedSpawns.has(spawnIndex)) {
                console.warn(`[MATCH REJECTED] duplicate spawn ${spawnIndex} in ${mode}`);
                return;
            }
            usedSpawns.add(spawnIndex);
            entries.push({
                ws: m.ws,
                uid: m.playerUid || "",
                username: (live && live.username) || m.username || "Player",
                characterId: (live && live.characterId) || m.characterId || 1,
                bundleId: live && live.bundleId !== undefined ? live.bundleId : bundleOf(m),
                teamId: group.teamId || "",
                side: sideIndex,
                team: sideIndex === 0 ? "A" : "B",
                teamName: MUMMY_TEAM_NAMES[sideIndex] || (sideIndex === 0 ? "TEAM A" : "TEAM B"),
                spawnIndex: spawnIndex,
                spawnId: spawnIndex + 1
            });
        });
    });

    if (entries.length !== seats.length || entries.length !== slotSize * 2) {
        console.warn(`[MATCH REJECTED] seat/spawn assignment incomplete for ${mode} (${entries.length}/${slotSize * 2})`);
        return false;
    }

    const room = {
        players: entries.map(e => e.ws),
        mode: mode,
        matchId: matchId,
        slotSize: slotSize,
        entries: entries
    };
    matches.set(matchId, room);
    console.log(`[MATCH FOUND] ${entries.length} bodies in ${matchId} for ${mode} ${slotSize}v${slotSize} (${sides.map(s => s.teamId || 'solo').join(' vs ')})`);

    for (const self of entries) {
        const enemy = entries.find(e => e.side !== self.side) || null;
        const payload = {
            type: "match_found",
            mode: mode,
            match_id: matchId,
            spawn_index: self.spawnIndex,
            spawn_id: self.spawnId,
            side: self.side,
            team: self.team,
            team_name: self.teamName,
            total_players: entries.length,
            team_size: slotSize,
            team_id: self.teamId,
            players: entries.map(e => ({
                id: mummyIdOf(e),
                player_uid: e.uid,
                username: e.username,
                character_id: e.characterId,
                bundle_id: bundleOf(e),
                spawn_index: e.spawnIndex,
                spawn_id: e.spawnId,
                side: e.side,
                team: e.team,
                team_name: e.teamName,
                team_id: e.teamId
            })),
            // Kept for the arena client, which still labels the first enemy it sees.
            opponent: enemy ? {
                character_id: enemy.characterId,
                username: enemy.username,
                player_uid: enemy.uid,
                spawn_index: enemy.spawnIndex,
                spawn_id: enemy.spawnId,
                side: enemy.side,
                team: enemy.team
            } : {}
        };
        self.ws.matchId = matchId;
        self.ws.matchSpawnIndex = self.spawnIndex;
        self.ws.matchUid = self.uid;
        self.ws.matchSide = self.side;
        self.ws.matchTeam = self.team;
        sendJson(self.ws, payload);
    }

    if (mode === MUMMY_MODE) initMummyMatch(room);
    else if (mode === ZOMBIE_MODE) initZombieMatch(room);
    return true;
}

// ---- One queue, both pools ----
// A search is keyed on (mode, slot) and nothing else: a party keeps its own
// roster and seats a whole side, and the seats it left open are filled by the
// players who searched that exact slot alone. Nothing is invented and nothing
// is resized - a room opens only when every side is exactly the slot the players
// themselves picked, so a pool that cannot reach slot * 2 real bodies just keeps
// waiting. Fewest strangers first, so two parties that are already full meet
// each other before a single one of their seats is handed to someone off the
// street.
function processMatchQueue(mode) {
    if (!queues[mode] || !teamQueues[mode]) return;
    for (const slot of TEAM_SLOTS) {
        dropRepeatSoloEntries(mode, slot);
        for (let guard = 0; guard < 16; guard++) {
            const plan = planRoom(mode, slot);
            if (!plan) break;
            // makeRoom re-checks every socket, seat and side size one last time;
            // a refusal leaves the whole pool exactly as it was.
            if (!makeRoom(mode, plan.sides)) break;
            for (const g of plan.groups) {
                const idx = teamQueues[mode].indexOf(g);
                if (idx !== -1) teamQueues[mode].splice(idx, 1);
            }
            for (const e of plan.solos) {
                const idx = queues[mode].indexOf(e);
                if (idx !== -1) queues[mode].splice(idx, 1);
            }
        }
    }
    broadcastAllPools();
}

// The same body must never hold two seats in one pool: the newest search wins.
function dropRepeatSoloEntries(mode, slot) {
    const seen = new Set();
    queues[mode] = queues[mode].filter(e => {
        if (e.slot !== slot) return true;
        if (seen.has(e.ws)) return false;
        seen.add(e.ws);
        return true;
    });
}

function usableGroups(mode, slot) {
    return teamQueues[mode].filter(g => g.slot === slot
        && g.members.length <= slot
        && g.members.every(m => queueEntryUsable(m, mode, slot)));
}

// Every way of filling one side out of whole parties, with the lone seats each
// leaves. A slot is at most 4, so enumerating the subsets costs nothing and it
// is the only honest way to find that a 3-party plus one searcher is a team.
function sidePacks(groups, slot) {
    const packs = [{ groups: [], openSeats: slot }];
    for (const g of groups) {
        const added = [];
        for (const p of packs) {
            const open = p.openSeats - g.members.length;
            if (open < 0) continue;
            added.push({ groups: p.groups.concat([g]), openSeats: open });
        }
        packs.push(...added);
    }
    packs.sort((a, b) => a.openSeats - b.openSeats || b.groups.length - a.groups.length);
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
    // Match at the slot the player picked (1v1/2v2/3v3/4v4).
    // Solo/party fillers are combined only within that same slot.
    if (mode === MUMMY_MODE) return requestedSlot;
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

// ---- Character 5: Shadow Ranger personal shield ----
// Extra HP layered over the normal bar. Damage spends this first; whatever is
// left after 20 seconds disappears. The green body shell is drawn by every client.
const HP_SHIELD_AMOUNT = 100;
const HP_SHIELD_LIFETIME_MS = 20000;
const HP_SHIELD_COOLDOWN_MS = 80000;

function abilityCooldownMs(kind) {
    return kind === "hp_shield" ? HP_SHIELD_COOLDOWN_MS : ABILITY_COOLDOWN_MS;
}

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
            shield: 0,
            shieldUntil: 0,
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
            // +Z is the way the model faces at yaw 0, so this walks it forwards.
            c.x += Math.sin(c.yaw) * step;
            c.z += Math.cos(c.yaw) * step;
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

    if (kind === "hp_shield") {
        const state = g.combat[self];
        if (!state || state.downed || state.eliminated) return "none";
        state.shield = HP_SHIELD_AMOUNT;
        state.shieldUntil = now + HP_SHIELD_LIFETIME_MS;
        mine.cooldownUntil = now + HP_SHIELD_COOLDOWN_MS;
        for (const e of room.entries) {
            sendJson(e.ws, {
                type: "ability_spawn",
                match_id: room.matchId,
                player_id: self,
                ability_type: "hp_shield",
                shield_hp: HP_SHIELD_AMOUNT,
                duration_ms: HP_SHIELD_LIFETIME_MS
            });
        }
        broadcastMummyState(room, true);
        console.log(`[MUMMY] ${self} raised a ${HP_SHIELD_AMOUNT} HP shadow shield in ${room.matchId}`);
        return "";
    }

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

    // The holograms step out in front of the body that cast them, turned the way
    // that body is already facing, so a clone leads the caster instead of standing
    // at their shoulder - and it never appears behind a player who has just spun
    // around to run. The roster's models face +Z at yaw 0 (the player controller
    // aims them with atan2(dx, dz), and the phone reports that same model yaw), so
    // "ahead" is +Z here - the opposite sign would put the pair behind the caster.
    const at = entry.pos || { x: 0, y: 0, z: 0, yaw: 0 };
    const yaw = Number(at.yaw) || 0;
    const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const created = [];
    for (let i = 0; i < CLONE_COUNT; i++) {
        const side = i === 0 ? 1 : -1;
        const id = `${self}#${g.cloneSeq++}`;
        const clone = {
            owner: self,
            x: Number(at.x) + forward.x * CLONE_FRONT_METRES + right.x * CLONE_SPREAD_METRES * side,
            y: Number(at.y),
            z: Number(at.z) + forward.z * CLONE_FRONT_METRES + right.z * CLONE_SPREAD_METRES * side,
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

// The blue body shield lasts exactly 20 seconds, and the server's clock is what
// ends it so every phone drops the effect on the same tick.
function tickMummyHpShields(room, now) {
    const g = room.game;
    let changed = false;
    for (const id of Object.keys(g.combat)) {
        const c = g.combat[id];
        if (!c) continue;
        if ((c.shield || 0) > 0 && c.shieldUntil > 0 && c.shieldUntil <= now) {
            c.shield = 0;
            c.shieldUntil = 0;
            changed = true;
        }
    }
    return changed;
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
    // A revived player stands back up at half health, not a fresh full bar.
    c.hp = Math.floor(MUMMY_HP / 2);
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
        // should not watch an emote that already happened. Broadcast to every
        // connected lobby client so emotes sync globally, not just within a party.
        case 'lobby_emote': {
            const uid = bindUid(ws, data);
            if (!uid) break;
            const emote = Number(data.emote);
            if (!Number.isInteger(emote) || emote < 1 || emote > 16) break;
            const txt = JSON.stringify({
                type: "lobby_emote",
                emote: emote,
                player_uid: uid,
                username: String(data.username || "").slice(0, 24)
            });
            for (const client of wss.clients) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(txt);
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
