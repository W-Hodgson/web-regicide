// data.js — load, normalise and index the MESBG army data (data2024.json).
//
// The source data (https://nowforwrath.github.io/data2024.json) is vendored locally
// as ./data2024.json. It is community-maintained and contains a number of typo'd keys
// (e.g. `factino`, `uniType`, `unitTYpe`, `inttelligence`, `basseSize`). We normalise
// those defensively on load so the rest of the app can rely on clean field names.
//
// This module is environment-agnostic: `buildIndex(raw)` is a pure function (used by the
// node tests), while `loadData()` fetches the vendored JSON in the browser and indexes it.

const DATA_URL = new URL('./data2024.json', import.meta.url).href;

// Map of misspelled / inconsistent source keys -> canonical key.
const KEY_FIXES = {
  factino: 'faction',
  uniType: 'unitType',
  unitTYpe: 'unitType',
  inttelligence: 'intelligence',
  basseSize: 'baseSize',
};

function canonicaliseKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = KEY_FIXES[k] || k;
    // Don't clobber a correctly-spelled key with a typo'd duplicate.
    if (key in out && KEY_FIXES[k]) continue;
    out[key] = v;
  }
  return out;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const lc = (s) => String(s || '').trim().toLowerCase();

// --- Faction membership -----------------------------------------------------
// Heroes store membership as [{ name, heroicTier }] (tier can vary per faction).
// Warriors store membership as ["Faction Name", ...]. Tolerate either shape.

export function unitFactionEntries(unit) {
  return asArray(unit.factions).map((f) =>
    typeof f === 'string' ? { name: f, heroicTier: unit.heroicTier || null } : { name: f.name, heroicTier: f.heroicTier || unit.heroicTier || null }
  );
}

export function unitInFaction(unit, factionName) {
  const target = lc(factionName);
  return unitFactionEntries(unit).some((e) => lc(e.name) === target);
}

export function heroTierInFaction(hero, factionName) {
  const target = lc(factionName);
  const e = unitFactionEntries(hero).find((x) => lc(x.name) === target);
  return e?.heroicTier || hero.heroicTier || 'Independent Hero';
}

// --- Index ------------------------------------------------------------------

export function buildIndex(raw) {
  const data = raw.data;
  const heroes = data.heroes.map(canonicaliseKeys);
  const warriors = data.warriors.map(canonicaliseKeys);
  const gear = data.gear.map(canonicaliseKeys);
  const factions = data.factions.map(canonicaliseKeys);

  const gearByName = new Map();
  for (const g of gear) gearByName.set(lc(g.name), g);

  const keywordByName = new Map();
  for (const k of asArray(data.keywords)) keywordByName.set(lc(k.name), k);
  const magicalPowerByName = new Map();
  for (const m of asArray(data.magicalPowers)) magicalPowerByName.set(lc(m.name), m);
  const armyBonusByName = new Map();
  for (const b of asArray(data.armyBonuses)) armyBonusByName.set(lc(b.name), b);

  const factionByName = new Map();
  for (const f of factions) factionByName.set(lc(f.name), f);

  // Warband size + ranking per heroic tier, read from the master `elements` schema.
  const heroesEl = (raw.elements?.[0]?.children || []).find((c) => c.propertyName === 'heroes');
  const tierByName = new Map();
  for (const t of asArray(heroesEl?.tiers)) {
    tierByName.set(lc(t.name), {
      name: t.name,
      maxWarriors: t.maximumChildren?.warriors ?? 0,
      rank: t.rank ?? 99,
      canBeChild: !!t.canBeChild,
    });
  }

  // Precompute unit lists per faction for fast builder lookups.
  const heroesByFaction = new Map();
  const warriorsByFaction = new Map();
  for (const f of factions) {
    const key = lc(f.name);
    heroesByFaction.set(key, heroes.filter((h) => unitInFaction(h, f.name)));
    warriorsByFaction.set(key, warriors.filter((w) => unitInFaction(w, f.name)));
  }

  return {
    raw,
    factions,
    heroes,
    warriors,
    gear,
    factionByName,
    gearByName,
    keywordByName,
    magicalPowerByName,
    armyBonusByName,
    tierByName,

    // Config used by the rules engine.
    limits: asArray(raw.limits),
    counts: asArray(raw.counts),
    calculations: asArray(raw.calculations),
    validations: asArray(raw.validations),
    heroicTiers: asArray(data.heroicTiers),

    // --- accessors ---
    factionsByAlignment(alignment) {
      const a = lc(alignment);
      return factions.filter((f) => lc(f.alignment) === a);
    },
    unitsForFaction(factionName) {
      const key = lc(factionName);
      return {
        heroes: heroesByFaction.get(key) || [],
        warriors: warriorsByFaction.get(key) || [],
      };
    },
    getFaction(name) {
      return factionByName.get(lc(name)) || null;
    },
    getGear(name) {
      return gearByName.get(lc(name)) || null;
    },
    // Weapon-type classification for a named piece of gear/option ('bow', 'throwingWeapon',
    // 'mount', 'armour', 'shield', ... ) or null if unknown.
    gearType(name) {
      return gearByName.get(lc(name))?.type || null;
    },
    tier(name) {
      return tierByName.get(lc(name)) || { name: name || 'Independent Hero', maxWarriors: 0, rank: 99, canBeChild: true };
    },
  };
}

let _cache = null;

// Browser entry point: fetch the vendored JSON and index it (memoised).
export async function loadData() {
  if (_cache) return _cache;
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load army data (${res.status})`);
  const raw = await res.json();
  _cache = buildIndex(raw);
  return _cache;
}

export { unitFactionEntries as factionEntries };
