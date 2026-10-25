const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 7777;

// ── OAuth relay store (Google/Facebook login — no localhost) ──
const pendingAuth = new Map();
const AUTH_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (now - v.ts > AUTH_TTL_MS) pendingAuth.delete(k);
}, 60000);

const AUTH_CALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FLAME STRIKE</title>
<style>body{background:#0b070c;color:#e7d8c4;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#ff7a1a;font-size:30px;letter-spacing:4px;margin:0 0 16px}p{color:#8a7a72;font-size:15px}#st{color:#c43b4a;margin-top:16px}</style></head>
<body><div class="c"><h1>&#10003; FLAME STRIKE</h1><p id="st">Completing login...</p>
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
    st.textContent = 'Login successful! Return to FLAME STRIKE.';
    try { window.location.href = 'nightward://login'; } catch (e) {}
  }).catch(function(e) {
    st.textContent = 'Error sending tokens: ' + e;
  });
})();
</script></div></body></html>`;

// ── SERVER REGISTRY ───────────────────────────────────────
const SERVERS = [
  { id: "ASIA", name: "Server 1 (ASIA)", countries: ["Nepal", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Myanmar", "Cambodia", "Vietnam"] },
  { id: "ASIA 2", name: "Server 2 (ASIA 2)", countries: ["China", "Japan", "Korea", "Taiwan", "Hong Kong", "Malaysia", "Philippines", "Indonesia", "Thailand"] },
  { id: "EUROPE", name: "Server 3 (EUROPE)", countries: ["UK", "Ireland", "Germany", "France", "Italy", "Spain", "Netherlands", "Poland", "Sweden", "Ukraine"] },
  { id: "AFRICA", name: "Server 4 (AFRICA)", countries: ["South Africa", "Nigeria", "Kenya", "Egypt", "Morocco", "Ghana", "Tanzania", "Uganda"] },
  { id: "OCEANIA", name: "Server 5 (OCEANIA)", countries: ["Australia", "New Zealand", "Fiji", "Papua New Guinea", "Samoa"] },
  { id: "NORTH AMERICA", name: "Server 6 (NORTH AMERICA)", countries: ["USA", "Canada", "Mexico", "Guatemala", "Costa Rica", "Panama"] },
  { id: "SOUTH AMERICA", name: "Server 7 (SOUTH AMERICA)", countries: ["Brazil", "Argentina", "Colombia", "Chile", "Peru", "Venezuela"] },
  { id: "MIDDLE EAST", name: "Server 8 (MIDDLE EAST)", countries: ["UAE", "Saudi Arabia", "Qatar", "Kuwait", "Oman", "Bahrain", "Jordan", "Lebanon", "Iran", "Iraq"] },
];
const DEFAULT_SERVER_ID = SERVERS[0].id;
const serverById = (id) => SERVERS.find((sv) => sv.id === id) || null;
const MAX_PLAYERS = Math.max(10, Number(process.env.MAX_PLAYERS) || 400);
const DISABLED_SERVERS = new Set(
  (process.env.DISABLED_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

const BACKEND_HOSTS = {
  "dark-ward-sever.onrender.com": "ASIA",
  "darkward-asia2.onrender.com": "ASIA 2",
  "darkward-europe.onrender.com": "EUROPE",
  "darkwrad-afcria.onrender.com": "AFRICA",
  "ocenina-darkward.onrender.com": "OCEANIA",
  "north-amecria-ward.onrender.com": "NORTH AMERICA",
  "south-america-ward.onrender.com": "SOUTH AMERICA",
  "middle-east-ward.onrender.com": "MIDDLE EAST",
};
const BACKEND_URLS = {
  "ASIA": "https://dark-ward-sever.onrender.com",
  "ASIA 2": "https://darkward-asia2.onrender.com",
  "EUROPE": "https://darkward-europe.onrender.com",
  "AFRICA": "https://darkwrad-afcria.onrender.com",
  "OCEANIA": "https://ocenina-darkward.onrender.com",
  "NORTH AMERICA": "https://north-amecria-ward.onrender.com",
  "SOUTH AMERICA": "https://south-america-ward.onrender.com",
  "MIDDLE EAST": "https://middle-east-ward.onrender.com",
};
const POOL_OF = {
  "ASIA": "GLOBAL", "ASIA 2": "GLOBAL", "EUROPE": "GLOBAL", "AFRICA": "GLOBAL",
  "OCEANIA": "GLOBAL", "NORTH AMERICA": "GLOBAL", "SOUTH AMERICA": "GLOBAL", "MIDDLE EAST": "GLOBAL",
};

let SELF_ID = (process.env.SERVER_ID || "").trim();
let SELF_URL = (process.env.PUBLIC_URL || "").trim();
let PEERS = [];
let ENV_PEERS = [];

function rebuildPeers() {
  if (ENV_PEERS.length) { PEERS = ENV_PEERS; return; }
  const myPool = POOL_OF[SELF_ID] || SELF_ID;
  PEERS = Object.keys(BACKEND_URLS)
    .filter((id) => (POOL_OF[id] || id) === myPool && id !== SELF_ID)
    .map((id) => ({ id, url: BACKEND_URLS[id] }))
    .filter((p) => p.url);
}

function detectSelf(host) {
  if (!host) return;
  const h = String(host).toLowerCase().split(":")[0].trim();
  const found = BACKEND_HOSTS[h];
  if (!found) return;
  if (SELF_ID === found) return;
  SELF_ID = found;
  if (!SELF_URL) SELF_URL = "https://" + h;
  rebuildPeers();
}

if (process.env.SERVER_ID) {
  SELF_ID = process.env.SERVER_ID.trim();
  if (process.env.PUBLIC_URL) SELF_URL = process.env.PUBLIC_URL.trim();
  ENV_PEERS = (process.env.PEERS || "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf("=");
      if (i < 0) return null;
      return { id: p.slice(0, i).trim(), url: p.slice(i + 1).trim() };
    }).filter(Boolean);
}
rebuildPeers();

const pendingClaims = new Map();
const CLAIM_TTL_MS = 60000;

function httpPostJson(url, path, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(path, url); } catch { return resolve(null); }
    const payload = JSON.stringify(bodyObj || {});
    const mod = target.protocol === "http:" ? require("http") : require("https");
    const req = mod.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: target.pathname + (target.search || ""),
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: timeoutMs || 4000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

const presence = new Map();
const PRESENCE_TTL = 90000;

const server = http.createServer((req, res) => {
  detectSelf(req.headers && req.headers.host);
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
        
        // FIX: Changed regex from /^[a-f0-9]{16,64}$/ to /^[a-zA-Z0-9]{16,128}$/
        // This allows standard alphanumeric states generated by most OAuth clients.
        if (/^[a-zA-Z0-9]{16,128}$/.test(state) && at.length > 20 && at.length < 16384) {
          pendingAuth.set(state, { at, rt: String(data.refresh_token || ""), ts: Date.now() });
          console.log("[AUTH] tokens stored for state", state.slice(0, 8));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          console.log("[AUTH] invalid payload rejected. State:", state, "Length:", state.length);
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

  if (path === "/servers") {
    const list = SERVERS.map((sv) => {
      let connected = 0;
      let queued = 0;
      for (const w of allClients) {
        if (w.readyState === 1 && w.__serverId === sv.id) connected++;
      }
      for (const q of matchQueue) {
        if (q.ws && q.ws.readyState === 1 && q.serverId === sv.id) queued++;
        else if (q.isBot && q.serverId === sv.id) queued++;
      }
      const now = Date.now();
      let browsing = 0;
      for (const [pid, p] of presence) {
        if (p.serverId === sv.id && now - p.ts < PRESENCE_TTL) browsing++;
        else if (now - p.ts >= PRESENCE_TTL) presence.delete(pid);
      }
      const disabled = DISABLED_SERVERS.has(sv.id);
      const isSelf = sv.id === SELF_ID;
      const peerReal = peerLiveCount(sv.id);
      const real = isSelf ? livePlayerCount() : (peerReal > 0 ? peerReal : (connected + queued + browsing));
      return {
        id: sv.id, name: sv.name, countries: sv.countries || [], online: !disabled, status: disabled ? "offline" : "online",
        players: real, connected, queued, browsing, capacity: MAX_PLAYERS, load: Math.min(100, Math.round((real / MAX_PLAYERS) * 100)), full: real >= MAX_PLAYERS,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servers: list, poolLive: poolLiveCount(), poolCapacity: poolCapacity() }));
    return;
  }

  if (req.url === "/rooms") {
    const list = Object.entries(rooms)
      .filter(([, r]) => r.players.length < r.maxPlayers)
      .map(([code, room]) => ({ code, name: room.roomName, players: room.players.length, maxPlayers: room.maxPlayers, region: room.region, mode: room.mode, host: room.hostName }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms: list }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", rooms: Object.keys(rooms).length, players: Object.values(rooms).reduce((a, r) => a + r.players.length, 0),
      serverId: SELF_ID, pool: POOL_OF[SELF_ID] || SELF_ID, peers: PEERS.length, capacity: MAX_PLAYERS, live: livePlayerCount(), full: isServerFull(),
      poolLive: poolLiveCount(), poolCapacity: poolCapacity(),
    }));
    return;
  }

  if (path === "/mm/status" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const allMode = data.mode === "";
      const mode = String(data.mode || "SURVIVAL");
      const teamSize = Math.max(1, Math.min(4, Number(data.teamSize) || 1));
      const groupId = String(data.groupId || "");
      const now = Date.now();
      const waiting = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot)
        && now - q.queuedAt < 180000
        && (allMode || (q.mode === mode && q.teamSize === teamSize))
        && (allMode || (q.groupId || "") === groupId) && !q.claimedBy);
      let oldest = 0;
      for (const q of waiting) if (!oldest || q.queuedAt < oldest) oldest = q.queuedAt;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, serverId: SELF_ID, pool: POOL_OF[SELF_ID] || SELF_ID,
        waiting: waiting.length, oldestQueuedAt: oldest, players: livePlayerCount(), capacity: MAX_PLAYERS, full: isServerFull(),
        rooms: Object.keys(rooms).length, team: true, teamSlots: TEAM_SLOTS, groupV2: true, groupKick: true, groupMm: true,
        bots: true, botFillMs: BOT_FILL_DELAY_MS, botFillMaxMs: BOT_FILL_DELAY_MAX_MS, botModes: BOT_MODES, botMax: BOT_MAX_PER_ROOM,
      }));
      return;
    });
    return;
  }

  if (path === "/mm/online-list" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: localOnlinePlayers() }));
    return;
  }

  if (path === "/mm/group-invite" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const targetProfileId = String(data.targetProfileId || "");
      const payload = data.payload || {};
      let delivered = false;
      if (targetProfileId && payload && payload.type === "group_invite") {
        for (const w of allClients) {
          if (w.readyState === 1 && w.chatProfileId && w.chatProfileId === targetProfileId) {
            send(w, payload);
            delivered = true;
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered }));
    });
    return;
  }

  if (path === "/mm/team-accept" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const team = teams.get(teamId);
      if (!team) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: false }));
        return;
      }
      const pid = String(data.profileId || "");
      const nm = String(data.name || "Player");
      const slotIdx = Number(data.slotIndex);
      const result = teamApplyAccept(team, pid, nm, slotIdx);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Object.assign({ ok: true, delivered: true }, result)));
    });
    return;
  }

  if (path === "/mm/team-member-left" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const pid = String(data.profileId || "");
      const team = teams.get(teamId);
      if (team && pid) {
        teamRemoveMember(team, pid);
        teamNotifyAll(team, [pid]);
        if (team.members.length === 0) teams.delete(teamId);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === "/mm/team-kick" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const targetId = String(data.targetProfileId || "");
      const pid = String(data.profileId || "");
      const team = teams.get(teamId);
      if (team && targetId) {
        if (pid && team.ownerProfileId && team.ownerProfileId !== pid) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "Only the group leader can kick players." }));
          return;
        }
        const had = teamRemoveMember(team, targetId);
        teamNotifyAll(team, [targetId]);
        for (const w of allClients) {
          if (w.readyState !== 1 || !w.chatProfileId) continue;
          if (w.chatProfileId === targetId) {
            send(w, { type: "team_removed", teamId, reason: "kicked" });
            send(w, { type: "team_state", teamId, ownerProfileId: team.ownerProfileId || "", teamSize: Number(team.teamSize || 0), maxSize: teamMaxSize(team), members: [], pending: [] });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: had, members: teamMembersPayload(team) }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "Team not found." }));
      }
    });
    return;
  }

  if (path === "/mm/team-decline" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const pid = String(data.profileId || "");
      const team = teams.get(teamId);
      if (team && pid && team.pending.some((p) => p.profileId === pid)) {
        team.pending = team.pending.filter((p) => p.profileId !== pid);
        teamNormalize(team);
        teamNotifyAll(team);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === "/mm/team-notify" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const members = Array.isArray(data.members) ? data.members : [];
      const pending = Array.isArray(data.pending) ? data.pending : [];
      const extraIds = Array.isArray(data.extraIds) ? data.extraIds : [];
      const extras = {
        ownerProfileId: String(data.ownerProfileId || ""),
        teamSize: Number(data.teamSize || 0),
        maxSize: Number(data.maxSize || 4),
      };
      if (teamId) teamNotifyLocal(members, pending, teamId, extraIds, extras);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === "/mm/team-broadcast" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const payload = (data.payload && typeof data.payload === "object") ? data.payload : null;
      const excludeProfileId = String(data.excludeProfileId || "");
      if (teamId && payload) teamBroadcastLocal(teamId, payload, excludeProfileId, null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (path === "/mm/team-invite-request" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const teamId = String(data.teamId || "");
      const team = teams.get(teamId);
      if (!team) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, delivered: false, message: "Team not found." }));
        return;
      }
      const targetProfileId = String(data.targetProfileId || "");
      const result = teamProcessInvite(team, {
        targetProfileId,
        targetName: String(data.targetName || ""),
        wantSlot: Number(data.wantSlot),
        ownerSlot: Number(data.ownerSlot),
        fromName: String(data.fromName || "Player"),
        fromProfileId: String(data.fromProfileId || ""),
        inviterProfileId: String(data.fromProfileId || ""),
      });
      if (!result.ok) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, delivered: false, message: result.message }));
        return;
      }
      const payload = {
        type: "team_invite",
        teamId,
        slotIndex: result.slot,
        fromName: String(data.fromName || "Player"),
        fromProfileId: String(data.fromProfileId || ""),
        roomCode: String(data.roomCode || "").trim().toUpperCase(),
        roomUrl: String(data.roomUrl || "").trim(),
        ts: Date.now(),
      };
      teamDeliverInvite(targetProfileId, payload).then((delivered) => {
        if (!delivered) {
          team.pending = team.pending.filter((p) => p.profileId !== targetProfileId);
          teamNotifyAll(team);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: delivered, delivered, slotIndex: result.slot, message: delivered ? "" : "That friend is not online." }));
      });
    });
    return;
  }

  if (path === "/mm/team-invite" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const targetProfileId = String(data.targetProfileId || "");
      const payload = data.payload || {};
      let delivered = false;
      if (targetProfileId && payload && payload.type === "team_invite") {
        for (const w of allClients) {
          if (w.readyState === 1 && w.chatProfileId && w.chatProfileId === targetProfileId) {
            send(w, payload);
            delivered = true;
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered }));
    });
    return;
  }

  if (path === "/mm/claim" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const mode = String(data.mode || "SURVIVAL");
      const teamSize = Math.max(1, Math.min(4, Number(data.teamSize) || 1));
      const groupId = String(data.groupId || "");
      const now = Date.now();
      let idx = -1;
      for (let i = 0; i < matchQueue.length; i++) {
        const q = matchQueue[i];
        if (q.ws) { if (q.ws.readyState !== 1) continue; } else if (!q.isBot) { continue; }
        if (now - q.queuedAt >= 180000) continue;
        if (q.mode !== mode || q.teamSize !== teamSize) continue;
        if ((q.groupId || "") !== groupId) continue;
        if (q.claimedBy) continue;
        if (q.pairing) continue;
        if (idx < 0 || q.queuedAt < matchQueue[idx].queuedAt) idx = i;
      }
      if (idx < 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "no_waiting_player" }));
        return;
      }
      const entry = matchQueue[idx];
      const reqKey = hostKeyOf(Number(data.myLoad) || 0, Number(data.myOldest) || 0, String(data.myId || ""));
      const myKey = hostKeyOf(livePlayerCount(), entry.queuedAt, SELF_ID);
      if (!hostKeyLess(reqKey, myKey)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "not_your_turn" }));
        return;
      }
      entry.claimedBy = String(data.claimId || "");
      entry.claimedAt = now;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, claimId: entry.claimedBy, queuedAt: entry.queuedAt,
        player: { name: entry.playerName, characterId: entry.characterId, loginType: entry.loginType, userId: entry.userId, profileId: entry.profileId, device: entry.device, groupId: entry.groupId, region: entry.region },
      }));
    });
    return;
  }

  if (path === "/mm/release" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { data = {}; }
      const claimId = String(data.claimId || "");
      let found = null;
      for (const q of matchQueue) {
        if (q.claimedBy === claimId) { found = q; break; }
      }
      if (found && data.cancel) {
        found.claimedBy = "";
        found.claimedAt = 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, cancelled: true }));
        return;
      }
      if (found) {
        matchQueue = matchQueue.filter((q) => q !== found);
        send(found.ws, {
          type: "match_migrate", roomCode: String(data.roomCode || ""), hostUrl: String(data.hostUrl || ""),
          playerId: Number(data.playerId) || 2, mode: String(data.mode || found.mode), maxPlayers: Number(data.maxPlayers) || (2 * found.teamSize),
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, released: !!found }));
    });
    return;
  }

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
        at.addGrant({ roomJoin: true, room: String(room), canPublish: true, canSubscribe: true, canPublishData: true });
        const token = await at.toJwt();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, url: process.env.LIVEKIT_URL || "wss://night-ward-tz4q970d.livekit.cloud" }));
      } catch (e) {
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
    if (!p.ws) return;
    if (p.ws !== exclude && p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendToAll(code, data) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(data);
  rooms[code].players.forEach((p) => {
    if (!p.ws) return;
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

function sendGlobal(data) {
  const msg = JSON.stringify(data);
  allClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

const BOT_FILL_DELAY_MS = Math.max(2000, Number(process.env.BOT_FILL_DELAY_MS) || 30000);
const BOT_FILL_DELAY_MAX_MS = Math.max(BOT_FILL_DELAY_MS, Number(process.env.BOT_FILL_DELAY_MAX_MS) || 50000);
const BOT_MAX_PER_ROOM = Math.max(0, Number(process.env.BOT_MAX_PER_ROOM) || 7);
const BOT_MODES = ["MUMMY_VS_HUMAN"];
const BOT_NAMES = ["NOOB", "RAFA", "ZEKE", "VIPER", "GHOST", "BOLT", "FANG", "ROOK", "MIRA", "KANE"];
const BOT_PERSONALITIES = ["aggressive", "balanced", "cautious", "berserker", "opportunist"];
const BOT_CHARACTERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
let botSeq = 0;
const botTimers = new Map();

function botProfileId() {
  botSeq += 1;
  return "bot_" + Date.now().toString(36) + "_" + botSeq;
}

function addBotToRoom(code) {
  const room = rooms[code];
  if (!room) return null;
  if (room.players.length >= room.maxPlayers) return null;
  const bots = room.players.filter((p) => p.isBot);
  if (bots.length >= BOT_MAX_PER_ROOM) return null;
  let id = 1;
  for (const p of room.players) id = Math.max(id, p.id + 1);
  const nm = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + "_" + (botSeq + 1);
  const skill = Math.round((0.25 + Math.random() * 0.7) * 100) / 100;
  const personality = BOT_PERSONALITIES[Math.floor(Math.random() * BOT_PERSONALITIES.length)];
  const bot = {
    ws: null, id, name: nm, characterId: BOT_CHARACTERS[Math.floor(Math.random() * BOT_CHARACTERS.length)],
    loginType: "bot", userId: "", profileId: botProfileId(),
    groupId: "", device: "", region: room.region || DEFAULT_SERVER_ID,
    ready: true, slot: id, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    isBot: true, botSkill: skill, botPersonality: personality,
  };
  room.players.push(bot);
  broadcast(code, { type: "player_joined", player: playerPublic(bot), players: roomPlayers(code), hostId: hostIdOf(room) }, null);
  return bot;
}

function scheduleQueueBotFill(entry) {
  if (!entry || entry.botFillTimer) return;
  if (!BOT_MODES.includes(entry.mode)) return;
  const delay = BOT_FILL_DELAY_MS + Math.floor(Math.random() * Math.max(0, BOT_FILL_DELAY_MAX_MS - BOT_FILL_DELAY_MS));
  const h = setTimeout(() => {
    entry.botFillTimer = null;
    if (!matchQueue.includes(entry)) return;
    if (!BOT_MODES.includes(entry.mode)) return;
    const required = 2 * entry.teamSize;
    const groupId = entry.groupId || "";
    const local = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && q.mode === entry.mode && q.teamSize === entry.teamSize && q.serverId === entry.serverId && (q.groupId || "") === groupId && !q.claimedBy).length;
    let need = required - local;
    if (need <= 0) return;
    let added = 0;
    while (need > 0 && added < BOT_MAX_PER_ROOM) {
      const bot = makeBotQueueEntry(entry);
      if (!bot) break;
      matchQueue.push(bot);
      added += 1;
      need -= 1;
    }
    if (added > 0) tryQuickPair(entry);
  }, BOT_FILL_DELAY_MS);
  entry.botFillTimer = h;
}

function makeBotQueueEntry(src) {
  botSeq += 1;
  const skill = Math.round((0.25 + Math.random() * 0.7) * 100) / 100;
  const personality = BOT_PERSONALITIES[Math.floor(Math.random() * BOT_PERSONALITIES.length)];
  const nm = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + "_" + botSeq;
  return {
    ws: null, playerName: nm, characterId: BOT_CHARACTERS[Math.floor(Math.random() * BOT_CHARACTERS.length)],
    loginType: "bot", userId: "", profileId: botProfileId(),
    groupId: src.groupId || "", device: "", region: src.region || DEFAULT_SERVER_ID,
    serverId: src.serverId || "", mode: src.mode, teamSize: src.teamSize,
    queuedAt: Date.now(), isBot: true, botSkill: skill, botPersonality: personality,
    claimedBy: "", botFillTimer: null,
  };
}

function scheduleBotFill(code) {
  if (botTimers.has(code)) return;
  const h = setTimeout(() => {
    botTimers.delete(code);
    const room = rooms[code];
    if (!room) return;
    if (room.players.length >= room.maxPlayers) return;
    if (room.players.filter((p) => p.isBot).length >= BOT_MAX_PER_ROOM) return;
    addBotToRoom(code);
  }, BOT_FILL_DELAY_MS);
  botTimers.set(code, h);
}

function cancelBotFill(code) {
  if (!botTimers.has(code)) return;
  clearTimeout(botTimers.get(code));
  botTimers.delete(code);
}

function removeBotForRealPlayer(code) {
  const room = rooms[code];
  if (!room) return null;
  const idx = room.players.findIndex((p) => p.isBot);
  if (idx < 0) return null;
  const bot = room.players[idx];
  room.players.splice(idx, 1);
  broadcast(code, { type: "player_left", playerId: bot.id, players: roomPlayers(code), hostId: hostIdOf(room) }, null);
  return bot;
}

const teams = new Map();
const TEAM_SLOTS = 4;
const TEAM_SIZE_DEFAULT = 4;
const TEAM_INVITE_TTL_MS = Number(process.env.TEAM_INVITE_TTL_MS) || 120000;
const localTeams = new Map();

function teamGet(teamId) {
  let t = teams.get(teamId);
  if (!t) {
    t = { id: teamId, ownerProfileId: "", teamSize: TEAM_SIZE_DEFAULT, members: [], pending: [], kicked: [] };
    teams.set(teamId, t);
  }
  if (!Array.isArray(t.members)) t.members = [];
  if (!Array.isArray(t.pending)) t.pending = [];
  if (!Array.isArray(t.kicked)) t.kicked = [];
  return t;
}

function teamMaxSize(team) {
  const ts = Number(team.teamSize || 0);
  if (ts === 1 || ts === 2 || ts === 4) return ts;
  return TEAM_SIZE_DEFAULT;
}

function teamIsFull(team, exceptPid) {
  const cap = teamMaxSize(team);
  let n = 0;
  for (const m of team.members) if (!exceptPid || m.profileId !== exceptPid) n += 1;
  for (const p of team.pending) if (!exceptPid || p.profileId !== exceptPid) n += 1;
  return n >= cap;
}

function teamSlotUsed(team, slot, exceptPid) {
  for (const m of team.members) {
    if (m.slot === slot && m.profileId !== exceptPid) return true;
  }
  for (const p of team.pending) {
    if (p.slot === slot && p.profileId !== exceptPid) return true;
  }
  return false;
}

function teamFirstFreeSlot(team, exceptPid) {
  for (let i = 0; i < TEAM_SLOTS; i++) {
    if (!teamSlotUsed(team, i, exceptPid)) return i;
  }
  return -1;
}

function teamPruneExpired(team) {
  const now = Date.now();
  const before = team.pending.length;
  team.pending = team.pending.filter((p) => now - (Number(p.ts) || 0) <= TEAM_INVITE_TTL_MS);
  return team.pending.length !== before;
}

function teamMembersPayload(team) {
  return team.members.slice().sort((a, b) => (a.slot || 0) - (b.slot || 0)).map((m) => ({
    profileId: m.profileId, name: m.name, slot: m.slot, isLeader: m.profileId === team.ownerProfileId,
  }));
}

function teamPendingPayload(team) {
  return team.pending.slice().sort((a, b) => (a.slot || 0) - (b.slot || 0)).map((p) => ({ profileId: p.profileId, name: p.name, slot: p.slot }));
}

function teamStatePayload(team) {
  return {
    teamId: team.id, ownerProfileId: team.ownerProfileId || "", teamSize: Number(team.teamSize || 0), maxSize: teamMaxSize(team),
    members: teamMembersPayload(team), pending: teamPendingPayload(team),
  };
}

function teamNormalize(team) {
  team.members.sort((a, b) => (a.slot || 0) - (b.slot || 0));
  team.pending.sort((a, b) => (a.slot || 0) - (b.slot || 0));
}

function teamRemovePlayerEverywhere(team, pid, exceptTeamId) {
  for (const [tid, t] of teams.entries()) {
    if (tid === exceptTeamId) continue;
    const had = t.members.some((m) => m.profileId === pid) || t.pending.some((p) => p.profileId === pid);
    if (!had) continue;
    teamRemoveMember(t, pid);
    teamNotifyAll(t, [pid]);
    if (t.members.length === 0) teams.delete(tid);
  }
}

function teamRegisterMember(team, pid, nm, wantSlot) {
  const existing = team.members.find((m) => m.profileId === pid);
  let slot = (Number.isInteger(wantSlot) && wantSlot >= 0 && wantSlot < TEAM_SLOTS) ? wantSlot : -1;
  if (existing) {
    if (slot < 0 || teamSlotUsed(team, slot, pid)) slot = existing.slot;
    existing.slot = slot;
    existing.name = nm || existing.name;
    return slot;
  }
  if (slot < 0 || teamSlotUsed(team, slot, pid)) slot = teamFirstFreeSlot(team, pid);
  if (slot < 0) return -1;
  if (team.kicked && team.kicked.includes(pid)) return -1;
  if (teamIsFull(team, pid)) return -1;
  team.members.push({ profileId: pid, name: nm, slot });
  if (!team.ownerProfileId) {
    team.ownerProfileId = pid;
    team.teamSize = TEAM_SIZE_DEFAULT;
  }
  teamRemovePlayerEverywhere(team, pid, team.id);
  return slot;
}

function teamRemoveMember(team, pid) {
  const had = team.members.some((m) => m.profileId === pid);
  team.members = team.members.filter((m) => m.profileId !== pid);
  team.pending = team.pending.filter((p) => p.profileId !== pid);
  if (!team.kicked.includes(pid)) team.kicked.push(pid);
  if (team.ownerProfileId === pid) {
    team.pending = [];
    const rest = team.members.slice().sort((a, b) => (a.slot || 0) - (b.slot || 0));
    team.ownerProfileId = rest.length ? rest[0].profileId : "";
  }
  teamNormalize(team);
  return had;
}

function teamApplyAccept(team, pid, nm, preferSlot) {
  const pruned = teamPruneExpired(team);
  if (!pid) return { ok: false, message: "Team join failed — not logged in." };
  const already = team.members.find((m) => m.profileId === pid);
  if (already) {
    team.pending = team.pending.filter((p) => p.profileId !== pid);
    teamNormalize(team);
    teamNotifyAll(team);
    return { ok: true, slot: already.slot, members: teamMembersPayload(team), pending: teamPendingPayload(team) };
  }
  if (team.kicked && team.kicked.includes(pid)) {
    team.pending = team.pending.filter((p) => p.profileId !== pid);
    teamNotifyAll(team);
    return { ok: false, message: "You were removed from this group by the leader." };
  }
  const pend = team.pending.find((p) => p.profileId === pid);
  if (!pend) {
    if (pruned) teamNotifyAll(team);
    return { ok: false, message: "That invitation is no longer valid (expired or already used)." };
  }
  let slot = pend.slot;
  if (!Number.isInteger(slot) || slot < 0 || slot >= TEAM_SLOTS || teamSlotUsed(team, slot, pid)) {
    slot = teamFirstFreeSlot(team, pid);
  }
  if (slot < 0) {
    team.pending = team.pending.filter((p) => p.profileId !== pid);
    teamNotifyAll(team);
    return { ok: false, message: "Team is full (4/4)." };
  }
  if (teamIsFull(team, pid)) {
    team.pending = team.pending.filter((p) => p.profileId !== pid);
    teamNotifyAll(team);
    return { ok: false, message: "Team is full." };
  }
  team.pending = team.pending.filter((p) => p.profileId !== pid);
  team.members.push({ profileId: pid, name: nm || pend.name || "Player", slot });
  teamNormalize(team);
  teamRemovePlayerEverywhere(team, pid, team.id);
  teamNotifyAll(team);
  return { ok: true, slot, members: teamMembersPayload(team), pending: teamPendingPayload(team) };
}

function teamNotifyLocal(members, pending, teamId, extraIds, stateExtras) {
  const ids = [];
  for (const m of members) ids.push(m.profileId);
  for (const p of pending) ids.push(p.profileId);
  for (const e of (extraIds || [])) if (e) ids.push(e);
  for (const w of allClients) {
    if (w.readyState !== 1 || !w.chatProfileId) continue;
    if (ids.includes(w.chatProfileId)) {
      const payload = Object.assign({ type: "team_state", teamId, members, pending }, stateExtras || {});
      send(w, payload);
      send(w, { type: "team_members", teamId, members });
    }
  }
}

function teamNotifyAll(team, extraIds) {
  const members = teamMembersPayload(team);
  const pending = teamPendingPayload(team);
  const extras = {
    ownerProfileId: team.ownerProfileId || "", teamSize: Number(team.teamSize || 0), maxSize: teamMaxSize(team),
  };
  teamNotifyLocal(members, pending, team.id, extraIds, extras);
  for (const peer of (PEERS || [])) {
    httpPostJson(peer.url, "/mm/team-notify", { teamId: team.id, members, pending, ownerProfileId: extras.ownerProfileId, teamSize: extras.teamSize, maxSize: extras.maxSize, extraIds: (extraIds || []).filter(Boolean) }, 3000);
  }
}

function teamIdOfProfileAny(pid) {
  const p = String(pid || "");
  if (!p) return "";
  const local = teamIdOfProfile(p);
  if (local) return local;
  for (const [tid, set] of localTeams.entries()) {
    if (set && set.has(p)) return tid;
  }
  return "";
}

function teamLocalRecipientIds(teamId) {
  const ids = new Set();
  const tid = String(teamId || "");
  const team = teams.get(tid);
  if (team) for (const m of team.members) ids.add(m.profileId);
  const local = localTeams.get(tid);
  if (local) for (const p of local) ids.add(p);
  return ids;
}

function teamBroadcastLocal(teamId, payload, excludeProfileId, excludeWs) {
  const ids = teamLocalRecipientIds(teamId);
  const ex = String(excludeProfileId || "");
  for (const w of allClients) {
    if (w.readyState !== 1 || !w.chatProfileId) continue;
    if (w === excludeWs) continue;
    if (ex && w.chatProfileId === ex) continue;
    if (ids.has(w.chatProfileId)) send(w, payload);
  }
}

function teamBroadcastAll(teamId, payload, excludeProfileId, excludeWs) {
  const tid = String(teamId || "");
  if (!tid) return;
  teamBroadcastLocal(tid, payload, excludeProfileId, excludeWs);
  for (const peer of (PEERS || [])) {
    httpPostJson(peer.url, "/mm/team-broadcast", { teamId: tid, payload, excludeProfileId: String(excludeProfileId || "") }, 2000);
  }
}

function teamProcessInvite(team, opts) {
  const targetProfileId = String(opts.targetProfileId || "");
  const targetName = String(opts.targetName || "");
  const inviterPid = String(opts.inviterProfileId || "");
  if (inviterPid && !team.ownerProfileId) team.ownerProfileId = inviterPid;
  if (teamIsFull(team, targetProfileId)) return { ok: false, message: "Team is full." };
  if (team.kicked && team.kicked.includes(targetProfileId)) return { ok: false, message: "That player was removed from this group." };
  const wantSlot = Number(opts.wantSlot);
  const ownerSlot = Number(opts.ownerSlot);
  const fromName = String(opts.fromName || "Player");
  const fromProfileId = String(opts.fromProfileId || "");
  teamPruneExpired(team);
  if (fromProfileId && !team.members.some((m) => m.profileId === fromProfileId)) {
    const own = teamRegisterMember(team, fromProfileId, fromName, Number.isInteger(ownerSlot) ? ownerSlot : -1);
    if (own < 0) return { ok: false, message: "Team is full (4/4)." };
  }
  const already = team.members.find((m) => m.profileId === targetProfileId);
  if (already) return { ok: true, slot: already.slot, resend: true };
  const dupe = team.pending.find((p) => p.profileId === targetProfileId);
  if (dupe) return { ok: true, slot: dupe.slot, resend: true };
  let slot = (Number.isInteger(wantSlot) && wantSlot >= 0 && wantSlot < TEAM_SLOTS) ? wantSlot : -1;
  if (slot < 0 || teamSlotUsed(team, slot, targetProfileId)) slot = teamFirstFreeSlot(team, targetProfileId);
  if (slot < 0) return { ok: false, message: "Team is full (4/4)." };
  team.pending.push({ profileId: targetProfileId, name: targetName || "Player", slot, ts: Date.now() });
  teamNormalize(team);
  teamNotifyAll(team);
  return { ok: true, slot, resend: false };
}

function teamDeliverInvite(targetProfileId, payload) {
  let sent = false;
  for (const w of allClients) {
    if (w.readyState === 1 && w.chatProfileId && w.chatProfileId === targetProfileId) {
      send(w, payload);
      sent = true;
    }
  }
  if (sent) return Promise.resolve(true);
  const peers = PEERS || [];
  if (!peers.length) return Promise.resolve(false);
  return Promise.all(peers.map((peer) => httpPostJson(peer.url, "/mm/team-invite", { targetProfileId, payload }, 3000))).then((results) => results.some((r) => r && r.delivered));
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function playerPublic(p) {
  if (!p) return { id: 0, name: "?", characterId: 0, ready: false, slot: 0, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, loginType: "guest", groupId: "", region: "", profileId: "", isBot: false, botSkill: 0.5, botPersonality: "balanced" };
  return { id: p.id, name: p.name, characterId: p.characterId, ready: p.ready, slot: p.slot, position: p.position, rotation: p.rotation, loginType: p.loginType || "guest", groupId: p.groupId || "", region: p.region || "", profileId: p.profileId || "", isBot: !!p.isBot, botSkill: p.botSkill != null ? p.botSkill : 0.5, botPersonality: p.botPersonality || "balanced" };
}

function roomPlayers(code) {
  if (!rooms[code] || !Array.isArray(rooms[code].players)) return [];
  return rooms[code].players.filter(Boolean).map(playerPublic);
}

function findPlayer(code, ws) {
  return rooms[code]?.players.find((p) => p.ws === ws);
}

function hostIdOf(room) {
  const h = room.players.find((p) => p.ws === room.host);
  return h ? h.id : (room.players[0] ? room.players[0].id : 1);
}

function localOnlinePlayers() {
  const out = [];
  const seen = new Set();
  for (const w of allClients) {
    if (w.readyState !== 1) continue;
    const pid = w.chatProfileId || "";
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push({ profileId: pid, name: w.chatName || "Player" });
  }
  return out;
}

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

function interleaveGroups(players) {
  const buckets = new Map();
  for (const p of players) {
    const g = p.groupId || "";
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(p);
  }
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

function pumpQueueGroups() {
  const groups = new Map();
  for (const q of matchQueue) {
    if (q.claimedBy) continue;
    if (!q.ws || q.ws.readyState !== 1) continue;
    const g = q.groupId || "";
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(q);
  }
  const all = [...groups.entries()];
  all.sort((a, b) => b[1].length - a[1].length);
  const merged = new Set();
  for (const [gid, entries] of all) {
    if (merged.has(gid)) continue;
    const size = entries[0].teamSize || 4;
    if (size <= 1) continue;
    if (entries.length >= size) continue;
    for (const [gid2, entries2] of all) {
      if (gid2 === gid || merged.has(gid2)) continue;
      if (entries2.length >= size) continue;
      if (entries2[0].mode !== entries[0].mode) continue;
      if (entries2[0].serverId !== entries[0].serverId) continue;
      if (entries[0].mode !== "MUMMY_VS_HUMAN") continue;
      for (const e of entries2) {
        e.groupId = gid;
        e.teamSize = size;
        const team = teams.get(gid);
        if (team && e.profileId) {
          teamRegisterMember(team, e.profileId, e.playerName, -1);
          const oldTeam = teams.get(gid2);
          if (oldTeam) {
            teamRemoveMember(oldTeam, e.profileId);
            teamNotifyAll(oldTeam, [e.profileId]);
            if (oldTeam.members.length === 0) teams.delete(gid2);
          }
          teamNotifyAll(team);
        }
      }
      merged.add(gid2);
    }
  }
}

function progressTo(mode, teamSize, serverId, groupId) {
  const required = 2 * teamSize;
  const same = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && q.mode === mode && q.teamSize === teamSize && q.serverId === serverId && !q.claimedBy);
  const count = Math.min(same.length, required);
  same.forEach((q) => { if (q.ws) send(q.ws, { type: "match_progress", count, required }); });
  return same;
}

function teamIdOfProfile(pid) {
  const p = String(pid || "");
  if (!p) return "";
  for (const [tid, t] of teams.entries()) {
    if (t.members.some((m) => m.profileId === p)) return tid;
  }
  return "";
}

function sameTeam(attackerPid, targetPid) {
  const a = String(attackerPid || "");
  const b = String(targetPid || "");
  if (!a || !b || a === b) return false;
  const ta = teamIdOfProfile(a);
  const tb = teamIdOfProfile(b);
  return !!(ta && tb && ta === tb);
}

function pickParties(same, required) {
  const parties = new Map();
  for (const e of same) {
    const g = e.groupId || ("solo:" + (e.id || e.profileId || e.playerName));
    if (!parties.has(g)) parties.set(g, []);
    parties.get(g).push(e);
  }
  const out = [];
  let total = 0;
  for (const [, list] of parties) {
    if (total + list.length > required) continue;
    for (const e of list) out.push(e);
    total += list.length;
  }
  return out;
}

function localOldestQueuedAt(mode, teamSize, groupId) {
  let oldest = 0;
  for (const q of matchQueue) {
    if (q.ws) { if (q.ws.readyState !== 1) continue; } else if (!q.isBot) continue;
    if (q.mode !== mode || q.teamSize !== teamSize) continue;
    if ((q.groupId || "") !== (groupId || "")) continue;
    if (q.claimedBy) continue;
    if (!oldest || q.queuedAt < oldest) oldest = q.queuedAt;
  }
  return oldest;
}

function hostKeyOf(load, oldest, id) {
  return [Number(load) || 0, Number(oldest) || 0, String(id || "")];
}
function hostKeyLess(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

let peerScanCursor = 0;
function nextPeers(count) {
  if (PEERS.length === 0) return [];
  const n = Math.min(count, PEERS.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(PEERS[(peerScanCursor + i) % PEERS.length]);
  }
  peerScanCursor = (peerScanCursor + n) % PEERS.length;
  return out;
}

async function tryPeerPair(entry) {
  if (PEERS.length === 0) return false;
  if (entry.pairing) return false;
  if (!matchQueue.includes(entry)) return false;
  if (entry.ws) { if (entry.ws.readyState !== 1) return false; } else if (!entry.isBot) return false;
  if (entry.teamSize !== 1) return false;
  entry.pairing = true;
  try {
    return await _tryPeerPairInner(entry);
  } finally {
    entry.pairing = false;
  }
}

async function _tryPeerPairInner(entry) {
  if (isServerFull()) return false;
  const required = 2 * entry.teamSize;
  const groupId = entry.groupId || "";
  const localCount = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && q.mode === entry.mode && q.teamSize === entry.teamSize && q.serverId === entry.serverId && (q.groupId || "") === groupId && !q.claimedBy).length;
  if (localCount >= required) return false;
  const myOldest = localOldestQueuedAt(entry.mode, entry.teamSize, groupId);
  const candidates = nextPeers(3);
  const results = await Promise.all(candidates.map(async (peer) => {
    const status = await httpPostJson(peer.url, "/mm/status", { mode: entry.mode, teamSize: entry.teamSize, groupId }, 2500);
    if (!status || !status.ok) return null;
    cachePeerLive(peer.id, status.players);
    const peerOldest = Number(status.oldestQueuedAt) || 0;
    if (!peerOldest) return null;
    const myKey = hostKeyOf(livePlayerCount(), myOldest, SELF_ID);
    const peerKey = hostKeyOf(Number(status.players) || 0, peerOldest, peer.id);
    if (!hostKeyLess(myKey, peerKey)) return null;
    const claimId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const res = await httpPostJson(peer.url, "/mm/claim", { claimId, mode: entry.mode, teamSize: entry.teamSize, groupId, myOldest, myId: SELF_ID, myLoad: livePlayerCount() }, 3000);
    if (!res || !res.ok || !res.player) return null;
    return { peer, res, claimId };
  }));
  for (const hit of results) {
    if (!hit) continue;
    const { peer, res, claimId } = hit;
    const remote = res.player;
    if (!matchQueue.includes(entry) || (entry.ws ? entry.ws.readyState !== 1 : !entry.isBot) || entry.claimedBy) {
      await httpPostJson(peer.url, "/mm/release", { claimId, cancel: true }, 3000);
      return false;
    }
    const code = genCode();
    const localPlayer = { ws: entry.ws, id: 1, name: entry.playerName, characterId: entry.characterId, loginType: entry.loginType, userId: entry.userId, profileId: entry.profileId || "", groupId: groupId, device: entry.device, region: entry.region || "ASIA", ready: false, slot: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const remotePlayer = { ws: null, id: 2, name: remote.name || "Player", characterId: remote.characterId || 0, loginType: remote.loginType || "guest", userId: remote.userId || "", profileId: remote.profileId || "", groupId: remote.groupId || groupId, device: remote.device || "", region: remote.region || entry.region || "ASIA", ready: false, slot: 2, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    rooms[code] = { host: entry.ws, hostName: entry.playerName, roomName: "Match", region: "GLOBAL", mode: entry.mode, maxPlayers: required, loginType: entry.loginType, players: [localPlayer, remotePlayer], gameStarted: true, matchmadeAt: Date.now(), matchLikes: {}, matchEliminated: [], awaitingRemote: true };
    pendingClaims.set(code, { roomCode: code, slotIndex: 1, player: remotePlayer, mode: entry.mode, maxPlayers: required, claimId, at: Date.now() });
    matchQueue = matchQueue.filter((q) => q !== entry);
    if (entry.ws) entry.ws.setRoom(code);
    send(entry.ws, { type: "room_created", roomCode: code, roomName: "Match", region: "GLOBAL", mode: entry.mode, playerId: 1, maxPlayers: required, hostId: 1 });
    await httpPostJson(peer.url, "/mm/release", { claimId, roomCode: code, hostUrl: peerHostUrl(), playerId: 2, mode: entry.mode, maxPlayers: required }, 4000);
    scheduleBotFill(code);
    return true;
  }
  return false;
}

function livePlayerCount() {
  let n = 0;
  for (const w of allClients) if (w.readyState === 1) n++;
  return n;
}

const peerLiveCache = new Map();
let lastConnectLog = 0;
let lastLoggedCount = 0;
const PEER_LIVE_TTL_MS = 45000;

function cachePeerLive(peerId, live) {
  if (!peerId) return;
  peerLiveCache.set(peerId, { live: Number(live) || 0, at: Date.now() });
}

function peerLiveCount(peerId) {
  const c = peerLiveCache.get(peerId);
  if (!c) return 0;
  if (Date.now() - c.at > PEER_LIVE_TTL_MS) return 0;
  return c.live;
}

function poolLiveCount() {
  let total = livePlayerCount();
  for (const [pid] of peerLiveCache) total += peerLiveCount(pid);
  return total;
}

function poolCapacity() {
  return MAX_PLAYERS * Object.keys(BACKEND_HOSTS).length;
}

function logPlayerCount(reason) {
  const live = livePlayerCount();
  console.log(`[POOL] ${SELF_ID} live=${live} pool=${poolLiveCount()}/${poolCapacity()} (${reason})`);
  return live;
}

function isServerFull() {
  return livePlayerCount() >= MAX_PLAYERS;
}

function peerHostUrl() {
  if (SELF_URL) return SELF_URL;
  if (process.env.RENDER_SERVICE_URL) return "https://" + process.env.RENDER_SERVICE_URL;
  return "https://" + (SELF_ID === "ASIA" ? "dark-ward-sever.onrender.com" : (BACKEND_URLS[SELF_ID] || "dark-ward-sever.onrender.com").replace("https://", ""));
}

function tryQuickPair(entry) {
  if (!matchQueue.includes(entry)) return;
  if (entry.ws) { if (entry.ws.readyState !== 1) return; } else if (!entry.isBot) return;
  matchQueue = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && Date.now() - q.queuedAt < 180000);
  if (!matchQueue.includes(entry)) return;
  const same = progressTo(entry.mode, entry.teamSize, entry.serverId);
  const required = 2 * entry.teamSize;
  const picked = pickParties(same, required);
  const partyCount = new Set(picked.map((q) => q.groupId || ("solo:" + (q.id || q.profileId || q.playerName)))).size;
  if (picked.length < required && partyCount < 2) {
    tryPeerPair(entry);
    return;
  }
  if (picked.length < 2) {
    tryPeerPair(entry);
    return;
  }
  const group = picked;
  for (const q of picked) {
    if (q.botFillTimer) { clearTimeout(q.botFillTimer); q.botFillTimer = null; }
  }
  matchQueue = matchQueue.filter((q) => !picked.includes(q));
  const code = genCode();
  const mk = (e, id) => ({
    ws: e.ws, id, name: e.playerName, characterId: e.characterId,
    loginType: e.loginType, userId: e.userId, profileId: e.profileId || "",
    groupId: e.groupId || "", device: e.device, region: e.region || "ASIA",
    ready: false, slot: id, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    isBot: !!e.isBot, botSkill: e.botSkill != null ? e.botSkill : 0.5, botPersonality: e.botPersonality || "balanced",
  });
  rooms[code] = {
    host: group[0].ws, hostName: group[0].playerName, roomName: "Match", region: "GLOBAL",
    mode: group[0].mode, maxPlayers: required, loginType: group[0].loginType,
    players: group.map((e, i) => mk(e, i + 1)),
    gameStarted: true, matchmadeAt: Date.now(), matchLikes: {}, matchEliminated: [],
  };
  group.forEach((e, i) => {
    if (!e.ws) return;
    e.ws.setRoom(code);
    if (i === 0) {
      send(e.ws, { type: "room_created", roomCode: code, roomName: "Match", region: "GLOBAL", mode: rooms[code].mode, playerId: 1, maxPlayers: required, players: roomPlayers(code), hostId: 1 });
    } else {
      send(e.ws, { type: "room_joined", roomCode: code, roomName: "Match", region: "GLOBAL", mode: rooms[code].mode, playerId: i + 1, maxPlayers: required, players: roomPlayers(code), hostId: 1 });
    }
  });
  for (let i = 1; i < rooms[code].players.length; i++) {
    broadcast(code, { type: "player_joined", player: playerPublic(rooms[code].players[i]), players: roomPlayers(code), hostId: 1 }, group[i].ws);
  }
  sendToAll(code, { type: "game_start", mode: rooms[code].mode, players: roomPlayers(code) });
  scheduleBotFill(code);
}

wss.on("connection", (ws, req) => {
  let currentRoom = null;
  allClients.add(ws);
  if (req && req.headers && req.headers.host) detectSelf(req.headers.host);
  const liveNow = livePlayerCount();
  if (liveNow % 100 === 0) console.log(`[POOL] ${SELF_ID} reached ${liveNow} players — pool ${poolLiveCount()}/${poolCapacity()}`);
  if (Date.now() - lastConnectLog > 5000) {
    lastConnectLog = Date.now();
    logPlayerCount("connect");
  }
  ws.setRoom = (code) => { currentRoom = code; };
  ws.chatName = "";
  ws.chatProfileId = "";
  ws.__serverId = null;
  ws.__mode = "";

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

    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: "error", message: "Room not found." }); return; }
      const room = rooms[code];
      const reserved = pendingClaims.get(code);
      if (reserved && reserved.slotIndex < room.players.length) {
        const slot = room.players[reserved.slotIndex];
        if (slot && !slot.ws) {
          slot.ws = ws;
          slot.name = msg.playerName || slot.name;
          slot.characterId = msg.characterId ?? slot.characterId;
          slot.loginType = msg.loginType || slot.loginType;
          slot.userId = msg.userId || slot.userId;
          slot.profileId = msg.profileId || slot.profileId;
          slot.device = msg.deviceId || slot.device;
          pendingClaims.delete(code);
          room.awaitingRemote = false;
          currentRoom = code;
          send(ws, { type: "room_joined", roomCode: code, roomName: room.roomName, region: room.region, mode: room.mode, playerId: slot.id, maxPlayers: room.maxPlayers, players: roomPlayers(code), hostId: hostIdOf(room) });
          broadcast(code, { type: "player_joined", player: playerPublic(slot), players: roomPlayers(code), hostId: hostIdOf(room) }, ws);
          sendToAll(code, { type: "game_start", mode: room.mode, players: roomPlayers(code) });
          return;
        }
      }
      if (room.players.some((p) => p.isBot)) {
        cancelBotFill(code);
        removeBotForRealPlayer(code);
      }
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }
      const joinLoginType = msg.loginType || "guest";
      const hostLoginType = room.loginType || "guest";
      if ((joinLoginType === "guest") !== (hostLoginType === "guest")) {
        send(ws, { type: "error", message: joinLoginType === "guest" ? "Guests can only play with other guests." : "This room only accepts logged-in players." });
        return;
      }
      const joinUserId = msg.userId || "";
      const joinDevice = msg.deviceId || "";
      const sameDeviceAs = (p) => {
        if (!joinDevice || !p.device) return true;
        return p.device === joinDevice;
      };
      if (joinUserId) {
        const dupHere = room.players.find((p) => p.userId === joinUserId);
        if (dupHere && sameDeviceAs(dupHere)) { send(ws, { type: "error", message: "This account is already in the room." }); return; }
      }
      if (joinUserId) {
        for (const [rCode, r] of Object.entries(rooms)) {
          if (rCode === code) continue;
          const other = r.players.find((p) => p.userId === joinUserId);
          if (other && sameDeviceAs(other)) { send(ws, { type: "error", message: "This account is already in another room." }); return; }
        }
      }
      const pid = room.players.length + 1;
      const player = { ws, id: pid, name: msg.playerName || "Player", characterId: msg.characterId || 0, loginType: joinLoginType, userId: joinUserId, profileId: msg.profileId || "", device: joinDevice, ready: false, slot: pid, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
      room.players.push(player);
      currentRoom = code;
      if (msg.profileId) ws.chatProfileId = String(msg.profileId);
      if (msg.playerName) ws.chatName = String(msg.playerName).slice(0, 24);
      send(ws, { type: "room_joined", roomCode: code, roomName: room.roomName, region: room.region, mode: room.mode, playerId: pid, maxPlayers: room.maxPlayers, players: roomPlayers(code), hostId: hostIdOf(room) });
      broadcast(code, { type: "player_joined", player: playerPublic(player), players: roomPlayers(code), hostId: hostIdOf(room) }, ws);
      return;
    }

    if (msg.type === "ping") { send(ws, { type: "pong", room: currentRoom }); return; }
    if (msg.type === "chat_identity") {
      ws.chatName = String(msg.name || "Player").substring(0, 40);
      ws.chatProfileId = String(msg.profileId || "");
      return;
    }
    if (msg.type === "online_list") {
      const local = localOnlinePlayers();
      send(ws, { type: "online_list", players: local, scope: "local" });
      for (const peer of (PEERS || [])) {
        httpPostJson(peer.url, "/mm/online-list", {}, 3000).then((res) => {
          if (res && Array.isArray(res.players) && res.players.length) send(ws, { type: "online_list", players: res.players, scope: "peer" });
        });
      }
      return;
    }
    if (msg.type === "chat_dm") {
      const targetId = String(msg.targetProfileId || "").trim();
      const text = String(msg.text || "").substring(0, 200);
      if (!targetId || text.length === 0) return;
      let target = null;
      for (const w of allClients) {
        if (w.readyState === 1 && w.chatProfileId && w.chatProfileId === targetId) { target = w; break; }
      }
      if (!target) { send(ws, { type: "error", message: "That player is not online." }); return; }
      const dm = { type: "chat_dm", sender: ws.chatName || "Player", senderProfileId: ws.chatProfileId || "", text, ts: Date.now() };
      send(target, dm);
      send(ws, dm);
      return;
    }
    if (msg.type === "team_sync" || msg.type === "team_slot_select") {
      const teamId = String(msg.teamId || "").trim();
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      if (!teamId || !pid) { send(ws, { type: "team_error", message: "Team sync failed — not logged in." }); return; }
      const nm = ws.chatName || String(msg.name || "Player");
      const wantSlot = Number(msg.slotIndex);
      const teamExisted = teams.has(teamId);
      const team = teamGet(teamId);
      const wantSize = Number(msg.teamSize || 0);
      const validSize = (wantSize === 1 || wantSize === 2 || wantSize === 4);
      const isOwner = !team.ownerProfileId || team.ownerProfileId === pid;
      const slot = teamRegisterMember(team, pid, nm, Number.isInteger(wantSlot) ? wantSlot : -1);
      if (slot < 0) {
        const errMsg = (team.kicked && team.kicked.includes(pid)) ? "You were removed from this group by the leader." : "Team is full.";
        send(ws, { type: "team_error", message: errMsg });
        return;
      }
      if (validSize && isOwner) {
        const cur = Number(team.teamSize || TEAM_SIZE_DEFAULT);
        if (!teamExisted) team.teamSize = wantSize;
        else if (wantSize === 1 || wantSize === 2) {
          if (cur === 4) {
            send(ws, { type: "team_error", message: "Exit or disband the team before switching to a smaller size." });
            team.teamSize = cur;
          } else if (team.members.length > wantSize) {
            send(ws, { type: "team_error", message: "Too many members for that team size." });
            team.teamSize = cur;
          } else team.teamSize = wantSize;
        } else team.teamSize = wantSize;
      }
      teamPruneExpired(team);
      teamNormalize(team);
      teamNotifyAll(team);
      send(ws, Object.assign({ type: "team_state" }, teamStatePayload(team)));
      return;
    }
    if (msg.type === "team_invite") {
      const targetProfileId = String(msg.targetProfileId || "").trim();
      const teamId = String(msg.teamId || "").trim();
      const targetName = String(msg.targetName || "").trim();
      const wantSlot = Number(msg.slotIndex);
      const ownerSlot = Number(msg.ownerSlot);
      const roomCode = String(msg.roomCode || "").trim().toUpperCase();
      const roomUrl = String(msg.roomUrl || "").trim();
      if (!targetProfileId || !teamId) { send(ws, { type: "team_error", message: "Team invite failed — bad request." }); return; }
      const myId = (ws.chatProfileId || String(msg.profileId || msg.fromProfileId || "")).trim();
      if (targetProfileId === myId) { send(ws, { type: "team_error", message: "You cannot invite yourself." }); return; }
      const fromName = ws.chatName || "Player";
      const team = teams.get(teamId);
      if (!team) {
        const peers = PEERS || [];
        if (!peers.length) { send(ws, { type: "team_error", message: "Team not found." }); return; }
        let pending = peers.length;
        let done = false;
        let lastErr = "Team not found.";
        for (const peer of peers) {
          httpPostJson(peer.url, "/mm/team-invite-request", { teamId, targetProfileId, targetName, ownerSlot, roomCode, roomUrl, fromName, fromProfileId: myId }, 3000).then((res) => {
            if (res && res.ok) {
              done = true;
              send(ws, { type: "team_invite_sent", targetProfileId, name: targetName, slotIndex: Number(res.slotIndex || 0) });
            } else if (res && res.message) lastErr = res.message;
            pending -= 1;
            if (pending === 0 && !done) send(ws, { type: "team_error", message: lastErr });
          });
        }
        return;
      }
      const result = teamProcessInvite(team, { targetProfileId, targetName, wantSlot, ownerSlot, fromName, fromProfileId: myId, inviterProfileId: myId });
      if (!result.ok) { send(ws, { type: "team_error", message: result.message }); return; }
      const payload = { type: "team_invite", teamId, slotIndex: result.slot, fromName, fromProfileId: myId, roomCode: roomCode, roomUrl: roomUrl, ts: Date.now() };
      teamDeliverInvite(targetProfileId, payload).then((delivered) => {
        if (delivered) send(ws, { type: "team_invite_sent", targetProfileId, name: targetName, slotIndex: result.slot });
        else {
          team.pending = team.pending.filter((p) => p.profileId !== targetProfileId);
          teamNotifyAll(team);
          send(ws, { type: "team_error", message: "That friend is not online." });
        }
      });
      return;
    }
    if (msg.type === "team_accept") {
      const teamId = String(msg.teamId || "").trim();
      const slotIndex = Number(msg.slotIndex);
      if (!teamId) { send(ws, { type: "team_error", message: "Team join failed — bad request." }); return; }
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      if (!pid) { send(ws, { type: "team_error", message: "Team join failed — not logged in." }); return; }
      const nm = ws.chatName || String(msg.name || "Player");
      const team = teams.get(teamId);
      if (team) {
        const result = teamApplyAccept(team, pid, nm, slotIndex);
        if (!result.ok) { send(ws, { type: "team_error", message: result.message }); return; }
        send(ws, { type: "team_state", teamId, members: result.members, pending: result.pending });
        return;
      }
      if (!localTeams.has(teamId)) localTeams.set(teamId, new Set());
      localTeams.get(teamId).add(pid);
      const peers = PEERS || [];
      let pending = peers.length;
      let ok = false;
      let lastErr = "Team not found.";
      if (pending === 0) { send(ws, { type: "team_error", message: lastErr }); return; }
      for (const peer of peers) {
        httpPostJson(peer.url, "/mm/team-accept", { teamId, profileId: pid, name: nm, slotIndex }, 3000).then((res) => {
          if (res && res.delivered) {
            ok = true;
            if (res && Array.isArray(res.members)) send(ws, { type: "team_state", teamId, members: res.members, pending: Array.isArray(res.pending) ? res.pending : [] });
          } else if (res && res.message) lastErr = res.message;
          pending -= 1;
          if (pending === 0 && !ok) send(ws, { type: "team_error", message: lastErr });
        });
      }
      return;
    }
    if (msg.type === "team_kick") {
      const teamId = String(msg.teamId || "").trim();
      const targetId = String(msg.targetProfileId || "").trim();
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      if (!teamId || !targetId) { send(ws, { type: "team_error", message: "Kick failed — bad request." }); return; }
      const team = teams.get(teamId);
      if (!team) {
        for (const peer of (PEERS || [])) httpPostJson(peer.url, "/mm/team-kick", { teamId, targetProfileId: targetId, profileId: pid }, 3000);
        return;
      }
      if (!pid || team.ownerProfileId !== pid) { send(ws, { type: "team_error", message: "Only the group leader can kick players." }); return; }
      if (targetId === pid) { send(ws, { type: "team_error", message: "You cannot kick yourself." }); return; }
      const had = teamRemoveMember(team, targetId);
      if (!had) { send(ws, { type: "team_error", message: "That player is not in your group." }); return; }
      teamNotifyAll(team, [targetId]);
      for (const w of allClients) {
        if (w.readyState !== 1 || !w.chatProfileId) continue;
        if (w.chatProfileId === targetId) {
          send(w, { type: "team_removed", teamId, reason: "kicked" });
          send(w, { type: "team_state", teamId, ownerProfileId: team.ownerProfileId || "", teamSize: Number(team.teamSize || 0), maxSize: teamMaxSize(team), members: [], pending: [] });
        }
      }
      return;
    }
    if (msg.type === "team_decline") {
      const teamId = String(msg.teamId || "").trim();
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      if (!teamId || !pid) return;
      const team = teams.get(teamId);
      if (team) {
        if (team.pending.some((p) => p.profileId === pid)) {
          team.pending = team.pending.filter((p) => p.profileId !== pid);
          teamNormalize(team);
          teamNotifyAll(team);
        }
      } else {
        for (const peer of (PEERS || [])) httpPostJson(peer.url, "/mm/team-decline", { teamId, profileId: pid }, 3000);
      }
      return;
    }
    if (msg.type === "group_mm") {
      const teamId = String(msg.teamId || "").trim();
      const op = String(msg.op || "").trim();
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      if (!teamId) return;
      const team = teams.get(teamId);
      const isMember = team ? team.members.some((m) => m.profileId === pid) : false;
      const isLeader = team ? team.ownerProfileId === pid : false;
      if (op === "start" && !isLeader) return;
      if (op === "cancel" && !isMember) return;
      if (op === "cancel") {
        matchQueue = matchQueue.filter((q) => (q.groupId || "") !== teamId);
      }
      const ids = team ? team.members.map((m) => m.profileId) : (pid ? [pid] : []);
      for (const w of allClients) {
        if (w.readyState !== 1 || !w.chatProfileId) continue;
        if (ids.includes(w.chatProfileId)) send(w, { type: "group_mm", op, teamId });
      }
      return;
    }
    if (msg.type === "team_leave") {
      const teamId = String(msg.teamId || "").trim();
      const pid = (ws.chatProfileId || String(msg.profileId || "")).trim();
      const team = teams.get(teamId);
      if (team && pid) {
        teamRemoveMember(team, pid);
        teamNotifyAll(team, [pid]);
        for (const w of allClients) {
          if (w.readyState !== 1 || !w.chatProfileId) continue;
          if (w.chatProfileId === pid) {
            send(w, { type: "team_removed", teamId, reason: "left" });
            send(w, { type: "team_state", teamId, ownerProfileId: team.ownerProfileId || "", teamSize: Number(team.teamSize || 0), maxSize: teamMaxSize(team), members: [], pending: [] });
          }
        }
        if (team.members.length === 0) teams.delete(teamId);
      } else if (pid) {
        for (const peer of (PEERS || [])) httpPostJson(peer.url, "/mm/team-member-left", { teamId, profileId: pid }, 3000);
      }
      if (localTeams.has(teamId)) localTeams.get(teamId).delete(pid);
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
      if (text.length === 0) return;
      const pid = ws.chatProfileId || "";
      const tid = pid ? teamIdOfProfileAny(pid) : "";
      const payload = { type: "chat_room", sender: msg.sender || "Player", text, ts: Date.now() };
      if (tid) {
        const teamMsg = Object.assign({ teamId: tid }, payload);
        teamBroadcastAll(tid, teamMsg, "", ws);
        send(ws, teamMsg);
        return;
      }
      if (!currentRoom) return;
      broadcast(currentRoom, payload);
      return;
    }
    if (msg.type === "room_invite") {
      const targetProfileId = (msg.targetProfileId || "").trim();
      const code = (msg.roomCode || "").toUpperCase().trim();
      if (!targetProfileId || !code || !rooms[code]) { send(ws, { type: "error", message: "Invite failed — no room." }); return; }
      const room = rooms[code];
      if (!room.players.some((p) => p.ws === ws)) { send(ws, { type: "error", message: "Invite failed — you are not in a room." }); return; }
      const target = findPlayerByProfileId(targetProfileId);
      if (!target) { send(ws, { type: "error", message: "That friend is not online." }); return; }
      if (target.ws === ws) { send(ws, { type: "error", message: "You cannot invite yourself." }); return; }
      if (room.players.length >= room.maxPlayers) { send(ws, { type: "error", message: "Room is full." }); return; }
      const fromName = (room.players.find((p) => p.ws === ws) || {}).name || "Player";
      send(target.ws, { type: "room_invite", roomCode: code, roomName: room.roomName, fromName, fromProfileId: msg.fromProfileId || "", ts: Date.now() });
      return;
    }
    if (msg.type === "quick_match") {
      if (msg.profileId) ws.chatProfileId = String(msg.profileId);
      if (msg.playerName) ws.chatName = String(msg.playerName).slice(0, 24);
      if (matchQueue.some((q) => q.ws === ws)) return;
      if (isServerFull()) { send(ws, { type: "error", message: "This server's traffic is full. Please try in a later or choose another server." }); return; }
      if (currentRoom && rooms[currentRoom]) {
        const old = rooms[currentRoom];
        old.players = old.players.filter((p) => p.ws !== ws);
        if (old.players.length === 0) delete rooms[currentRoom];
        else {
          if (old.host === ws) { old.host = old.players[0].ws; old.hostName = old.players[0].name; }
          broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(old) });
        }
        currentRoom = null;
      }
      matchQueue = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && Date.now() - q.queuedAt < 180000);
      const entry = {
        ws, playerName: msg.playerName || "Player", characterId: msg.characterId | 0,
        mode: msg.mode || ws.__mode || "MUMMY_VS_HUMAN", loginType: msg.loginType || "guest",
        userId: msg.userId || "", profileId: msg.profileId || "", groupId: String(msg.groupId || ""),
        device: msg.deviceId || "", region: msg.region || DEFAULT_SERVER_ID,
        serverId: msg.serverId || msg.region || DEFAULT_SERVER_ID,
        queuedAt: Date.now(),
        teamSize: (Number(msg.teamSize) >= 1 ? Math.min(4, Number(msg.teamSize)) : 2),
      };
      const qPid = String(msg.profileId || ws.chatProfileId || "");
      matchQueue = matchQueue.filter((q) => q.ws !== ws && !(qPid && q.profileId === qPid));
      matchQueue.push(entry);
      pumpQueueGroups();
      setTimeout(() => tryQuickPair(entry), 0);
      scheduleQueueBotFill(entry);
      return;
    }
    if (msg.type === "set_server") {
      const sid = String(msg.serverId || "");
      if (serverById(sid)) ws.__serverId = sid;
      return;
    }
    if (msg.type === "quick_match_cancel") {
      const cancelPid = String(msg.profileId || ws.chatProfileId || "");
      let entry = matchQueue.find((q) => q.ws === ws);
      if (!entry && cancelPid) entry = matchQueue.find((q) => q.profileId === cancelPid);
      if (entry && entry.botFillTimer) { clearTimeout(entry.botFillTimer); entry.botFillTimer = null; }
      matchQueue = matchQueue.filter((q) => q !== entry && q.ws !== ws);
      if (entry) progressTo(entry.mode, entry.teamSize);
      if (entry && currentRoom && rooms[currentRoom]) {
        const r = rooms[currentRoom];
        if (r.matchmadeAt && Date.now() - r.matchmadeAt < 3000) {
          r.players = r.players.filter((p) => p.ws !== ws);
          if (r.players.length === 0) delete rooms[currentRoom];
          else {
            if (r.host === ws) { r.host = r.players[0].ws; r.hostName = r.players[0].name; }
            broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(r) });
          }
          currentRoom = null;
        }
      }
      return;
    }
    if (msg.type === "set_mode") {
      const m = String(msg.mode || "");
      if (m) {
        ws.__mode = m;
        if (currentRoom && rooms[currentRoom]) {
          const r = rooms[currentRoom];
          if (ws === r.host) {
            r.mode = m;
            broadcast(currentRoom, { type: "mode_changed", mode: r.mode, players: roomPlayers(currentRoom) });
          }
        }
      }
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = findPlayer(currentRoom, ws);

    if (msg.type === "emote" || msg.type === "entry_anim") {
      const anim = String(msg.anim || "").slice(0, 64);
      if (!anim) return;
      const isEmote = msg.type === "emote";
      const pid = ws.chatProfileId || (player && player.profileId) || "";
      const tid = pid ? teamIdOfProfileAny(pid) : "";
      if (tid) teamBroadcastAll(tid, { type: isEmote ? "team_emote" : "team_entry_anim", senderProfileId: pid, anim, ts: Date.now() }, pid);
      if (player) {
        const teamIds = tid ? teamLocalRecipientIds(tid) : new Set();
        const payload = { type: msg.type, playerId: player.id, anim, senderProfileId: pid };
        for (const p of (room.players || [])) {
          if (!p || !p.ws || p.ws === ws) continue;
          if (teamIds.size && teamIds.has(p.profileId)) continue;
          send(p.ws, payload);
        }
      }
      return;
    }
    if (msg.type === "check_game") {
      if (room.gameStarted) send(ws, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      return;
    }
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
        }
      }
      return;
    }
    if (msg.type === "start_game") {
      if (ws === room.host) {
        room.gameStarted = true;
        room.matchLikes = {};
        room.matchEliminated = [];
        sendToAll(currentRoom, { type: "game_start", mode: room.mode, players: roomPlayers(currentRoom) });
      }
      return;
    }
    if (msg.type === "game_ended") {
      if (room) room.gameStarted = false;
      return;
    }
    if (msg.type === "player_move") {
      if (player) {
        player.position = msg.position || player.position;
        player.rotation = msg.rotation || player.rotation;
        broadcast(currentRoom, { type: "player_moved", id: player.id, position: player.position, rotation: player.rotation }, ws);
      }
      return;
    }
    if (msg.type === "bot_move") {
      if (!room || !player || !room.host || room.host !== ws) return;
      const bot = room.players.find((p) => p.isBot && p.id === (msg.playerId | 0));
      if (!bot) return;
      bot.position = msg.position || bot.position;
      bot.rotation = msg.rotation || bot.rotation;
      broadcast(currentRoom, { type: "player_moved", id: bot.id, position: bot.position, rotation: bot.rotation }, null);
      return;
    }
    if (msg.type === "bot_hit") {
      if (!room || !player || !room.host || room.host !== ws) return;
      const bot = room.players.find((p) => p.isBot && p.id === (msg.playerId | 0));
      if (!bot) return;
      const target = room.players.find((p) => p.id === (msg.targetPlayerId | 0) && !p.isBot);
      if (!target) return;
      broadcast(currentRoom, { type: "player_hit", targetPlayerId: target.id, fromPlayerId: bot.id, isBot: true, dmg: Number(msg.dmg) || 30 }, null);
      return;
    }
    if (msg.type === "ghost_move") {
      broadcast(currentRoom, { type: "ghost_moved", position: msg.position, rotation: msg.rotation, state: msg.state }, ws);
      return;
    }
    if (msg.type === "door_sync") {
      broadcast(currentRoom, { type: "door_update", doorId: msg.doorId, isOpen: msg.isOpen, playerId: player?.id }, ws);
      return;
    }
    if (msg.type === "ghost_jumpscare") {
      broadcast(currentRoom, { type: "ghost_jumpscare", targetPlayerId: msg.targetPlayerId | 0 }, ws);
      return;
    }
    if (msg.type === "player_hit") {
      const targetId = msg.targetPlayerId | 0;
      if (player && sameTeam(ws.chatProfileId, targetId)) return;
      broadcast(currentRoom, { type: "player_hit", targetPlayerId: targetId }, ws);
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
    if (msg.type === "mummy_sync") {
      if (!player || !currentRoom) return;
      broadcast(currentRoom, { type: "mummy_sync", from: player.id, data: msg.data || {} }, ws);
      return;
    }
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
      if (entry.likedBy.includes(player.id)) return;
      entry.likedBy.push(player.id);
      const count = entry.likedBy.length;
      sendToAll(currentRoom, { type: "spectate_like_update", targetId, count, fromId: player.id });
      if (count >= 3) {
        room.matchEliminated.push(targetId);
        sendToAll(currentRoom, { type: "spectate_eliminated", targetId });
      }
      return;
    }
  });

  ws.on("close", () => {
    const pid = ws.chatProfileId || "";
    if (pid) {
      for (const team of teams.values()) {
        const hadPending = team.pending.some((p) => p.profileId === pid);
        const hadMember = team.members.some((m) => m.profileId === pid);
        if (hadMember || hadPending) {
          teamRemoveMember(team, pid);
          teamNotifyAll(team);
          if (team.members.length === 0) teams.delete(team.id);
        }
      }
      for (const [tid, set] of localTeams.entries()) {
        if (set.has(pid)) {
          set.delete(pid);
          for (const peer of (PEERS || [])) httpPostJson(peer.url, "/mm/team-member-left", { teamId: tid, profileId: pid }, 3000);
        }
      }
    }
    allClients.delete(ws);
    for (const q of matchQueue) {
      if (q.ws === ws && q.botFillTimer) { clearTimeout(q.botFillTimer); q.botFillTimer = null; }
    }
    matchQueue = matchQueue.filter((q) => q.ws !== ws);
    if (currentRoom) cancelBotFill(currentRoom);
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter((p) => p.ws !== ws);
    const connected = room.players.filter((p) => p.ws);
    if (connected.length === 0) { delete rooms[currentRoom]; return; }
    if (room.host === ws) {
      const next = connected[0];
      room.host = next.ws;
      room.hostName = next.name;
    }
    broadcast(currentRoom, { type: "player_left", playerId: null, players: roomPlayers(currentRoom), hostId: hostIdOf(room) });
  });
});

setInterval(() => {
  for (const q of matchQueue.slice()) {
    if (!q || q.claimedBy) continue;
    tryQuickPair(q);
  }
}, 2000);

setInterval(() => {
  const nowP = Date.now();
  for (const [pid, p] of presence) {
    if (nowP - p.ts >= PRESENCE_TTL) presence.delete(pid);
  }
  matchQueue = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && Date.now() - q.queuedAt < 180000);
  Object.keys(rooms).forEach((code) => {
    const connected = rooms[code].players.filter((p) => p.ws);
    if (connected.length === 0) delete rooms[code];
    else rooms[code].players = rooms[code].players.filter((p) => !p.ws || p.ws.readyState === 1);
  });
  const nowC = Date.now();
  for (const [code, c] of pendingClaims) {
    if (nowC - c.at > CLAIM_TTL_MS) {
      pendingClaims.delete(code);
      if (rooms[code]) delete rooms[code];
    }
  }
  for (const q of matchQueue) {
    if (q.claimedBy && nowC - (q.claimedAt || 0) > 20000) {
      q.claimedBy = "";
      q.claimedAt = 0;
    }
  }
  for (const team of teams.values()) {
    if (teamPruneExpired(team)) teamNotifyAll(team);
  }
  pumpQueueGroups();
  const live = livePlayerCount();
  if (live >= lastLoggedCount + 100) {
    lastLoggedCount = Math.floor(live / 100) * 100;
    console.log(`[POOL] ${SELF_ID} crossed ${lastLoggedCount} players — pool ${poolLiveCount()}/${poolCapacity()}`);
  }
  logPlayerCount("tick");
}, 30000);

setInterval(async () => {
  if (PEERS.length === 0) return;
  if (livePlayerCount() === 0) return;
  await Promise.all(PEERS.map(async (peer) => {
    const st = await httpPostJson(peer.url, "/mm/status", { mode: "", teamSize: 0, groupId: "" }, 3000);
    if (st && st.ok) cachePeerLive(peer.id, st.players);
  }));
}, 20000);

setInterval(() => {
  if (PEERS.length === 0) return;
  if (isServerFull()) return;
  for (const entry of matchQueue.slice()) {
    if (entry.ws) { if (entry.ws.readyState !== 1) continue; } else if (!entry.isBot) continue;
    if (entry.claimedBy) continue;
    const localCount = matchQueue.filter((q) => (q.ws ? q.ws.readyState === 1 : !!q.isBot) && q.mode === entry.mode && q.teamSize === entry.teamSize && q.serverId === entry.serverId && (q.groupId || "") === (entry.groupId || "") && !q.claimedBy).length;
    if (localCount >= 2 * entry.teamSize) continue;
    if (entry.teamSize !== 1) continue;
    tryPeerPair(entry);
  }
}, 2500);

server.listen(PORT, () => {
  console.log(`Night Ward Server v4.5 on port ${PORT} (${SELF_ID})`);
  console.log(`[BOT] AI bot system ON — fill delay ${BOT_FILL_DELAY_MS}ms, max ${BOT_MAX_PER_ROOM}/match`);
});
