// app.js — shell: routing, home, roster browser, the "cake" gate, and wiring the
// builder + runner. Pure-logic lives in data.js / rules.js; persistence in store.js.

import { el, $, clear } from './ui.js';
import { loadData } from './data.js';
import { listRosters, getRoster, saveRoster, deleteRoster, backendLabel } from './store.js';
import { initBuilder, openBuilder } from './builder.js';
import { initRunner, openPlay } from './runner.js';

const SCREENS = ['home', 'browse', 'builder', 'game-setup', 'game'];
let idx = null;

function nav(screen) {
  for (const s of SCREENS) $(s).hidden = s !== screen;
  window.scrollTo(0, 0);
}

// ── "cake" password gate ───────────────────────────────────────────────────────
let cakeUnlocked = false;
function requireCake() {
  if (cakeUnlocked) return Promise.resolve(true);
  return new Promise((resolve) => {
    const dlg = $('cake-dialog');
    const input = $('cake-input');
    const err = $('cake-error');
    input.value = '';
    err.hidden = true;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue === 'ok' && input.value === 'cake') {
        cakeUnlocked = true;
        resolve(true);
      } else if (dlg.returnValue === 'ok') {
        err.hidden = false;
        requireCake().then(resolve); // wrong password — re-prompt
      } else {
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
  });
}

// ── Roster browser ──────────────────────────────────────────────────────────
async function renderBrowse() {
  nav('browse');
  const list = clear($('roster-list'));
  $('browse-status').textContent = 'Loading…';
  let rosters;
  try {
    rosters = await listRosters();
  } catch (e) {
    $('browse-status').textContent = 'Could not load armies: ' + (e.message || e);
    return;
  }
  $('browse-status').textContent = `${rosters.length} arm${rosters.length === 1 ? 'y' : 'ies'} · ${backendLabel()}`;
  if (!rosters.length) {
    list.append(el('.empty-note.muted', {}, 'No armies yet. Create one with “+ New army”.'));
    return;
  }
  for (const r of rosters) {
    list.append(el('.panel.roster-card', { role: 'button', title: 'Edit this army', onclick: () => editRoster(r.id) }, [
      el('.panel-grow', {}, [
        el('h3', {}, r.name || 'Untitled army'),
        el('.roster-meta.muted.small', {}, [
          el('span', { class: `tag ${r.alignment || ''}` }, r.faction || '—'),
          el('span', {}, `${r.points ?? '?'} pts`),
          el('span', {}, `${r.models ?? '?'} models`),
        ]),
      ]),
      el('.actions', {}, [
        el('button', { title: 'Use in a battle', onclick: (e) => { e.stopPropagation(); openPlay(); } }, '▶'),
        el('button', { title: 'Delete', onclick: (e) => { e.stopPropagation(); removeRoster(r); } }, '✕'),
      ]),
    ]));
  }
}

async function editRoster(id) {
  const r = await getRoster(id);
  if (!r) return;
  openBuilder(r);
  nav('builder');
}

async function removeRoster(r) {
  const ok = await requireCake();
  if (!ok) return;
  if (!confirm(`Delete “${r.name}”? This removes it for everyone.`)) return;
  await deleteRoster(r.id);
  renderBrowse();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  $('storage-note').textContent = 'Loading army data…';
  try {
    idx = await loadData();
  } catch (e) {
    $('storage-note').textContent = 'Failed to load army data: ' + (e.message || e);
    return;
  }
  $('storage-note').textContent = `${idx.factions.length} factions loaded · Storage: ${backendLabel()}`;

  initBuilder(idx, {
    requireCake,
    onSaved: (roster) => saveRoster(roster),
    goBack: () => renderBrowse(),
  });
  initRunner(idx, { nav, listRosters, getRoster });

  $('go-armies').addEventListener('click', renderBrowse);
  $('go-play').addEventListener('click', () => openPlay());
  $('new-roster-btn').addEventListener('click', async () => {
    const ok = await requireCake();
    if (!ok) return;
    openBuilder(null);
    nav('builder');
  });
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.addEventListener('click', () => {
      const target = b.dataset.nav;
      if (target === 'browse') renderBrowse();
      else nav(target);
    }),
  );

  nav('home');
}

boot();
