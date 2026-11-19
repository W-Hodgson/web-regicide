// Show screen: renders whatever the control panel broadcasts. It also
// forwards buzzer key presses, because only the focused window receives them.

(function () {
  const $ = (id) => document.getElementById(id);
  const METER_MAX = 200;

  let view = null;
  let lastFlashId = null;
  let lastScreenKey = null;
  let lastScores = null;

  const channel = createChannel((msg) => {
    if (msg.type === 'state') {
      view = msg.view;
      render();
    } else if (msg.type === 'test') {
      lightTest(msg.team);
    }
  });

  channel.postMessage({ type: 'hello' });
  // Keep asking until the control panel answers (it may be opened second).
  const helloTimer = setInterval(() => {
    if (view) clearInterval(helloTimer);
    else channel.postMessage({ type: 'hello' });
  }, 1000);

  document.addEventListener('keydown', (e) => {
    const team = buzzerTeam(e);
    if (team === null) return;
    e.preventDefault();
    channel.postMessage({ type: 'buzz', team });
  });

  function reportFocus() {
    channel.postMessage({ type: 'focus', focused: document.hasFocus() });
  }
  window.addEventListener('focus', reportFocus);
  window.addEventListener('blur', reportFocus);
  window.addEventListener('pagehide', () => channel.postMessage({ type: 'focus', focused: false }));
  setInterval(reportFocus, 2000);
  reportFocus();

  // ---------- rendering ----------

  function name(t) {
    return brandName(view.teams[t].name);
  }

  function render() {
    $('waiting').hidden = true;
    $('stage').hidden = false;
    renderMeters();
    renderScreen();
    renderFlash();
  }

  function renderMeters() {
    const b = view.buzz || {};
    for (let t = 0; t < 2; t++) {
      const el = $('team-' + t);
      const score = view.teams[t].score;
      el.querySelector('.meter-name').innerHTML = brandName(view.teams[t].name);
      el.querySelector('.meter-score').textContent = score;
      const pct = Math.max(0, Math.min(1, score / METER_MAX)) * 100;
      el.querySelector('.meter-fill').style.height = pct + '%';
      el.classList.toggle('full', score >= METER_MAX);
      el.classList.toggle('locked', view.phase === 'starter' && !!(b.lockedOut && b.lockedOut[t]));
      el.classList.toggle('active', view.phase === 'starter' && b.team === t);

      if (lastScores && lastScores[t] !== score) popDelta(el, score - lastScores[t]);
    }
    lastScores = view.teams.map((x) => x.score);
  }

  // Floating "+10" next to a meter when its score changes.
  function popDelta(el, delta) {
    const chip = document.createElement('span');
    chip.className = 'delta ' + (delta > 0 ? 'up' : 'down');
    chip.textContent = (delta > 0 ? '+' : '') + delta;
    el.appendChild(chip);
    setTimeout(() => chip.remove(), 1800);
  }

  // Only rebuild the centre of the screen when its content changes, so
  // entrance animations don't replay on unrelated updates (e.g. timer).
  function screenKey(v) {
    return JSON.stringify({
      phase: v.phase, test: v.testMode, title: v.title, number: v.number,
      q: v.question, a: v.answer, img: v.image, buzz: v.buzz, won: v.starterWon,
      bonuses: v.bonuses, stage: v.bonusStage, applied: v.bonusApplied, topic: v.topic,
      names: v.teams.map((t) => t.name),
      scores: v.phase === 'end' ? v.teams.map((t) => t.score) : null,
    });
  }

  function questionBlock() {
    let html = '';
    if (view.image) html += '<img class="q-image" src="' + escapeHtml(view.image) + '" alt="">';
    html += view.question
      ? '<p class="q-text">' + escapeHtml(view.question) + '</p>'
      : '<p class="q-text listen">Listen carefully…</p>';
    if (view.answer) html += '<div class="q-answer">' + escapeHtml(view.answer) + '</div>';
    return html;
  }

  function renderScreen() {
    const v = view;
    const key = screenKey(v);
    if (key === lastScreenKey) return;
    lastScreenKey = key;
    let html = '';

    if (v.testMode) {
      html = '<div class="center">' +
        '<p class="kicker">Buzzer test</p>' +
        '<h1 class="mega">Press your buzzers</h1>' +
        '<div class="test-lights big">' +
          '<span id="light-0" class="light team-0">' + name(0) + '</span>' +
          '<span id="light-1" class="light team-1">' + name(1) + '</span>' +
        '</div></div>';
    } else if (v.phase === 'setup') {
      html = '<div class="center"><h1 class="mega">' + brandTitle(v.title) + '</h1>' +
        '<p class="sub">Starting soon</p></div>';
    } else if (v.phase === 'intro') {
      html = '<div class="center intro">' +
        '<h1 class="mega">' + brandTitle(v.title) + '</h1>' +
        '<div class="versus">' +
          '<span class="vs-team team-0">' + name(0) + '</span>' +
          '<span class="vs">vs</span>' +
          '<span class="vs-team team-1">' + name(1) + '</span>' +
        '</div></div>';
    } else if (v.phase === 'starter') {
      const b = v.buzz;
      let banner = '';
      if (b.team !== null) {
        banner = '<div class="buzz-banner team-' + b.team + '">' + name(b.team) + '</div>';
      } else if (v.starterWon !== null) {
        banner = '<div class="buzz-banner settled team-' + v.starterWon + '">' + name(v.starterWon) + ' +10</div>';
      }
      html = '<div class="question">' +
        '<p class="kicker">Starter ' + v.number + ' of ' + v.total + '</p>' +
        questionBlock() + '</div>' + banner;
    } else if (v.phase === 'bonus') {
      const items = v.bonuses.map((b, i) =>
        '<div class="bonus-item">' +
          '<span class="bonus-num">' + (i + 1) + '</span>' +
          '<div class="bonus-body">' +
            (b.image ? '<img class="q-image small" src="' + escapeHtml(b.image) + '" alt="">' : '') +
            '<p class="bq">' + escapeHtml(b.q) + '</p>' +
            (b.a ? '<div class="ba">' + escapeHtml(b.a) + '</div>' : '') +
          '</div>' +
        '</div>').join('');
      let results = '';
      if (v.bonusStage === 'scored') {
        results = '<div class="bonus-results">' + [0, 1].map((t) =>
          '<span class="result-chip team-' + t + '">' + name(t) + ' +' + v.bonusApplied[t] + '</span>').join('') +
          '</div>';
      }
      html = '<div class="bonus-round">' +
        '<p class="kicker">Bonus questions' + (v.topic ? ' · ' + escapeHtml(v.topic) : '') + '</p>' +
        '<div class="bonus-list">' + items + '</div>' + results + '</div>';
    } else if (v.phase === 'end') {
      const [a, b] = v.teams;
      const draw = a.score === b.score;
      const winner = a.score > b.score ? 0 : 1;
      html = '<div class="center final">' +
        '<p class="kicker">Final scores</p>' +
        (draw ? '<h1 class="mega">It’s a draw!</h1>'
          : '<h1 class="mega team-text team-' + winner + '">' + name(winner) + ' win!</h1>') +
        '<div class="final-scores">' +
          '<div class="final-team team-0"><span>' + name(0) + '</span><b>' + a.score + '</b></div>' +
          '<div class="final-team team-1"><span>' + name(1) + '</span><b>' + b.score + '</b></div>' +
        '</div></div>';
    }

    $('screen').innerHTML = html;
  }

  function renderFlash() {
    const f = view.flash;
    if (!f || f.id === lastFlashId) return;
    lastFlashId = f.id;
    for (const item of f.items) {
      const el = $('team-' + item.team);
      el.classList.remove('flash-correct', 'flash-wrong', 'flash-interrupt');
      void el.offsetWidth;
      el.classList.add('flash-' + item.kind);
    }
  }

  function lightTest(team) {
    const el = $('light-' + team);
    if (!el) return;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  // ---------- timer ----------

  function tick() {
    const t = view && view.timer;
    const bar = $('timer');
    if (!t) {
      bar.hidden = true;
    } else {
      const left = Math.max(0, t.endsAt - Date.now());
      bar.hidden = false;
      $('timer-fill').style.width = (100 * left / t.duration) + '%';
      $('timer-num').textContent = Math.ceil(left / 1000);
      bar.classList.toggle('urgent', left < 3000);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- full screen ----------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
  });

  // Hide the full-screen button and cursor when the mouse is still.
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  }
  document.addEventListener('mousemove', wake);
  wake();
})();
