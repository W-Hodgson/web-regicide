// Shared theme toggle. Reads/writes localStorage key 'regicide-theme'.
(function () {
  const btn = document.getElementById('theme-toggle');

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#DDD5D0' : '#0f1419';
    if (btn) {
      btn.textContent = theme === 'light' ? '☾' : '☀';
      btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    }
  }

  applyTheme(currentTheme());

  if (btn) {
    btn.addEventListener('click', () => {
      const next = currentTheme() === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('regicide-theme', next); } catch {}
    });
  }
})();
