/* Readlater extension — options page. */
/* global RL */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('form');
  var serverUrl = $('serverUrl');
  var apiKey = $('apiKey');
  var createKey = $('createKey');
  var toggleKey = $('toggleKey');
  var testBtn = $('testBtn');
  var saveBtn = $('saveBtn');
  var msg = $('msg');
  var captureHtml = $('captureHtml');
  var showBadge = $('showBadge');

  function say(text, kind) {
    msg.textContent = text;
    msg.className = 'msg small' + (kind ? ' ' + kind : '');
  }

  function updateCreateKeyLink() {
    var p = RL.parseServerUrl(serverUrl.value);
    if (p.origin) {
      createKey.href = p.origin + '/settings#extension';
      createKey.removeAttribute('aria-disabled');
      createKey.title = '';
    } else {
      createKey.href = '#';
      createKey.setAttribute('aria-disabled', 'true');
      createKey.title = 'Enter the server URL first';
    }
  }

  /**
   * Ask for access to the server origin. MUST be the first async call in a
   * click/submit handler (Firefox drops the user gesture after an await).
   * Declining is not fatal: the API also sends CORS headers.
   */
  function requestHostPermission(pattern) {
    if (!chrome.permissions || !chrome.permissions.request) return Promise.resolve(true);
    try {
      return Promise.resolve(chrome.permissions.request({ origins: [pattern] })).catch(function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  /** Give back access to a server origin we no longer use (least privilege). */
  function releaseHostPermission(oldOrigin, keepPattern) {
    if (!oldOrigin || !chrome.permissions || !chrome.permissions.remove) return Promise.resolve();
    var old = RL.parseServerUrl(oldOrigin);
    if (!old.pattern || old.pattern === keepPattern) return Promise.resolve();
    return Promise.resolve(chrome.permissions.remove({ origins: [old.pattern] })).catch(function () {});
  }

  function readForm() {
    var key = apiKey.value.trim();
    var raw = serverUrl.value.trim();
    if (!raw && !key) return { clear: true };
    var p = RL.parseServerUrl(raw);
    if (p.error) return { error: p.error, focus: serverUrl };
    if (!key) return { error: 'Paste your API key.', focus: apiKey };
    if (/\s/.test(key)) return { error: 'The API key must not contain spaces.', focus: apiKey };
    return { origin: p.origin, pattern: p.pattern, key: key };
  }

  function test(cfg) {
    say('Testing…');
    return RL.api(cfg, 'GET', '/api/tags').then(function (d) {
      var n = d && Array.isArray(d.tags) ? d.tags.length : 0;
      say('✓ Connected to ' + RL.hostOf(cfg.serverUrl) + ' — ' + n + ' tag' + (n === 1 ? '' : 's') + ' in your library.', 'ok');
      return true;
    }, function (e) {
      say(RL.toError(e).message.replace(' — open options', ' — create a new key and paste it above'), 'err');
      return false;
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = readForm();
    if (f.error) {
      say(f.error, 'err');
      f.focus.focus();
      return;
    }
    if (f.clear) {
      RL.getConfig().then(function (old) {
        return RL.setConnection('', '').then(function () { return releaseHostPermission(old.serverUrl, null); });
      }).then(function () {
        say('Disconnected. The extension is turned off until you add a server and key.', 'ok');
      });
      return;
    }
    var perm = requestHostPermission(f.pattern); // first, while we still have the user gesture
    saveBtn.disabled = true;
    perm.then(function (granted) {
      serverUrl.value = f.origin;
      return RL.getConfig().then(function (old) {
        return RL.setConnection(f.origin, f.key).then(function () { return releaseHostPermission(old.serverUrl, f.pattern); });
      }).then(function () {
        updateCreateKeyLink();
        return test({ serverUrl: f.origin, apiKey: f.key }).then(function (ok) {
          if (ok) {
            say(msg.textContent + ' Saved.' + (granted ? '' : ' (Access to ' + RL.hostOf(f.origin) + ' was not granted — relying on the server’s CORS headers.)'), 'ok');
          } else {
            say('Saved, but: ' + msg.textContent, 'err');
          }
        });
      });
    }).catch(function (err) {
      say(RL.toError(err).message, 'err');
    }).then(function () {
      saveBtn.disabled = false;
    });
  });

  testBtn.addEventListener('click', function () {
    var f = readForm();
    if (f.clear) { say('Enter a server URL and API key first.', 'err'); return; }
    if (f.error) { say(f.error, 'err'); f.focus.focus(); return; }
    var perm = requestHostPermission(f.pattern);
    testBtn.disabled = true;
    perm.then(function () {
      return test({ serverUrl: f.origin, apiKey: f.key });
    }).then(function () {
      testBtn.disabled = false;
    });
  });

  serverUrl.addEventListener('input', updateCreateKeyLink);
  serverUrl.addEventListener('blur', function () {
    var p = RL.parseServerUrl(serverUrl.value);
    if (serverUrl.value.trim() && p.error) say(p.error, 'err');
    else if (msg.classList.contains('err')) say('');
  });

  toggleKey.addEventListener('click', function () {
    var show = apiKey.type === 'password';
    apiKey.type = show ? 'text' : 'password';
    toggleKey.textContent = show ? 'Hide' : 'Show';
    toggleKey.setAttribute('aria-pressed', String(show));
  });

  captureHtml.addEventListener('change', function () {
    chrome.storage.sync.set({ captureHtml: captureHtml.checked });
  });
  showBadge.addEventListener('change', function () {
    chrome.storage.sync.set({ showBadge: showBadge.checked });
  });

  function fillShortcut(slotId, shortcut) {
    var slot = $(slotId);
    slot.textContent = '';
    if (shortcut) {
      var k = document.createElement('kbd');
      k.textContent = shortcut;
      slot.appendChild(k);
    } else {
      slot.textContent = 'no shortcut set';
    }
  }

  if (chrome.commands && chrome.commands.getAll) {
    chrome.commands.getAll().then(function (cmds) {
      var by = {};
      cmds.forEach(function (c) { by[c.name] = c.shortcut; });
      fillShortcut('kbdAction', by._execute_action);
      fillShortcut('kbdSave', by['save-page']);
    }).catch(function () {});
  }

  RL.getConfig().then(function (cfg) {
    serverUrl.value = cfg.serverUrl;
    apiKey.value = cfg.apiKey;
    captureHtml.checked = cfg.captureHtml;
    showBadge.checked = cfg.showBadge;
    updateCreateKeyLink();
    if (!RL.isConfigured(cfg)) {
      say('Enter your server URL, then create an API key and paste it here.');
      serverUrl.focus();
    }
  });
})();
