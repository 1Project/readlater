/* Readlater extension — popup: saves the current tab immediately, then lets
 * the user add tags / category / note (each change re-POSTs to /api/save,
 * the server dedupes by URL). */
/* global RL */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    status: $('status'), statusText: $('statusText'), retry: $('retryBtn'), fix: $('fixBtn'),
    title: $('pageTitle'), host: $('pageHost'), fields: $('fields'),
    tags: $('tags'), suggest: $('suggest'), category: $('category'),
    noteToggle: $('noteToggle'), note: $('note'), sync: $('syncState'),
    openItem: $('openItem'), openLibrary: $('openLibrary'), options: $('optionsBtn'), hint: $('shortcutHint'),
  };

  var cfg = null;
  var tab = null;
  var url = '';
  var itemId = null;
  var saving = false;
  var allTags = [];
  // What the server already has from us (to only send real changes).
  // sent.category is undefined until a category was actually sent.
  var sent = { tags: [], category: undefined, note: '' };
  var categoryTouched = false;
  var dirty = false;
  var updateChain = Promise.resolve();

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then(function (res) {
      return res || { ok: false, error: RL.apiError('client', 'No response from the extension background') };
    }, function (e) {
      return { ok: false, error: RL.toError(e) };
    });
  }

  function setStatus(state, text, error) {
    els.status.className = 'status is-' + state;
    els.statusText.textContent = text;
    var retryable = state === 'error' && !(error && (error.kind === 'unsupported' || error.kind === 'config'));
    els.retry.classList.toggle('hidden', !retryable);
    els.fix.classList.toggle('hidden', !(state === 'error' && error && (error.kind === 'auth' || error.kind === 'config' || error.status === 404)));
  }

  function openTab(href) {
    chrome.tabs.create({ url: href }).then(function () { window.close(); });
  }

  // ------------------------------------------------------------ save

  function currentTags() {
    return RL.normalizeTags(els.tags.value);
  }

  function save() {
    if (saving) return;
    saving = true;
    setStatus('saving', 'Saving…');
    var extra = {};
    var tags = currentTags();
    if (tags.length) extra.tags = tags;
    if (categoryTouched) extra.category = els.category.value || null;
    if (els.note.value.trim()) extra.note = els.note.value.trim();
    send({ type: 'save-tab', tabId: tab.id, extra: extra }).then(function (res) {
      saving = false;
      if (!res.ok) {
        setStatus('error', res.error.message, res.error);
        syncDraft();
        return;
      }
      itemId = res.id;
      // Record what this request carried — not the fields' current values, which
      // may have changed while it was in flight (commit() below sends those).
      sent = {
        tags: extra.tags || [],
        category: extra.category !== undefined ? extra.category || '' : undefined,
        note: extra.note || '',
      };
      setStatus('saved', res.html ? 'Saved' : 'Saved — the server will fetch the page');
      els.openItem.setAttribute('aria-disabled', 'false');
      els.openItem.href = cfg.serverUrl + '/item/' + encodeURIComponent(itemId);
      if (extra.tags) RL.rememberTags(cfg, extra.tags);
      if (dirty) commit();
      syncDraft();
    });
  }

  // ------------------------------------------------------------ updates

  function sameList(a, b) {
    return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  }

  /** Re-POST whatever changed since the last successful send. */
  function commit() {
    if (!itemId) { dirty = true; return; }
    dirty = false;
    var tags = currentTags();
    var category = els.category.value;
    var note = els.note.value.trim();
    var msg = { type: 'update', url: url };
    var changed = false;
    if (!sameList(tags, sent.tags)) { msg.tags = tags; changed = true; }
    if (categoryTouched && category !== sent.category) { msg.category = category || null; changed = true; }
    if (note !== sent.note) { msg.note = note; changed = true; }
    if (!changed) return;
    // Per spec the re-POST carries {url, tags, category}: always include the tag list.
    if (!msg.tags && tags.length) msg.tags = tags;
    els.sync.textContent = 'Saving changes…';
    els.sync.className = 'sync small muted';
    updateChain = updateChain.then(function () {
      return send(msg).then(function (res) {
        if (res.ok) {
          if (msg.tags) sent.tags = msg.tags;
          if (msg.category !== undefined) sent.category = category;
          if (msg.note !== undefined) sent.note = note;
          if (msg.tags) allTags = msg.tags.concat(allTags.filter(function (t) { return msg.tags.indexOf(t) === -1; }));
          els.sync.textContent = '✓ Changes saved';
          els.sync.className = 'sync small ok-text';
        } else {
          els.sync.textContent = res.error.message;
          els.sync.className = 'sync small error-text';
        }
        syncDraft();
      });
    });
  }

  // ------------------------------------------------------------ tag suggestions

  function renderSuggestions() {
    var parts = els.tags.value.split(',');
    var token = parts[parts.length - 1].trim().replace(/^#+/, '').toLowerCase();
    var entered = RL.normalizeTags(parts.slice(0, -1));
    var pool = allTags.filter(function (t) { return entered.indexOf(t) === -1 && t !== token; });
    var list;
    if (!token) {
      list = pool.slice(0, 8);
    } else {
      var starts = pool.filter(function (t) { return t.indexOf(token) === 0; });
      var contains = pool.filter(function (t) { return t.indexOf(token) > 0; });
      list = starts.concat(contains).slice(0, 8);
    }
    els.suggest.textContent = '';
    list.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = t;
      b.title = 'Add tag “' + t + '”';
      // Keep focus in the input so blur/change doesn't fire first.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { pickSuggestion(t); });
      els.suggest.appendChild(b);
    });
  }

  function pickSuggestion(tag) {
    var parts = els.tags.value.split(',');
    parts[parts.length - 1] = tag;
    els.tags.value = RL.normalizeTags(parts).join(', ') + ', ';
    els.tags.focus();
    renderSuggestions();
    commit();
  }

  function tidyTags() {
    var tags = currentTags();
    els.tags.value = tags.length ? tags.join(', ') : '';
  }

  // ------------------------------------------------------------ lists

  function loadLists() {
    RL.getTags(cfg).then(function (tags) {
      allTags = tags.concat(allTags.filter(function (t) { return tags.indexOf(t) === -1; }));
      renderSuggestions();
    }).catch(function () { /* suggestions are optional */ });
    RL.getCategories(cfg).then(function (cats) {
      var keep = els.category.value;
      while (els.category.options.length > 1) els.category.remove(1);
      cats.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        els.category.appendChild(o);
      });
      els.category.value = keep;
      if (!cats.length) els.category.closest('.field').classList.add('hidden');
    }).catch(function () {
      els.category.closest('.field').classList.add('hidden');
    });
  }

  function showShortcuts() {
    if (!chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll().then(function (cmds) {
      var open = cmds.find(function (c) { return c.name === '_execute_action'; });
      var quick = cmds.find(function (c) { return c.name === 'save-page'; });
      var bits = [];
      if (open && open.shortcut) bits.push([open.shortcut, ' opens this']);
      if (quick && quick.shortcut) bits.push([quick.shortcut, ' saves silently']);
      els.hint.textContent = '';
      bits.forEach(function (b, i) {
        if (i) els.hint.appendChild(document.createTextNode(' · '));
        var k = document.createElement('kbd');
        k.textContent = b[0];
        els.hint.appendChild(k);
        els.hint.appendChild(document.createTextNode(b[1]));
      });
    }).catch(function () {});
  }

  // ------------------------------------------------------------ wire up

  els.options.addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });
  els.fix.addEventListener('click', function () { chrome.runtime.openOptionsPage(); window.close(); });
  els.retry.addEventListener('click', save);
  els.openItem.addEventListener('click', function (e) {
    e.preventDefault();
    if (itemId) openTab(cfg.serverUrl + '/item/' + encodeURIComponent(itemId));
  });
  els.openLibrary.addEventListener('click', function (e) {
    e.preventDefault();
    if (cfg && cfg.serverUrl) openTab(cfg.serverUrl + '/');
  });

  els.tags.addEventListener('input', renderSuggestions);
  els.tags.addEventListener('focus', renderSuggestions);
  els.tags.addEventListener('keydown', function (e) {
    var parts = els.tags.value.split(',');
    var token = parts[parts.length - 1].trim().toLowerCase().replace(/^#+/, '');
    var first = els.suggest.querySelector('.chip');
    if (e.key === 'Tab' && !e.shiftKey && token && first && first.textContent.indexOf(token) === 0) {
      // Tab completes a partly typed tag with the top suggestion.
      e.preventDefault();
      pickSuggestion(first.textContent);
    } else if (e.key === 'Enter') {
      // Enter keeps exactly what was typed (so "ai" stays "ai" even if "aircraft" exists).
      e.preventDefault();
      tidyTags();
      renderSuggestions();
      commit();
    }
  });
  els.tags.addEventListener('change', function () { tidyTags(); commit(); });

  els.category.addEventListener('change', function () { categoryTouched = true; commit(); });

  els.noteToggle.addEventListener('click', function () {
    els.note.classList.remove('hidden');
    els.noteToggle.classList.add('hidden');
    els.noteToggle.setAttribute('aria-expanded', 'true');
    els.note.focus();
  });
  els.note.addEventListener('change', commit);
  els.note.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  // Edits that were typed but never committed (no Enter/blur) when the popup
  // closes: the popup keeps a port open to the background and mirrors the pending
  // update into it; the background sends it when the port disconnects (popup
  // closed). pagehide/unload messages are not reliably delivered from a closing popup.
  var port = null;
  try { port = chrome.runtime.connect({ name: 'popup' }); } catch (e) { port = null; }

  function pendingUpdate() {
    if (!url || !RL.isSavableUrl(url) || !tab) return null;
    if (!itemId && !saving) return null; // the save failed: nothing to attach the edits to
    var tags = currentTags();
    var note = els.note.value.trim();
    var category = els.category.value;
    var catChanged = categoryTouched && category !== sent.category;
    if (sameList(tags, sent.tags) && note === sent.note && !catChanged) return null;
    // Before the first save has finished, the background applies these after it.
    var msg = { type: itemId ? 'update' : 'update-after-save', tabId: tab.id, url: url, tags: tags };
    if (note !== sent.note) msg.note = note;
    if (catChanged) msg.category = category || null;
    return msg;
  }

  function syncDraft() {
    if (!port) return;
    try { port.postMessage({ type: 'draft', update: pendingUpdate() }); } catch (e) { port = null; }
  }

  els.tags.addEventListener('input', syncDraft);
  els.note.addEventListener('input', syncDraft);
  els.category.addEventListener('change', syncDraft);

  // ------------------------------------------------------------ start

  RL.getConfig().then(function (c) {
    cfg = c;
    if (!RL.isConfigured(cfg)) {
      chrome.runtime.openOptionsPage();
      window.close();
      return;
    }
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      tab = tabs[0];
      if (!tab) {
        setStatus('error', 'No active tab', RL.apiError('unsupported', 'No active tab'));
        return;
      }
      url = RL.unwrapUrl(tab.url || '');
      els.title.textContent = tab.title || url || 'Untitled';
      els.host.textContent = RL.hostOf(url) || url;
      showShortcuts();
      if (!RL.isSavableUrl(url)) {
        setStatus('error', "This page can't be saved — only web pages can", RL.apiError('unsupported', ''));
        els.fields.classList.add('is-disabled');
        return;
      }
      save();
      loadLists();
      els.tags.focus();
    });
  }).catch(function (e) {
    setStatus('error', RL.toError(e).message);
  });
})();
