// rules.js — MESBG army-construction rules engine.
//
// Operates on a `roster` (the persisted/shared data model) plus an `idx` from data.js.
// Pure functions only: costing, model counting, and full legality validation driven by
// the declarative rule structures in the data (limits, counts, validations, heroic tiers,
// faction requiredChildren). No DOM, no IO — node-testable.
//
// ── Roster data model ───────────────────────────────────────────────────────
//   roster = {
//     schema: 2,
//     name, faction, alignment,
//     warbands: [ { id, leader: RUnit|null, followers: [RUnit] } ],
//   }
//   RUnit = {
//     id, name, kind: 'hero'|'warrior',
//     count,                         // models bought in this entry (heroes: 1)
//     options: [{ name, points, addsModels, unlockedBy }],   // selected options
//     profile,                       // resolved stat snapshot (for the game runner)
//   }
//
// Costing assumptions (documented so they can be corrected): warrior `points` are
// per-model, so a group costs count × (base + per-model option points). Hero options are
// flat. `addsModels` options contribute extra models (e.g. a named companion).

const STAT_FIELDS = [
  'movement', 'fight', 'shoot', 'strength', 'defence', 'attack',
  'wounds', 'courage', 'intelligence', 'might', 'will', 'fate',
];

let _uid = 0;
function uid(prefix = 'u') {
  _uid += 1;
  return `${prefix}${_uid.toString(36)}`;
}

// ── Roster construction helpers ──────────────────────────────────────────────

export function emptyRoster() {
  return { schema: 2, name: '', faction: '', alignment: '', warbands: [] };
}

export function makeWarband() {
  return { id: uid('wb'), leader: null, followers: [] };
}

// Snapshot the stat profile + identity bits the game runner needs, so the runner never
// has to re-load the full dataset to play.
export function resolveProfile(unit, idx, factionName) {
  const p = {};
  for (const f of STAT_FIELDS) p[f] = Number(unit[f]) || 0;
  p.name = unit.name;
  p.unitType = unit.unitType || [];
  p.keywords = unit.keywords || [];
  p.heroicActions = unit.heroicActions || [];
  p.specialRules = unit.specialRules || [];
  p.wargear = unit.wargear || [];
  if (idx && factionName) {
    // heroTierInFaction lives in data.js; accept a precomputed tier instead to stay pure.
  }
  return p;
}

export function makeRosterUnit(unit, kind, { count = 1, options = [], heroicTier = null } = {}) {
  return {
    id: uid(kind === 'hero' ? 'h' : 'w'),
    name: unit.name,
    kind,
    count: kind === 'hero' ? 1 : Math.max(1, count),
    heroicTier,
    options: options.map((o) => ({
      name: o.name,
      points: Number(o.points) || 0,
      addsModels: Number(o.addsModels) || 0,
      unlockedBy: o.unlockedBy || null,
    })),
    profile: resolveProfile(unit, null, null),
  };
}

// ── Costing & counting ───────────────────────────────────────────────────────

export function unitBasePoints(unit) {
  return Number(unit.points) || 0;
}

export function rUnitPoints(runit, basePoints) {
  const optPer = runit.options.reduce((s, o) => s + o.points, 0);
  if (runit.kind === 'hero') return basePoints + optPer;
  // warrior options are per-model and applied to the whole group
  return runit.count * (basePoints + optPer);
}

export function rUnitModels(runit) {
  const base = runit.kind === 'hero' ? 1 : runit.count;
  const added = runit.options.reduce((s, o) => s + (o.addsModels || 0), 0);
  return base + added;
}

// Does this entry carry weapon gear of the given gear `type` (e.g. 'bow', 'throwingWeapon')?
// Checks base wargear and any selected options, classified via idx.gearType().
function entryHasGearType(runit, idx, type) {
  const names = [...(runit.profile?.wargear || []), ...runit.options.map((o) => o.name)];
  return names.some((n) => idx.gearType(n) === type);
}

// ── Annotation: compute per-warband and army-wide totals ─────────────────────

export function annotate(idx, roster) {
  const allUnits = [];
  const warbands = roster.warbands.map((wb) => {
    const entries = [];
    if (wb.leader) entries.push({ runit: wb.leader, role: 'leader' });
    for (const f of wb.followers) entries.push({ runit: f, role: 'follower' });

    let wbPoints = 0;
    let wbModels = 0;
    let followerWarriorModels = 0;
    for (const e of entries) {
      const src = lookupUnit(idx, e.runit);
      const base = unitBasePoints(src || {});
      const pts = rUnitPoints(e.runit, base);
      const models = rUnitModels(e.runit);
      e.points = pts;
      e.models = models;
      e.src = src;
      wbPoints += pts;
      wbModels += models;
      if (e.role === 'follower' && e.runit.kind === 'warrior') followerWarriorModels += models;
      allUnits.push(e);
    }
    const tier = wb.leader ? idx.tier(wb.leader.heroicTier) : null;
    return {
      ...wb,
      entries,
      points: wbPoints,
      models: wbModels,
      followerWarriorModels,
      capacity: tier ? tier.maxWarriors : 0,
      tier,
    };
  });

  // Army-wide weapon counts (limits operate on the 'warriors' property).
  let totalWarriorModels = 0;
  let bows = 0;
  let throwers = 0;
  for (const e of allUnits) {
    if (e.runit.kind !== 'warrior') continue;
    totalWarriorModels += e.models;
    if (entryHasGearType(e.runit, idx, 'bow')) bows += e.models;
    if (entryHasGearType(e.runit, idx, 'throwingWeapon')) throwers += e.models;
  }

  const points = warbands.reduce((s, w) => s + w.points, 0);
  const models = warbands.reduce((s, w) => s + w.models, 0);
  const heroes = allUnits.filter((e) => e.runit.kind === 'hero').length;

  return {
    warbands,
    points,
    models,
    heroes,
    totalWarriorModels,
    bows,
    throwers,
    breakPoint: Math.ceil(models * 0.5),     // models lost to become Broken
    quarterPoint: Math.floor(models * 0.25), // models remaining when Quartered
  };
}

function lookupUnit(idx, runit) {
  const list = runit.kind === 'hero' ? idx.heroes : idx.warriors;
  return list.find((u) => u.name === runit.name) || null;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validate(idx, roster) {
  const errors = [];
  const warnings = [];
  const a = annotate(idx, roster);

  // 1. Every warband needs a hero leader; warriors cannot lead.
  for (const wb of a.warbands) {
    if (!wb.leader) {
      if (wb.followers.length) errors.push('A warband has warriors but no Hero to lead them.');
      continue;
    }
    if (wb.leader.kind !== 'hero') errors.push(`${wb.leader.name} is not a Hero and cannot lead a warband.`);
    // 2. Warband size vs leading hero's tier capacity.
    if (wb.followerWarriorModels > wb.capacity) {
      errors.push(`${wb.leader.name} (${wb.tier?.name}) can lead ${wb.capacity} warriors but has ${wb.followerWarriorModels}.`);
    }
  }

  // 3. Army needs at least one Hero (the General).
  if (a.heroes === 0) errors.push('An army must include at least one Hero to be its General.');
  if (a.models === 0) errors.push('Add at least one model to the roster.');

  // 4/5. Bow / throwing-weapon percentage limits (from data.limits).
  for (const lim of idx.limits) {
    const have = lim.type === 'bow' ? a.bows : lim.type === 'throwingWeapon' ? a.throwers : 0;
    const denom = a.totalWarriorModels;
    if (!denom) continue;
    const maxAllowed = lim.roundUp
      ? Math.ceil((denom * lim.maximumPercentage) / 100)
      : Math.floor((denom * lim.maximumPercentage) / 100);
    if (have > maxAllowed) {
      errors.push(`Too many ${lim.label}: ${have}/${maxAllowed} allowed (max ${lim.maximumPercentage}% of ${denom} warriors).`);
    }
  }

  // 6. Unique units may only appear once.
  const nameCounts = new Map();
  for (const wb of a.warbands) for (const e of wb.entries) {
    nameCounts.set(e.runit.name, (nameCounts.get(e.runit.name) || 0) + 1);
  }
  for (const [name, n] of nameCounts) {
    if (n <= 1) continue;
    const src = idx.heroes.find((u) => u.name === name) || idx.warriors.find((u) => u.name === name);
    const isUnique = src && (src.unique || (src.unitType || []).includes('Unique'));
    if (isUnique) errors.push(`${name} is Unique and may only be taken once (found ${n}).`);
  }

  // 7. propertyPerTier validations (e.g. one Siege keyword per Hero of Fortitude+).
  for (const v of idx.validations) {
    if (v.type !== 'propertyPerTier') continue;
    const matching = [];
    for (const wb of a.warbands) for (const e of wb.entries) {
      const vals = e.src?.[v.property] || [];
      if (asArr(vals).some((x) => v.value.includes(x))) matching.push(e);
    }
    if (!matching.length) continue;
    // count heroes whose tier rank is at least as senior as v.tier (lower rank number = more senior)
    const eligibleHeroes = a.warbands
      .map((wb) => wb.leader)
      .filter(Boolean)
      .filter((h) => (idx.tier(h.heroicTier).rank || 99) <= v.tier).length;
    const allowed = eligibleHeroes * (v.maxPer || 1);
    if (matching.length > allowed) errors.push(v.message || `Too many ${v.property} for your heroes.`);
  }

  // 8. disallowedCombination — best-effort: illegal if the army contains every named
  //    element in the rule (matched against unit names, option names, or keywords).
  for (const v of idx.validations) {
    if (v.type !== 'disallowedCombination') continue;
    const present = new Set();
    for (const wb of a.warbands) for (const e of wb.entries) {
      present.add(e.runit.name);
      for (const o of e.runit.options) present.add(o.name);
      for (const k of asArr(e.src?.keywords)) present.add(k);
    }
    const named = v.value.slice(1); // value[0] is the faction/context label
    if (named.length && named.every((n) => present.has(n))) {
      warnings.push(v.message || 'Disallowed combination of units/options.');
    }
  }

  // 9. Faction-required units (faction.requiredChildren at the top level).
  const faction = idx.getFaction(roster.faction);
  for (const rc of asArr(faction?.requiredChildren)) {
    if (rc.ignoreModels || rc.hideFromPrint) continue;
    const present = a.warbands.some((wb) => wb.entries.some((e) => e.runit.name === rc.name));
    if (!present) warnings.push(`${roster.faction} armies must include ${rc.name}.`);
  }

  // 10. "Choose one" wargear groups: requireChooseOneKey = exactly one (mandatory),
  //     chooseOneKey = at most one (optional, mutually exclusive).
  for (const wb of a.warbands) for (const e of wb.entries) errors.push(...chooseOneIssues(e));

  // 11. Conditionally-available units (availableIn). Only flag conditional-only units (not
  //     normal faction units) whose requirement isn't met in their warband — e.g. a Khazad
  //     Guard whose Dwarf-King leader was removed.
  const fu = idx.unitsForFaction(roster.faction);
  const normalNames = new Set([...fu.heroes, ...fu.warriors].map((u) => u.name));
  for (const wb of a.warbands) for (const e of wb.entries) {
    const src = e.src;
    if (src?.availableIn?.length && !normalNames.has(src.name) && !unitAvailable(idx, roster, src, wb)) {
      errors.push(`${e.runit.name} needs a specific leader or hero in its warband/army to be fielded.`);
    }
  }

  const dedup = (arr) => [...new Set(arr)];
  const errs = dedup(errors);
  return { errors: errs, warnings: dedup(warnings), stats: a, legal: errs.length === 0 };
}

// Some units (e.g. Khazad Guard) have empty `factions` and an `availableIn` rule instead:
// an OR-list of requirement groups. A group is `{ all: [conditions] }` (or a bare condition
// / string). A condition `{ in: X, ifLeader? }` is met when X equals the army's faction, or
// a unit named/keyworded X is in the army — or, with ifLeader, leads THIS warband.
export function unitAvailable(idx, roster, unit, warband) {
  const av = unit.availableIn;
  if (!av || !av.length) return true; // not gated

  const matchesToken = (runit, token) => {
    if (!runit) return false;
    if (runit.name === token) return true;
    const src = (runit.kind === 'hero' ? idx.heroes : idx.warriors).find((u) => u.name === runit.name);
    return !!src && ((src.keywords || []).includes(token) || (src.specialRules || []).includes(token) || (src.unitType || []).includes(token));
  };
  const armyUnits = [];
  for (const wb of roster.warbands || []) {
    if (wb.leader) armyUnits.push(wb.leader);
    for (const f of wb.followers || []) armyUnits.push(f);
  }
  const condHolds = (c) => {
    const token = typeof c === 'string' ? c : c.in;
    if (token === roster.faction) return true;
    if (typeof c === 'object' && c.ifLeader) return matchesToken(warband?.leader, token);
    return armyUnits.some((u) => matchesToken(u, token));
  };
  return av.some((group) => {
    if (typeof group === 'string') return condHolds(group);
    const conds = Array.isArray(group.all) ? group.all : [group];
    return conds.every(condHolds);
  });
}

function chooseOneIssues(entry) {
  const src = entry.src;
  if (!src?.options) return [];
  const groups = new Map(); // key -> { required, names: [] }
  for (const o of src.options) {
    const key = o.requireChooseOneKey ? `r:${o.requireChooseOneKey}` : o.chooseOneKey ? `c:${o.chooseOneKey}` : null;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { required: !!o.requireChooseOneKey, names: [] });
    groups.get(key).names.push(o.name);
  }
  const selected = new Set(entry.runit.options.map((o) => o.name));
  const issues = [];
  for (const g of groups.values()) {
    const chosen = g.names.filter((n) => selected.has(n)).length;
    if (g.required && chosen !== 1) issues.push(`${entry.runit.name} must have exactly one of: ${g.names.join(', ')}.`);
    else if (!g.required && chosen > 1) issues.push(`${entry.runit.name} may only have one of: ${g.names.join(', ')}.`);
  }
  return issues;
}

function asArr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
