// Apply the saved theme before first paint (lib/prefs applyTheme() takes over once the app loads).
// A file rather than an inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  var t = JSON.parse(localStorage.getItem('rl.theme') || '"system"');
  if (['system', 'light', 'dark', 'sepia', 'eink'].indexOf(t) < 0) t = 'system';
  var d = document.documentElement;
  d.dataset.theme = t;
  d.dataset.scheme = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch (e) {}
