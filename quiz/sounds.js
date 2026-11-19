// Soundboard for the control panel. All audio plays from the control window
// (browsers block audio in windows nobody has clicked, like the show screen).
// Built-in sounds are synthesised with Web Audio; extra sound files can be
// added and are kept in IndexedDB on this laptop only.

const Sounds = (function () {
  let ctx = null;
  let master = null;
  let volume = 0.8;
  let noiseBuf = null;
  const custom = []; // { id, name, buffer }

  try {
    const v = parseFloat(localStorage.getItem('quiz-night-volume'));
    if (!isNaN(v)) volume = v;
  } catch {}

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, opts) {
    const o = opts || {};
    const c = ac();
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
    const peak = o.gain == null ? 0.3 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise() {
    const c = ac();
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function clap(start, gain, freq) {
    const c = ac();
    const t0 = c.currentTime + start;
    const src = c.createBufferSource();
    src.buffer = noise();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(bp).connect(g).connect(master);
    src.start(t0, Math.random() * 0.8, 0.12);
  }

  const builtIn = [
    { id: 'buzzA', label: 'Buzz A', play() {
      tone(196, 0, 0.7, { type: 'square', gain: 0.16 });
      tone(247, 0, 0.7, { type: 'square', gain: 0.1 });
    } },
    { id: 'buzzB', label: 'Buzz B', play() {
      tone(330, 0, 0.7, { type: 'sawtooth', gain: 0.14 });
      tone(440, 0, 0.7, { type: 'sawtooth', gain: 0.08 });
    } },
    { id: 'correct', label: 'Correct', play() {
      tone(784, 0, 0.18, { type: 'triangle', gain: 0.3 });
      tone(1047, 0.13, 0.45, { type: 'triangle', gain: 0.3 });
    } },
    { id: 'wrong', label: 'Wrong', play() {
      tone(311, 0, 0.28, { type: 'sawtooth', gain: 0.13 });
      tone(220, 0.25, 0.6, { type: 'sawtooth', gain: 0.13 });
    } },
    { id: 'fanfare', label: 'Fanfare', play() {
      [523, 659, 784].forEach((f, i) => tone(f, i * 0.15, 0.3, { type: 'triangle', gain: 0.25 }));
      tone(1047, 0.45, 0.25, { type: 'triangle', gain: 0.28 });
      tone(784, 0.68, 0.18, { type: 'triangle', gain: 0.25 });
      tone(1047, 0.84, 1.1, { type: 'triangle', gain: 0.3 });
      tone(523, 0.84, 1.1, { type: 'sine', gain: 0.2 });
      tone(659, 0.84, 1.1, { type: 'sine', gain: 0.15 });
    } },
    { id: 'timeup', label: 'Time up', play() {
      [0, 0.22, 0.44].forEach((t) => tone(880, t, 0.14, { type: 'square', gain: 0.1 }));
      tone(587, 0.7, 0.7, { type: 'square', gain: 0.1 });
    } },
    { id: 'suspense', label: 'Tick tock', play() {
      for (let i = 0; i < 10; i++) tone(i % 2 ? 1400 : 1000, i * 0.5, 0.05, { type: 'square', gain: 0.08 });
    } },
    { id: 'applause', label: 'Applause', play() {
      for (let i = 0; i < 260; i++) {
        const t = Math.random() * 3;
        const fade = t > 2 ? (3 - t) : 1;
        clap(t, (0.15 + Math.random() * 0.25) * fade, 900 + Math.random() * 2200);
      }
    } },
    { id: 'gong', label: 'Gong', play() {
      tone(98, 0, 4, { gain: 0.4, attack: 0.02 });
      tone(147.5, 0, 3.2, { gain: 0.2, attack: 0.02 });
      tone(203, 0, 2.6, { gain: 0.12, attack: 0.02 });
      tone(277, 0, 1.8, { gain: 0.08, attack: 0.02 });
    } },
  ];

  function play(id) {
    try {
      const b = builtIn.find((s) => s.id === id);
      if (b) { b.play(); return; }
      const cst = custom.find((s) => s.id === id);
      if (cst) {
        const c = ac();
        const src = c.createBufferSource();
        src.buffer = cst.buffer;
        src.connect(master);
        src.start();
      }
    } catch (err) {
      console.warn('Could not play sound', id, err);
    }
  }

  // Cut everything that's playing by swapping out the master gain node.
  function stopAll() {
    if (!ctx) return;
    master.disconnect();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }

  function setVolume(v) {
    volume = v;
    if (master) master.gain.value = v;
    try { localStorage.setItem('quiz-night-volume', String(v)); } catch {}
  }

  // --- custom sound files, persisted in IndexedDB ---

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('quiz-night', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sounds', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbDo(mode, fn) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('sounds', mode);
      const req = fn(tx.objectStore('sounds'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    }));
  }

  async function decode(bytes) {
    return ac().decodeAudioData(bytes.slice(0));
  }

  async function loadSaved() {
    try {
      const rows = (await idbDo('readonly', (s) => s.getAll())) || [];
      rows.sort((a, b) => a.added - b.added);
      for (const r of rows) {
        try { custom.push({ id: r.id, name: r.name, buffer: await decode(r.bytes) }); }
        catch (err) { console.warn('Could not decode saved sound', r.name, err); }
      }
    } catch (err) {
      console.warn('Saved sounds unavailable', err);
    }
  }

  async function addFiles(files) {
    const failed = [];
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer();
        const buffer = await decode(bytes);
        const id = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const name = f.name.replace(/\.[^.]+$/, '');
        custom.push({ id, name, buffer });
        try { await idbDo('readwrite', (s) => s.put({ id, name, bytes, added: Date.now() })); } catch {}
      } catch (err) {
        failed.push(f.name);
      }
    }
    return failed;
  }

  async function remove(id) {
    const i = custom.findIndex((s) => s.id === id);
    if (i >= 0) custom.splice(i, 1);
    try { await idbDo('readwrite', (s) => s.delete(id)); } catch {}
  }

  return {
    play, stopAll, setVolume, addFiles, remove, loadSaved,
    get volume() { return volume; },
    list() {
      return builtIn.map((s) => ({ id: s.id, label: s.label, custom: false }))
        .concat(custom.map((s) => ({ id: s.id, label: s.name, custom: true })));
    },
    unlock() { ac(); },
  };
})();
