// rulesview.js — read-only "rules reference" modals for a unit or a faction.
// Resolves names to their definitions (special rules → keywords, wargear → gear,
// magical powers → magicalPowers, army bonuses → armyBonuses) from the data index.
// Renders into the shared #rules-dialog. Reusable from the builder and the game runner.

import { el, $, clear, closeX } from './ui.js';

const lc = (s) => String(s || '').toLowerCase();

// ── Inline rule references ────────────────────────────────────────────────────
// Detect defined special-rule (keyword) names inside prose and turn them into tappable
// links that expand the definition in place. Case-sensitive + word-bounded, longest-first,
// and we skip very short names to avoid matching common words.

let _matcher = null;
function ruleMatcher(idx) {
  if (_matcher && _matcher.idx === idx) return _matcher;
  const names = [...idx.keywordByName.values()].map((k) => k.name).filter((n) => n && n.length >= 4);
  names.sort((a, b) => b.length - a.length); // longest-first so "Blades of the Dead" beats "Dead"
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w'])(${names.map(esc).join('|')})(?![\\w'])`, 'g');
  _matcher = { idx, re };
  return _matcher;
}

function refLink(idx, name) {
  const def = idx.keywordByName.get(lc(name))?.definition;
  let block = null;
  const btn = el('button.rule-ref', {
    type: 'button', title: 'Show rule',
    onclick: () => {
      if (block) { block.remove(); block = null; btn.classList.remove('open'); return; }
      const host = btn.closest('.rs-def') || btn.closest('li') || btn.parentElement;
      block = el('.ref-def.muted.small', {}, def || 'No definition available.');
      host.appendChild(block);
      btn.classList.add('open');
    },
  }, name);
  return btn;
}

// Returns an array of text fragments + ref-link buttons for a prose string.
function linkifyRules(idx, text) {
  const { re } = ruleMatcher(idx);
  re.lastIndex = 0;
  const nodes = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(refLink(idx, m[0]));
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

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

// `mods` is a stat→delta map summed from the selected options' gear modifiesStats.
// Effective values (base + delta) are shown as the main line; changed stats are highlighted.
function statBlock(src, isHero, mods = {}) {
  const eff = (k) => (Number(src[k]) || 0) + (mods[k] || 0);
  const cells = [
    ['Mv', 'movement', `${eff('movement')}"`], ['F', 'fight', eff('fight')], ['Sh', 'shoot', eff('shoot') ? `${eff('shoot')}+` : '—'],
    ['S', 'strength', eff('strength')], ['D', 'defence', eff('defence')], ['A', 'attack', eff('attack')],
    ['W', 'wounds', eff('wounds')], ['C', 'courage', eff('courage')],
  ];
  if (Number(src.intelligence) || 0) cells.push(['I', 'intelligence', eff('intelligence')]);
  const grid = el('.rs-stats', {}, cells.map(([l, k, v]) =>
    el(`.rs-stat${mods[k] ? '.modified' : ''}`, {}, [el('.rs-stat-l', {}, l), el('.rs-stat-v', {}, String(v))])));
  const parts = [grid];
  if (isHero) {
    const hStat = (label, k) => `${label} ${eff(k)}`;
    parts.push(el('.rs-heroic.small', {}, `${hStat('Might', 'might')} · ${hStat('Will', 'will')} · ${hStat('Fate', 'fate')}`));
  }
  parts.push(el('.rs-pts.muted.small', {}, `${Number(src.points) || 0} pts`));
  return el('.rs-profile', {}, parts);
}

// ── Views ────────────────────────────────────────────────────────────────────

function unitRulesView(idx, src, kind, options = []) {
  const isHero = kind === 'hero' || (src.unitType || []).includes('Hero');
  // Sum stat modifiers from the selected options' gear (e.g. Shield → +1 Defence).
  const mods = {};
  for (const o of options) {
    for (const m of idx.getGear(o.name)?.modifiesStats || []) {
      mods[m.stat] = (mods[m.stat] || 0) + (Number(m.modifier) || 0);
    }
  }
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
    statBlock(src, isHero, mods),
    section('Wargear', wargear),
    section('Upgrades', upgrades),
    section('Special Rules', special),
    isHero ? section('Heroic Actions', heroic) : null,
    section('Magical Powers', powers),
    closeBtn(),
  ]);
}

function armyRulesView(idx, f) {
  const bonuses = (f.armyBonuses || []).map((nm) => {
    const def = idx.armyBonusByName.get(lc(nm))?.definition;
    return el('.rs-def', {}, [
      el('.rs-def-name', {}, nm),
      def ? el('.rs-def-text.muted.small', {}, linkifyRules(idx, def)) : null,
    ]);
  });
  const additional = (f.additionalRules || []).map((r) => el('li', {}, linkifyRules(idx, r)));
  return el('.rules-body', {}, [
    el('h3', {}, f.name),
    el('.rs-type.muted.small', {}, `${f.alignment || ''} army`),
    additional.length ? el('.rs-section', {}, [el('h4', {}, 'Army Rules'), el('ul.rs-list', {}, additional)]) : null,
    section('Army Bonuses', bonuses),
    closeBtn(),
  ]);
}
