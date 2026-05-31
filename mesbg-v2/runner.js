// runner.js — battle setup + live game tracker.
//
// Two ways to play:
//   • Single device — one screen tracks both armies (no network).
//   • Two devices    — synced through Firestore (see room.js). The host is authoritative:
//                      it writes the game state to the room doc; the guest reads it live via
//                      onSnapshot and submits its moves as action docs the host applies.
//                      Works on any network (no WebRTC / NAT / TURN), unlike old Trystero.
//
// Roster data comes from the store via the injected ctx (listRosters/getRoster).

import { el, $, clear, eyeIcon } from './ui.js';
import { openUnitRules, openArmyRules } from './rulesview.js';
import * as room from './room.js';
import * as G from './gengine.js';

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LEN = 5;
const LOG_MAX = 60;
const STATS = [
  { key: 'wounds', label: 'W', glyph: '❤' },
  { key: 'might', label: 'M', glyph: '⚔' },
  { key: 'will', label: 'Wi', glyph: '✦' },
  { key: 'fate', label: 'F', glyph: '★' },
];

let idx, ctx;
const S = {
  mode: null,            // 'solo' | 'host' | 'client'
  name: 'Captain',
  rosters: [],           // cached full roster docs for pickers
  myRoster: null,
  peerRoster: null,
  isHost: false, mySide: 0,
  roomCode: null,
  unsubRoom: null, unsubActions: null,
  actionSeq: 0,
  game: null, log: [],
};

export function initRunner(dataIndex, context) {
  idx = dataIndex;
  ctx = context; // { nav, listRosters, getRoster }
  $('mode-solo').addEventListener('click', () => chooseMode('solo'));
  $('mode-create').addEventListener('click', () => chooseMode('host'));
  $('join-btn').addEventListener('click', onJoin);
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, ROOM_LEN);
  });
  $('player-name').addEventListener('input', (e) => { S.name = e.target.value.trim() || 'Captain'; });
  $('start-battle-btn').addEventListener('click', onStart);
  $('game-leave-btn').addEventListener('click', leave);
  // Best-effort: if the host closes the tab, remove their room (the createRoom sweep is the backstop).
  window.addEventListener('pagehide', () => { if (S.isHost && S.roomCode) room.deleteRoom(S.roomCode); });
}

export async function openPlay() {
  resetState();
  ctx.nav('game-setup');
  $('setup-status').textContent = 'Loading armies…';
  $('roster-pick').hidden = true;
  try {
    S.rosters = await ctx.listRosters();
  } catch (e) {
    $('setup-status').textContent = 'Could not load armies: ' + (e.message || e);
    return;
  }
  $('setup-status').textContent = S.rosters.length
    ? 'Choose how to play.'
    : 'No saved armies yet — build one first.';
}

function resetState() {
  if (S.unsubRoom) S.unsubRoom();
  if (S.unsubActions) S.unsubActions();
  Object.assign(S, {
    mode: null, myRoster: null, peerRoster: null,
    isHost: false, mySide: 0, roomCode: null,
    unsubRoom: null, unsubActions: null, actionSeq: 0,
    game: null, log: [],
  });
}

// ── Mode selection / setup UI ─────────────────────────────────────────────────

function rosterOptions(selectedId) {
  return [
    el('option', { value: '' }, '— choose an army —'),
    ...S.rosters.map((r) => el('option', { value: r.id, selected: r.id === selectedId },
      `${r.name} (${r.faction || '?'}, ${r.points ?? '?'}pts)`)),
  ];
}

function chooseMode(mode) {
  S.mode = mode;
  const pick = $('roster-pick');
  const body = clear($('roster-pick-body'));
  pick.hidden = false;
  const startBtn = $('start-battle-btn');

  if (mode === 'solo') {
    let a = '', b = '';
    body.append(
      pickSide('Army 1', '', (id) => { a = id; updateSolo(); }),
      pickSide('Army 2', '', (id) => { b = id; updateSolo(); }),
    );
    startBtn.textContent = 'Start the battle';
    function updateSolo() { startBtn.disabled = !(a && b); S._solo = { a, b }; }
    updateSolo();
  } else {
    // host: pick your army; opponent joins by code
    body.append(pickSide('Your army', '', (id) => {
      S.myRoster = S.rosters.find((r) => r.id === id) || null;
      $('start-battle-btn').disabled = !(S.myRoster && S.peerRoster);
      if (S.roomCode && S.myRoster) room.patchRoom(S.roomCode, { hostRoster: S.myRoster, hostName: S.name });
    }));
    body.append(el('.muted.small', { id: 'host-wait' }, ''));
    startBtn.textContent = 'Start (need opponent)';
    startBtn.disabled = true;
    createRoom();
  }
}

function pickSide(label, selectedId, onChange) {
  return el('.pick-side', {}, [
    el('label.muted.small', {}, label),
    el('select', { onchange: (e) => onChange(e.target.value) }, rosterOptions(selectedId)),
  ]);
}

// ── Networking ────────────────────────────────────────────────────────────────

function genCode() {
  let c = '';
  for (let i = 0; i < ROOM_LEN; i++) c += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return c;
}

function createRoom() {
  S.isHost = true;
  S.mySide = 0;
  freshCode().then((code) => {
    S.roomCode = code;
    $('game-room-code').textContent = code;
    setStatus(`Room ${code} — share this code with your opponent.`);
    room.createRoom(code, { hostName: S.name, hostRoster: S.myRoster || null, guestRoster: null, guestName: null })
      .catch((e) => setStatus('Could not create room: ' + (e.message || e)));
    // Watch for the guest joining (lobby phase only — during play the host watches actions).
    S.unsubRoom = room.watchRoom(code, (data) => {
      if (!data || S.game) return;
      S.peerRoster = data.guestRoster || null;
      updateHostWait();
      $('start-battle-btn').disabled = !(S.myRoster && S.peerRoster);
    });
  });
}

async function freshCode() {
  for (let i = 0; i < 5; i++) {
    const c = genCode();
    try { if (!(await room.roomExists(c))) return c; } catch { return c; }
  }
  return genCode();
}

async function onJoin() {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== ROOM_LEN) return;
  setStatus(`Looking for room ${code}…`);
  let exists;
  try { exists = await room.roomExists(code); }
  catch (e) { setStatus('Error reaching the server: ' + (e.message || e)); return; }
  if (!exists) { setStatus(`No room found with code ${code}.`); return; }

  S.mode = 'client';
  S.isHost = false;
  S.mySide = 1;
  S.roomCode = code;
  $('game-room-code').textContent = code;
  const pick = $('roster-pick');
  const body = clear($('roster-pick-body'));
  pick.hidden = false;
  $('start-battle-btn').hidden = true;
  body.append(pickSide('Your army', '', (id) => {
    S.myRoster = S.rosters.find((r) => r.id === id) || null;
    if (S.myRoster) room.patchRoom(code, { guestRoster: S.myRoster, guestName: S.name });
  }));
  body.append(el('.muted.small', {}, `Joined room ${code}. Choose your army, then wait for the host to start.`));
  setStatus(`Joined room ${code}.`);

  S.unsubRoom = room.watchRoom(code, (data) => {
    if (!data) { setStatus('Host closed the room.'); leave(); return; }
    if (data.status === 'playing' && data.game) {
      S.game = data.game;
      S.log = data.log || [];
      if ($('game').hidden) ctx.nav('game');
      renderGame();
    }
  });
}

function updateHostWait() {
  const w = $('host-wait');
  if (!w) return;
  if (S.peerRoster) {
    w.textContent = `Opponent ready: ${S.peerRoster.name} (${S.peerRoster.faction}).`;
    $('start-battle-btn').textContent = 'Start the battle';
  } else {
    w.textContent = 'Waiting for an opponent to join and choose an army…';
    $('start-battle-btn').textContent = 'Start (need opponent)';
  }
}

function setStatus(msg) { $('setup-status').textContent = msg || ''; }

// ── Start ─────────────────────────────────────────────────────────────────────

function onStart() {
  if (S.mode === 'solo') {
    const a = S.rosters.find((r) => r.id === S._solo?.a);
    const b = S.rosters.find((r) => r.id === S._solo?.b);
    if (!a || !b) return;
    S.game = G.createGame(a, b);
    S.log = [];
    ctx.nav('game'); renderGame();
    return;
  }
  if (S.mode === 'host') {
    if (!S.myRoster || !S.peerRoster) return;
    S.game = G.createGame(S.myRoster, S.peerRoster); // side 0 = host, side 1 = guest
    S.log = [];
    S.unsubActions = room.watchActions(S.roomCode, onGuestAction); // apply the guest's moves
    pushState();
    ctx.nav('game'); renderGame();
  }
}

// ── Action handling (host authoritative) ────────────────────────────────────────

// A guest move arrives as an action doc; apply it (anti-cheat: guest may only edit side 1).
function onGuestAction(action) {
  if (S.game && action.armyIdx === 1) apply(action);
  if (S.roomCode) room.deleteAction(S.roomCode, action.id).catch(() => {});
}

function apply(action) {
  let res;
  if (action.type === 'models') res = G.applyAdjustModels(S.game, action.armyIdx, action.delta);
  else if (action.type === 'stat') res = G.applyAdjustStat(S.game, action.armyIdx, action.heroId, action.stat, action.delta);
  else return;
  if (res.error) return;
  S.game = res.state;
  for (const e of res.state.events || []) { const m = fmtEvent(e); if (m) S.log.push(m); }
  if (S.log.length > LOG_MAX) S.log = S.log.slice(-LOG_MAX);
  renderGame();
  if (S.mode === 'host') pushState();
}

// Host writes the authoritative game state to the room doc; the guest reads it via watchRoom.
function pushState() {
  if (S.mode !== 'host' || !S.roomCode) return;
  room.patchRoom(S.roomCode, { status: 'playing', game: S.game, log: S.log }).catch(() => {});
}

// Local dispatch from the UI.
function dispatch(action) {
  if (S.mode === 'solo' || S.isHost) { apply(action); return; }
  if (S.roomCode) room.sendAction(S.roomCode, { ...action, seq: ++S.actionSeq }).catch(() => {}); // guest → host
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderGame() {
  const host = clear($('game-armies'));
  $('game-title').textContent = S.mode === 'solo' ? 'Battle (this device)' : 'Battle';
  if (!S.game) return;
  S.game.armies.forEach((army, i) => host.append(armyPanel(army, i)));
  const log = clear($('game-log'));
  for (const line of [...S.log].reverse()) log.append(el('li', {}, line));
}

function armyPanel(army, armyIdx) {
  const editable = S.mode === 'solo' || armyIdx === S.mySide;
  const cur = G.currentModels(army);
  const broken = G.isBroken(army);
  const quartered = G.isQuartered(army);
  const stateLabel = quartered ? 'Quartered!' : broken ? 'Broken' : 'Steady';

  const head = el('.army-head', {}, [
    el('.army-name-row', {}, [
      el('.army-name', {}, `${army.name}${editable ? '' : ' 🔒'}`),
      army.faction ? el('button.icon-btn.army-rules-eye', { title: 'Army rules & bonuses', onclick: () => openArmyRules(idx, army.faction) }, eyeIcon()) : null,
    ]),
    el('.muted.small', {}, `${army.faction} · ${army.alignment}`),
    el(`.army-state${quartered ? '.quartered' : broken ? '.broken' : ''}`, {},
      `${stateLabel} — ${cur}/${army.maxModels} models (break at ${Math.ceil(army.maxModels / 2)})`),
  ]);

  const track = el('.models-track', {}, [
    editable ? el('button.model-step', { onclick: () => dispatch({ type: 'models', armyIdx, delta: -1 }) }, '−') : null,
    el('.big', {}, String(cur)),
    editable ? el('button.model-step', { onclick: () => dispatch({ type: 'models', armyIdx, delta: 1 }) }, '+') : null,
    el('.muted.small', {}, `of ${army.maxModels} models`),
  ]);

  const heroHost = el('.hero-track');
  for (const h of army.heroes) heroHost.append(heroCard(army, armyIdx, h, editable));

  const sev = quartered ? '.quartered' : broken ? '.broken' : '';
  return el(`.army-panel${sev}`, {}, [head, track, heroHost, unitReference(army)]);
}

// Quick in-game rules reference: one tappable row per distinct hero/warrior type.
function unitReference(army) {
  if (!army.types?.length) return null;
  const rows = army.types.map((t) =>
    el('button.ref-chip', {
      type: 'button', title: 'View stats & rules',
      onclick: () => openUnitRules(idx, t.name, t.kind, t.options || []),
    }, [eyeIcon(14), el('span', {}, t.name)]));
  return el('.unit-ref', {}, [el('.unit-ref-label.muted.small', {}, 'Reference'), el('.ref-chips', {}, rows)]);
}

function heroCard(army, armyIdx, h, editable) {
  const grid = el('.stat-grid');
  for (const st of STATS) {
    const val = h[st.key];
    const max = h[{ wounds: 'maxWounds', might: 'maxMight', will: 'maxWill', fate: 'maxFate' }[st.key]];
    grid.append(el('.stat-cell', {}, [
      el('.sc-label', {}, `${st.glyph} ${st.label}`),
      el('.sc-controls', {}, [
        editable ? el('button', { class: 'sc-up', onclick: () => dispatch({ type: 'stat', armyIdx, heroId: h.id, stat: st.key, delta: 1 }) }, '+') : null,
        el('span', { class: 'sc-val' }, `${val}/${max}`),
        editable ? el('button', { class: 'sc-down', onclick: () => dispatch({ type: 'stat', armyIdx, heroId: h.id, stat: st.key, delta: -1 }) }, '−') : null,
      ]),
    ]));
  }
  return el(`.hero-card${h.dead ? '.dead' : ''}`, {}, [
    el('.hc-name', {}, [h.name, h.dead ? el('span', { class: 'dead-tag' }, 'SLAIN') : null]),
    grid,
  ]);
}

function fmtEvent(e) {
  const who = (i) => S.game?.armies[i]?.name || `Army ${i + 1}`;
  switch (e.type) {
    case 'models': return `${who(e.army)}: ${e.from}→${e.to} models`;
    case 'stat': return `${who(e.army)}: ${e.name} ${e.stat} ${e.from}→${e.to}`;
    case 'death': return `✖ ${who(e.army)}: ${e.name} slain`;
    case 'revive': return `♥ ${who(e.army)}: ${e.name} revived`;
    default: return '';
  }
}

function leave() {
  const code = S.roomCode;
  if (S.isHost && code) room.deleteRoom(code).catch(() => {});
  else if (S.mode === 'client' && code) room.patchRoom(code, { guestRoster: null, guestName: null }).catch(() => {});
  resetState();
  if (ctx.exit) ctx.exit(); else ctx.nav('home');
}
