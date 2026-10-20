#!/usr/bin/env node
/**
 * Night Ward — LIVE server patch (Render/VPS).
 *  1) create_room DISABLE (Free Fire style: world chat group + quick match only)
 *  2) chatroom_created broadcast (world chat ma "NEW ROOM" system line)
 *  3) chatRoomListPayload ma player names (slots) — row ma kasa kasa cha dekhincha
 *
 * Run:  node patch_live.js && pm2 restart nw-game
 * Idempotent — aile apply bhayo bhaye "already patched" print huncha.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "server.js");
let src = fs.readFileSync(FILE, "utf8");
let changed = [];
let missing = [];

// ── 1) create_room handler disable ────────────────────────────────────────
const OLD_CREATE = `    if (msg.type === "create_room") {
      const code = genCode();`;
const NEW_CREATE = `    // ── create_room DISABLED ────────────────────────────────────────────
    // Free Fire style: game room manual create garna banned.
    // Room/group banaune kaam WORLD CHAT (chatroom) bata,
    // khelne ko QUICK MATCH (matchmaking) matra.
    if (msg.type === "create_room") {
      send(ws, { type: "error", message: "Room creation is disabled. Use QUICK MATCH or create a group in World Chat." });
      return;
    }
    if (false && msg.type === "create_room_legacy") {
      const code = genCode();`;

if (src.includes("Room creation is disabled")) {
  console.log("[1/3] create_room already disabled — skip");
} else if (src.includes(OLD_CREATE)) {
  src = src.replace(OLD_CREATE, NEW_CREATE);
  changed.push("1) create_room disabled");
} else {
  console.warn("[1/3] WARN: create_room block identify hudaina — yo version nai hola, skip");
  missing.push("1) create_room");
}

// ── 2) chatroom_created broadcast ─────────────────────────────────────────
const OLD_BC = `      send(ws, { type: "chatroom_joined", roomId: room.id, roomName: room.name, owner: true });
      broadcastChatRooms();
      sendChatRoomMembers(room);`;
const NEW_BC = `      send(ws, { type: "chatroom_joined", roomId: room.id, roomName: room.name, owner: true });
      broadcastChatRooms();
      // Naya room banaayo bhaye sabai lai batau → client le world chat room
      // list ma "NEW ROOM" system line dekhau.
      sendGlobal({ type: "chatroom_created", roomId: room.id, roomName: room.name, ownerName: room.ownerName, ts: Date.now() });
      sendChatRoomMembers(room);`;

if (src.includes('type: "chatroom_created"')) {
  console.log("[2/3] chatroom_created already patched — skip");
} else if (src.includes(OLD_BC)) {
  src = src.replace(OLD_BC, NEW_BC);
  changed.push("2) chatroom_created broadcast added");
} else {
  console.warn("[2/3] WARN: chatroom_create block identify hudaina — yo version nai hola, skip");
  missing.push("2) chatroom_created");
}

// ── 3) slots (player names) in chat room list payload ─────────────────────
const OLD_PAY = `    list.push({
      id: r.id,
      name: r.name,
      ownerName: r.ownerName,
      ownerProfileId: r.ownerProfileId,
      members: r.members.size,
    });`;
const NEW_PAY = `    // Room bhitra ko player names (slots) — world chat row ma dekhau,
    // naya room kasa kasa cha pata garna sake.
    const names = [];
    for (const w of r.members) {
      if (w.readyState === 1) names.push({ name: w.chatName || "Player", profileId: w.chatProfileId || "" });
    }
    const slots = [];
    for (let i = 0; i < 4; i++) {
      slots.push(names[i] ? { slot: i, playerName: names[i].name, playerId: names[i].profileId } : {});
    }
    list.push({
      id: r.id,
      name: r.name,
      ownerName: r.ownerName,
      ownerProfileId: r.ownerProfileId,
      members: r.members.size,
      slots,
    });`;

if (src.includes("playerName: names[i].name")) {
  console.log("[3/3] slots already patched — skip");
} else if (src.includes(OLD_PAY)) {
  src = src.replace(OLD_PAY, NEW_PAY);
  changed.push("3) player names (slots) added to room list");
} else {
  console.warn("[3/3] WARN: chatRoomListPayload identify hudaina — yo version nai hola, skip");
  missing.push("3) slots");
}

fs.writeFileSync(FILE, src);
if (changed.length) console.log("\nPATCHED:\n - " + changed.join("\n - "));
else console.log("\nAlready patched (nothing to do).");
if (missing.length) {
  console.log("\n!! NOT APPLIED (yo version ma block differ cha):\n - " + missing.join("\n - "));
  console.log("   -> Full new server.js copy garda replace garu.");
}
console.log("\nRestart:  pm2 restart nw-game   (ya Render ko redeploy garda push garu)");
