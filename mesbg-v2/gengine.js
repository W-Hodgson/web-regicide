// gengine.js — pure game-runner engine. Builds a trackable battle state from saved
// rosters and applies casualty / heroic-resource changes. Host-authoritative for P2P:
// the same reducer runs locally (single-device) and on the host (two-device play).

import { rUnitModels } from './rules.js';

function flattenEntries(roster) {
  const out = [];
  for (const wb of roster.warbands || []) {
    if (wb.leader) out.push(wb.leader);
    for (const f of wb.followers || []) out.push(f);
  }
  return out;
}

// Build one side's tracked army from a saved roster.
export function armyFromRoster(roster, side) {
  const entries = flattenEntries(roster);
  const heroes = [];
  let maxModels = 0;

  for (const e of entries) {
    const models = rUnitModels(e);
    maxModels += models;
    if (e.kind === 'hero') {
      const p = e.profile || {};
      heroes.push({
        id: e.id,
        name: e.name,
        heroModels: models,
        maxWounds: Math.max(1, p.wounds || 1), wounds: Math.max(1, p.wounds || 1),
        maxMight: p.might || 0, might: p.might || 0,
        maxWill: p.will || 0, will: p.will || 0,
        maxFate: p.fate || 0, fate: p.fate || 0,
        dead: false,
      });
    }
  }

  return {
    side,
    name: roster.name || 'Army',
    faction: roster.faction || '',
    alignment: roster.alignment || '',
    rosterId: roster.id || null,
    maxModels,
    models: maxModels, // single tracked model count (warriors + heroes); +/- as casualties occur
    heroes,
  };
}

export function createGame(rosterA, rosterB) {
  const armies = [armyFromRoster(rosterA, 0)];
  if (rosterB) armies.push(armyFromRoster(rosterB, 1));
  return { phase: 'playing', armies, events: [] };
}

// ── Derived values ───────────────────────────────────────────────────────────

export function currentModels(army) {
  return army.models;
}

// MESBG: Broken once an army has lost more than half its starting models;
// Quartered once 25% or fewer remain.
export function isBroken(army) { return currentModels(army) * 2 < army.maxModels; }
export function isQuartered(army) { return currentModels(army) * 4 <= army.maxModels; }

// ── Actions (mutate a cloned state; return { state, events }) ─────────────────

const STAT_MAX = { wounds: 'maxWounds', might: 'maxMight', will: 'maxWill', fate: 'maxFate' };

export function applyAdjustModels(state, armyIdx, delta) {
  const s = structuredClone(state);
  const army = s.armies[armyIdx];
  if (!army) return { error: 'No such army' };
  const prev = army.models;
  army.models = Math.max(0, Math.min(army.maxModels, prev + delta));
  s.events = prev === army.models ? [] : [{ type: 'models', army: armyIdx, from: prev, to: army.models }];
  return { state: s };
}

export function applyAdjustStat(state, armyIdx, heroId, stat, delta) {
  if (!STAT_MAX[stat]) return { error: 'Bad stat' };
  const s = structuredClone(state);
  const army = s.armies[armyIdx];
  if (!army) return { error: 'No such army' };
  const h = army.heroes.find((x) => x.id === heroId);
  if (!h) return { error: 'No such hero' };

  if (stat === 'wounds') {
    if (delta > 0 && h.dead && h.wounds === 0) {
      h.dead = false; h.wounds = 1;
      army.models = Math.min(army.maxModels, army.models + h.heroModels); // hero returns to the count
      s.events = [{ type: 'revive', army: armyIdx, name: h.name }];
      return { state: s };
    }
    const prev = h.wounds;
    h.wounds = Math.max(0, Math.min(h.maxWounds, prev + delta));
    if (h.wounds === 0 && !h.dead) {
      h.dead = true;
      army.models = Math.max(0, army.models - h.heroModels); // slain hero leaves the count
      s.events = [{ type: 'death', army: armyIdx, name: h.name }];
      return { state: s };
    }
    s.events = prev === h.wounds ? [] : [{ type: 'stat', army: armyIdx, name: h.name, stat, from: prev, to: h.wounds }];
    return { state: s };
  }

  const prev = h[stat];
  h[stat] = Math.max(0, Math.min(h[STAT_MAX[stat]], prev + delta));
  s.events = prev === h[stat] ? [] : [{ type: 'stat', army: armyIdx, name: h.name, stat, from: prev, to: h[stat] }];
  return { state: s };
}
