const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. OAUTH TOKEN MEMORY STORE
// ==========================================
const oauthTokens = new Map(); // state -> { access_token, refresh_token, expires_at, user }

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: "online",
        service: "Flame Strike Game Server",
        timestamp: new Date().toISOString()
    });
});

// OAuth Callback from Supabase / Google
// Supabase OAuth redirects with hash fragment (#access_token=...&refresh_token=...&state=...)
// This page reads the hash and submits it back to the server
app.get('/auth/callback', (req, res) => {
    res.send(`
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
});

// Internal endpoint to store extracted token
app.post('/auth/save-token', (req, res) => {
    const { state, access_token, refresh_token } = req.body;
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
        return res.json({ success: true });
    }
    res.status(400).json({ error: "Missing token" });
});

// Godot polls this endpoint during login
app.get('/auth/poll', (req, res) => {
    const state = req.query.state;
    if (!state) {
        return res.status(400).json({ error: "Missing state query param" });
    }

    // Try exact state match first
    if (oauthTokens.has(state)) {
        const tokenData = oauthTokens.get(state);
        oauthTokens.delete(state); // One-time use
        return res.json({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    // Zero-State fallback: if global_fallback exists, use it
    if (oauthTokens.has('global_fallback')) {
        const tokenData = oauthTokens.get('global_fallback');
        oauthTokens.delete('global_fallback'); // One-time use
        return res.json({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            pending: false
        });
    }

    res.json({ pending: true });
});

// ==========================================
// 2. WEBSOCKET REAL-TIME MATCHMAKING
// ==========================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Mode queues: array of { ws, uid, team_size, character_id, username, player_uid }
const queues = {
    "MUMMY_VS_HUMAN": [],
    "ZOMBIE_ECLIPSE": []
};

// Team queues: mode -> array of { teamId, teamSize, members: [same shape as above] }
const teamQueues = {
    "MUMMY_VS_HUMAN": [],
    "ZOMBIE_ECLIPSE": []
};

// Active match rooms: match_id -> { players: [ws1, ws2], mode }
const matches = new Map();
let matchCounter = 1000;

// ---- Authoritative team (party) state ----
const clientsByUid = new Map();   // player_uid -> ws (last connection wins)
const teams = new Map();          // team_id -> { id, leaderUid, maxSize, members: [{ws, uid, username, characterId}] }
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

function memberInfo(m) {
    return { player_uid: m.uid, username: m.username, character_id: m.characterId };
}

// Clients attach their identity (UID, name, equipped character) to every team
// message, so a player who equips or buys a character while already in a party —
// or while queued — is carried with their new model instead of the one they
// registered with.
function refreshIdentity(uid, data) {
    if (!uid) return;
    const name = String(data.username || "").trim();
    const charId = parseInt(data.character_id, 10);
    const patch = (row) => {
        if (name !== "") row.username = name;
        if (!isNaN(charId) && charId > 0) row.characterId = charId;
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

function createTeam(ws, uid, username, characterId, maxSize) {
    const id = "team_" + (teamCounter++);
    const team = {
        id: id,
        leaderUid: uid,
        maxSize: maxSize,
        members: [{ ws: ws, uid: uid, username: username, characterId: characterId }]
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

wss.on('connection', (ws) => {
    console.log('[WS] New player connected');
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            handleClientMessage(ws, data);
        } catch (err) {
            console.error('[WS ERROR] Failed to parse message:', err);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Player disconnected');
        if (ws.playerUid && clientsByUid.get(ws.playerUid) === ws) {
            clientsByUid.delete(ws.playerUid);
        }
        removeFromAllQueues(ws);
        leaveTeam(ws);

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
                // Dropping out mid-round is an exit, not a survive: the Human side
                // loses that slot so the round stays winnable instead of hanging
                // until the clock.
                if (gone && room.game.roles[mummyIdOf(gone)] === "human") {
                    eliminateMummyPlayer(room, mummyIdOf(gone));
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
    });
});

function makeRoom(mode, sides) {
    // One shared room for the whole opposing set: 1v1 = 2 players, 2v2 = 4,
    // 3v3 = 6, 4v4 = 8. Each side keeps a contiguous block of spawn indexes so
    // teams start on opposite sides of the arena, never stacked.
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
                teamId: group.teamId || "",
                side: sideIndex,
                spawnIndex: base + i
            });
        });
    });

    const room = {
        players: entries.map(e => e.ws),
        mode: mode,
        matchId: matchId,
        entries: entries
    };
    matches.set(matchId, room);
    console.log(`[MATCH FOUND] ${entries.length} players in ${matchId} for ${mode} (${sides.map(s => s.teamId || 'solo').join(' vs ')})`);

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
}

// Teams queue as whole groups and only ever meet a group of the same size.
// Sizes are never mixed: a duo can only meet another duo, a squad only a squad.
function processTeamQueue(mode) {
    let paired = true;
    while (paired) {
        paired = false;
        const q = teamQueues[mode];
        for (let i = 0; i < q.length && !paired; i++) {
            for (let j = i + 1; j < q.length; j++) {
                if (q[i].teamSize !== q[j].teamSize) continue;
                const groupB = q.splice(j, 1)[0];
                const groupA = q.splice(i, 1)[0];
                makeRoom(mode, [groupA, groupB]);
                paired = true;
                break;
            }
        }
    }
}

function queueTeam(mode, team) {
    const allyUidsOf = (uid) => team.members.filter(m => m.uid !== uid).map(m => m.uid);
    const group = {
        teamId: team.id,
        teamSize: team.members.length,
        members: team.members.map(m => ({
            ws: m.ws,
            characterId: m.characterId,
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
            player_count: group.teamSize,
            required_players: group.teamSize
        });
    }
    // Every mode meets a party of the same size: duo v duo, trio v trio, squad v squad.
    processTeamQueue(mode);
}

// ---- Mummy vs Human: server-authoritative 1v1 / 2v2 / 3v3 / 4v4 match ----
// The clients only report proximity; every role, timer tick, knockdown, revive,
// elimination, round point and the final result is decided here so all screens agree.
const MUMMY_MODE = "MUMMY_VS_HUMAN";
const MUMMY_ROUNDS = 4;
// The knockdown bar: once downed, a Human bleeds this whole HP away over
// MUMMY_DOWN_SECONDS and is eliminated when it empties.
const MUMMY_HP = 100;
const MUMMY_DOWN_SECONDS = parseInt(process.env.MUMMY_DOWN_SECONDS, 10) || 30;
const MUMMY_REVIVE_SECONDS = parseInt(process.env.MUMMY_REVIVE_SECONDS, 10) || 5;
const MUMMY_DOWN_MS = MUMMY_DOWN_SECONDS * 1000;
const MUMMY_REVIVE_MS = MUMMY_REVIVE_SECONDS * 1000;
// A reviver stops counting the moment its heartbeats go silent (dropped socket,
// run away, scene quit) instead of leaving a channel frozen at 4/5 seconds.
const MUMMY_REVIVE_HEARTBEAT_MS = 2000;
// The gap that lets a fully-eliminated side be confirmed before the next round.
const MUMMY_BREAK_MS = (parseInt(process.env.MUMMY_BREAK_SECONDS, 10) || 3) * 1000;

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
        mummyScore: 0,
        humanScore: 0,
        roles: {},                 // id -> "mummy" | "human"
        combat: {},                // id -> { hp, downed, downedSince, eliminated, reviveMs, revivers }
        settled: false,            // one result per round, however it ends
        roundOutcome: "",
        matchWinner: null,         // "mummy" | "human" | "draw"
        endsAt: 0
    };
    resetMummyCombat(room);
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
            reviveMs: 0,
            reviveAt: 0,
            revivers: {}
        };
    }
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
    return true;
}

// The Mummy side only wins once every Human is out. Downed-but-still-bleeding
// Humans count as alive, so the round never advances while one of them remains.
function mummyHumansWiped(room) {
    const humans = mummyHumanIds(room);
    return humans.length > 0 && humans.every(id => room.game.combat[id].eliminated);
}

function tickMummyCombat(room, now) {
    const g = room.game;
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

function shuffled(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function beginMummyRound(room, roundNumber) {
    const g = room.game;
    const ids = room.entries.map(mummyIdOf);

    g.round = roundNumber;
    g.settled = false;
    g.roundOutcome = "";
    g.phase = "playing";
    g.endsAt = Date.now() + g.roundMs;
    resetMummyCombat(room);

    if (roundNumber === 1 || roundNumber === 3) {
        // Random sides, but never a lopsided split: exactly half become mummies.
        const mummies = shuffled(ids).slice(0, Math.ceil(ids.length / 2));
        g.roles = {};
        for (const id of ids) g.roles[id] = mummies.includes(id) ? "mummy" : "human";
    } else {
        // Swap rounds: the previous humans inherit the mummy role and vice versa.
        const flipped = {};
        for (const id of ids) flipped[id] = g.roles[id] === "mummy" ? "human" : "mummy";
        g.roles = flipped;
    }

    console.log(`[MUMMY] ${room.mode} round ${roundNumber}: ${Object.entries(g.roles).map(([id, r]) => `${id}=${r}`).join(" ")}`);
    broadcastMummyState(room, true);
}

function settleMummyRound(room, winner) {
    const g = room.game;
    if (g.settled) return;
    g.settled = true;
    g.roundOutcome = winner;
    if (winner === "mummy") g.mummyScore += 1;
    else if (winner === "human") g.humanScore += 1;

    if (g.round >= MUMMY_ROUNDS) {
        g.phase = "finished";
        g.endsAt = 0;
        const diff = g.mummyScore - g.humanScore;
        g.matchWinner = diff > 0 ? "mummy" : diff < 0 ? "human" : "draw";
        console.log(`[MUMMY] match over: mummies ${g.mummyScore} - ${g.humanScore} humans (${g.matchWinner})`);
        broadcastMummyState(room, true);
        // The result has been delivered, so nobody stays parked in a dead room:
        // these sockets are free to queue again.
        for (const e of room.entries) e.ws.matchId = null;
        matches.delete(room.matchId);
        return;
    }

    g.phase = "round_break";
    g.endsAt = Date.now() + MUMMY_BREAK_MS;
    broadcastMummyState(room, true);
}

function mummyStatePayload(room, self) {
    const g = room.game;
    const now = Date.now();
    return {
        type: "match_state",
        match_id: room.matchId,
        mode: room.mode,
        phase: g.phase,
        round: g.round,
        rounds_total: MUMMY_ROUNDS,
        side_size: g.sideSize,
        round_seconds: Math.round(g.roundMs / 1000),
        remaining_seconds: g.endsAt > 0 ? Math.max(0, Math.ceil((g.endsAt - now) / 1000)) : 0,
        mummy_score: g.mummyScore,
        human_score: g.humanScore,
        roles: g.roles,
        hp_max: MUMMY_HP,
        down_seconds: MUMMY_DOWN_SECONDS,
        revive_seconds: MUMMY_REVIVE_SECONDS,
        round_outcome: g.roundOutcome,
        match_winner: g.matchWinner,
        ready_count: g.ready.size,
        required_players: room.entries.length,
        self_id: mummyIdOf(self),
        players: room.entries.map(e => {
            const id = mummyIdOf(e);
            const c = g.combat[id] || { hp: MUMMY_HP, downed: false, eliminated: false, reviveMs: 0, revivers: {} };
            const downLeft = c.downed ? Math.max(0, Math.ceil((c.downedSince + MUMMY_DOWN_MS - now) / 1000)) : 0;
            return {
                id: id,
                player_uid: e.uid,
                username: e.username,
                character_id: e.characterId,
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
        if (!g) continue;

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
                team = createTeam(ws, uid, data.username || "Player", data.character_id || 1, maxSize);
            } else if (team.leaderUid !== uid) {
                teamError(ws, "Only the team leader can invite players"); break;
            }

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
                characterId: data.character_id || 1
            });
            console.log(`[TEAM] ${uid} joined ${team.id} (${team.members.length}/${team.maxSize})`);
            broadcastTeam(team);
            break;
        }

        case 'team_decline': {
            const uid = bindUid(ws, data);
            const team = teams.get(String(data.team_id || ""));
            if (team) {
                const leader = team.members.find(m => m.uid === team.leaderUid);
                sendJson(leader && leader.ws, {
                    type: "team_invite_declined",
                    player_uid: uid,
                    username: data.username || "Player"
                });
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

        case 'quick_match': {
            const uid = bindUid(ws, data);
            // A socket already inside a live Mummy match is not a free body: letting
            // it queue again would put the same player in two arenas at once.
            const current = ws.matchId && matches.get(ws.matchId);
            if (current && current.game) break;

            const mode = data.mode || "MUMMY_VS_HUMAN";
            const characterId = data.character_id || 1;
            const username = data.username || "Player";
            const playerUid = uid || "";

            if (!queues[mode]) {
                queues[mode] = [];
            }
            if (!teamQueues[mode]) {
                teamQueues[mode] = [];
            }

            // The queue size is the server's roster, never the number the client
            // claims — so a party can only ever meet a party of the same size.
            const team = teamOf(ws);
            if (team && team.members.length > 1) {
                if (team.leaderUid !== playerUid) { teamError(ws, "Only the team leader can start matchmaking"); break; }
                removeFromAllQueues(ws);
                removeFromTeamQueue(team.id);
                queueTeam(mode, team);
                break;
            }

            removeFromAllQueues(ws);

            queues[mode].push({ ws, teamSize: 1, characterId, username, playerUid });
            console.log(`[QUEUE] Player joined ${mode} queue. Current waiting: ${queues[mode].length}`);

            if (queues[mode].length >= 2) {
                const player1 = queues[mode].shift();
                const player2 = queues[mode].shift();
                // Solo is a two-player room of two one-player sides.
                makeRoom(mode, [
                    { teamId: "", members: [player1] },
                    { teamId: "", members: [player2] }
                ]);
            } else {
                ws.send(JSON.stringify({
                    type: "player_joined",
                    player_count: 1,
                    required_players: 2
                }));
            }
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
                break;
            }
            removeFromAllQueues(ws);
            ws.send(JSON.stringify({ type: "match_cancelled" }));
            break;
        }

        case 'player_move':
        case 'player_action':
        case 'player_anim': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room) break;
            // Tag the relay so a room of up to 8 clients can tell who moved.
            const frame = Object.assign({}, data, {
                player_uid: ws.matchUid || "",
                spawn_index: ws.matchSpawnIndex === undefined ? -1 : ws.matchSpawnIndex
            });
            const txt = JSON.stringify(frame);
            for (const otherWs of room.players) {
                if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
                    otherWs.send(txt);
                }
            }
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
            if (g.phase !== "waiting") { broadcastMummyState(room, true); break; }

            g.ready.add(mummyIdOf(self));
            console.log(`[MUMMY] ${mummyIdOf(self)} ready in ${room.matchId} (${g.ready.size}/${room.entries.length})`);
            if (g.ready.size >= room.entries.length) beginMummyRound(room, 1);
            else broadcastMummyState(room, true);
            break;
        }

        // Only the catcher's own proximity is trusted: the attacker comes from the
        // socket, the role from the server's table, and a Human who is already down
        // or already out cannot be knocked a second time.
        case 'mummy_attack': {
            const room = ws.matchId && matches.get(ws.matchId);
            if (!room || !room.game) break;

            const g = room.game;
            if (g.phase !== "playing" || g.settled) break;

            const attacker = room.entries.find(e => e.ws === ws);
            if (!attacker) break;
            const attackerId = mummyIdOf(attacker);
            if (g.roles[attackerId] !== "mummy") break;
            if (!mummyAlive(room, attackerId)) break;

            const targetId = String(data.target_id || "");
            if (!room.entries.some(e => mummyIdOf(e) === targetId)) break;
            if (targetId === attackerId || g.roles[targetId] !== "human") break;

            // false = this Human is already down or already out, so the report is a
            // duplicate rather than a second elimination.
            if (!downMummyPlayer(room, targetId)) break;
            console.log(`[MUMMY] ${attackerId} knocked ${targetId} down in ${room.matchId}`);

            // 1v1 has no remaining teammate to wait for: the round ends on the down
            // and both players come back at full health, so nobody spectates.
            if (g.sideSize <= 1) settleMummyRound(room, "mummy");
            else broadcastMummyState(room, true);
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
});

server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Flame Strike Server listening on port ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`===========================================`);
});
