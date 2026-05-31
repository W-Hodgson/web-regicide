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
