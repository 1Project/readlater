/*
 * Readlater extension — background (Chrome/Edge MV3 service worker, Firefox event page).
 * Owns: saving (so a save survives the popup closing), the toolbar badge,
 * context menus and keyboard commands.
 */
/* global RL, importScripts */
if (typeof self.RL === 'undefined' && typeof importScripts === 'function') {
  importScripts('lib.js'); // Chrome service worker; Firefox loads lib.js via manifest "scripts"
}

var MENU_SAVE_PAGE = 'rl-save-page';
var MENU_SAVE_LINK = 'rl-save-link';
var MENU_OPEN_LIBRARY = 'rl-open-library';

var BADGE = {
  saved: { text: '✓', color: '#1a7f37', title: 'Saved to Readlater' },
  saving: { text: '…', color: '#6e7781', title: 'Saving to Readlater…' },
  error: { text: '!', color: '#cf222e', title: 'Readlater: could not save' },
};

// ---------------------------------------------------------------- badge

function setBadge(tabId, state, title) {
  if (tabId == null || tabId < 0) return Promise.resolve();
  var b = state ? BADGE[state] : null;
  var ops = [
    chrome.action.setBadgeText({ tabId: tabId, text: b ? b.text : '' }),
    chrome.action.setTitle({ tabId: tabId, title: title || (b ? b.title : 'Save to Readlater') }),
  ];
  if (b) {
    ops.push(chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: b.color }));
    if (chrome.action.setBadgeTextColor) ops.push(chrome.action.setBadgeTextColor({ tabId: tabId, color: '#ffffff' }));
  }
  // The tab may have been closed meanwhile — ignore.
  return Promise.all(ops.map(function (p) { return Promise.resolve(p).catch(function () {}); }));
}

function clearAllBadges() {
  return chrome.tabs.query({}).then(function (tabs) {
    return Promise.all(tabs.map(function (t) { return setBadge(t.id, null); }));
  });
}

// ---------------------------------------------------------------- lookup cache
// Per-URL cache (5 min) of GET /api/lookup. storage.session survives the
// service worker being suspended; falls back to memory.

var memLookup = new Map();
var inflightLookup = new Map();
var sessionStore = chrome.storage && chrome.storage.session ? chrome.storage.session : null;

function lookupCacheGet(key) {
  var now = Date.now();
  var m = memLookup.get(key);
  if (m) return Promise.resolve(now - m.at < RL.LOOKUP_CACHE_MS ? m.value : null);
  if (!sessionStore) return Promise.resolve(null);
  var k = 'lk:' + key;
  return sessionStore.get(k).then(function (got) {
    var e = got[k];
    if (!e) return null;
    memLookup.set(key, e);
    return now - e.at < RL.LOOKUP_CACHE_MS ? e.value : null;
  }).catch(function () { return null; });
}

function lookupCacheSet(key, value) {
  var e = { at: Date.now(), value: value };
  memLookup.set(key, e);
  if (memLookup.size > 500) memLookup.delete(memLookup.keys().next().value);
  if (!sessionStore) return Promise.resolve();
  var put = {};
  put['lk:' + key] = e;
  return sessionStore.set(put).catch(function () {});
}

function lookupCacheClear() {
  memLookup.clear();
  if (!sessionStore) return Promise.resolve();
  return sessionStore.get(null).then(function (all) {
    var keys = Object.keys(all).filter(function (k) { return k.indexOf('lk:') === 0; });
    return keys.length ? sessionStore.remove(keys) : undefined;
  }).catch(function () {});
}

/** → { saved, id?, status?, location? } or null when unknown (error / not configured). */
function lookup(cfg, url) {
  var key = RL.cacheKey(url);
  return lookupCacheGet(key).then(function (hit) {
    if (hit) return hit;
    if (inflightLookup.has(key)) return inflightLookup.get(key);
    var p = RL.api(cfg, 'GET', '/api/lookup?url=' + encodeURIComponent(key)) // without #fragment
      .then(function (d) {
        var v = { saved: !!(d && d.saved) };
        if (d && d.id) v.id = String(d.id);
        if (d && d.status) v.status = d.status;
        if (d && d.location) v.location = d.location;
        return lookupCacheSet(key, v).then(function () { return v; });
      })
      .catch(function () { return null; })
      .then(function (v) { inflightLookup.delete(key); return v; });
    inflightLookup.set(key, p);
    return p;
  });
}

// ---------------------------------------------------------------- badge refresh (throttled)

var savingTabs = new Set();
var refreshTimers = new Map();

function scheduleBadgeRefresh(tabId, delay) {
  if (refreshTimers.has(tabId)) clearTimeout(refreshTimers.get(tabId));
  refreshTimers.set(tabId, setTimeout(function () {
    refreshTimers.delete(tabId);
    refreshBadge(tabId);
  }, delay == null ? 500 : delay));
}

function refreshBadge(tabId) {
  return Promise.all([RL.getConfig(), chrome.tabs.get(tabId).catch(function () { return null; })]).then(function (r) {
    var cfg = r[0];
    var tab = r[1];
    if (!tab || savingTabs.has(tabId)) return;
    if (!RL.isConfigured(cfg)) return setBadge(tabId, null, 'Readlater — click to set up');
    var url = RL.unwrapUrl(tab.url || '');
    // Private windows: never tell the server which pages are visited there.
    if (!cfg.showBadge || tab.incognito || !RL.isSavableUrl(url)) return setBadge(tabId, null);
    if (url.indexOf(cfg.serverUrl + '/') === 0) return setBadge(tabId, null);
    return lookup(cfg, url).then(function (v) {
      if (savingTabs.has(tabId)) return;
      // Ignore a stale answer if the tab navigated meanwhile.
      return chrome.tabs.get(tabId).then(function (now) {
        if (RL.cacheKey(RL.unwrapUrl(now.url || '')) !== RL.cacheKey(url)) return;
        return setBadge(tabId, v && v.saved ? 'saved' : null, v && v.saved ? 'Already in Readlater' : undefined);
      }).catch(function () {});
    });
  }).catch(function () {});
}

chrome.tabs.onActivated.addListener(function (info) {
  scheduleBadgeRefresh(info.tabId, 150);
});

chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
  if (!tab.active) return;
  if (change.url || change.status === 'complete') scheduleBadgeRefresh(tabId);
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  savingTabs.delete(tabId);
  if (refreshTimers.has(tabId)) {
    clearTimeout(refreshTimers.get(tabId));
    refreshTimers.delete(tabId);
  }
});

// ---------------------------------------------------------------- page capture

/**
 * Runs in the page. Returns the rendered HTML (scripts/styles stripped,
 * JSON-LD kept for metadata) or a skip reason. Must be self-contained.
 */
function capturePageInTab(maxBytes) {
  try {
    var ct = document.contentType || 'text/html';
    if (!/html/i.test(ct)) return { skip: 'type' };
    var clone = document.documentElement.cloneNode(true);
    var junk = clone.querySelectorAll('script:not([type="application/ld+json"]), style, link[rel~="stylesheet"], link[rel~="preload"], iframe, template');
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    // Never send form secrets (CSRF tokens, prefilled passwords) to the server.
    var secrets = clone.querySelectorAll('input[type="password"], input[type="hidden"]');
    for (var j = 0; j < secrets.length; j++) secrets[j].remove();
    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    var size = new Blob([html]).size;
    if (size > maxBytes) return { skip: 'size', size: size };
    return { html: html, size: size, href: location.href };
  } catch (e) {
    return { skip: 'error' };
  }
}

function captureHtml(tab) {
  var url = tab.url || '';
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(null); // chrome://, about:reader, file://…
  var path = '';
  try { path = new URL(url).pathname; } catch (e) { /* ignore */ }
  if (/\.(pdf|epub)$/i.test(path)) return Promise.resolve(null); // let the server download the file
  return chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: capturePageInTab, args: [RL.MAX_HTML_BYTES] })
    .then(function (results) {
      var r = results && results[0] && results[0].result;
      if (!r || typeof r.html !== 'string') return null;
      // The tab navigated between reading tab.url and capturing: don't attach another page's HTML.
      if (RL.cacheKey(r.href || '') !== RL.cacheKey(url)) return null;
      return r.html;
    })
    .catch(function () { return null; }); // no permission / restricted page → URL only
}

// ---------------------------------------------------------------- saving

// Chrome stops an idle service worker after ~30 s; a save with a large page on a
// slow connection can take longer. Calling any extension API resets the idle timer.
var keepAliveCount = 0;
var keepAliveTimer = null;
function keepAlive(promise) {
  keepAliveCount++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(function () { chrome.runtime.getPlatformInfo().catch(function () {}); }, 20000);
  }
  function done() {
    if (--keepAliveCount === 0 && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }
  promise.then(done, done);
  return promise;
}

// tabId → promise of the running saveTab(), so popup edits made while the
// first save is still running can be applied after it (see 'update-after-save').
var inflightSaves = new Map();

function postSave(cfg, body) {
  return RL.api(cfg, 'POST', '/api/save', body).then(function (d) {
    if (!d || !d.id) throw RL.apiError('server', 'The server did not return an item id');
    return d;
  });
}

function categoryFields(body, category) {
  // `category` is a category id from GET /api/categories (null = none).
  body.category = category;
  body.categoryId = category;
}

/**
 * Save a tab (page + rendered HTML).
 * extra: { tags?: string[], category?: string|null, note?: string }
 * → { ok:true, id, url, title, html:boolean } | { ok:false, error }
 */
function saveTab(tab, extra) {
  var p = keepAlive(doSaveTab(tab, extra));
  inflightSaves.set(tab.id, p);
  p.then(function () { if (inflightSaves.get(tab.id) === p) inflightSaves.delete(tab.id); });
  return p;
}

function doSaveTab(tab, extra) {
  extra = extra || {};
  var tabId = tab.id;
  var url = RL.unwrapUrl(tab.url || '');
  return RL.getConfig().then(function (cfg) {
    if (!RL.isConfigured(cfg)) throw RL.apiError('config', 'Set your server URL and API key in options');
    if (!RL.isSavableUrl(url)) throw RL.apiError('unsupported', "This page can't be saved — only web pages (http/https) can");
    savingTabs.add(tabId);
    setBadge(tabId, 'saving');
    return (cfg.captureHtml ? captureHtml(tab) : Promise.resolve(null)).then(function (html) {
      var body = { url: url, source: 'extension' };
      var title = (tab.title || '').trim();
      if (title && title !== url && title !== tab.url) body.title = title.slice(0, 500);
      if (html) body.html = html;
      var tags = RL.normalizeTags(extra.tags || []);
      if (tags.length) body.tags = tags;
      if (extra.category !== undefined) categoryFields(body, extra.category);
      if (extra.note) body.note = extra.note;
      return postSave(cfg, body)
        .catch(function (e) {
          // Page too large for the server? Retry with the URL only.
          if (html && e && e.status === 413) {
            delete body.html;
            html = null;
            return postSave(cfg, body);
          }
          throw e;
        })
        .then(function (d) {
          var id = String(d.id);
          lookupCacheSet(RL.cacheKey(url), { saved: true, id: id });
          savingTabs.delete(tabId);
          setBadge(tabId, 'saved');
          return { ok: true, id: id, url: url, title: body.title || url, html: !!html };
        });
    });
  }).catch(function (e) {
    var err = RL.toError(e);
    if (savingTabs.has(tabId)) {
      savingTabs.delete(tabId);
      setBadge(tabId, 'error', 'Readlater: ' + err.message);
    }
    return { ok: false, error: err };
  });
}

/** Save a link (context menu) — URL only, the server fetches it. */
function saveLink(url, title, tabId) {
  return keepAlive(RL.getConfig().then(function (cfg) {
    if (!RL.isConfigured(cfg)) throw RL.apiError('config', 'Set your server URL and API key in options');
    if (!RL.isSavableUrl(url)) throw RL.apiError('unsupported', 'Only http/https links can be saved');
    var body = { url: url, source: 'extension' };
    if (title && title.trim() && title.trim() !== url) body.title = title.trim().slice(0, 500);
    return postSave(cfg, body).then(function (d) {
      lookupCacheSet(RL.cacheKey(url), { saved: true, id: String(d.id) });
      return { ok: true, id: String(d.id) };
    });
  }).catch(function (e) {
    return { ok: false, error: RL.toError(e) };
  }).then(function (res) {
    // Brief feedback on the current tab, then restore its own state.
    if (tabId != null && tabId >= 0) {
      setBadge(tabId, res.ok ? 'saved' : 'error', res.ok ? 'Link saved to Readlater' : 'Readlater: ' + res.error.message);
      scheduleBadgeRefresh(tabId, res.ok ? 2500 : 6000);
    }
    return res;
  }));
}

/** Re-POST changed tags / category / note for an already saved URL (server dedupes by URL). */
function updateSaved(msg) {
  return keepAlive(RL.getConfig().then(function (cfg) {
    if (!RL.isSavableUrl(msg.url)) throw RL.apiError('unsupported', 'Only http/https pages can be saved');
    var body = { url: msg.url, source: 'extension' };
    if (msg.tags !== undefined) body.tags = RL.normalizeTags(msg.tags);
    if (msg.category !== undefined) categoryFields(body, msg.category);
    if (msg.note !== undefined) body.note = msg.note;
    return postSave(cfg, body).then(function (d) {
      if (body.tags) RL.rememberTags(cfg, body.tags);
      return { ok: true, id: String(d.id) };
    });
  }).catch(function (e) {
    return { ok: false, error: RL.toError(e) };
  }));
}

/** Popup closed before its first save finished: apply its edits once that save succeeds. */
function updateAfterSave(msg) {
  var running = inflightSaves.get(msg.tabId);
  if (!running) return updateSaved(msg);
  return running.then(function (res) {
    return res && res.ok ? updateSaved(msg) : res;
  });
}

function openOptions() {
  return chrome.runtime.openOptionsPage();
}

function openLibrary() {
  return RL.getConfig().then(function (cfg) {
    if (!cfg.serverUrl) return openOptions();
    return chrome.tabs.create({ url: cfg.serverUrl + '/' });
  });
}

function withConfigured(fn) {
  return RL.getConfig().then(function (cfg) {
    if (!RL.isConfigured(cfg)) return openOptions();
    return fn(cfg);
  });
}

// ---------------------------------------------------------------- context menus

// Firefox for Android has neither context menus nor keyboard commands.
var hasMenus = !!(chrome.contextMenus && chrome.contextMenus.onClicked);

function createMenus() {
  if (!hasMenus) return;
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: MENU_SAVE_PAGE, title: 'Save page to Readlater', contexts: ['page', 'frame', 'selection', 'image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: MENU_SAVE_LINK, title: 'Save link to Readlater', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU_OPEN_LIBRARY, title: 'Open Readlater library', contexts: ['action'] });
  });
}

if (hasMenus) chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === MENU_OPEN_LIBRARY) return openLibrary();
  withConfigured(function () {
    if (info.menuItemId === MENU_SAVE_PAGE && tab) {
      // In a frame, still save the top-level page.
      return saveTab(tab);
    }
    if (info.menuItemId === MENU_SAVE_LINK && info.linkUrl) {
      return saveLink(info.linkUrl, info.linkText || '', tab ? tab.id : null);
    }
  });
});

// ---------------------------------------------------------------- keyboard command

if (chrome.commands && chrome.commands.onCommand) chrome.commands.onCommand.addListener(function (command, tab) {
  if (command !== 'save-page') return;
  withConfigured(function () {
    var p = tab ? Promise.resolve(tab) : chrome.tabs.query({ active: true, currentWindow: true }).then(function (t) { return t[0]; });
    return p.then(function (t) { if (t) return saveTab(t); });
  });
});

// ---------------------------------------------------------------- messages (popup / options)

var EXT_BASE = chrome.runtime.getURL(''); // chrome-extension://<id>/ or moz-extension://<uuid>/

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;
  // Only our own popup / options pages talk to the background (no content scripts).
  if (!sender || sender.id !== chrome.runtime.id || !sender.url || sender.url.indexOf(EXT_BASE) !== 0) return false;
  var p;
  if (msg.type === 'save-tab') {
    p = chrome.tabs.get(msg.tabId).then(function (tab) { return saveTab(tab, msg.extra); });
  } else if (msg.type === 'update') {
    p = updateSaved(msg);
  } else if (msg.type === 'update-after-save') {
    p = updateAfterSave(msg);
  } else if (msg.type === 'lookup') {
    p = RL.getConfig().then(function (cfg) { return RL.isConfigured(cfg) ? lookup(cfg, msg.url) : null; });
  } else if (msg.type === 'refresh-badges') {
    p = refreshActiveTabs().then(function () { return { ok: true }; });
  } else {
    return false;
  }
  p.then(sendResponse, function (e) { sendResponse({ ok: false, error: RL.toError(e) }); });
  return true; // async response
});

// The popup mirrors its not-yet-sent edits here; when it closes (port
// disconnects) they are sent, after the first save if that is still running.
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'popup') return;
  var s = port.sender;
  if (!s || s.id !== chrome.runtime.id || !s.url || s.url.indexOf(EXT_BASE) !== 0) return port.disconnect();
  var draft = null;
  port.onMessage.addListener(function (m) {
    if (m && m.type === 'draft') draft = m.update && typeof m.update.url === 'string' ? m.update : null;
  });
  port.onDisconnect.addListener(function () {
    if (draft) updateAfterSave(draft);
    draft = null;
  });
});

// ---------------------------------------------------------------- lifecycle

function refreshActiveTabs() {
  return chrome.tabs.query({ active: true }).then(function (tabs) {
    tabs.forEach(function (t) { scheduleBadgeRefresh(t.id, 0); });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  createMenus();
  if (details.reason === 'install') {
    RL.getConfig().then(function (cfg) { if (!RL.isConfigured(cfg)) openOptions(); });
  }
});

// Chrome keeps menus across restarts; rebuilding on startup is harmless and
// covers Firefox versions that don't persist event-page menus.
chrome.runtime.onStartup.addListener(createMenus);

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync' && area !== 'local') return;
  if (area === 'local' && !changes.apiKey) return; // tag/category caches also live in local
  if (changes.serverUrl || changes.apiKey) {
    lookupCacheClear();
    RL.clearCaches();
  }
  if (changes.serverUrl || changes.apiKey || changes.showBadge) {
    RL.getConfig().then(function (cfg) {
      if (!RL.isConfigured(cfg) || !cfg.showBadge) return clearAllBadges();
      return refreshActiveTabs();
    });
  }
});
