// app.js — MESBG tracker, Trystero P2P + DOM rendering
// Pinned to 0.21.0: the last version with the tuple makeAction API ([send, receive]).
// 0.22+ (the @trystero-p2p scope) returns an action object instead, which breaks
// the `const [send, get] = room.makeAction(...)` destructures below.
import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.0/nostr'
import * as engine from './engine.js'

const APP_ID = 'mesbg-tracker-2026';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 5;
const JOIN_TIMEOUT_MS = 10000;
const LOG_MAX = 60;
const SOLO_ID = 'solo';
const STORAGE_KEY = 'mesbg-saved-game-v1';
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const state = {
  screen: 'lobby',
  name: '',
  roomCode: null,
  isHost: false,
  isSolo: false,
  hostPeerId: null,
  room: null,
  send: {},
  rosters: {},           // peerId -> { id, name }
  game: null,            // host's authoritative state
  view: null,            // last received state (same shape as game)
  log: [],
  joinTimeout: null,
  connecting: false,
  // Local-only editor drafts: { [armyIndex]: { [heroId | 'new']: { name, maxWounds, ... } } }
  heroDraft: { 0: {}, 1: {} },
};

const myId = () => (state.isSolo ? SOLO_ID : selfId);

// ===== DOM =====

const $ = id => document.getElementById(id);
const els = {
  lobby: $('lobby'),
  setup: $('setup'),
  game: $('game'),
  nameInput: $('name-input'),
  soloBtn: $('solo-btn'),
  createBtn: $('create-btn'),
  joinCode: $('join-code'),
  joinBtn: $('join-btn'),
  lobbyStatus: $('lobby-status'),
  setupRoomCode: $('setup-room-code'),
  setupSubtitle: $('setup-subtitle'),
  setupArmies: $('setup-armies'),
  setupStartBtn: $('setup-start-btn'),
  setupLeaveBtn: $('setup-leave-btn'),
  setupStatus: $('setup-status'),
  gameHeaderTitle: $('game-header-title'),
  gameArmies: $('game-armies'),
  gameLog: $('game-log'),
  gameLeaveBtn: $('game-leave-btn'),
  gameResetBtn: $('game-reset-btn'),
  resumePanel: $('resume-panel'),
  resumeInfo: $('resume-info'),
  resumeBtn: $('resume-btn'),
  resumeDiscardBtn: $('resume-discard-btn'),
};

function showScreen(name) {
  state.screen = name;
  els.lobby.hidden = name !== 'lobby';
  els.setup.hidden = name !== 'setup';
  els.game.hidden = name !== 'game';
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

function setStatus(msg, where) {
  if (where === 'lobby') els.lobbyStatus.textContent = msg || '';
  else if (where === 'setup') els.setupStatus.textContent = msg || '';
}

function flashError(msg) {
  setStatus(msg, state.screen === 'setup' ? 'setup' : 'lobby');
  if (state.screen === 'game') {
    // Briefly show in the log
    state.log.push(`✖ ${msg}`);
    if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);
    renderLog();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ===== Persistence =====

function saveSnapshot() {
  if (state.screen === 'lobby') return;
  if (!state.view && !state.game) return;
  const snap = {
    v: 1,
    roomCode: state.roomCode,
    isHost: state.isHost,
    isSolo: state.isSolo,
    name: state.name,
    game: (state.isHost || state.isSolo) ? state.game : null,
    view: state.view,
    log: state.log,
    timestamp: Date.now(),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); } catch {}
}

function loadSavedSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1) return null;
    if (Date.now() - snap.timestamp > STORAGE_MAX_AGE_MS) {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      return null;
    }
    return snap;
  } catch {
    return null;
  }
}

function clearSavedSnapshot() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function formatAgo(timestamp) {
  const mins = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hr ago' : `${hrs} hr ago`;
}

function refreshResumeUi() {
  const snap = loadSavedSnapshot();
  if (!snap) {
    els.resumePanel.hidden = true;
    return;
  }
  const where = snap.isSolo ? 'Solo session' : `Room ${snap.roomCode}`;
  const role = snap.isSolo ? '' : (snap.isHost ? ' (host)' : ' (joiner)');
  els.resumeInfo.textContent = `${where}${role} · last active ${formatAgo(snap.timestamp)}`;
  els.resumePanel.hidden = false;
}

function resumeFromSnapshot() {
  const snap = loadSavedSnapshot();
  if (!snap) {
    refreshResumeUi();
    return;
  }
  state.name = snap.name || 'Anonymous';
  state.log = snap.log || [];
  els.nameInput.value = state.name;

  if (snap.isSolo) {
    state.isSolo = true;
    state.isHost = false;
    state.hostPeerId = null;
    state.room = null;
    state.send = {};
    state.game = snap.game;
    state.view = snap.view || snap.game;
    state.rosters = { [SOLO_ID]: { id: SOLO_ID, name: state.name } };
    state.heroDraft = { 0: {}, 1: {} };
    els.setupRoomCode.textContent = '— solo —';
    routeFromView();
    saveSnapshot();
    return;
  }

  if (snap.isHost) {
    // Re-create room as host with the same code, then overlay the saved game.
    // selfId changes on every Trystero session, so remap ownership ids.
    setupRoom(snap.roomCode, true);
    state.game = snap.game;
    state.game.hostId = selfId;
    state.game.armies[0].ownerId = selfId;
    state.game.armies[1].ownerId = null;
    state.game.armies[1].ready = false;
    state.view = state.game;
    saveSnapshot();
    routeFromView();
  } else {
    // Joiner: rejoin existing room. Host's broadcast will replace our state.
    setLobbyConnecting(true);
    setStatus(`Reconnecting to room ${snap.roomCode}…`, 'lobby');
    setupRoom(snap.roomCode, false);
    state.joinTimeout = setTimeout(() => {
      if (state.hostPeerId) return;
      state.joinTimeout = null;
      cleanupAndReturnToLobby({ clearSave: false });
      setStatus(`Could not reconnect to room ${snap.roomCode}. The host may not be back yet.`, 'lobby');
    }, JOIN_TIMEOUT_MS);
  }
}

// ===== Networking =====

function setupRoom(roomCode, asHost) {
  state.roomCode = roomCode;
  state.isHost = asHost;
  state.rosters = { [selfId]: { id: selfId, name: state.name } };
  if (asHost) state.hostPeerId = selfId;

  const room = joinRoom({ appId: APP_ID }, roomCode);
  state.room = room;

  const [sendName, getName] = room.makeAction('nm');
  const [sendHost, getHost] = room.makeAction('ho');
  const [sendAct, getAct] = room.makeAction('act');
  const [sendState, getState] = room.makeAction('st');
  const [sendErr, getErr] = room.makeAction('er');
  state.send = { sendName, sendHost, sendAct, sendState, sendErr };

  room.onPeerJoin(peerId => {
    if (state.isHost) {
      sendHost('1', peerId);
      // If slot 1 is held by a peer Trystero hasn't yet reported as disconnected
      // (e.g. their tab refreshed and they're rejoining fast), free it up first.
      pruneStaleSlot1();
      const result = engine.attachOwner(state.game, peerId);
      if (result.error) {
        sendErr(result.error, peerId);
      } else {
        state.game = result.state;
        broadcastState();
      }
    }
    sendName(state.name, peerId);
  });

  room.onPeerLeave(peerId => {
    delete state.rosters[peerId];
    if (peerId === state.hostPeerId) {
      setStatus('The host left or refreshed. Tap Resume from the lobby once they\'re back.', 'lobby');
      cleanupAndReturnToLobby({ clearSave: false });
      return;
    }
    if (state.isHost && state.game) {
      const result = engine.detachOwner(state.game, peerId);
      if (!result.error) {
        state.game = result.state;
        if (state.game.phase === 'playing') {
          const reset = engine.applyResetToSetup(state.game, selfId);
          if (!reset.error) state.game = reset.state;
          state.log.push('A player left — back to setup.');
        }
        broadcastState();
      }
    }
  });

  getHost((_payload, peerId) => {
    state.hostPeerId = peerId;
    if (state.joinTimeout) {
      clearTimeout(state.joinTimeout);
      state.joinTimeout = null;
      setLobbyConnecting(false);
      setStatus('', 'lobby');
      showScreen('setup');
      renderSetup();
    }
  });

  getName((name, peerId) => {
    const cleaned = String(name).slice(0, 20) || 'Player';
    state.rosters[peerId] = { id: peerId, name: cleaned };
    if (state.screen === 'setup') renderSetup();
    if (state.screen === 'game') renderGame();
  });

  getAct((action, peerId) => {
    if (!state.isHost) return;
    if (!action || action.playerId !== peerId) return;
    processAction(action);
  });

  getState((payload, peerId) => {
    if (peerId !== state.hostPeerId) return;
    state.view = payload.view;
    state.log = payload.log || [];
    saveSnapshot();
    routeFromView();
  });

  getErr(msg => {
    flashError(String(msg));
  });

  els.setupRoomCode.textContent = roomCode;

  if (asHost) {
    state.game = engine.createGame(selfId, { isSolo: false });
    state.view = state.game;
    showScreen('setup');
    renderSetup();
  }
  // Joiners stay on the lobby until getHost confirms a real room exists.
}

function routeFromView() {
  if (!state.view) return;
  if (state.view.phase === 'playing') {
    if (state.screen !== 'game') showScreen('game');
    renderGame();
  } else {
    if (state.screen !== 'setup') showScreen('setup');
    renderSetup();
  }
}

function broadcastState() {
  if (!state.game) return;
  // Drain engine events into the log.
  for (const e of state.game.events || []) {
    const msg = formatEvent(e);
    if (msg) state.log.push(msg);
  }
  if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);
  state.game.events = [];

  state.view = state.game;
  routeFromView();
  saveSnapshot();

  if (state.isSolo) return;
  for (const peerId of Object.keys(state.room.getPeers())) {
    state.send.sendState({ view: state.view, log: state.log }, peerId);
  }
}

function cleanupAndReturnToLobby(options = {}) {
  // Saves are preserved by default — only the explicit Discard button or
  // a 24h expiry clears them. Callers can opt-in with { clearSave: true }.
  const clearSave = options.clearSave === true;
  if (state.joinTimeout) {
    clearTimeout(state.joinTimeout);
    state.joinTimeout = null;
  }
  if (state.room) {
    try { state.room.leave(); } catch {}
  }
  state.room = null;
  state.isHost = false;
  state.isSolo = false;
  state.hostPeerId = null;
  state.roomCode = null;
  state.rosters = {};
  state.game = null;
  state.view = null;
  state.log = [];
  state.heroDraft = { 0: {}, 1: {} };
  setLobbyConnecting(false);
  if (clearSave) clearSavedSnapshot();
  showScreen('lobby');
  refreshResumeUi();
}

function pruneStaleSlot1() {
  if (!state.isHost || !state.game || !state.room) return;
  const oid = state.game.armies[1].ownerId;
  if (!oid) return;
  const connected = Object.keys(state.room.getPeers());
  if (connected.includes(oid)) return;
  const r = engine.detachOwner(state.game, oid);
  if (!r.error) state.game = r.state;
}

// ===== Action dispatch =====

function processAction(action) {
  if (!state.game) return;
  let result;
  switch (action.type) {
    case 'setArmyName':
      result = engine.applySetArmyName(state.game, action.playerId, action.armyIndex, action.name);
      break;
    case 'setMaxModels':
      result = engine.applySetMaxModels(state.game, action.playerId, action.armyIndex, action.n);
      break;
    case 'addHero':
      result = engine.applyAddHero(state.game, action.playerId, action.armyIndex, action.hero);
      break;
    case 'updateHero':
      result = engine.applyUpdateHero(state.game, action.playerId, action.armyIndex, action.heroId, action.patch);
      break;
    case 'removeHero':
      result = engine.applyRemoveHero(state.game, action.playerId, action.armyIndex, action.heroId);
      break;
    case 'setReady':
      result = engine.applySetReady(state.game, action.playerId, action.armyIndex, action.ready);
      break;
    case 'startGame':
      result = engine.applyStartGame(state.game, action.playerId);
      break;
    case 'adjustModels':
      result = engine.applyAdjustModels(state.game, action.playerId, action.armyIndex, action.delta);
      break;
    case 'adjustStat':
      result = engine.applyAdjustStat(state.game, action.playerId, action.armyIndex, action.heroId, action.stat, action.delta);
      break;
    case 'resetToSetup':
      result = engine.applyResetToSetup(state.game, action.playerId);
      break;
    default:
      return;
  }
  if (result.error) {
    if (state.isSolo) {
      flashError(result.error);
    } else if (action.playerId === selfId) {
      flashError(result.error);
    } else {
      state.send.sendErr(result.error, action.playerId);
    }
    return;
  }
  state.game = result.state;
  broadcastState();
}

function dispatch(action) {
  action.playerId = myId();
  if (state.isHost || state.isSolo) processAction(action);
  else state.send.sendAct(action);
}

// ===== Solo mode =====

function startSolo() {
  state.isSolo = true;
  state.isHost = false;
  state.hostPeerId = null;
  state.room = null;
  state.send = {};
  state.rosters = { [SOLO_ID]: { id: SOLO_ID, name: state.name } };
  state.game = engine.createGame(SOLO_ID, { isSolo: true });
  state.view = state.game;
  state.log = [];
  state.heroDraft = { 0: {}, 1: {} };
  els.setupRoomCode.textContent = '— solo —';
  showScreen('setup');
  renderSetup();
}

// ===== Event log formatting =====

function formatEvent(e) {
  const armyName = a => a || `Army ${e.armyIndex + 1}`;
  switch (e.type) {
    case 'game_started':
      return '⚔ Battle begins.';
    case 'reset_to_setup':
      return '↺ Back to setup.';
    case 'models_adjusted':
      return `${armyName(e.armyName)}: ${e.from} → ${e.to} models`;
    case 'hero_died':
      return `✖ ${e.heroName} fell — ${armyName(e.armyName)} now ${e.models} models`;
    case 'hero_revived':
      return `↺ ${e.heroName} restored — ${armyName(e.armyName)} now ${e.models} models`;
    case 'stat_adjusted':
      return `${e.heroName}: ${engine.STAT_LABEL[e.stat]} ${e.from} → ${e.to}`;
    default:
      return '';
  }
}

// ===== Setup rendering =====

function renderSetup() {
  const v = state.view;
  if (!v) return;

  // Preserve focus + selection across full re-render (inputs use stable ids).
  const active = document.activeElement;
  let restore = null;
  if (active && active.tagName === 'INPUT' && active.id && els.setup.contains(active)) {
    restore = {
      id: active.id,
      value: active.value,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  els.setupRoomCode.textContent = state.isSolo ? '— solo —' : (state.roomCode || '');
  els.setupSubtitle.textContent = state.isSolo
    ? 'Build both armies, then start when you\'re ready.'
    : 'Share the code below with your opponent.';

  els.setupArmies.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    els.setupArmies.appendChild(renderSetupArmy(v.armies[i], i));
  }

  const canStart = computeCanStart(v);
  els.setupStartBtn.hidden = !(state.isHost || state.isSolo);
  els.setupStartBtn.disabled = !canStart.ok;
  setStatus(canStart.reason || '', 'setup');

  if (restore) {
    const newEl = document.getElementById(restore.id);
    if (newEl) {
      newEl.value = restore.value;
      newEl.focus();
      try { newEl.setSelectionRange(restore.start, restore.end); } catch {}
    }
  }
}

function computeCanStart(view) {
  if (!(state.isHost || state.isSolo)) return { ok: false, reason: '' };
  if (!view.isSolo) {
    if (!view.armies[0].ownerId || !view.armies[1].ownerId) {
      return { ok: false, reason: 'Waiting for the second player to join.' };
    }
    if (!view.armies[0].ready || !view.armies[1].ready) {
      return { ok: false, reason: 'Both players must tick Ready.' };
    }
  }
  for (const a of view.armies) {
    if (a.maxModels <= 0) return { ok: false, reason: `${a.armyName || 'An army'} needs a model count.` };
    if (a.heroes.length === 0) return { ok: false, reason: `${a.armyName || 'An army'} needs at least one hero.` };
  }
  return { ok: true };
}

function ownerLabel(army, armyIndex) {
  if (state.isSolo) return `Army ${armyIndex + 1}`;
  if (!army.ownerId) return armyIndex === 1 ? 'Waiting for opponent…' : '(no owner)';
  const r = state.rosters[army.ownerId];
  const isMe = army.ownerId === selfId;
  const name = r?.name || (isMe ? state.name : 'Opponent');
  return `${escapeHtml(name)}${isMe ? ' · you' : ''}`;
}

function canEdit(army, armyIndex) {
  if (state.isSolo) return true;
  return army.ownerId === selfId;
}

function renderSetupArmy(army, armyIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'army-panel setup';
  if (!army.ownerId && !state.isSolo) wrap.classList.add('empty-slot');
  const mine = canEdit(army, armyIndex);
  if (mine) wrap.classList.add('mine');

  const ownerHtml = ownerLabel(army, armyIndex);
  const readyDot = army.ready ? '<span class="ready-dot" title="Ready">●</span>' : '';

  wrap.innerHTML = `
    <header class="army-header">
      <div class="army-owner">${ownerHtml} ${readyDot}</div>
    </header>
    <div class="army-meta"></div>
    <div class="army-heroes"></div>
    <div class="army-actions"></div>
  `;

  const metaEl = wrap.querySelector('.army-meta');
  const heroesEl = wrap.querySelector('.army-heroes');
  const actionsEl = wrap.querySelector('.army-actions');

  // Army name + model count
  if (mine) {
    const nameId = `army-${armyIndex}-name`;
    const modelsId = `army-${armyIndex}-models`;
    metaEl.innerHTML = `
      <label class="field">
        <span>Army name</span>
        <input id="${nameId}" type="text" maxlength="32" value="${escapeHtml(army.armyName)}" placeholder="Rohan, Mordor, …">
      </label>
      <label class="field">
        <span>Total model count</span>
        <input id="${modelsId}" type="number" min="0" max="999" value="${army.maxModels || ''}" placeholder="">
      </label>
    `;
    const nameInput = metaEl.querySelector(`#${nameId}`);
    nameInput.addEventListener('change', () => {
      dispatch({ type: 'setArmyName', armyIndex, name: nameInput.value });
    });
    const modelsInput = metaEl.querySelector(`#${modelsId}`);
    modelsInput.addEventListener('change', () => {
      dispatch({ type: 'setMaxModels', armyIndex, n: modelsInput.value });
    });
  } else {
    metaEl.innerHTML = `
      <div class="readonly-row"><span class="muted small">Army</span><strong>${escapeHtml(army.armyName || '—')}</strong></div>
      <div class="readonly-row"><span class="muted small">Models</span><strong>${army.maxModels || '—'}</strong></div>
    `;
  }

  // Heroes
  heroesEl.innerHTML = '<h3>Heroes</h3>';
  if (army.heroes.length === 0 && !mine) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No heroes yet.';
    heroesEl.appendChild(empty);
  }
  for (const hero of army.heroes) {
    const draft = state.heroDraft[armyIndex]?.[hero.id];
    if (draft && mine) {
      heroesEl.appendChild(renderHeroEditor(army, armyIndex, hero, draft));
    } else {
      heroesEl.appendChild(renderHeroSummary(army, armyIndex, hero, mine));
    }
  }
  // "Add hero" / new hero form
  if (mine) {
    const newDraft = state.heroDraft[armyIndex]?.new;
    if (newDraft) {
      heroesEl.appendChild(renderHeroEditor(army, armyIndex, null, newDraft));
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'add-hero-btn';
      addBtn.textContent = '+ Add hero';
      addBtn.addEventListener('click', () => {
        state.heroDraft[armyIndex].new = { name: '', maxWounds: 2, maxMight: 1, maxWill: 1, maxFate: 1 };
        renderSetup();
      });
      heroesEl.appendChild(addBtn);
    }
  }

  // Ready / actions
  if (mine && !state.isSolo) {
    const readyBtn = document.createElement('button');
    readyBtn.className = army.ready ? 'primary' : '';
    readyBtn.textContent = army.ready ? '✓ Ready (tap to un-ready)' : 'Mark ready';
    readyBtn.addEventListener('click', () => {
      dispatch({ type: 'setReady', armyIndex, ready: !army.ready });
    });
    actionsEl.appendChild(readyBtn);
  }

  return wrap;
}

function renderHeroSummary(army, armyIndex, hero, editable) {
  const row = document.createElement('div');
  row.className = 'hero-row setup-summary';
  const stats = engine.STAT_KEYS
    .filter(k => k !== 'wounds')
    .map(k => `<span class="stat-chip">${engine.STAT_GLYPH[k]} ${hero[`max${cap(k)}`]}</span>`)
    .join('');
  row.innerHTML = `
    <div class="hero-name">${escapeHtml(hero.name)}</div>
    <div class="hero-chips">
      <span class="stat-chip">${engine.STAT_GLYPH.wounds} ${hero.maxWounds}</span>
      ${stats}
    </div>
    <div class="hero-row-actions"></div>
  `;
  if (editable) {
    const actions = row.querySelector('.hero-row-actions');
    const editBtn = document.createElement('button');
    editBtn.className = 'small-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      state.heroDraft[armyIndex][hero.id] = {
        name: hero.name,
        maxWounds: hero.maxWounds,
        maxMight: hero.maxMight,
        maxWill: hero.maxWill,
        maxFate: hero.maxFate,
      };
      renderSetup();
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'small-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove hero';
    removeBtn.addEventListener('click', () => {
      dispatch({ type: 'removeHero', armyIndex, heroId: hero.id });
    });
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);
  }
  return row;
}

function renderHeroEditor(army, armyIndex, hero, draft) {
  const row = document.createElement('div');
  row.className = 'hero-row editor';
  const isNew = !hero;
  const key = isNew ? 'new' : hero.id;
  const idFor = field => `hero-${armyIndex}-${key}-${field}`;
  row.innerHTML = `
    <label class="field">
      <span>Name</span>
      <input id="${idFor('name')}" type="text" maxlength="32" data-field="name" value="${escapeHtml(draft.name)}" placeholder="Hero name">
    </label>
    <div class="hero-stat-inputs">
      <label class="stat-field"><span>${engine.STAT_GLYPH.wounds} Wounds</span><input id="${idFor('maxWounds')}" type="number" min="1" max="99" data-field="maxWounds" value="${draft.maxWounds}"></label>
      <label class="stat-field"><span>${engine.STAT_GLYPH.might} Might</span><input id="${idFor('maxMight')}" type="number" min="0" max="99" data-field="maxMight" value="${draft.maxMight}"></label>
      <label class="stat-field"><span>${engine.STAT_GLYPH.will} Will</span><input id="${idFor('maxWill')}" type="number" min="0" max="99" data-field="maxWill" value="${draft.maxWill}"></label>
      <label class="stat-field"><span>${engine.STAT_GLYPH.fate} Fate</span><input id="${idFor('maxFate')}" type="number" min="0" max="99" data-field="maxFate" value="${draft.maxFate}"></label>
    </div>
    <div class="hero-row-actions">
      <button class="small-btn save-btn">${isNew ? 'Add' : 'Save'}</button>
      <button class="small-btn cancel-btn">Cancel</button>
    </div>
  `;

  const inputs = row.querySelectorAll('input[data-field]');
  for (const inp of inputs) {
    inp.addEventListener('input', () => {
      draft[inp.dataset.field] = inp.dataset.field === 'name' ? inp.value : (parseInt(inp.value, 10) || 0);
    });
  }

  row.querySelector('.save-btn').addEventListener('click', () => {
    const payload = {
      name: draft.name,
      maxWounds: draft.maxWounds,
      maxMight: draft.maxMight,
      maxWill: draft.maxWill,
      maxFate: draft.maxFate,
    };
    if (isNew) {
      delete state.heroDraft[armyIndex].new;
      dispatch({ type: 'addHero', armyIndex, hero: payload });
    } else {
      delete state.heroDraft[armyIndex][hero.id];
      dispatch({ type: 'updateHero', armyIndex, heroId: hero.id, patch: payload });
    }
  });
  row.querySelector('.cancel-btn').addEventListener('click', () => {
    if (isNew) delete state.heroDraft[armyIndex].new;
    else delete state.heroDraft[armyIndex][hero.id];
    renderSetup();
  });

  return row;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ===== Game rendering =====

function renderGame() {
  const v = state.view;
  if (!v) return;

  const a0 = v.armies[0].armyName || 'Army 1';
  const a1 = v.armies[1].armyName || 'Army 2';
  els.gameHeaderTitle.textContent = `${a0} vs ${a1}`;
  els.gameResetBtn.hidden = !(state.isHost || state.isSolo);

  els.gameArmies.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    els.gameArmies.appendChild(renderGameArmy(v.armies[i], i));
  }

  renderLog();
}

function renderGameArmy(army, armyIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'army-panel game';
  const mine = canEdit(army, armyIndex);
  if (mine) wrap.classList.add('mine');
  const broken = engine.isBroken(army);
  const quartered = engine.isQuartered(army);
  if (broken) wrap.classList.add('broken');
  if (quartered) wrap.classList.add('quartered');

  const th = engine.thresholds(army.maxModels);

  wrap.innerHTML = `
    <header class="army-header">
      <div class="army-title">
        <strong>${escapeHtml(army.armyName || `Army ${armyIndex + 1}`)}</strong>
        <span class="muted small">${ownerLabel(army, armyIndex)}</span>
      </div>
      ${broken ? '<span class="badge danger">Broken</span>' : ''}
      ${quartered ? '<span class="badge danger">Quartered</span>' : ''}
    </header>

    <div class="models-row">
      <div class="models-count">
        <span class="big">${army.currentModels}</span><span class="muted"> / ${army.maxModels}</span>
        <div class="muted small">models</div>
      </div>
      <div class="models-thresholds">
        <div><span class="muted small">50%</span><strong>${th.half}</strong></div>
        <div><span class="muted small">25%</span><strong>${th.quarter}</strong></div>
      </div>
      ${mine ? `
        <div class="models-buttons">
          <button class="stat-btn minus" data-action="model-minus">−</button>
          <button class="stat-btn plus" data-action="model-plus">+</button>
        </div>
      ` : ''}
    </div>

    <div class="heroes-game"></div>
  `;

  if (mine) {
    wrap.querySelector('[data-action=model-minus]').addEventListener('click', () => {
      dispatch({ type: 'adjustModels', armyIndex, delta: -1 });
    });
    wrap.querySelector('[data-action=model-plus]').addEventListener('click', () => {
      dispatch({ type: 'adjustModels', armyIndex, delta: 1 });
    });
  }

  const heroesEl = wrap.querySelector('.heroes-game');
  for (const hero of army.heroes) {
    heroesEl.appendChild(renderGameHero(hero, armyIndex, mine));
  }

  return wrap;
}

function renderGameHero(hero, armyIndex, editable) {
  const card = document.createElement('div');
  card.className = 'hero-card';
  if (hero.dead) card.classList.add('dead');

  const statRow = (stat) => {
    const cur = hero[stat];
    const max = hero[`max${cap(stat)}`];
    const over = cur > max;
    return `
      <div class="stat-row" data-stat="${stat}">
        <span class="stat-label">${engine.STAT_GLYPH[stat]} ${engine.STAT_LABEL[stat]}</span>
        <span class="stat-value ${over ? 'over' : ''}">${cur} <span class="muted">/ ${max}</span></span>
        ${editable ? `
          <div class="stat-buttons">
            <button class="stat-btn minus" data-stat="${stat}" data-delta="-1">−</button>
            <button class="stat-btn plus" data-stat="${stat}" data-delta="1">+</button>
          </div>
        ` : ''}
      </div>
    `;
  };

  card.innerHTML = `
    <div class="hero-card-header">
      <strong>${escapeHtml(hero.name)}</strong>
      ${hero.dead ? '<span class="badge danger">Fallen</span>' : ''}
    </div>
    ${statRow('wounds')}
    ${statRow('might')}
    ${statRow('will')}
    ${statRow('fate')}
  `;

  if (editable) {
    card.querySelectorAll('.stat-btn[data-stat]').forEach(btn => {
      btn.addEventListener('click', () => {
        dispatch({
          type: 'adjustStat',
          armyIndex,
          heroId: hero.id,
          stat: btn.dataset.stat,
          delta: parseInt(btn.dataset.delta, 10),
        });
      });
    });
  }

  return card;
}

function renderLog() {
  els.gameLog.innerHTML = '';
  for (const msg of state.log.slice(-30)) {
    const li = document.createElement('li');
    li.textContent = msg;
    els.gameLog.appendChild(li);
  }
  els.gameLog.scrollTop = els.gameLog.scrollHeight;
}

// ===== Event listeners =====

function updateJoinButton() {
  const code = els.joinCode.value.trim();
  els.joinBtn.disabled = state.connecting || code.length !== ROOM_CODE_LEN;
}

function setLobbyConnecting(connecting) {
  state.connecting = connecting;
  els.soloBtn.disabled = connecting;
  els.createBtn.disabled = connecting;
  els.joinCode.disabled = connecting;
  els.nameInput.disabled = connecting;
  updateJoinButton();
}

function pickName() {
  return (els.nameInput.value.trim() || 'Anonymous').slice(0, 16);
}

els.soloBtn.addEventListener('click', () => {
  state.name = pickName();
  startSolo();
});

els.createBtn.addEventListener('click', () => {
  state.name = pickName();
  setupRoom(generateRoomCode(), true);
});

els.joinCode.addEventListener('input', () => {
  const cleaned = els.joinCode.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, ROOM_CODE_LEN);
  if (cleaned !== els.joinCode.value) els.joinCode.value = cleaned;
  updateJoinButton();
});

els.joinBtn.addEventListener('click', () => {
  const code = els.joinCode.value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LEN) return;
  state.name = pickName();
  setLobbyConnecting(true);
  setStatus(`Searching for room ${code}…`, 'lobby');
  setupRoom(code, false);
  state.joinTimeout = setTimeout(() => {
    if (state.hostPeerId) return;
    state.joinTimeout = null;
    cleanupAndReturnToLobby();
    setStatus(`No room found with code ${code}.`, 'lobby');
  }, JOIN_TIMEOUT_MS);
});

els.setupStartBtn.addEventListener('click', () => {
  dispatch({ type: 'startGame' });
});

els.setupLeaveBtn.addEventListener('click', () => cleanupAndReturnToLobby());
els.gameLeaveBtn.addEventListener('click', () => cleanupAndReturnToLobby());
els.gameResetBtn.addEventListener('click', () => {
  dispatch({ type: 'resetToSetup' });
});

els.resumeBtn.addEventListener('click', () => {
  resumeFromSnapshot();
});
els.resumeDiscardBtn.addEventListener('click', () => {
  clearSavedSnapshot();
  refreshResumeUi();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && state.screen === 'lobby') {
    if (els.joinCode.value.trim()) els.joinBtn.click();
  }
});

// Initial
showScreen('lobby');
updateJoinButton();
refreshResumeUi();
