/*
 * Readlater extension — shared helpers (classic script).
 * Loaded by popup.html / options.html via <script>, by the Chrome service
 * worker via importScripts(), and by Firefox's background "scripts" list.
 * Exposes a single global: self.RL
 */
(function (root) {
  'use strict';

  var MAX_HTML_BYTES = 5 * 1024 * 1024; // server limit for `html` on POST /api/save
  var REQUEST_TIMEOUT_MS = 30000;
  var LIST_CACHE_MS = 10 * 60 * 1000; // tags / categories
  var LOOKUP_CACHE_MS = 5 * 60 * 1000; // GET /api/lookup per URL

  // serverUrl + preferences live in storage.sync (follow the user to other browsers);
  // the API key stays in storage.local so it is never uploaded to the browser's sync service.
  var DEFAULTS = { serverUrl: '', captureHtml: true, showBadge: true };

  var migrated = null;
  /** Move an API key saved by an older version from storage.sync to storage.local (once). */
  function migrateKey() {
    if (migrated) return migrated;
    migrated = chrome.storage.sync.get('apiKey').then(function (got) {
      if (!got || !got.apiKey) return;
      return chrome.storage.local.get('apiKey').then(function (loc) {
        return (loc && loc.apiKey ? Promise.resolve() : chrome.storage.local.set({ apiKey: got.apiKey })).then(function () {
          return chrome.storage.sync.remove('apiKey');
        });
      });
    }).catch(function () {});
    return migrated;
  }

  function getConfig() {
    return migrateKey().then(function () {
      return Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get({ apiKey: '' })]);
    }).then(function (r) {
      var c = r[0];
      return {
        serverUrl: c.serverUrl || '',
        apiKey: r[1].apiKey || '',
        captureHtml: c.captureHtml !== false,
        showBadge: c.showBadge !== false,
      };
    });
  }

  /** Store (or clear, with empty strings) the connection. */
  function setConnection(serverUrl, apiKey) {
    return Promise.all([
      chrome.storage.sync.set({ serverUrl: serverUrl }),
      chrome.storage.local.set({ apiKey: apiKey }),
    ]);
  }

  function isConfigured(cfg) {
    return !!(cfg && cfg.serverUrl && cfg.apiKey);
  }

  /**
   * Validate + normalise a server URL typed by the user.
   * Returns { origin, pattern } or { error }.
   * Allowed: https://anything, or http://localhost / http://127.0.0.1 (dev).
   */
  function parseServerUrl(input) {
    var s = String(input || '').trim();
    if (!s) return { error: 'Enter the address of your Readlater server.' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(s) ? 'http://' : 'https://') + s;
    }
    var u;
    try {
      u = new URL(s);
    } catch (e) {
      return { error: 'That is not a valid URL.' };
    }
    var host = u.hostname.toLowerCase();
    var dev = host === 'localhost' || host === '127.0.0.1';
    if (u.protocol === 'https:') {
      // ok
    } else if (u.protocol === 'http:' && dev) {
      // ok (local development, e.g. Firebase emulators)
    } else {
      return { error: 'The server URL must start with https:// (http:// is only allowed for localhost).' };
    }
    if (u.username || u.password) return { error: 'The server URL must not contain a user name or password.' };
    // Match patterns ignore ports, so this also covers http://localhost:5000.
    return { origin: u.origin, pattern: u.protocol + '//' + host + '/*' };
  }

  // ---------- tags ----------

  /** Normalise like the server: lowercase, trimmed, no '#', ≤ 32 chars, ≤ 30 tags, unique. */
  function normalizeTags(input) {
    var parts = Array.isArray(input) ? input : String(input || '').split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = String(parts[i]).trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, ' ').slice(0, 32).trim();
      if (t && out.indexOf(t) === -1) out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  }

  // ---------- URLs ----------

  /** Firefox reader view wraps the real URL: about:reader?url=… */
  function unwrapUrl(url) {
    if (url && url.indexOf('about:reader?') === 0) {
      try {
        return new URL(url).searchParams.get('url') || url;
      } catch (e) {
        return url;
      }
    }
    return url;
  }

  function isSavableUrl(url) {
    return /^https?:\/\//i.test(unwrapUrl(url || ''));
  }

  /** Key used for the lookup cache — drop the #fragment. */
  function cacheKey(url) {
    try {
      var u = new URL(url);
      u.hash = '';
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  // ---------- HTTP ----------

  /**
   * Plain-object error (survives runtime messaging).
   * kind: 'config' | 'auth' | 'network' | 'timeout' | 'server' | 'client' | 'unsupported'
   */
  function apiError(kind, message, status) {
    return { kind: kind, message: message, status: status || 0 };
  }

  function errorFromStatus(status, body, origin) {
    var serverMsg = body && typeof body.error === 'string' ? body.error : '';
    if (status === 401) return apiError('auth', 'Invalid API key — open options', status);
    if (status === 403) return apiError('auth', serverMsg || 'This API key is not allowed to do that — open options', status);
    if (status === 404) return apiError('client', 'Readlater API not found at ' + origin + ' — check the server URL in options', status);
    if (status === 413) return apiError('client', 'The page is too large to save', status);
    if (status === 429) return apiError('server', 'Too many requests — try again in a minute', status);
    if (status >= 500) return apiError('server', 'Server error (' + status + ')' + (serverMsg ? ': ' + serverMsg : ''), status);
    return apiError('client', serverMsg || 'Request failed (' + status + ')', status);
  }

  /**
   * Call the Readlater HTTP API. Resolves with the parsed JSON body;
   * rejects with an apiError() object.
   */
  function api(cfg, method, path, body) {
    if (!isConfigured(cfg)) {
      return Promise.reject(apiError('config', 'Set your server URL and API key in options'));
    }
    // Re-validate what is stored (https, or http only for localhost) before sending the key.
    var parsed = parseServerUrl(cfg.serverUrl);
    if (!parsed.origin) return Promise.reject(apiError('config', 'Set a valid server URL in options'));
    var origin = parsed.origin;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var init = {
      method: method,
      headers: { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      // Never follow redirects: a redirect to another origin (or to http://) could
      // otherwise carry the request — and in older browsers the key — elsewhere.
      redirect: 'manual',
      signal: ctrl ? ctrl.signal : undefined,
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(origin + path, init).then(
      function (res) {
        if (timer) clearTimeout(timer);
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
          throw apiError('client', origin + ' redirected the request — enter the exact server address in options (e.g. with or without www)');
        }
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            data = null;
          }
          if (!res.ok) throw errorFromStatus(res.status, data, origin);
          if (data === null) throw apiError('client', 'Unexpected response from ' + origin + ' — is this a Readlater server?', res.status);
          return data;
        });
      },
      function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw apiError('timeout', 'The server took too long to respond — try again');
        }
        throw apiError('network', "Can't reach " + hostOf(origin) + ' — check your connection and the server URL');
      }
    );
  }

  /** Normalise anything thrown into an apiError-shaped object. */
  function toError(e) {
    if (e && typeof e === 'object' && e.kind && e.message) return e;
    return apiError('client', (e && e.message) || String(e || 'Something went wrong'));
  }

  // ---------- cached lists (tags / categories) ----------

  function cachedList(cfg, key, path, pick, force) {
    var storeKey = 'cache:' + key;
    return chrome.storage.local.get(storeKey).then(function (got) {
      var c = got[storeKey];
      if (!force && c && c.server === cfg.serverUrl && Date.now() - c.at < LIST_CACHE_MS) return c.value;
      return api(cfg, 'GET', path).then(function (data) {
        var value = pick(data);
        var put = {};
        put[storeKey] = { at: Date.now(), server: cfg.serverUrl, value: value };
        return chrome.storage.local.set(put).then(function () { return value; });
      });
    });
  }

  function getTags(cfg, force) {
    return cachedList(cfg, 'tags', '/api/tags', function (d) {
      return Array.isArray(d && d.tags) ? d.tags.filter(function (t) { return typeof t === 'string'; }) : [];
    }, force);
  }

  function getCategories(cfg, force) {
    return cachedList(cfg, 'categories', '/api/categories', function (d) {
      var list = Array.isArray(d && d.categories) ? d.categories : [];
      return list
        .filter(function (c) { return c && typeof c.id === 'string'; })
        .map(function (c) { return { id: c.id, name: String(c.name || c.id) }; });
    }, force);
  }

  function clearCaches() {
    return chrome.storage.local.remove(['cache:tags', 'cache:categories']);
  }

  /** Remember tags the user just used so they show up as suggestions before the 10-min refresh. */
  function rememberTags(cfg, tags) {
    if (!tags || !tags.length) return Promise.resolve();
    return chrome.storage.local.get('cache:tags').then(function (got) {
      var c = got['cache:tags'];
      if (!c || c.server !== cfg.serverUrl) return;
      var merged = tags.concat(c.value.filter(function (t) { return tags.indexOf(t) === -1; }));
      return chrome.storage.local.set({ 'cache:tags': { at: c.at, server: c.server, value: merged } });
    });
  }

  root.RL = {
    MAX_HTML_BYTES: MAX_HTML_BYTES,
    LOOKUP_CACHE_MS: LOOKUP_CACHE_MS,
    DEFAULTS: DEFAULTS,
    getConfig: getConfig,
    setConnection: setConnection,
    isConfigured: isConfigured,
    parseServerUrl: parseServerUrl,
    normalizeTags: normalizeTags,
    unwrapUrl: unwrapUrl,
    isSavableUrl: isSavableUrl,
    cacheKey: cacheKey,
    hostOf: hostOf,
    api: api,
    apiError: apiError,
    toError: toError,
    getTags: getTags,
    getCategories: getCategories,
    clearCaches: clearCaches,
    rememberTags: rememberTags,
  };
})(typeof self !== 'undefined' ? self : this);
