// app.js — Trystero P2P + DOM rendering
import { joinRoom, selfId } from 'https://esm.sh/@trystero-p2p/nostr'
import * as engine from './engine.js'

const APP_ID = 'regicide-clide-2026';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOG_MAX = 80;

const SOLO_ID = 'solo';

const state = {
  screen: 'lobby',         // 'lobby' | 'room' | 'game'
  name: '',
  roomCode: null,
  isHost: false,
  isSolo: false,
  hostPeerId: null,
  room: null,
  send: {},
  rosters: {},             // peerId -> { id, name }  (lobby)
  game: null,              // engine state (host only)
  view: null,              // viewFor(state, selfId)
  log: [],
  selected: new Set(),
  gameOver: false,
};

const myId = () => (state.isSolo ? SOLO_ID : selfId);

const RANK_ORDER = { X: 0, A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 };
const SUIT_ORDER = { H: 0, D: 1, C: 2, S: 3 };
function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const r = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99);
    if (r) return r;
    return (SUIT_ORDER[a.suit] ?? 99) - (SUIT_ORDER[b.suit] ?? 99);
  });
}

// ===== DOM refs =====

const $ = id => document.getElementById(id);
const els = {
  lobby: $('lobby'),
  room: $('room'),
  game: $('game'),
  nameInput: $('name-input'),
  soloBtn: $('solo-btn'),
  createBtn: $('create-btn'),
  joinCode: $('join-code'),
  joinBtn: $('join-btn'),
  lobbyStatus: $('lobby-status'),
  roomCodeDisplay: $('room-code-display'),
  playersList: $('players-list'),
  startBtn: $('start-btn'),
  leaveBtn: $('leave-btn'),
  statusMsg: $('status-msg'),
  enemiesProgress: $('enemies-progress'),
  rulesBtn: $('rules-btn'),
  leaveGameBtn: $('leave-game-btn'),
  enemyArea: $('enemy-area'),
  playedCards: $('played-cards'),
  logEl: $('log'),
  playersRow: $('players-row'),
  handCards: $('hand-cards'),
  handTitle: $('hand-title'),
  actionPrompt: $('action-prompt'),
  playBtn: $('play-btn'),
  discardBtn: $('discard-btn'),
  jesterBtn: $('jester-btn'),
  yieldBtn: $('yield-btn'),
  rulesDialog: $('rules-dialog'),
  rulesClose: $('rules-close'),
};

// ===== Utility =====

function showScreen(screen) {
  state.screen = screen;
  els.lobby.hidden = screen !== 'lobby';
  els.room.hidden = screen !== 'room';
  els.game.hidden = screen !== 'game';
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

function nameOf(playerId) {
  if (!state.view) return state.rosters[playerId]?.name || '?';
  const p = state.view.players.find(p => p.id === playerId);
  return p ? p.name : (state.rosters[playerId]?.name || '?');
}

function setStatus(msg, where = 'room') {
  if (where === 'lobby') els.lobbyStatus.textContent = msg || '';
  else if (where === 'room') els.statusMsg.textContent = msg || '';
}

function flashError(msg) {
  els.actionPrompt.textContent = msg;
  els.actionPrompt.classList.add('lost');
  setTimeout(() => els.actionPrompt.classList.remove('lost'), 2000);
}

// ===== Networking =====

function setupRoom(roomCode, asHost) {
  state.roomCode = roomCode;
  state.isHost = asHost;
  state.rosters = { [selfId]: { id: selfId, name: state.name } };
  if (asHost) state.hostPeerId = selfId;

  const room = joinRoom({ appId: APP_ID }, roomCode);
  state.room = room;

  // Trystero actions (one per message type)
  const [sendName, getName] = room.makeAction('nm');
  const [sendHost, getHost] = room.makeAction('ho');
  const [sendLobby, getLobby] = room.makeAction('lo');
  const [sendAct, getAct] = room.makeAction('act');
  const [sendState, getState] = room.makeAction('st');
  const [sendErr, getErr] = room.makeAction('er');
  state.send = { sendName, sendHost, sendLobby, sendAct, sendState, sendErr };

  room.onPeerJoin(peerId => {
    if (state.isHost) {
      // Tell the new peer that we are the host and send the lobby snapshot.
      sendHost('1', peerId);
      sendLobby(lobbySnapshot(), peerId);
      // If a game is already running, refuse mid-game joins gracefully.
      if (state.game) {
        sendErr('Game in progress — please wait until it ends.', peerId);
      }
    }
    // Tell anyone who joins our name.
    sendName(state.name, peerId);
  });

  room.onPeerLeave(peerId => {
    delete state.rosters[peerId];
    if (peerId === state.hostPeerId) {
      // Host left — bounce everyone to lobby.
      setStatus('Host left the room.', 'lobby');
      cleanupAndReturnToLobby();
      return;
    }
    if (state.isHost) {
      broadcastLobby();
      if (state.game && !state.gameOver) {
        broadcastError('A player left — game aborted.');
        state.game = null;
        state.view = null;
        showScreen('room');
        renderRoom();
      } else {
        renderRoom();
      }
    } else {
      renderRoom();
    }
  });

  getHost((_payload, peerId) => {
    state.hostPeerId = peerId;
  });

  getLobby((snapshot, peerId) => {
    if (peerId !== state.hostPeerId) return;
    state.rosters = {};
    for (const p of snapshot.players || []) state.rosters[p.id] = p;
    if (!state.rosters[selfId]) state.rosters[selfId] = { id: selfId, name: state.name };
    renderRoom();
  });

  getName((name, peerId) => {
    const cleaned = String(name).slice(0, 20) || 'Player';
    state.rosters[peerId] = { id: peerId, name: cleaned };
    if (state.isHost) broadcastLobby();
    renderRoom();
  });

  getAct((action, peerId) => {
    if (!state.isHost) return;
    if (!action || action.playerId !== peerId) return; // anti-impersonate
    processAction(action);
  });

  getState((payload, peerId) => {
    if (peerId !== state.hostPeerId) return;
    state.view = payload.view;
    state.log = payload.log || [];
    if (state.view?.phase) state.gameOver = state.view.phase === 'won' || state.view.phase === 'lost';
    if (state.screen !== 'game') showScreen('game');
    renderGame();
  });

  getErr((msg) => {
    flashError(String(msg));
  });

  els.roomCodeDisplay.textContent = roomCode;
  showScreen('room');
  renderRoom();
}

function lobbySnapshot() {
  return { players: Object.values(state.rosters) };
}

function broadcastLobby() {
  state.send.sendLobby(lobbySnapshot());
}

function broadcastError(msg) {
  state.send.sendErr(msg);
  flashError(msg);
}

function cleanupAndReturnToLobby() {
  if (state.room) {
    try { state.room.leave(); } catch {}
  }
  state.room = null;
  state.isHost = false;
  state.isSolo = false;
  state.hostPeerId = null;
  state.rosters = {};
  state.game = null;
  state.view = null;
  state.log = [];
  state.selected.clear();
  state.gameOver = false;
  document.body.classList.remove('solo');
  showScreen('lobby');
}

// ===== Host action handling =====

function processAction(action) {
  if (!state.game) return;
  let result;
  switch (action.type) {
    case 'play':
      result = engine.applyPlay(state.game, action.playerId, action.cardIds);
      break;
    case 'yield':
      result = engine.applyYield(state.game, action.playerId);
      break;
    case 'discard':
      result = engine.applyDiscard(state.game, action.playerId, action.cardIds);
      break;
    case 'chooseNext':
      result = engine.applyChooseNext(state.game, action.playerId, action.targetPlayerId);
      break;
    case 'useJester':
      result = engine.applyUseJester(state.game, action.playerId);
      break;
    default:
      return;
  }
  if (result.error) {
    if (state.isSolo) {
      flashError(result.error);
    } else {
      state.send.sendErr(result.error, action.playerId);
      if (action.playerId === selfId) flashError(result.error);
    }
    return;
  }
  state.game = result.state;
  broadcastGameState();
}

function broadcastGameState() {
  if (!state.game) return;
  // Update the log with this transition's events
  for (const e of state.game.events) {
    const msg = formatEvent(e);
    if (msg) state.log.push(msg);
  }
  if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);

  // Self view (host is also a player)
  state.view = engine.viewFor(state.game, myId());
  state.gameOver = state.view.phase === 'won' || state.view.phase === 'lost';
  renderGame();

  if (state.isSolo) return;

  // Per-peer views
  for (const peerId of Object.keys(state.room.getPeers())) {
    const v = engine.viewFor(state.game, peerId);
    state.send.sendState({ view: v, log: state.log }, peerId);
  }
}

function startSoloGame() {
  state.isSolo = true;
  state.isHost = false;
  state.hostPeerId = null;
  state.room = null;
  state.send = {};
  state.rosters = { [SOLO_ID]: { id: SOLO_ID, name: state.name } };
  try {
    state.game = engine.createGame([{ id: SOLO_ID, name: state.name }]);
  } catch (e) {
    setStatus(String(e.message || e), 'lobby');
    return;
  }
  state.log = [];
  state.gameOver = false;
  state.selected.clear();
  showScreen('game');
  broadcastGameState();
}

function startGame() {
  if (!state.isHost) return;
  // Players in roster insertion order (host first by Object.values semantics)
  const players = Object.values(state.rosters).map(p => ({ id: p.id, name: p.name }));
  if (players.length < 1 || players.length > 4) {
    setStatus('Need 1–4 players to start.', 'room');
    return;
  }
  try {
    state.game = engine.createGame(players);
  } catch (e) {
    setStatus(String(e.message || e), 'room');
    return;
  }
  state.log = [];
  state.gameOver = false;
  state.selected.clear();
  broadcastGameState();
  showScreen('game');
}

// ===== Local dispatch =====

function dispatchAction(action) {
  action.playerId = myId();
  if (state.isHost || state.isSolo) processAction(action);
  else state.send.sendAct(action);
}

// ===== Event log formatting =====

function formatEvent(e) {
  switch (e.type) {
    case 'cards_played':
      return `${nameOf(e.playerId)} played ${e.cards.join(', ')} — ${e.total} attack`;
    case 'yield':
      return `${nameOf(e.playerId)} yielded`;
    case 'jester_played':
      return `${nameOf(e.playerId)} played a Jester — enemy immunity lifted`;
    case 'heal':
      return e.amount > 0 ? `♥ Healed ${e.amount} card(s) into the tavern` : '♥ Heal had no effect (no discard)';
    case 'draw': {
      const drew = Object.entries(e.byPlayer || {})
        .map(([pid, n]) => `${nameOf(pid)} +${n}`)
        .join(', ');
      return e.amount > 0 ? `♦ Drew ${e.amount} — ${drew}` : '♦ Tavern empty';
    }
    case 'clubs_doubled':
      return `♣ Damage doubled to ${e.amount}`;
    case 'damage_dealt':
      return `Dealt ${e.amount} damage`;
    case 'shield':
      return e.retroactive
        ? `♠ Retroactive shield +${e.amount}`
        : `♠ Shield +${e.amount}`;
    case 'immune':
      return `· ${engine.SUIT_SYMBOL[e.suit]} ${engine.SUIT_NAME[e.suit]} blocked (enemy immune)`;
    case 'enemy_defeated': {
      const tag = e.exact ? ' (exact kill — face-down on tavern)' : '';
      return `✦ ${e.enemy.rank}${engine.SUIT_SYMBOL[e.enemy.suit] || ''} defeated${tag}`;
    }
    case 'enemy_revealed':
      return `New enemy revealed: ${e.enemy.rank}${engine.SUIT_SYMBOL[e.enemy.suit]}`;
    case 'enemy_attacks':
      return `Enemy attacks ${nameOf(e.target)} for ${e.amount}`;
    case 'damage_taken':
      return `${nameOf(e.playerId)} discarded ${e.cardIds.join(', ')} for ${e.total}`;
    case 'next_chosen':
      return `${nameOf(e.byPlayerId)} chose ${nameOf(e.chosenPlayerId)} to go next`;
    case 'solo_jester':
      return `★ Jester used — discarded ${e.discarded}, drew ${e.drew} (${e.jestersLeft} left)`;
    case 'game_over':
      if (e.won) return '★ VICTORY — all 12 royals defeated';
      if (e.reason === 'damage') return `✖ ${nameOf(e.playerId)} fell to ${e.incoming} damage`;
      return `✖ ${nameOf(e.playerId)} cannot continue`;
    default:
      return '';
  }
}

// ===== Card rendering =====

const FACE_ICON = { J: '♞', Q: '♛', K: '♚' }; // chess knight/queen/king

function makeCardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.dataset.cardId = card.id;

  if (engine.isJesterCard(card)) {
    el.className = 'card jester';
    el.innerHTML = `
      <div class="rank">★</div>
      <div class="suit-big">★</div>
      <div class="rank rank-bot">★</div>
    `;
  } else {
    const cls = ['card', engine.isRed(card) ? 'red' : 'black'];
    if (engine.isFace(card)) cls.push('face');
    if (opts.big) cls.push('enemy');
    el.className = cls.join(' ');
    const sym = engine.SUIT_SYMBOL[card.suit] || '';
    if (engine.isFace(card)) {
      el.innerHTML = `
        <div class="rank">${card.rank}</div>
        <div class="corner-suit tl">${sym}</div>
        <div class="face-icon">${FACE_ICON[card.rank] || '?'}</div>
        <div class="corner-suit br">${sym}</div>
        <div class="rank rank-bot">${card.rank}</div>
      `;
    } else {
      el.innerHTML = `
        <div class="rank">${card.rank}</div>
        <div class="suit-big">${sym}</div>
        <div class="rank rank-bot">${card.rank}</div>
      `;
    }
  }
  if (opts.selected) el.classList.add('selected');
  if (opts.disabled) el.classList.add('disabled');
  if (opts.onClick && !opts.disabled) el.addEventListener('click', opts.onClick);
  return el;
}

function enemyNameStr(enemy) {
  return `${({ J: 'Jack', Q: 'Queen', K: 'King' })[enemy.rank]} of ${engine.SUIT_NAME[enemy.suit]}`;
}

// ===== Renderers =====

function renderRoom() {
  els.playersList.innerHTML = '';
  const players = Object.values(state.rosters);
  for (const p of players) {
    const li = document.createElement('li');
    const tags = [];
    if (p.id === state.hostPeerId) tags.push('host');
    if (p.id === selfId) tags.push('you');
    li.innerHTML = `${escapeHtml(p.name)}${tags.length ? ` <span class="badge">${tags.join(' · ')}</span>` : ''}`;
    els.playersList.appendChild(li);
  }
  els.startBtn.hidden = !state.isHost;
  els.startBtn.disabled = players.length < 1 || players.length > 4;
}

function renderGame() {
  const v = state.view;
  if (!v) return;

  document.body.classList.toggle('solo', !!v.isSolo);

  // Header
  if (v.phase === 'won') {
    els.enemiesProgress.textContent = `★ Victory — defeated all ${v.totalEnemies} royals`;
  } else if (v.phase === 'lost') {
    els.enemiesProgress.textContent = `✖ Defeated after ${v.enemiesDefeated}/${v.totalEnemies} royals`;
  } else {
    els.enemiesProgress.textContent = `Royal ${v.enemiesDefeated + 1} of ${v.totalEnemies}`;
  }

  // Enemy
  els.enemyArea.innerHTML = '';
  if (v.enemy) {
    const wrap = document.createElement('div');
    wrap.className = 'enemy-display';
    wrap.appendChild(makeCardEl(v.enemy, { big: true, disabled: true }));
    const info = document.createElement('div');
    info.className = 'enemy-info';
    const remaining = v.enemyHealth - v.enemyDamage;
    const atk = Math.max(0, v.enemyAttack - v.enemyShield);
    const immuneTxt = v.enemyImmunityNegated
      ? '<em class="muted">cancelled</em>'
      : `${engine.SUIT_SYMBOL[v.enemy.suit]} ${engine.SUIT_NAME[v.enemy.suit]}`;
    const shieldTxt = v.enemyShield ? ` <small>(base ${v.enemyAttack} − shield ${v.enemyShield})</small>` : '';
    info.innerHTML = `
      <div class="enemy-name">${enemyNameStr(v.enemy)}</div>
      <div class="stat"><span>HP</span><strong>${remaining} / ${v.enemyHealth}</strong></div>
      <div class="stat"><span>ATK</span><strong>${atk}</strong>${shieldTxt}</div>
      <div class="stat"><span>Immune</span><strong>${immuneTxt}</strong></div>
      <div class="stat"><span>Tavern</span><strong>${v.tavernCount}</strong></div>
      <div class="stat"><span>Discard</span><strong>${v.discard.length}</strong></div>
    `;
    wrap.appendChild(info);
    els.enemyArea.appendChild(wrap);
  }

  // Played
  els.playedCards.innerHTML = '';
  for (const c of v.playedAgainstEnemy) {
    els.playedCards.appendChild(makeCardEl(c, { disabled: true }));
  }

  // Log
  els.logEl.innerHTML = '';
  for (const msg of state.log.slice(-14)) {
    const li = document.createElement('li');
    li.textContent = msg;
    els.logEl.appendChild(li);
  }
  els.logEl.scrollTop = els.logEl.scrollHeight;

  // Players row
  els.playersRow.innerHTML = '';
  const choosing = v.phase === 'choose_next' && v.currentPlayerId === myId();
  const meId = myId();
  for (const p of v.players) {
    const pe = document.createElement('div');
    pe.className = 'player-card';
    if (p.isCurrent) pe.classList.add('current');
    if (p.id === meId) pe.classList.add('you');
    pe.innerHTML = `
      <div class="pname">${escapeHtml(p.name)}${p.id === meId ? ' · you' : ''}${p.isCurrent ? ' ★' : ''}</div>
      <div class="hand-count">${p.handCount} cards${p.yieldedLast ? ' · yielded last' : ''}</div>
    `;
    if (choosing) {
      pe.classList.add('clickable');
      pe.addEventListener('click', () => {
        dispatchAction({ type: 'chooseNext', targetPlayerId: p.id });
      });
    }
    els.playersRow.appendChild(pe);
  }

  // Hand
  const me = v.players.find(p => p.id === meId);
  const hand = sortHand(me?.hand || []);
  els.handTitle.textContent = `Your hand (${hand.length}/${v.handSize})`;
  els.handCards.innerHTML = '';
  const selectable = v.yourTurn && (v.phase === 'play' || v.phase === 'damage');
  for (const c of hand) {
    const isSelected = state.selected.has(c.id);
    const el = makeCardEl(c, {
      selected: isSelected,
      disabled: !selectable,
      onClick: selectable ? () => toggleSelect(c.id) : null,
    });
    els.handCards.appendChild(el);
  }

  // Action bar
  updateActionBar();
}

function updateActionBar() {
  const v = state.view;
  if (!v) return;

  els.actionPrompt.classList.remove('urgent', 'over', 'lost');
  els.playBtn.hidden = false;
  els.playBtn.disabled = true;
  els.discardBtn.hidden = true;
  els.discardBtn.disabled = true;
  els.jesterBtn.hidden = true;
  els.jesterBtn.disabled = true;
  els.yieldBtn.hidden = false;
  els.yieldBtn.disabled = true;

  if (v.phase === 'won') {
    els.actionPrompt.textContent = v.isSolo
      ? `★ ${soloMedal(v.jestersLeft)} victory — defeated all 12 royals (Jesters used: ${2 - v.jestersLeft})`
      : '★ All royals defeated. Victory!';
    els.actionPrompt.classList.add('over');
    els.playBtn.hidden = true;
    els.yieldBtn.hidden = true;
    return;
  }
  if (v.phase === 'lost') {
    els.actionPrompt.textContent = '✖ The party falls.';
    els.actionPrompt.classList.add('lost');
    els.playBtn.hidden = true;
    els.yieldBtn.hidden = true;
    return;
  }
  if (!v.yourTurn) {
    els.actionPrompt.textContent = `Waiting for ${nameOf(v.currentPlayerId)}…`;
    els.playBtn.hidden = true;
    els.yieldBtn.hidden = true;
    return;
  }

  if (v.phase === 'play') {
    els.actionPrompt.textContent = v.isSolo
      ? 'Your turn — play, Jester, or yield.'
      : 'Your turn — play or yield.';
    els.actionPrompt.classList.add('urgent');
    els.playBtn.disabled = state.selected.size === 0;
    const total = sumSelected();
    els.playBtn.textContent = state.selected.size ? `Play (${total})` : 'Play';
    els.yieldBtn.disabled = !v.canYieldNow;
    if (v.isSolo) {
      els.jesterBtn.hidden = false;
      els.jesterBtn.disabled = v.jestersLeft <= 0;
      els.jesterBtn.textContent = `Jester (${v.jestersLeft})`;
    }
  } else if (v.phase === 'damage') {
    const total = sumSelected();
    els.actionPrompt.textContent = `You must discard at least ${v.pendingDamage}.`;
    els.actionPrompt.classList.add('urgent');
    els.playBtn.hidden = true;
    els.yieldBtn.hidden = true;
    els.discardBtn.hidden = false;
    els.discardBtn.disabled = total < v.pendingDamage;
    els.discardBtn.textContent = `Discard (${total}/${v.pendingDamage})`;
  } else if (v.phase === 'choose_next') {
    els.actionPrompt.textContent = 'Choose any player to go next.';
    els.actionPrompt.classList.add('urgent');
    els.playBtn.hidden = true;
    els.yieldBtn.hidden = true;
  }
}

function soloMedal(jestersLeft) {
  const used = 2 - jestersLeft;
  return used === 0 ? 'Gold' : used === 1 ? 'Silver' : 'Bronze';
}

function sumSelected() {
  const v = state.view;
  if (!v) return 0;
  const hand = v.players.find(p => p.id === myId())?.hand || [];
  return hand.filter(c => state.selected.has(c.id)).reduce((s, c) => s + engine.cardValue(c), 0);
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderGame();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ===== Event listeners =====

els.soloBtn.addEventListener('click', () => {
  state.name = (els.nameInput.value.trim() || 'Anonymous').slice(0, 16);
  startSoloGame();
});

els.createBtn.addEventListener('click', () => {
  state.name = (els.nameInput.value.trim() || 'Anonymous').slice(0, 16);
  setupRoom(generateRoomCode(), true);
});

els.joinBtn.addEventListener('click', () => {
  const code = els.joinCode.value.trim().toUpperCase();
  if (!code) { setStatus('Enter a room code.', 'lobby'); return; }
  state.name = (els.nameInput.value.trim() || 'Anonymous').slice(0, 16);
  setupRoom(code, false);
});

els.startBtn.addEventListener('click', startGame);

els.leaveBtn.addEventListener('click', cleanupAndReturnToLobby);
els.leaveGameBtn.addEventListener('click', cleanupAndReturnToLobby);

els.playBtn.addEventListener('click', () => {
  const cardIds = [...state.selected];
  if (!cardIds.length) return;
  dispatchAction({ type: 'play', cardIds });
  state.selected.clear();
});

els.discardBtn.addEventListener('click', () => {
  const cardIds = [...state.selected];
  if (!cardIds.length) return;
  dispatchAction({ type: 'discard', cardIds });
  state.selected.clear();
});

els.yieldBtn.addEventListener('click', () => {
  dispatchAction({ type: 'yield' });
});

els.jesterBtn.addEventListener('click', () => {
  state.selected.clear();
  dispatchAction({ type: 'useJester' });
});

els.rulesBtn.addEventListener('click', () => els.rulesDialog.showModal());
els.rulesClose.addEventListener('click', () => els.rulesDialog.close());

document.addEventListener('keydown', e => {
  if (e.key === '?' && state.screen === 'game') {
    if (els.rulesDialog.open) els.rulesDialog.close();
    else els.rulesDialog.showModal();
  }
  if (e.key === 'Enter' && state.screen === 'lobby') {
    if (els.joinCode.value.trim()) els.joinBtn.click();
  }
});

// Initial
showScreen('lobby');
