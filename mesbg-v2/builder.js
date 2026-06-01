// builder.js — the army builder screen.
//
// Owns an in-progress `roster` and renders it into #builder. Faction pick → warbands of
// (hero leader + warrior/independent-hero followers) → per-unit options. Live points,
// model count and full legality come from rules.validate(). Saving is gated by the
// caller-supplied requireCake() (the "cake" password).

import { el, $, clear, closeX, eyeIcon, copyIcon } from './ui.js';
import { heroTierInFaction, factionEntries } from './data.js';
import { openUnitRules, openArmyRules } from './rulesview.js';
import {
  emptyRoster, makeWarband, makeRosterUnit, validate,
  unitBasePoints, rUnitPoints, rUnitModels, unitAvailable,
} from './rules.js';

let idx, ctx;
let roster = emptyRoster();

export function initBuilder(dataIndex, context) {
  idx = dataIndex;
  ctx = context; // { requireCake, onSaved, goBack }
  $('add-warband-btn').addEventListener('click', () => {
    roster.warbands.push(makeWarband());
    render();
  });
  $('roster-name').addEventListener('input', (e) => { roster.name = e.target.value; });
  $('save-roster-btn').addEventListener('click', onSave);
}

// Open with an existing roster (edit) or null (new).
export function openBuilder(existing) {
  roster = existing ? structuredClone(existing) : emptyRoster();
  if (!roster.warbands?.length) roster.warbands = [makeWarband()];
  $('roster-name').value = roster.name || '';
  render();
}

// ── Render ───────────────────────────────────────────────────────────────────

function rosterHasUnits() {
  return roster.warbands.some((wb) => wb.leader || wb.followers.length);
}

// Confirm before discarding a roster's contents (no prompt when it's empty).
function confirmWipe(action) {
  if (!rosterHasUnits()) return true;
  return confirm(`${action} will clear the current roster. Continue?`);
}

function render() {
  // render() rebuilds the whole builder DOM, which loses the page scroll position. Preserve
  // it so adjusting a unit deep in the list doesn't jump you back to the top.
  const y = window.scrollY;
  if (roster.faction) ensureFactionRequirements();
  renderFaction();
  renderSummary();
  renderWarbands();
  if (window.scrollY !== y) window.scrollTo(0, y);
}

// Auto-include any units a faction mandates (faction.requiredChildren). They're added once,
// marked `required` so the builder won't let them be removed, and a `mustBeLeader` hero is
// placed as a warband leader (the army's General). Idempotent — safe to call every render.
function ensureFactionRequirements() {
  const faction = idx.getFaction(roster.faction);
  if (!faction) return;
  for (const rc of faction.requiredChildren || []) {
    if (rc.ignoreModels || rc.hideFromPrint) continue;
    if (rc.elementPropertyName !== 'heroes' && rc.elementPropertyName !== 'warriors') continue;

    const present = roster.warbands.some((wb) =>
      (wb.leader && wb.leader.name === rc.name) || wb.followers.some((f) => f.name === rc.name));
    if (present) continue;

    const kind = rc.elementPropertyName === 'warriors' ? 'warrior' : 'hero';
    const src = (kind === 'hero' ? idx.heroes : idx.warriors).find((u) => u.name === rc.name);
    if (!src) continue;

    const tier = kind === 'hero' ? heroTierInFaction(src, roster.faction) : null;
    const ru = makeRosterUnit(src, kind, { heroicTier: tier, count: 1 });
    ru.required = true;
    autoRequired(ru, src);

    if (kind === 'hero' && rc.mustBeLeader) {
      let wb = roster.warbands.find((w) => !w.leader) || makeWarband();
      if (!roster.warbands.includes(wb)) roster.warbands.unshift(wb);
      wb.leader = ru;
    } else {
      let wb = roster.warbands.find((w) => w.leader) || roster.warbands[0] || makeWarband();
      if (!roster.warbands.includes(wb)) roster.warbands.push(wb);
      wb.followers.push(ru);
    }
  }
}

function renderFaction() {
  const host = clear($('builder-faction'));
  const align = roster.alignment || 'good';

  const mkAlign = (a, label) =>
    el('button', {
      class: a === align ? 'active' : '',
      onclick: () => {
        if (roster.alignment === a) return;
        if (!confirmWipe('Switching alignment')) { render(); return; }
        roster.alignment = a;
        roster.faction = '';
        roster.warbands = [makeWarband()];
        render();
      },
    }, label);

  host.append(
    el('.align-toggle', {}, [mkAlign('good', 'Good'), mkAlign('evil', 'Evil')]),
  );

  const factions = idx.factionsByAlignment(align).slice().sort((a, b) => a.name.localeCompare(b.name));
  const sel = el('select', {
    onchange: (e) => {
      const next = e.target.value;
      if (next === roster.faction) return;
      if (!confirmWipe('Changing the army list')) { render(); return; } // render() resets the <select>
      roster.faction = next;
      roster.warbands = [makeWarband()]; // units belong to a faction — start fresh
      render();
    },
  }, [
    el('option', { value: '' }, '— choose a faction —'),
    ...factions.map((f) => el('option', { value: f.name, selected: f.name === roster.faction }, f.name)),
  ]);
  host.append(sel);
}

function renderSummary() {
  const host = clear($('builder-summary'));
  const v = validate(idx, roster);
  const s = v.stats;
  host.append(
    el('.pts', {}, `${s.points} pts`),
    el('.stat', {}, [el('b', {}, String(s.models)), el('span', { class: 'muted small' }, 'models')]),
    el('.stat', {}, [el('b', {}, String(s.heroes)), el('span', { class: 'muted small' }, 'heroes')]),
    el('.stat', {}, [el('span', { class: 'muted small' }, `Broken at ${s.breakPoint} lost · Quartered at ${s.quarterPoint} left`)]),
  );
  if (roster.faction) {
    host.append(el('button', { class: 'army-rules-btn', title: 'Army rules & bonuses', onclick: () => openArmyRules(idx, roster.faction) }, [eyeIcon(), 'Army rules']));
  }

  const leg = clear($('legality'));
  if (!roster.faction) {
    leg.append(el('.legal-line.warn', {}, 'Choose a faction to begin.'));
    return;
  }
  for (const e of v.errors) leg.append(el('.legal-line.err', {}, `✖ ${e}`));
  for (const w of v.warnings) leg.append(el('.legal-line.warn', {}, `! ${w}`));
  if (v.legal && !v.warnings.length && s.models > 0) leg.append(el('.legal-line.ok', {}, '✓ This army is legal.'));
}

// A unit is unique (the Balrog, named characters…) if flagged so in the data — can't be duplicated.
function isUnique(runit) {
  const src = (runit.kind === 'hero' ? idx.heroes : idx.warriors).find((u) => u.name === runit.name);
  return !!(src && (src.unique || (src.unitType || []).includes('Unique')));
}

let _copyN = 0;
function cloneUnit(runit) {
  const c = structuredClone(runit);
  _copyN += 1;
  c.id = `${runit.kind === 'hero' ? 'h' : 'w'}cp${_copyN}`;
  return c;
}

// Duplicate a warband just below itself, dropping any unique units (which can't be repeated).
function copyWarband(wi) {
  const wb = roster.warbands[wi];
  if (!wb.leader || isUnique(wb.leader)) return;
  const copy = makeWarband();
  copy.leader = cloneUnit(wb.leader);
  copy.followers = wb.followers.filter((f) => !isUnique(f)).map(cloneUnit);
  roster.warbands.splice(wi + 1, 0, copy);
  render();
}

function renderWarbands() {
  const host = clear($('warbands'));
  const disabled = !roster.faction;
  $('add-warband-btn').disabled = disabled;

  roster.warbands.forEach((wb, wi) => {
    const cap = wb.leader ? idx.tier(wb.leader.heroicTier).maxWarriors : 0;
    const used = wb.followers.filter((f) => f.kind === 'warrior').reduce((s, f) => s + rUnitModels(f), 0);
    const full = !!wb.leader && used >= cap; // warband at (or over) its leader's warrior capacity

    const leaderUnique = !!wb.leader && isUnique(wb.leader);
    const head = el('.warband-head', {}, [
      el('.wb-title', {}, `Warband ${wi + 1}`),
      el('span', { class: 'wb-cap' + (used > cap ? ' over' : '') }, wb.leader ? `${used}/${cap} warriors` : 'no leader'),
      el('button', {
        class: 'icon-btn',
        disabled: !wb.leader || leaderUnique,
        title: !wb.leader ? 'Add a leader first' : leaderUnique ? `Can’t copy — ${wb.leader.name} is unique` : 'Copy warband (excludes unique units)',
        onclick: () => copyWarband(wi),
      }, copyIcon()),
      el('button', { class: 'icon-btn', title: 'Remove warband', onclick: () => { roster.warbands.splice(wi, 1); render(); } }, '✕'),
    ]);

    const body = el('.warband-body');

    // Leader slot
    if (wb.leader) body.append(unitRow(wb.leader, 'leader', wi));
    else body.append(el('.unit-row', {}, [
      el('.u-main.slot-empty', {}, 'No leader'),
      el('button', { disabled, onclick: () => pickUnit('leader', wi) }, '+ Choose hero'),
    ]));

    // Followers
    wb.followers.forEach((f, fi) => body.append(unitRow(f, 'follower', wi, fi, full)));

    body.append(el('.add-row', {}, [
      el('button', {
        disabled: disabled || !wb.leader || full,
        title: full ? 'Warband at capacity' : null,
        onclick: () => pickUnit('warrior', wi),
      }, '+ Warriors'),
      el('button', { disabled: disabled || !wb.leader, onclick: () => pickUnit('attach-hero', wi) }, '+ Attach hero'),
    ]));

    host.append(el('.warband', {}, [head, body]));
  });
}

function unitRow(runit, role, wi, fi, warbandFull = false) {
  const src = (runit.kind === 'hero' ? idx.heroes : idx.warriors).find((u) => u.name === runit.name);
  const pts = rUnitPoints(runit, unitBasePoints(src || {}));
  const optSummary = runit.options.length ? runit.options.map((o) => o.name).join(', ') : null;
  const subBits = [];
  if (runit.kind === 'hero') subBits.push(runit.heroicTier || 'Hero');
  subBits.push(`${rUnitModels(runit)} model${rUnitModels(runit) > 1 ? 's' : ''}`);
  if (optSummary) subBits.push(optSummary);

  const main = el('.u-main', {}, [
    el('.u-name', {}, [
      runit.name,
      role === 'leader' ? el('span', { class: 'role' }, 'LEADER') : null,
      runit.required ? el('span', { class: 'role req' }, 'REQUIRED') : null,
    ]),
    el('.u-sub', {}, subBits.join(' · ')),
  ]);

  const controls = [];
  if (runit.kind === 'warrior') {
    controls.push(el('.qty', {}, [
      el('button', { onclick: () => { runit.count = Math.max(1, runit.count - 1); render(); } }, '−'),
      el('span', { class: 'n' }, String(runit.count)),
      el('button', { disabled: warbandFull, title: warbandFull ? 'Warband at capacity' : null, onclick: () => { runit.count += 1; render(); } }, '+'),
    ]));
  }
  controls.push(el('button', { class: 'icon-btn', title: 'View rules', onclick: () => openUnitRules(idx, runit.name, runit.kind, runit.options) }, eyeIcon()));
  if (src && (src.options?.length || src.requiredChildren?.length)) {
    controls.push(el('button', { class: 'icon-btn', title: 'Options', onclick: () => editOptions(runit, src) }, '⚙'));
  }
  controls.push(el('.u-pts', {}, `${pts}`));
  if (runit.required) {
    controls.push(el('span', { class: 'icon-btn req-lock', title: 'Required by this faction' }, '★'));
  } else {
    controls.push(el('button', {
      class: 'icon-btn', title: 'Remove',
      onclick: () => {
        if (role === 'leader') roster.warbands[wi].leader = null;
        else roster.warbands[wi].followers.splice(fi, 1);
        render();
      },
    }, '✕'));
  }

  return el(`.unit-row${role === 'leader' ? '.leader' : ''}`, {}, [main, ...controls]);
}

// ── Unit picker dialog ─────────────────────────────────────────────────────────

function pickUnit(kind, wi) {
  const { heroes, warriors } = idx.unitsForFaction(roster.faction);
  let pool;
  if (kind === 'leader' || kind === 'attach-hero') {
    pool = heroes.map((h) => ({ unit: h, tier: heroTierInFaction(h, roster.faction) }));
    if (kind === 'attach-hero') pool = pool.filter((p) => idx.tier(p.tier).canBeChild);
    pool.sort((a, b) => idx.tier(a.tier).rank - idx.tier(b.tier).rank || a.unit.points - b.unit.points);
  } else {
    pool = warriors.map((w) => ({ unit: w, tier: null }));
    // Add conditionally-available warriors (empty `factions`, gated by `availableIn`) that
    // this warband currently unlocks — e.g. Khazad Guard under a Dwarf-King leader.
    const have = new Set(pool.map((p) => p.unit.name));
    for (const w of idx.warriors) {
      if (have.has(w.name) || !(w.availableIn && w.availableIn.length)) continue;
      if (unitAvailable(idx, roster, w, roster.warbands[wi])) pool.push({ unit: w, tier: null });
    }
    pool.sort((a, b) => a.unit.name.localeCompare(b.unit.name));
  }

  const dlg = $('unit-dialog');
  const list = el('.picker-list');

  function renderList(items) {
    clear(list);
    for (const p of items) {
      list.append(el('button', {
        class: 'picker-item', type: 'button',
        onclick: () => { add(p); dlg.close(); },
      }, [
        el('.pi-name', {}, p.unit.name),
        p.tier ? el('span', { class: 'pi-tier' }, p.tier) : null,
        el('span', { class: 'pi-pts' }, `${p.unit.points}`),
      ]));
    }
    if (!items.length) list.append(el('.empty-note.muted', {}, 'No units available.'));
  }

  function add(p) {
    if (kind === 'leader') {
      const ru = makeRosterUnit(p.unit, 'hero', { heroicTier: p.tier });
      autoRequired(ru, p.unit);
      roster.warbands[wi].leader = ru;
    } else if (kind === 'attach-hero') {
      const ru = makeRosterUnit(p.unit, 'hero', { heroicTier: p.tier });
      autoRequired(ru, p.unit);
      roster.warbands[wi].followers.push(ru);
    } else {
      const ru = makeRosterUnit(p.unit, 'warrior', { count: 1 });
      autoRequired(ru, p.unit);
      roster.warbands[wi].followers.push(ru);
    }
    render();
  }

  clear(dlg).append(el('.dialog-body', {}, [
    el('h3', {}, kind === 'warrior' ? 'Add warriors' : kind === 'attach-hero' ? 'Attach a hero' : 'Choose warband leader'),
    list,
    el('.dialog-actions', {}, [el('button', { onclick: () => dlg.close() }, 'Cancel')]),
  ]), closeX(dlg));
  renderList(pool);
  dlg.showModal();
}

// Force-include any requiredChildren that are simple options (mandatory gear), but only
// when they actually apply to the current faction. Many required options are scoped with an
// `in: [["Faction", ...], ...]` constraint (e.g. the Witch-King's Crown/Fell Beast are only
// mandatory in "Legions of Mordor", not in "Minas Morgul").
function autoRequired(runit, src) {
  for (const rc of src.requiredChildren || []) {
    if (rc.elementPropertyName !== 'options') continue;
    if (rc.autoAddOnly === false) continue;
    if (!requirementApplies(rc)) continue;
    if (!runit.options.some((o) => o.name === rc.name)) {
      runit.options.push({ name: rc.name, points: Number(rc.points) || 0, addsModels: Number(rc.addsModels) || 0, unlockedBy: null, required: true });
    }
  }
}

// A requiredChild with an `in` constraint only applies when the current faction is listed.
function requirementApplies(rc) {
  if (!rc.in) return true;
  return rc.in.some((group) => group.includes(roster.faction));
}

// ── Options dialog ───────────────────────────────────────────────────────────

function editOptions(runit, src) {
  const dlg = $('unit-dialog');
  const opts = src.options || [];

  // Group options by their choose-one key: requireChooseOneKey = exactly one (radios, no
  // "none"); chooseOneKey = at most one (radios + a "None"). Everything else is a checkbox.
  const groupKeyOf = (o) => (o.requireChooseOneKey ? `r:${o.requireChooseOneKey}` : o.chooseOneKey ? `c:${o.chooseOneKey}` : null);
  const groups = new Map();
  for (const o of opts) {
    const k = groupKeyOf(o);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { required: !!o.requireChooseOneKey, opts: [] });
    groups.get(k).opts.push(o);
  }

  const isSelected = (name) => runit.options.some((o) => o.name === name);
  const addOpt = (o) => runit.options.push({ name: o.name, points: Number(o.points) || 0, addsModels: Number(o.addsModels) || 0, unlockedBy: o.unlockedBy || null });
  const removeByName = (name) => { const i = runit.options.findIndex((o) => o.name === name); if (i >= 0) runit.options.splice(i, 1); };
  const dropUnlocked = () => { runit.options = runit.options.filter((o) => { const def = opts.find((d) => d.name === o.name); return !def?.unlockedBy || isSelected(def.unlockedBy); }); };

  function toggle(opt) {
    if (opt.required) return;
    if (isSelected(opt.name)) removeByName(opt.name); else addOpt(opt);
    dropUnlocked(); body(); render();
  }
  function setChoice(group, name) {
    for (const o of group.opts) removeByName(o.name);
    if (name) { const opt = group.opts.find((o) => o.name === name); if (opt) addOpt(opt); }
    dropUnlocked(); body(); render();
  }

  // Options that resolve to a defined gear item (Crown of Morgul, Morgul Blade…) are
  // "special": mark them and offer an inline 👁 to read the rules. Generic options
  // (Two-handed weapon, etc.) have no gear definition and stay plain.
  const expanded = new Set();
  function wrap(name, rowEl) {
    const def = idx.getGear(name)?.definition;
    if (!def) return rowEl;
    rowEl.classList.add('special');
    rowEl.append(el('button', {
      class: 'opt-info', type: 'button', title: 'Rules',
      onclick: () => { expanded.has(name) ? expanded.delete(name) : expanded.add(name); body(); },
    }, eyeIcon(15)));
    return expanded.has(name) ? el('.opt-wrap', {}, [rowEl, el('.opt-def.muted.small', {}, def)]) : rowEl;
  }

  function radioRow(key, label, pts, checked, onpick) {
    return el('.opt-row', {}, [
      el('input', { type: 'radio', name: `grp-${key}`, checked, onchange: onpick }),
      el('.opt-name', {}, label),
      el('.opt-pts', {}, pts),
    ]);
  }
  function groupBlock(key, group) {
    const chosen = group.opts.find((o) => isSelected(o.name))?.name || null;
    const rows = [];
    if (!group.required) rows.push(radioRow(key, 'None', '—', chosen === null, () => setChoice(group, null)));
    for (const o of group.opts) rows.push(wrap(o.name, radioRow(key, o.name, o.points ? `+${o.points}` : '—', chosen === o.name, () => setChoice(group, o.name))));
    return el('.opt-group', {}, [
      el('.opt-group-label.muted.small', {}, group.required ? 'Choose one (required)' : 'Choose one (optional)'),
      ...rows,
    ]);
  }

  function body() {
    const prevScroll = dlg.querySelector('.opt-list')?.scrollTop || 0; // survive the re-render
    const blocks = [];
    const emitted = new Set();
    for (const o of opts) {
      const k = groupKeyOf(o);
      if (k) {
        if (!emitted.has(k)) { emitted.add(k); blocks.push(groupBlock(k, groups.get(k))); }
        continue;
      }
      const locked = o.unlockedBy && !isSelected(o.unlockedBy);
      const required = runit.options.find((x) => x.name === o.name)?.required;
      blocks.push(wrap(o.name, el(`.opt-row${locked ? '.disabled' : ''}`, {}, [
        el('input', { type: 'checkbox', checked: isSelected(o.name), disabled: locked || required, onchange: () => toggle(o) }),
        el('.opt-name', {}, o.name + (locked ? ` (needs ${o.unlockedBy})` : required ? ' (required)' : '')),
        el('.opt-pts', {}, o.points ? `+${o.points}` : '—'),
      ])));
    }
    clear(dlg).append(el('.dialog-body', {}, [
      el('h3', {}, runit.name),
      el('.profile-line', {}, profileNodes(runit.profile, statMods(runit.options))),
      opts.length ? el('.opt-list', {}, blocks) : el('.muted.small', {}, 'No options.'),
      el('.dialog-actions', {}, [el('button', { class: 'primary', onclick: () => dlg.close() }, 'Done')]),
    ]), closeX(dlg));
    const list = dlg.querySelector('.opt-list');
    if (list) list.scrollTop = prevScroll;
  }

  body();
  dlg.showModal();
}

// Sum stat modifiers from selected options' gear (Shield → +1 Defence, etc.).
function statMods(options) {
  const mods = {};
  for (const o of options || []) {
    for (const m of idx.getGear(o.name)?.modifiesStats || []) mods[m.stat] = (mods[m.stat] || 0) + (Number(m.modifier) || 0);
  }
  return mods;
}

// Compact profile line with the option modifiers applied; changed stats are gold.
function profileNodes(p, mods = {}) {
  if (!p) return [''];
  const eff = (k) => (Number(p[k]) || 0) + (mods[k] || 0);
  const tok = (text, modified) => el(`span${modified ? '.pl-mod' : ''}`, {}, text);
  return [
    tok(`M${eff('movement')}"`, mods.movement), ' ',
    tok(`F${eff('fight')}/${eff('shoot')}+`, mods.fight || mods.shoot), ' ',
    tok(`S${eff('strength')}`, mods.strength), ' ',
    tok(`D${eff('defence')}`, mods.defence), ' ',
    tok(`A${eff('attack')}`, mods.attack), ' ',
    tok(`W${eff('wounds')}`, mods.wounds), ' ',
    tok(`C${eff('courage')}`, mods.courage), ' | ',
    tok(`Mt${eff('might')}`, mods.might), ' ',
    tok(`Wi${eff('will')}`, mods.will), ' ',
    tok(`Ft${eff('fate')}`, mods.fate),
  ];
}

// ── Save ───────────────────────────────────────────────────────────────────

async function onSave() {
  if (!roster.faction) { flash('Choose a faction first.'); return; }
  if (!roster.name.trim()) { flash('Give your army a name.'); return; }
  const v = validate(idx, roster);
  if (!v.legal && !confirm(`This army has ${v.errors.length} legality issue(s). Save anyway?`)) return;

  const ok = await ctx.requireCake();
  if (!ok) return;

  const btn = $('save-roster-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    roster.points = v.stats.points;
    roster.models = v.stats.models;
    const id = await ctx.onSaved(roster);
    roster.id = id;
    flash('Saved.');
  } catch (e) {
    flash('Save failed: ' + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

function flash(msg) {
  const leg = $('legality');
  const line = el('.legal-line.ok', {}, msg);
  leg.prepend(line);
  setTimeout(() => line.remove(), 2500);
}
