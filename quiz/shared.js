// Shared bits for the quiz control panel (admin) and the show screen.
// Both pages run in the same browser on the same laptop and talk over a
// BroadcastChannel — no server, no network.

const QUIZ_CHANNEL = 'quiz-night';

// The physical buzzers type a letter, like a USB keyboard.
const BUZZER_KEYS = { a: 0, b: 1 };
const TEAM_LETTERS = ['A', 'B'];

function createChannel(onMessage) {
  const ch = new BroadcastChannel(QUIZ_CHANNEL);
  ch.onmessage = (e) => onMessage(e.data || {});
  return ch;
}

// Team index (0/1) for a buzzer keydown, or null if it isn't one.
// Ignores key-repeat and shortcuts like Cmd+A.
function buzzerTeam(e) {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = BUZZER_KEYS[(e.key || '').toLowerCase()];
  return t === undefined ? null : t;
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Escapes a title and gives the "u" in "Buzzkill" its two buzzers
// (one red dome over each arm, drawn in CSS; the letter itself is untouched).
function brandTitle(s) {
  return escapeHtml(s).replace(/(b)(u)(zzkill)/gi, '$1<span class="buzzer-u">$2</span>$3');
}

// Escapes a team name and gives the "u" in "Huw" the same two buzzers.
function brandName(s) {
  return escapeHtml(s).replace(/\b(h)(u)(w)\b/gi, '$1<span class="buzzer-u">$2</span>$3');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
