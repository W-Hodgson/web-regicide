// rulesview.js — read-only "rules reference" modals for a unit or a faction.
// Resolves names to their definitions (special rules → keywords, wargear → gear,
// magical powers → magicalPowers, army bonuses → armyBonuses) from the data index.
// Renders into the shared #rules-dialog. Reusable from the builder and the game runner.

import { el, $, clear, closeX } from './ui.js';

const lc = (s) => String(s || '').toLowerCase();

export function openUnitRules(idx, unitName, kind, options = []) {
  const src = (kind === 'hero' ? idx.heroes : idx.warriors).find((u) => u.name === unitName)
    || idx.heroes.find((u) => u.name === unitName) || idx.warriors.find((u) => u.name === unitName);
  if (!src) return;
  const dlg = $('rules-dialog');
  clear(dlg).append(unitRulesView(idx, src, kind, options), closeX(dlg));
  dlg.showModal();
}

export function openArmyRules(idx, factionName) {
  const f = idx.getFaction(factionName);
  if (!f) return;
  const dlg = $('rules-dialog');
  clear(dlg).append(armyRulesView(idx, f), closeX(dlg));
  dlg.showModal();
}

// ── Shared pieces ──────────────────────────────────────────────────────────

function closeBtn() {
  return el('.dialog-actions', {}, [el('button', { class: 'primary', onclick: () => $('rules-dialog').close() }, 'Close')]);
}

function defEntry(name, def, meta) {
  return el('.rs-def', {}, [
    el('.rs-def-name', {}, [name, meta ? el('span', { class: 'rs-meta' }, meta) : null]),
    def ? el('.rs-def-text.muted.small', {}, def) : null,
  ]);
}

function section(title, items) {
  const real = items.filter(Boolean);
  if (!real.length) return null;
  return el('.rs-section', {}, [el('h4', {}, title), el('.rs-defs', {}, real)]);
}

function statBlock(src, isHero) {
  const n = (k) => Number(src[k]) || 0;
  const cells = [
    ['Mv', `${n('movement')}"`], ['F', n('fight')], ['Sh', n('shoot') ? `${n('shoot')}+` : '—'],
    ['S', n('strength')], ['D', n('defence')], ['A', n('attack')], ['W', n('wounds')], ['C', n('courage')],
  ];
  if (n('intelligence')) cells.push(['I', n('intelligence')]);
  const grid = el('.rs-stats', {}, cells.map(([l, v]) =>
    el('.rs-stat', {}, [el('.rs-stat-l', {}, l), el('.rs-stat-v', {}, String(v))])));
  const parts = [grid];
  if (isHero) parts.push(el('.rs-heroic.small', {}, `Might ${n('might')} · Will ${n('will')} · Fate ${n('fate')}`));
  parts.push(el('.rs-pts.muted.small', {}, `${n('points')} pts`));
  return el('.rs-profile', {}, parts);
}

// ── Views ────────────────────────────────────────────────────────────────────

function unitRulesView(idx, src, kind, options = []) {
  const isHero = kind === 'hero' || (src.unitType || []).includes('Hero');
  const wargear = (src.wargear || []).map((nm) => defEntry(nm, idx.getGear(nm)?.definition));
  // Selected options/upgrades — special items (Crown of Morgul, Morgul Blade…) carry a gear
  // definition; generic ones (Two-handed weapon) just show their name and points.
  const upgrades = options.map((o) => defEntry(o.name, idx.getGear(o.name)?.definition, o.points ? `+${o.points}` : null));
  const special = (src.specialRules || []).map((nm) => defEntry(nm, idx.keywordByName.get(lc(nm))?.definition));
  const heroic = (src.heroicActions || []).map((nm) => defEntry(nm, idx.keywordByName.get(lc(nm))?.definition));
  const powers = (src.magicalPowers || []).map((m) => {
    const name = typeof m === 'string' ? m : m.name;
    const def = idx.magicalPowerByName.get(lc(name))?.definition;
    const meta = typeof m === 'object' ? [m.range != null ? `Range ${m.range}"` : null, m.casting != null ? `Cast ${m.casting}+` : null].filter(Boolean).join(' · ') : null;
    return defEntry(name, def, meta);
  });

  return el('.rules-body', {}, [
    el('h3', {}, src.name),
    el('.rs-type.muted.small', {}, (src.unitType || []).join(' · ')),
    statBlock(src, isHero),
    section('Wargear', wargear),
    section('Upgrades', upgrades),
    section('Special Rules', special),
    isHero ? section('Heroic Actions', heroic) : null,
    section('Magical Powers', powers),
    closeBtn(),
  ]);
}

function armyRulesView(idx, f) {
  const bonuses = (f.armyBonuses || []).map((nm) => defEntry(nm, idx.armyBonusByName.get(lc(nm))?.definition));
  const additional = (f.additionalRules || []).map((r) => el('li', {}, r));
  return el('.rules-body', {}, [
    el('h3', {}, f.name),
    el('.rs-type.muted.small', {}, `${f.alignment || ''} army`),
    additional.length ? el('.rs-section', {}, [el('h4', {}, 'Army Rules'), el('ul.rs-list', {}, additional)]) : null,
    section('Army Bonuses', bonuses),
    closeBtn(),
  ]);
}
