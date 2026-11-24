// Buzzkill game page. The host reads the questions out from this screen; the
// contestants don't see it. State and the loaded questions are kept in
// localStorage so an accidental reload doesn't lose the game.

(function () {
  const STATE_KEY = 'quiz-night-state-v2';
  const OLD_STATE_KEY = 'quiz-night-state-v1';
  const QUESTIONS_KEY = 'quiz-night-questions-v1';
  const POINTS = { starter: 10, bonus: 5 };
  const DEFAULT_TEAMS = ['Team Jonathan', 'Team Huw'];

  const $ = (id) => document.getElementById(id);

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function freshState(prev) {
    return {
      teams: prev ? prev.teams.map((t) => ({ name: t.name, score: 0 }))
        : DEFAULT_TEAMS.map((name) => ({ name, score: 0 })),
      phase: 'setup',          // setup | starter | bonus | end
      starterIndex: 0,
      // team: who is answering now. handedOver: the first team got it wrong
      // and it went straight to the other team.
      buzz: { armed: false, team: null, lockedOut: [false, false], handedOver: false },
      starterWon: null,        // team that got the current starter right
      bonusStage: null,        // marking | scored
      bonusMarks: [null, null],  // how many bonuses each team got right
      bonusApplied: [0, 0],    // points added for the current bonus round
      timer: null,             // { endsAt, duration }
      testMode: false,
    };
  }

  let quiz = load(QUESTIONS_KEY);
  let state = load(STATE_KEY);
  if (!state) {
    // A game saved by the old two-screen version: keep team names, start over.
    const old = load(OLD_STATE_KEY);
    state = freshState(old && Array.isArray(old.teams) ? old : null);
  }
  state.testMode = false;

  // ---------- questions ----------

  function normaliseQuiz(raw) {
    if (!raw || !Array.isArray(raw.starters) || raw.starters.length === 0) {
      throw new Error('The file needs a "starters" list with at least one question.');
    }
    const starters = raw.starters.map((s, i) => {
      if (!s || typeof s.q !== 'string' || typeof s.a !== 'string') {
        throw new Error('Starter ' + (i + 1) + ' needs a "q" (question) and an "a" (answer).');
      }
      let topic = '';
      let list = [];
      if (Array.isArray(s.bonuses)) list = s.bonuses;
      else if (s.bonuses && Array.isArray(s.bonuses.questions)) {
        list = s.bonuses.questions;
        topic = s.bonuses.topic || '';
      }
      const bonuses = list.map((b, j) => {
        if (!b || typeof b.q !== 'string' || typeof b.a !== 'string') {
          throw new Error('Bonus ' + (j + 1) + ' of starter ' + (i + 1) + ' needs a "q" and an "a".');
        }
        return { q: b.q, a: b.a, note: b.note || '', image: b.image || '' };
      });
      return { q: s.q, a: s.a, note: s.note || '', image: s.image || '', topic, bonuses };
    });
    return { title: raw.title || 'Buzzkill', starters };
  }

  // Questions come from questions.json next to this page, fetched fresh on
  // every load. If the file has changed since the last load, the saved game
  // starts over (its starter numbers would no longer line up).
  async function loadQuestions() {
    try {
      const res = await fetch('questions.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const next = normaliseQuiz(await res.json());
      const changed = JSON.stringify(next) !== JSON.stringify(quiz);
      quiz = next;
      save(QUESTIONS_KEY, quiz);
      if (changed) state = freshState(state);
      setQuestionsStatus('“' + quiz.title + '” · ' + quiz.starters.length + ' starters from questions.json' + '.', false);
      commit();
    } catch (err) {
      setQuestionsStatus('Could not load questions.json: ' + err.message +
        (quiz ? ' Using the copy from the last load.' : ''), true);
    }
  }

  function setQuestionsStatus(msg, isError) {
    const el = $('questions-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function currentStarter() {
    return quiz ? quiz.starters[state.starterIndex] : null;
  }

  // ---------- game actions ----------

  const actions = {
    // Setup's "Start new game": scores back to 0, straight to the first starter.
    startQuiz() {
      if (!quiz) return;
      const inProgress = state.phase !== 'setup' || state.teams.some((t) => t.score !== 0);
      if (inProgress && !confirm('Start a new game? Both scores will go back to 0.')) return;
      state = freshState(state);
      actions.goStarter(0);
      $('setup').open = false;
    },
    goStarter(i) {
      if (!quiz) return;
      if (i < 0 || i >= quiz.starters.length) return;
      state.phase = 'starter';
      state.starterIndex = i;
      state.testMode = false;
      state.buzz = { armed: true, team: null, lockedOut: [false, false], handedOver: false };
      state.starterWon = null;
      state.bonusStage = null;
      state.bonusMarks = [null, null];
      state.bonusApplied = [0, 0];
      state.timer = null;
    },
    nextStarter() {
      if (!quiz) return;
      if (state.phase === 'setup') return actions.goStarter(0);
      if (state.starterIndex + 1 < quiz.starters.length) actions.goStarter(state.starterIndex + 1);
      else actions.endQuiz();
    },
    prevStarter() {
      actions.goStarter(Math.max(0, state.starterIndex - 1));
    },
    starterCorrect() {
      const t = state.buzz.team;
      if (t === null) return;
      state.teams[t].score += POINTS.starter;
      state.starterWon = t;
      state.buzz.team = null;
      state.buzz.armed = false;
      state.timer = null;
      Sounds.play('correct');
    },
    // Wrong: it goes straight over to the other team (no buzzing needed).
    // If they've already had their go, nobody gets the points.
    starterWrong() {
      const t = state.buzz.team;
      if (t === null) return;
      const other = 1 - t;
      state.buzz.lockedOut[t] = true;
      state.buzz.armed = false;
      state.timer = null;
      if (!state.buzz.lockedOut[other]) {
        state.buzz.team = other;
        state.buzz.handedOver = true;
      } else {
        state.buzz.team = null;
      }
      Sounds.play('wrong');
    },
    // Bonus round: read to both teams, then mark how many each got right.
    startBonuses() {
      const s = currentStarter();
      if (!s || !s.bonuses.length || state.buzz.team !== null) return;
      state.phase = 'bonus';
      state.buzz.armed = false;
      state.bonusStage = 'marking';
      state.bonusMarks = [null, null];
      state.bonusApplied = [0, 0];
      state.timer = null;
    },
    bonusMark(team, count) {
      if (state.phase !== 'bonus' || state.bonusStage !== 'marking') return;
      state.bonusMarks[team] = count;
    },
    applyBonus() {
      if (state.bonusStage !== 'marking' || state.bonusMarks.some((m) => m === null)) return;
      let any = false;
      for (let t = 0; t < 2; t++) {
        const pts = state.bonusMarks[t] * POINTS.bonus;
        state.teams[t].score += pts;
        state.bonusApplied[t] = pts;
        if (pts > 0) any = true;
      }
      state.bonusStage = 'scored';
      Sounds.play(any ? 'correct' : 'wrong');
    },
    undoBonus() {
      if (state.bonusStage !== 'scored') return;
      for (let t = 0; t < 2; t++) state.teams[t].score -= state.bonusApplied[t];
      state.bonusApplied = [0, 0];
      state.bonusStage = 'marking';
    },
    endQuiz() {
      state.phase = 'end';
      state.buzz.armed = false;
      state.buzz.team = null;
      state.timer = null;
      Sounds.play('gong');
    },
    resetGame() {
      if (!confirm('Reset scores and go back to setup?')) return;
      state = freshState(state);
    },
    toggleTest() {
      state.testMode = !state.testMode;
    },
    timer(seconds) {
      state.timer = { endsAt: Date.now() + seconds * 1000, duration: seconds * 1000 };
    },
    timerStop() {
      state.timer = null;
    },
    score(team, delta) {
      state.teams[team].score += delta;
    },
  };

  function run(name, ...args) {
    Sounds.unlock();
    actions[name](...args);
    commit();
  }

  // ---------- buzzers ----------

  function handleBuzz(team) {
    if (state.testMode) {
      Sounds.play(team === 0 ? 'buzzA' : 'buzzB');
      lightTest(team);
      return;
    }
    if (state.phase !== 'starter' || !state.buzz.armed) return;
    if (state.buzz.team !== null || state.buzz.lockedOut[team]) return;
    state.buzz.team = team;
    state.buzz.armed = false;
    Sounds.play(team === 0 ? 'buzzA' : 'buzzB');
    commit();
  }

  function buzzersLive() {
    return state.testMode || (state.phase === 'starter' && state.buzz.armed);
  }

  document.addEventListener('keydown', (e) => {
    const team = buzzerTeam(e);
    if (team === null) return;
    const live = buzzersLive();
    // Let A/B type normally into text boxes unless the buzzers are live.
    if (!live && isTyping(document.activeElement)) return;
    if (live) e.preventDefault();
    handleBuzz(team);
  }, true);

  function lightTest(team) {
    const el = $('light-' + team);
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }


  function commit() {
    save(STATE_KEY, state);
    render();
  }

  // ---------- timer ----------

  setInterval(() => {
    if (state.timer && Date.now() >= state.timer.endsAt) {
      state.timer = null;
      Sounds.play('timeup');
      commit();
    }
    renderTimer();
  }, 100);

  // ---------- rendering ----------

  function teamName(t) {
    return escapeHtml(state.teams[t].name);
  }

  function btn(label, action, opts) {
    const o = opts || {};
    return '<button type="button" data-action="' + action + '"' +
      (o.arg != null ? ' data-arg="' + o.arg + '"' : '') +
      (o.cls ? ' class="' + o.cls + '"' : '') +
      (o.disabled ? ' disabled' : '') + '>' + label + '</button>';
  }

  function render() {
    renderSetup();
    renderControl();
    renderScores();
    renderListen();
    renderTimer();
  }

  function renderSetup() {
    const setup = $('setup');
    if (state.phase === 'setup') setup.open = true;
    for (let t = 0; t < 2; t++) {
      const input = $('team-' + t + '-name');
      if (document.activeElement !== input) input.value = state.teams[t].name;
    }
    $('start-quiz').disabled = !quiz;
    $('test-toggle').textContent = state.testMode ? 'Stop buzzer test' : 'Start buzzer test';
    $('test-toggle').classList.toggle('primary', state.testMode);
  }

  function renderControl() {
    const s = currentStarter();
    const phaseLabel = {
      setup: 'Setup', starter: 'Starter question',
      bonus: 'Bonus questions', end: 'Final scores',
    }[state.phase];
    $('phase-label').textContent = phaseLabel;
    $('progress').textContent = quiz && (state.phase === 'starter' || state.phase === 'bonus')
      ? 'Starter ' + (state.starterIndex + 1) + ' of ' + quiz.starters.length : '';

    let card = '';
    let status = '';
    let acts = '';

    if (!quiz) {
      card = '<p class="muted">Loading questions…</p>';
    } else if (state.phase === 'setup') {
      card = '<p class="big">' + brandTitle(quiz.title) + '</p><p class="muted">' +
        teamName(0) + ' vs ' + teamName(1) + ' · test the buzzers, then press <b>Start new game</b>.</p>';
    } else if (state.phase === 'starter') {
      card = questionCard(s.q, s.a, s.note, s.image);
      const b = state.buzz;
      if (b.team !== null) {
        status = '<div class="status buzzed team-' + b.team + '">' +
          (b.handedOver ? 'Over to ' + brandName(state.teams[b.team].name) : brandName(state.teams[b.team].name) + ' buzzed') +
          '</div>';
        acts = btn('Correct +' + POINTS.starter, 'starterCorrect', { cls: 'primary good' }) +
          btn(b.handedOver ? 'Wrong, nobody scores' : 'Wrong, over to ' + teamName(1 - b.team), 'starterWrong', { cls: 'bad' });
      } else {
        // Starter is settled (answered, or both teams had a go), or still live.
        if (state.starterWon !== null) {
          status = '<div class="status won team-' + state.starterWon + '">' + teamName(state.starterWon) + ' got it</div>';
        } else if (b.armed) {
          status = '<div class="status live">Buzzers live</div>';
        } else {
          status = '<div class="status dead">Both teams got it wrong, no points</div>';
        }
        const settled = state.starterWon !== null || !b.armed;
        acts = s.bonuses.length
          ? btn(settled ? 'Bonus questions →' : 'Nobody buzzed, bonus questions →', 'startBonuses',
            { cls: settled ? 'primary' : '' })
          : btn(settled ? 'Next starter →' : 'Nobody buzzed, next starter →', 'nextStarter',
            { cls: settled ? 'primary' : '' });
      }
    } else if (state.phase === 'bonus') {
      card = '<p class="kicker">' + (s.topic ? escapeHtml(s.topic) + ' · ' : '') + 'Read to both teams, then read the answers</p>' +
        s.bonuses.map((bq, i) =>
          '<div class="bonus-admin"><span class="bonus-num">' + (i + 1) + '</span><div>' +
          questionCard(bq.q, bq.a, bq.note, bq.image) + '</div></div>').join('');
      if (state.bonusStage === 'marking') {
        const n = s.bonuses.length;
        status = '<div class="marks">' + [0, 1].map((t) => {
          let opts = '';
          for (let c = 0; c <= n; c++) {
            opts += btn(String(c), 'bonusMark', {
              arg: t + ':' + c, cls: state.bonusMarks[t] === c ? 'mark on' : 'mark',
            });
          }
          return '<div class="mark-row team-' + t + '"><span class="mark-name">' + teamName(t) +
            ' got</span><span class="mark-opts">' + opts + '</span><span class="muted small">right</span></div>';
        }).join('') + '</div>';
        const ready = state.bonusMarks.every((m) => m !== null);
        const preview = ready ? ' (' + state.bonusMarks.map((m) => '+' + m * POINTS.bonus).join(' / ') + ')' : '';
        acts = btn('Add points' + preview, 'applyBonus', { cls: 'primary good', disabled: !ready });
      } else {
        status = '<div class="status dead">' + [0, 1].map((t) =>
          teamName(t) + ' +' + state.bonusApplied[t]).join(' · ') + '</div>';
        acts = btn('Next starter →', 'nextStarter', { cls: 'primary' }) + btn('Change marks', 'undoBonus');
      }
    } else if (state.phase === 'end') {
      const [a, b] = state.teams;
      card = '<p class="big">' + (a.score === b.score ? 'A draw!' :
        escapeHtml((a.score > b.score ? a : b).name) + ' win') + '</p>' +
        '<p class="muted">' + escapeHtml(a.name) + ' ' + a.score + ' – ' + b.score + ' ' + escapeHtml(b.name) + '</p>';
      acts = btn('Applause', 'sound', { arg: 'applause' });
    }

    $('question-card').innerHTML = card;
    $('buzz-status').innerHTML = status;
    $('actions').innerHTML = acts;

    const inGame = !!quiz && (state.phase === 'starter' || state.phase === 'bonus');
    $('prev-starter').disabled = !inGame || state.starterIndex === 0;
    $('next-starter').disabled = !quiz || state.phase === 'setup' || state.phase === 'end';
    $('end-quiz').disabled = !quiz || state.phase === 'setup' || state.phase === 'end';
  }

  function questionCard(q, a, note, image) {
    return '<p class="q">' + escapeHtml(q) + '</p>' +
      (image ? '<p class="muted small">Picture: ' + escapeHtml(image) + '</p>' : '') +
      '<div class="answer"><span class="label">Answer</span>' + escapeHtml(a) +
      (note ? '<span class="note">' + escapeHtml(note) + '</span>' : '') + '</div>';
  }

  function renderScores() {
    $('score-rows').innerHTML = state.teams.map((t, i) =>
      '<div class="score-row team-' + i + '">' +
        '<span class="score-name"><kbd>' + TEAM_LETTERS[i] + '</kbd> ' + escapeHtml(t.name) + '</span>' +
        '<span class="score-num">' + t.score + '</span>' +
        '<span class="score-adj">' +
          btn('−5', 'score', { arg: i + ':-5' }) +
          btn('+5', 'score', { arg: i + ':5' }) +
          btn('+10', 'score', { arg: i + ':10' }) +
        '</span>' +
      '</div>').join('');
  }

  function renderListen() {
    const el = $('listen-status');
    if (document.hasFocus()) {
      el.textContent = 'Buzzers: listening';
      el.className = 'listen-pill ok';
    } else {
      el.textContent = 'Buzzers: not listening, click this window';
      el.className = 'listen-pill warn';
    }
  }

  function renderTimer() {
    const el = $('timer-readout');
    if (!state.timer) { el.textContent = '—'; return; }
    const left = Math.max(0, state.timer.endsAt - Date.now());
    el.textContent = (left / 1000).toFixed(1) + 's';
  }

  function renderSoundboard() {
    $('soundboard').innerHTML = Sounds.list().map((s) =>
      '<div class="sound' + (s.custom ? ' custom' : '') + '">' +
        '<button type="button" data-sound="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</button>' +
        (s.custom ? '<button type="button" class="remove" data-remove="' + escapeHtml(s.id) +
          '" aria-label="Remove ' + escapeHtml(s.label) + '">×</button>' : '') +
      '</div>').join('');
  }

  // ---------- wiring ----------

  document.querySelector('.control').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    const name = b.dataset.action;
    const arg = b.dataset.arg;
    if (name === 'sound') { Sounds.play(arg); return; }
    if (name === 'bonusMark') run(name, ...arg.split(':').map(Number));
    else run(name);
  });

  $('score-rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action="score"]');
    if (!b) return;
    const [t, d] = b.dataset.arg.split(':').map(Number);
    run('score', t, d);
  });

  $('prev-starter').addEventListener('click', () => run('prevStarter'));
  $('next-starter').addEventListener('click', () => run('nextStarter'));
  $('end-quiz').addEventListener('click', () => {
    if (confirm('End the quiz and show final scores?')) run('endQuiz');
  });
  $('start-quiz').addEventListener('click', () => run('startQuiz'));
  $('reset-game').addEventListener('click', () => run('resetGame'));
  $('test-toggle').addEventListener('click', () => run('toggleTest'));

  document.querySelectorAll('[data-timer]').forEach((b) =>
    b.addEventListener('click', () => run('timer', Number(b.dataset.timer))));
  $('timer-stop').addEventListener('click', () => run('timerStop'));

  for (let t = 0; t < 2; t++) {
    $('team-' + t + '-name').addEventListener('input', (e) => {
      state.teams[t].name = e.target.value.trim() || DEFAULT_TEAMS[t];
      commit();
    });
  }

  $('soundboard').addEventListener('click', async (e) => {
    const rm = e.target.closest('button[data-remove]');
    if (rm) {
      await Sounds.remove(rm.dataset.remove);
      renderSoundboard();
      return;
    }
    const b = e.target.closest('button[data-sound]');
    if (b) Sounds.play(b.dataset.sound);
  });
  $('add-sounds').addEventListener('click', () => $('sound-files').click());
  $('sound-files').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const failed = await Sounds.addFiles(files);
    renderSoundboard();
    if (failed.length) alert('Could not load: ' + failed.join(', '));
  });
  $('stop-sounds').addEventListener('click', () => Sounds.stopAll());
  $('volume').value = Sounds.volume;
  $('volume').addEventListener('input', (e) => Sounds.setVolume(Number(e.target.value)));

  window.addEventListener('focus', renderListen);
  window.addEventListener('blur', () => setTimeout(renderListen, 50));
  document.addEventListener('pointerdown', () => Sounds.unlock(), { once: true });

  renderSoundboard();
  Sounds.loadSaved().then(renderSoundboard);
  commit();
  loadQuestions();
})();
