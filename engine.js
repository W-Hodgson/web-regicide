// engine.js — Regicide game engine (pure functions over state, 1-4 players)

export const SUITS = ['H', 'D', 'C', 'S'];
export const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
export const SUIT_NAME = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
export const RED_SUITS = new Set(['H', 'D']);

export const HAND_SIZE = { 1: 8, 2: 7, 3: 6, 4: 5 };
export const JESTER_COUNT = { 1: 0, 2: 0, 3: 1, 4: 2 };
export const ENEMY_HEALTH = { J: 20, Q: 30, K: 40 };
export const ENEMY_ATTACK = { J: 10, Q: 15, K: 20 };
export const TOTAL_ENEMIES = 12;

// === Card helpers ===

export function cardValue(card) {
  if (!card) return 0;
  if (card.rank === 'X') return 0;
  if (card.rank === 'A') return 1;
  if (card.rank === 'J') return 10;
  if (card.rank === 'Q') return 15;
  if (card.rank === 'K') return 20;
  return parseInt(card.rank, 10);
}

export const isAnimal = c => !!c && c.rank === 'A';
export const isJesterCard = c => !!c && c.rank === 'X';
export const isFace = c => !!c && 'JQK'.includes(c.rank);
export const isRed = c => !!c && RED_SUITS.has(c.suit);

export function cardLabel(c) {
  if (!c) return '';
  if (isJesterCard(c)) return '★ Jester';
  return `${c.rank}${SUIT_SYMBOL[c.suit] || ''}`;
}

// === RNG (Mulberry32 for reproducible setup; in-game shuffles use Math.random on the host) ===

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// === Deck construction ===

function makeTavern(numPlayers, rand) {
  const cards = [];
  for (const s of SUITS) {
    cards.push({ rank: 'A', suit: s, id: `A${s}` });
    for (let n = 2; n <= 10; n++) {
      cards.push({ rank: String(n), suit: s, id: `${n}${s}` });
    }
  }
  for (let i = 0; i < JESTER_COUNT[numPlayers]; i++) {
    cards.push({ rank: 'X', suit: null, id: `X${i + 1}` });
  }
  return shuffle(cards, rand);
}

function makeCastle(rand) {
  const k = shuffle(SUITS.map(s => ({ rank: 'K', suit: s, id: `K${s}` })), rand);
  const q = shuffle(SUITS.map(s => ({ rank: 'Q', suit: s, id: `Q${s}` })), rand);
  const j = shuffle(SUITS.map(s => ({ rank: 'J', suit: s, id: `J${s}` })), rand);
  // We pop() from the end, so end of the array = top of the pile.
  // Jacks at the end means Jacks are fought first.
  return [...k, ...q, ...j];
}

// === Game creation ===

export function createGame(players, options = {}) {
  const numPlayers = players.length;
  if (numPlayers < 1 || numPlayers > 4) {
    throw new Error('Regicide supports 1-4 players');
  }
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const rand = mulberry32(seed);
  const handSize = HAND_SIZE[numPlayers];
  const tavern = makeTavern(numPlayers, rand);
  const castle = makeCastle(rand);

  const gamePlayers = players.map(p => ({
    id: p.id,
    name: p.name || 'Player',
    hand: [],
    yieldedLast: false,
  }));

  for (const p of gamePlayers) {
    for (let i = 0; i < handSize; i++) {
      p.hand.push(tavern.pop());
    }
  }

  const enemy = castle.pop();

  return {
    seed,
    numPlayers,
    handSize,
    players: gamePlayers,
    tavern,
    castle,
    discard: [],
    enemy,
    enemyDamage: 0,
    enemyShield: 0,
    enemyImmunityNegated: false,
    playedAgainstEnemy: [],
    currentPlayerIndex: 0,
    phase: 'play', // play | damage | choose_next | won | lost
    pendingDamage: 0,
    enemiesDefeated: 0,
    totalEnemies: TOTAL_ENEMIES,
    lossReason: null,
    events: [],
  };
}

// === Validation ===

function turnError(state, playerId, phase) {
  if (state.phase !== phase) return `Not in ${phase} phase`;
  const idx = state.players.findIndex(p => p.id === playerId);
  if (idx < 0) return 'Unknown player';
  if (idx !== state.currentPlayerIndex) return 'Not your turn';
  return null;
}

export function validatePlay(state, playerId, cardIds) {
  const t = turnError(state, playerId, 'play');
  if (t) return t;
  if (!cardIds || cardIds.length === 0) return 'Pick at least one card';
  if (new Set(cardIds).size !== cardIds.length) return 'Cannot play the same card twice';

  const player = state.players[state.currentPlayerIndex];
  const cards = cardIds.map(id => player.hand.find(c => c.id === id));
  if (cards.some(c => !c)) return 'Card not in hand';

  if (cards.some(isJesterCard)) {
    if (cards.length !== 1) return 'A Jester must be played alone';
    return null;
  }
  if (cards.length === 1) return null;

  const animals = cards.filter(isAnimal);
  if (cards.length === 2) {
    if (animals.length === 2) return null;
    if (animals.length === 1) return null; // AC + any non-Jester
    if (cards[0].rank !== cards[1].rank) return 'Combos must use the same number';
    if (isFace(cards[0])) return 'Face cards cannot combo';
    const total = cards.reduce((s, c) => s + cardValue(c), 0);
    if (total > 10) return 'Combo total must be ≤ 10';
    return null;
  }

  if (cards.length > 4) return 'At most 4 cards in a combo';
  if (animals.length) return 'Animal Companions can only pair with one other card';
  const rank = cards[0].rank;
  if (cards.some(c => c.rank !== rank)) return 'Combos must use the same number';
  if (isFace(cards[0])) return 'Face cards cannot combo';
  const total = cards.reduce((s, c) => s + cardValue(c), 0);
  if (total > 10) return 'Combo total must be ≤ 10';
  return null;
}

export function canYield(state, playerId) {
  const t = turnError(state, playerId, 'play');
  if (t) return t;
  const idx = state.players.findIndex(p => p.id === playerId);
  const others = state.players.filter((_, i) => i !== idx);
  if (state.numPlayers === 1) {
    if (state.players[idx].yieldedLast) return 'Cannot yield twice in a row in solo';
    return null;
  }
  if (others.length && others.every(p => p.yieldedLast)) {
    return 'All other players yielded on their last turn';
  }
  return null;
}

// === Internal helpers (mutate the passed state) ===

function heal(s, n) {
  if (!s.discard.length) return 0;
  s.discard = shuffle(s.discard, Math.random);
  const take = Math.min(n, s.discard.length);
  const moved = s.discard.splice(0, take);
  // Tavern bottom = index 0; we pop() from the end.
  s.tavern.unshift(...moved);
  return take;
}

function drawClockwise(s, n, startPlayerId) {
  const startIdx = s.players.findIndex(p => p.id === startPlayerId);
  let i = startIdx;
  const byPlayer = {};
  let drawn = 0;
  let consecutiveSkips = 0;
  while (drawn < n && s.tavern.length > 0 && consecutiveSkips < s.players.length) {
    const p = s.players[i];
    if (p.hand.length < s.handSize) {
      p.hand.push(s.tavern.pop());
      byPlayer[p.id] = (byPlayer[p.id] || 0) + 1;
      drawn++;
      consecutiveSkips = 0;
    } else {
      consecutiveSkips++;
    }
    i = (i + 1) % s.players.length;
  }
  return { total: drawn, byPlayer };
}

function takeDamage(s, playerId) {
  const incoming = Math.max(0, ENEMY_ATTACK[s.enemy.rank] - s.enemyShield);
  if (incoming === 0) {
    advanceToNext(s);
    return;
  }
  const player = s.players.find(p => p.id === playerId);
  const handTotal = player.hand.reduce((sum, c) => sum + cardValue(c), 0);
  if (handTotal < incoming) {
    s.phase = 'lost';
    s.lossReason = 'damage';
    s.events.push({ type: 'game_over', won: false, reason: 'damage', playerId, incoming });
    return;
  }
  s.phase = 'damage';
  s.pendingDamage = incoming;
  s.events.push({ type: 'enemy_attacks', amount: incoming, target: playerId });
}

function advanceToNext(s) {
  s.currentPlayerIndex = (s.currentPlayerIndex + 1) % s.numPlayers;
  s.phase = 'play';
  s.pendingDamage = 0;
  checkStartTurn(s);
}

function checkStartTurn(s) {
  // A player with an empty hand may only yield. If they can't yield, the game is lost.
  const p = s.players[s.currentPlayerIndex];
  if (p.hand.length === 0 && canYield(s, p.id)) {
    s.phase = 'lost';
    s.lossReason = 'cannot_play';
    s.events.push({ type: 'game_over', won: false, reason: 'cannot_play', playerId: p.id });
  }
}

function resolveDefeat(s) {
  s.discard.push(...s.playedAgainstEnemy);
  s.playedAgainstEnemy = [];
  const enemy = s.enemy;
  const exact = s.enemyDamage === ENEMY_HEALTH[enemy.rank];
  if (exact) {
    s.tavern.push(enemy); // top of tavern (face-down to the player, but we just push to draw pile)
  } else {
    s.discard.push(enemy);
  }
  s.events.push({ type: 'enemy_defeated', enemy, exact });
  s.enemiesDefeated += 1;

  if (s.castle.length === 0) {
    s.enemy = null;
    s.phase = 'won';
    s.events.push({ type: 'game_over', won: true });
    return;
  }
  s.enemy = s.castle.pop();
  s.enemyDamage = 0;
  s.enemyShield = 0;
  s.enemyImmunityNegated = false;
  s.events.push({ type: 'enemy_revealed', enemy: s.enemy });
  s.phase = 'play';
  // Same player goes again — check they can still act
  checkStartTurn(s);
}

// === Apply actions (return { state, events } or { error }) ===

export function applyPlay(state, playerId, cardIds) {
  const err = validatePlay(state, playerId, cardIds);
  if (err) return { error: err };

  const s = structuredClone(state);
  s.events = [];
  const player = s.players[s.currentPlayerIndex];
  const cards = cardIds.map(id => player.hand.find(c => c.id === id));

  // Remove cards from hand
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));
  player.yieldedLast = false;

  // Jester branch
  if (cards.length === 1 && isJesterCard(cards[0])) {
    s.playedAgainstEnemy.push(cards[0]);
    const wasNegated = s.enemyImmunityNegated;
    s.enemyImmunityNegated = true;
    s.events.push({ type: 'jester_played', playerId, cardId: cards[0].id });
    // Retroactive shielding: any spades previously played against a Spades enemy now apply.
    if (!wasNegated && s.enemy.suit === 'S') {
      const priorSpades = s.playedAgainstEnemy
        .filter(c => c.suit === 'S')
        .reduce((sum, c) => sum + cardValue(c), 0);
      if (priorSpades > 0) {
        s.enemyShield += priorSpades;
        s.events.push({ type: 'shield', amount: priorSpades, retroactive: true });
      }
    }
    if (s.numPlayers === 1) {
      s.phase = 'play';
      checkStartTurn(s);
    } else {
      s.phase = 'choose_next';
    }
    return { state: s, events: s.events };
  }

  // Normal play: resolve suit powers at the total attack value
  s.playedAgainstEnemy.push(...cards);
  const total = cards.reduce((sum, c) => sum + cardValue(c), 0);
  const suits = new Set(cards.map(c => c.suit).filter(Boolean));
  const enemySuit = s.enemy.suit;
  const blocked = suit => !s.enemyImmunityNegated && enemySuit === suit;

  s.events.push({ type: 'cards_played', playerId, cards: cards.map(c => c.id), total });

  // Hearts first (then Diamonds), per rules
  if (suits.has('H')) {
    if (blocked('H')) s.events.push({ type: 'immune', suit: 'H' });
    else {
      const healed = heal(s, total);
      s.events.push({ type: 'heal', amount: healed });
    }
  }
  if (suits.has('D')) {
    if (blocked('D')) s.events.push({ type: 'immune', suit: 'D' });
    else {
      const drew = drawClockwise(s, total, playerId);
      s.events.push({ type: 'draw', amount: drew.total, byPlayer: drew.byPlayer });
    }
  }

  let damage = total;
  if (suits.has('C')) {
    if (blocked('C')) s.events.push({ type: 'immune', suit: 'C' });
    else {
      damage *= 2;
      s.events.push({ type: 'clubs_doubled', amount: damage });
    }
  }
  s.enemyDamage += damage;
  s.events.push({ type: 'damage_dealt', amount: damage });

  if (suits.has('S')) {
    if (blocked('S')) s.events.push({ type: 'immune', suit: 'S' });
    else {
      s.enemyShield += total;
      s.events.push({ type: 'shield', amount: total });
    }
  }

  if (s.enemyDamage >= ENEMY_HEALTH[s.enemy.rank]) {
    resolveDefeat(s);
    return { state: s, events: s.events };
  }

  takeDamage(s, playerId);
  return { state: s, events: s.events };
}

export function applyYield(state, playerId) {
  const err = canYield(state, playerId);
  if (err) return { error: err };
  const s = structuredClone(state);
  s.events = [];
  const idx = s.players.findIndex(p => p.id === playerId);
  s.players[idx].yieldedLast = true;
  s.events.push({ type: 'yield', playerId });
  takeDamage(s, playerId);
  return { state: s, events: s.events };
}

export function applyDiscard(state, playerId, cardIds) {
  const t = turnError(state, playerId, 'damage');
  if (t) return { error: t };
  if (!cardIds || !cardIds.length) return { error: 'Pick at least one card' };
  if (new Set(cardIds).size !== cardIds.length) return { error: 'Duplicate card' };
  const player = state.players[state.currentPlayerIndex];
  const cards = cardIds.map(id => player.hand.find(c => c.id === id));
  if (cards.some(c => !c)) return { error: 'Card not in hand' };
  const total = cards.reduce((sum, c) => sum + cardValue(c), 0);
  if (total < state.pendingDamage) {
    return { error: `Total ${total} doesn't cover ${state.pendingDamage} damage` };
  }

  const s = structuredClone(state);
  s.events = [];
  const p = s.players[s.currentPlayerIndex];
  p.hand = p.hand.filter(c => !cardIds.includes(c.id));
  s.discard.push(...cards);
  s.events.push({ type: 'damage_taken', playerId, total, required: state.pendingDamage, cardIds });
  advanceToNext(s);
  return { state: s, events: s.events };
}

export function applyChooseNext(state, playerId, targetPlayerId) {
  const t = turnError(state, playerId, 'choose_next');
  if (t) return { error: t };
  const targetIdx = state.players.findIndex(p => p.id === targetPlayerId);
  if (targetIdx < 0) return { error: 'Unknown target player' };
  const s = structuredClone(state);
  s.events = [];
  s.currentPlayerIndex = targetIdx;
  s.phase = 'play';
  s.events.push({ type: 'next_chosen', byPlayerId: playerId, chosenPlayerId: targetPlayerId });
  checkStartTurn(s);
  return { state: s, events: s.events };
}

// === View (per-player projection that masks hidden info) ===

export function viewFor(state, playerId) {
  return {
    phase: state.phase,
    numPlayers: state.numPlayers,
    handSize: state.handSize,
    enemy: state.enemy,
    enemyHealth: state.enemy ? ENEMY_HEALTH[state.enemy.rank] : 0,
    enemyAttack: state.enemy ? ENEMY_ATTACK[state.enemy.rank] : 0,
    enemyDamage: state.enemyDamage,
    enemyShield: state.enemyShield,
    enemyImmunityNegated: state.enemyImmunityNegated,
    playedAgainstEnemy: state.playedAgainstEnemy,
    discard: state.discard,
    tavernCount: state.tavern.length,
    castleCount: state.castle.length,
    enemiesDefeated: state.enemiesDefeated,
    totalEnemies: state.totalEnemies,
    pendingDamage: state.pendingDamage,
    currentPlayerIndex: state.currentPlayerIndex,
    currentPlayerId: state.players[state.currentPlayerIndex]?.id ?? null,
    yourTurn: state.players[state.currentPlayerIndex]?.id === playerId,
    you: playerId,
    canYieldNow: canYield(state, playerId) === null,
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : null,
      yieldedLast: p.yieldedLast,
      isCurrent: i === state.currentPlayerIndex,
    })),
    lossReason: state.lossReason,
    events: state.events,
  };
}
