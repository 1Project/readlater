# Readlater browser extension

Manifest V3 extension for Chrome, Edge and Firefox. Plain JS/HTML/CSS: no framework, no bundler, no dependencies.

## What it does

- **Toolbar button** (default <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) saves the current tab right away **with the rendered page HTML**, so pages behind a login or paywall are saved as you see them. The popup then lets you add **tags** (comma separated, suggestions from your library; <kbd>Tab</kbd> completes the top suggestion, <kbd>Enter</kbd> saves exactly what you typed), pick a **category** and add a **note**. A change is sent when you commit it (Enter, leaving the field, picking a suggestion, changing the category, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the note). Anything still unsent when the popup closes is sent by the background, after the first save if that is still running.
- **Silent save** (default <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>) saves without opening the popup. The badge shows the result.
- **Context menus**: *Save page to Readlater* (right-click a page) and *Save link to Readlater* (right-click a link; the server fetches that link). The menu on the toolbar button also has *Open Readlater library*.
- **Badge**: a ✓ shows on tabs whose URL is already in your library. The extension checks with `GET /api/lookup`, at most once per URL every 5 minutes. A `…` badge means a save is in progress, and `!` means the save failed (hover to see why).
- If the extension isn't configured yet, clicking it opens the options page. The options page also opens on first install.

## Install

### Chrome / Edge (unpacked, for development)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select this `extension/` folder.
3. Pin the extension. Its options page opens on its own. You can also open it with right-click on the icon → **Options**.

### Firefox

- Temporary install (development): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select `extension/manifest.json`. Firefox removes it when it restarts.
- Permanent install: run `./build.sh` and upload `dist/readlater-extension-firefox.zip` to [addons.mozilla.org](https://addons.mozilla.org/developers/). You can list it on AMO, or choose *On your own* to get a signed `.xpi` to self-host. The add-on id is `readlater@readlater.app`. Firefox 140 (ESR) or newer is required (140 is the first version that understands `data_collection_permissions`, which AMO requires).

### Store packages

```sh
./build.sh
# dist/readlater-extension.zip          → Chrome Web Store / Microsoft Edge Add-ons
# dist/readlater-extension-firefox.zip  → addons.mozilla.org
```

The unpacked folder has a single manifest with both `background.service_worker` (Chrome/Edge) and `background.scripts` (Firefox). Chrome 121+ and Firefox 121+ accept both keys (the manifest asks for Firefox 140+). `build.sh` writes a clean manifest for each store: the Chrome zip has only `service_worker` and no `browser_specific_settings`, and the Firefox zip has only `scripts`. The script also validates the manifest and runs `node --check` on every script.

## Configure

1. **Server URL**: the address you open Readlater at, e.g. `https://your-project.web.app`. Only `https://` is accepted, except `http://localhost` / `http://127.0.0.1` for the emulators. The extension keeps only the origin.
2. **API key**: click **Create an API key**. This opens `{server}/settings#extension`, where you create a key (`rl_…`) and paste it here.
3. Click **Save**. The browser asks for permission to access your server's origin. The extension requests it at this point, which is why the manifest only lists `optional_host_permissions`. If you decline, it still works through the server's CORS headers. The extension then runs **Test connection** (`GET /api/tags`).

The server URL and preferences are stored in `chrome.storage.sync`. The API key is stored only in `chrome.storage.local`, so it is never uploaded to the browser's sync service (on a new computer you paste the key once). Keys saved by older versions are moved there automatically. When you switch servers or disconnect, the extension gives back its access to the old server's origin.

Preferences:

- **Send the rendered page** (on by default). Turn it off to send only the URL, and the server fetches the page itself.
- **Show ✓ on pages you already saved** (on by default). Turn it off and the extension stops sending the URLs you visit to your server.

To change the keyboard shortcuts, go to `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`). In Firefox use about:addons → ⚙ → *Manage Extension Shortcuts*.

## How it talks to the server

All requests send `Authorization: Bearer <apiKey>` and expect JSON. CORS is `*` on the server. Requests go only to the configured origin (re-validated before every request), and redirects are never followed, so the key can't be carried to another host; if the server redirects (for example `example.com` → `www.example.com`), options shows an error asking for the exact address.

| request | used for |
|---|---|
| `POST /api/save` `{url, title?, html?, tags?, category?, categoryId?, note?, source:'extension'}` → `{ok, id}` | saving. `html` is the rendered page (≤ 5 MB) with scripts and styles stripped and JSON-LD kept. Changes made in the popup re-POST `{url, tags, category?, note?}`, and the server dedupes by URL and merges tags. `category` (and the alias `categoryId`) is a category **id**, or `null` to clear it. If the server answers 413, the extension retries without `html`. |
| `GET /api/lookup?url=` (URL without `#fragment`) → `{saved, id?, status?, location?}` | the ✓ badge. Never sent for tabs in private/incognito windows or for pages on the Readlater site itself. |
| `GET /api/tags` → `{tags: string[]}` | tag suggestions (cached 10 min) and Test connection |
| `GET /api/categories` → `{categories: {id, name}[]}` | category select (cached 10 min) |

"Open in Readlater" opens `{server}/item/{id}`, and "Open library" opens `{server}/`.

The extension skips HTML capture and sends just the URL for `chrome://`/`about:`/`file://` pages, for URLs ending in `.pdf`/`.epub` (the server downloads the file), for non-HTML documents (for example the built-in PDF viewer), for pages over 5 MB, and when script injection isn't allowed. Firefox Reader View (`about:reader?url=…`) saves the original URL.

## Files

```
manifest.json   MV3 manifest (Chrome + Firefox)
lib.js          shared helpers: config, URL validation, API client, error messages, cached lists
background.js   service worker / event page: saving, page capture, badge + lookup cache, context menus, commands
popup.html/js/css    toolbar popup (320 px, light/dark)
options.html/js/css  options page
ui.css          shared design tokens and primitives
icons/          16/32/48/128 PNG, rendered from web/public/icon.svg
build.sh        packages dist/*.zip
```

## Permissions

- `activeTab` + `scripting`: read the rendered HTML of the tab you are saving. This only happens when you click the button, use the shortcut or use the context menu. Password fields and hidden form inputs (CSRF tokens) are removed from the captured HTML, and the HTML is dropped if the tab navigated away during the save.
- `tabs`: read the current tab's URL for the ✓ badge.
- `contextMenus`, `storage`.
- Optional host permission for **your server's origin only**, requested on Save.
