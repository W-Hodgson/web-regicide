// engine.js — MESBG tracker engine (pure functions over state, 2 players or solo)

export const STAT_KEYS = ['wounds', 'might', 'will', 'fate'];
export const STAT_LABEL = { wounds: 'Wounds', might: 'Might', will: 'Will', fate: 'Fate' };
export const STAT_SHORT = { wounds: 'W', might: 'M', will: 'Wi', fate: 'F' };
export const STAT_GLYPH = { wounds: '❤', might: '⚔', will: '✦', fate: '★' };

const HERO_ID_PREFIX = 'h_';
let heroCounter = 0;
function newHeroId() {
  heroCounter += 1;
  return `${HERO_ID_PREFIX}${Date.now().toString(36)}_${heroCounter}`;
}

// === Game creation ===

export function createGame(hostId, options = {}) {
  return {
    phase: 'setup',
    hostId,
    isSolo: !!options.isSolo,
    armies: [makeArmy(hostId), makeArmy(options.isSolo ? hostId : null)],
    events: [],
  };
}

function makeArmy(ownerId) {
  return {
    ownerId,
    armyName: '',
    maxModels: 0,
    currentModels: 0,
    heroes: [],
    ready: false,
  };
}

function validateOwner(state, playerId, armyIndex) {
  if (state.isSolo) return null;
  const army = state.armies[armyIndex];
  if (!army) return 'Unknown army';
  if (army.ownerId !== playerId) return 'Not your army';
  return null;
}

// === Connection plumbing (host-side helpers) ===

export function attachOwner(state, ownerId) {
  if (state.armies[0].ownerId === ownerId) return { state };
  if (state.armies[1].ownerId === ownerId) return { state };
  if (state.armies[1].ownerId) return { error: 'Room is full' };
  if (state.phase !== 'setup') return { error: 'Game already started' };
  const s = structuredClone(state);
  s.armies[1].ownerId = ownerId;
  s.events = [];
  return { state: s };
}

export function detachOwner(state, ownerId) {
  if (state.armies[1].ownerId !== ownerId) return { state };
  const s = structuredClone(state);
  s.armies[1].ownerId = null;
  s.armies[1].ready = false;
  s.events = [];
  return { state: s };
}

// === Setup phase actions ===

export function applySetArmyName(state, playerId, armyIndex, name) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const s = structuredClone(state);
  s.armies[armyIndex].armyName = String(name || '').slice(0, 32);
  s.events = [];
  return { state: s };
}

export function applySetMaxModels(state, playerId, armyIndex, n) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const num = clamp(parseInt(n, 10) || 0, 0, 999);
  const s = structuredClone(state);
  s.armies[armyIndex].maxModels = num;
  s.armies[armyIndex].currentModels = num;
  s.events = [];
  return { state: s };
}

export function applyAddHero(state, playerId, armyIndex, heroInput) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const h = sanitizeHeroInput(heroInput);
  if (!h.name) return { error: 'Hero needs a name' };
  const s = structuredClone(state);
  h.id = newHeroId();
  s.armies[armyIndex].heroes.push(h);
  s.events = [];
  return { state: s };
}

export function applyUpdateHero(state, playerId, armyIndex, heroId, patch) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const s = structuredClone(state);
  const idx = s.armies[armyIndex].heroes.findIndex(h => h.id === heroId);
  if (idx < 0) return { error: 'Hero not found' };
  const merged = sanitizeHeroInput({ ...s.armies[armyIndex].heroes[idx], ...patch });
  if (!merged.name) return { error: 'Hero needs a name' };
  merged.id = heroId;
  s.armies[armyIndex].heroes[idx] = merged;
  s.events = [];
  return { state: s };
}

export function applyRemoveHero(state, playerId, armyIndex, heroId) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const s = structuredClone(state);
  s.armies[armyIndex].heroes = s.armies[armyIndex].heroes.filter(h => h.id !== heroId);
  s.events = [];
  return { state: s };
}

export function applySetReady(state, playerId, armyIndex, ready) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const s = structuredClone(state);
  s.armies[armyIndex].ready = !!ready;
  s.events = [];
  return { state: s };
}

export function applyStartGame(state, playerId) {
  if (state.phase !== 'setup') return { error: 'Not in setup' };
  if (playerId !== state.hostId) return { error: 'Only the host can start' };
  if (!state.isSolo) {
    if (!state.armies[0].ownerId || !state.armies[1].ownerId) {
      return { error: 'Waiting for both players' };
    }
    if (!state.armies[0].ready || !state.armies[1].ready) {
      return { error: 'Both players must be ready' };
    }
  }
  for (const a of state.armies) {
    if (a.maxModels <= 0) return { error: `${a.armyName || 'An army'} needs a model count` };
    if (a.heroes.length === 0) return { error: `${a.armyName || 'An army'} needs at least one hero` };
  }
  const s = structuredClone(state);
  s.phase = 'playing';
  for (const a of s.armies) {
    a.currentModels = a.maxModels;
    for (const h of a.heroes) {
      h.wounds = h.maxWounds;
      h.might = h.maxMight;
      h.will = h.maxWill;
      h.fate = h.maxFate;
      h.dead = false;
    }
  }
  s.events = [{ type: 'game_started' }];
  return { state: s };
}

// === Game phase actions ===

export function applyAdjustModels(state, playerId, armyIndex, delta) {
  if (state.phase !== 'playing') return { error: 'Not in play' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  const s = structuredClone(state);
  const army = s.armies[armyIndex];
  const prev = army.currentModels;
  army.currentModels = clamp(prev + delta, 0, army.maxModels);
  if (army.currentModels === prev) return { state: s };
  s.events = [{ type: 'models_adjusted', armyIndex, armyName: army.armyName, from: prev, to: army.currentModels }];
  return { state: s };
}

export function applyAdjustStat(state, playerId, armyIndex, heroId, stat, delta) {
  if (state.phase !== 'playing') return { error: 'Not in play' };
  const err = validateOwner(state, playerId, armyIndex);
  if (err) return { error: err };
  if (!STAT_KEYS.includes(stat)) return { error: 'Bad stat' };
  const s = structuredClone(state);
  const army = s.armies[armyIndex];
  const hero = army.heroes.find(h => h.id === heroId);
  if (!hero) return { error: 'Hero not found' };

  if (stat === 'wounds') {
    if (delta > 0 && hero.dead && hero.wounds === 0) {
      hero.dead = false;
      hero.wounds = 1;
      army.currentModels = Math.min(army.maxModels, army.currentModels + 1);
      s.events = [{ type: 'hero_revived', armyIndex, armyName: army.armyName, heroName: hero.name, models: army.currentModels }];
      return { state: s };
    }
    const prev = hero.wounds;
    hero.wounds = Math.max(0, prev + delta);
    if (hero.wounds === 0 && !hero.dead) {
      hero.dead = true;
      army.currentModels = Math.max(0, army.currentModels - 1);
      s.events = [{ type: 'hero_died', armyIndex, armyName: army.armyName, heroName: hero.name, models: army.currentModels }];
      return { state: s };
    }
    s.events = [{ type: 'stat_adjusted', armyIndex, armyName: army.armyName, heroName: hero.name, stat, from: prev, to: hero.wounds }];
    return { state: s };
  }

  const prev = hero[stat];
  hero[stat] = Math.max(0, prev + delta);
  if (hero[stat] === prev) return { state: s };
  s.events = [{ type: 'stat_adjusted', armyIndex, armyName: army.armyName, heroName: hero.name, stat, from: prev, to: hero[stat] }];
  return { state: s };
}

export function applyResetToSetup(state, playerId) {
  if (playerId !== state.hostId) return { error: 'Only the host can reset' };
  const s = structuredClone(state);
  s.phase = 'setup';
  for (const a of s.armies) {
    a.ready = false;
    a.currentModels = a.maxModels;
    for (const h of a.heroes) {
      h.wounds = h.maxWounds;
      h.might = h.maxMight;
      h.will = h.maxWill;
      h.fate = h.maxFate;
      h.dead = false;
    }
  }
  s.events = [{ type: 'reset_to_setup' }];
  return { state: s };
}

// === Helpers ===

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sanitizeHeroInput(h) {
  const wounds = clamp(parseInt(h.maxWounds ?? h.wounds ?? 1, 10) || 1, 1, 99);
  const might = clamp(parseInt(h.maxMight ?? h.might ?? 0, 10) || 0, 0, 99);
  const will = clamp(parseInt(h.maxWill ?? h.will ?? 0, 10) || 0, 0, 99);
  const fate = clamp(parseInt(h.maxFate ?? h.fate ?? 0, 10) || 0, 0, 99);
  return {
    id: h.id || '',
    name: String(h.name || '').trim().slice(0, 32),
    maxWounds: wounds,
    wounds,
    maxMight: might,
    might,
    maxWill: will,
    will,
    maxFate: fate,
    fate,
    dead: false,
  };
}

export function thresholds(maxModels) {
  return {
    half: Math.ceil(maxModels / 2),
    quarter: Math.ceil(maxModels / 4),
  };
}

export function isBroken(army) {
  return army.currentModels <= thresholds(army.maxModels).half;
}

export function isQuartered(army) {
  return army.currentModels <= thresholds(army.maxModels).quarter;
}
