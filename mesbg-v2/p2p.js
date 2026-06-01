// p2p.js — direct peer-to-peer transport over WebRTC (Trystero, latest 0.25.x with the new
// object-style action API). Exposes the SAME interface as room.js (the Firestore transport)
// so runner.js can use either interchangeably. Lower latency than the cloud relay when it
// connects, but subject to WebRTC NAT traversal (STUN + a best-effort free TURN below).
//
// This module is only loaded (dynamically) when the user picks "Direct", so the Trystero SDK
// isn't fetched on a normal page load.
//
// Model: the host holds the authoritative "room doc" in memory and broadcasts it to guests;
// guests send field patches and game actions back. Mirrors the Firestore doc/actions shape.

import { joinRoom } from 'https://esm.sh/@trystero-p2p/nostr@0.25.1';

const APP_ID = 'mesbg-v2-2026';
const DISCOVERY_MS = 12000; // how long a joiner waits to hear from a host before "not found"

const RTC = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // Free public TURN (best-effort) so mobile/CGNAT peers can still relay if direct fails.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

let A = null; // the single active room (the app only ever runs one at a time)

function open(code, isHost) {
  const room = joinRoom({ appId: APP_ID, rtcConfig: RTC }, code);
  const docA = room.makeAction('doc');   // host → guests: the full room doc
  const patchA = room.makeAction('pat'); // guest → host: field patch (e.g. guestRoster)
  const actA = room.makeAction('act');   // guest → host: a game action

  const inst = { room, code, isHost, doc: {}, docA, patchA, actA, hostId: null, roomWatchers: [], actionWatchers: [], onFirstDoc: null };
  A = inst;
  const live = () => A === inst; // ignore late callbacks after teardown/replacement

  docA.onMessage = (payload, meta) => {
    if (!live()) return;
    inst.doc = payload || {};
    inst.hostId = meta.peerId;
    if (inst.onFirstDoc) { const f = inst.onFirstDoc; inst.onFirstDoc = null; f(); }
    inst.roomWatchers.forEach((cb) => cb(inst.doc));
  };
  patchA.onMessage = (fields) => { if (live() && inst.isHost) merge(fields); };
  actA.onMessage = (action) => { if (live() && inst.isHost) inst.actionWatchers.forEach((cb) => cb(action)); };

  // In Trystero 0.25.x these are setter properties (assign a handler), not callable methods.
  room.onPeerJoin = (peerId) => {
    if (live() && inst.isHost) { inst.guestId = peerId; inst.docA.send(inst.doc, { target: peerId }); }
  };
  room.onPeerLeave = (peerId) => {
    if (!live()) return;
    if (inst.isHost) merge({ guestRoster: null, guestName: null });
    else if (peerId === inst.hostId) inst.roomWatchers.forEach((cb) => cb(null)); // host gone
  };
  return inst;
}

// Host-side: merge fields into the doc, broadcast to guests, and notify local watchers.
function merge(fields) {
  if (!A) return;
  A.doc = { ...A.doc, ...fields };
  if (A.isHost) A.docA.send(A.doc);
  A.roomWatchers.forEach((cb) => cb(A.doc));
}

// ── room.js-compatible API ────────────────────────────────────────────────────

export async function roomExists(code) {
  if (A && A.code !== code) teardown();
  if (!A) open(code, false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); if (!v) teardown(); resolve(v); };
    const t = setTimeout(() => finish(false), DISCOVERY_MS);
    A.onFirstDoc = () => finish(true); // a host sent us the doc → it exists
  });
}

export async function createRoom(code, data) {
  teardown();
  open(code, true);
  A.doc = { ...data, status: 'lobby' };
}

export async function patchRoom(code, fields) {
  if (!A) return;
  if (A.isHost) merge(fields);
  else A.patchA.send(fields); // guest → host
}

export function watchRoom(code, cb) {
  if (!A) return () => {};
  const inst = A;
  inst.roomWatchers.push(cb);
  if (Object.keys(inst.doc).length) Promise.resolve().then(() => { if (A === inst) cb(inst.doc); });
  return () => { inst.roomWatchers = inst.roomWatchers.filter((f) => f !== cb); };
}

export async function sendAction(code, action) {
  if (A && !A.isHost) A.actA.send(action); // guest → host
}

export function watchActions(code, cb) {
  if (!A) return () => {};
  const inst = A;
  inst.actionWatchers.push(cb);
  return () => { inst.actionWatchers = inst.actionWatchers.filter((f) => f !== cb); };
}

export async function deleteAction() { /* no-op: P2P actions are messages, not stored docs */ }

export async function deleteRoom() { teardown(); } // leaving the room signals "closed" to guests

export function teardown() {
  if (!A) return;
  try { A.room.leave(); } catch { /* ignore */ }
  A = null;
}
