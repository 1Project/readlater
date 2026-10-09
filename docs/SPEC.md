# Readlater — implementation spec

This is the contract every part of the codebase follows. If you change a
contract here, update this file.

Product: a minimal read-it-later app (inspired by Readwise Reader) — save
articles, X posts, papers, PDFs and EPUBs; subscribe to RSS feeds; read in a
clean reader with highlights; organise with categories and tags; full-text
search. Web (PWA) + Android + iOS (Capacitor). Must work well on a black &
white e-ink Android reader (Boox Go 6: 6", 1072x1448, Android 13): high
contrast, no animations, paginated reading, large tap targets, volume-key page
turns.

Hosting: Firebase (Hosting, Auth, Firestore, Cloud Functions gen2 Node 22,
Cloud Storage). Region `us-central1`. Default emulator project id
`demo-readlater`.

## Repo layout

```
firebase.json  .firebaserc  firestore.rules  firestore.indexes.json  storage.rules
functions/            Cloud Functions (TypeScript, built with tsc to lib/)
  src/index.ts        exports every function (names below)
  src/extract/*       URL → content extraction (article, tweet, paper, pdf, epub)
  src/...             feeds, auth codes, api keys, search, storage helpers
  test/*              vitest unit tests (fixtures in test/fixtures)
web/                  Vite + React 19 + TypeScript SPA, also the Capacitor app
  src/lib/*           shared core (firebase init, types, data access, prefs) — owned by core
  src/pages/*         route pages
  src/components/*    shared UI components
  src/reader/*        reader (article HTML, PDF viewer, pagination, highlights)
  src/native.ts       Capacitor integration (share intent, deep links, volume keys)
  android/ ios/       Capacitor native projects
e2e/                  Playwright tests running against the Firebase emulators
scripts/              setup.sh (one-time GCP/Firebase setup + deploy), deploy.sh, emulators helpers
.github/workflows/    ci.yml (test + build APK + iOS sim build), deploy.yml
```

## Firestore data model

All user data lives under `users/{uid}`. Timestamps are Firestore `Timestamp`
(serverTimestamp on write).

### `users/{uid}/items/{itemId}` — one saved thing

| field | type | notes |
|---|---|---|
| url | string \| null | canonical/original URL; null for uploads |
| type | `'article' \| 'tweet' \| 'paper' \| 'pdf' \| 'epub' \| 'video' \| 'other'` | client guesses on create, server corrects |
| location | `'library' \| 'feed'` | feed items live in the Feed until "saved to library" |
| status | `'unread' \| 'archived'` | library: unread = reading list; feed: unread = new, archived = seen/dismissed |
| favorite | boolean | |
| title | string | client sets a placeholder (URL hostname / file name); server overwrites if `titleLocked` is false |
| titleLocked | boolean | true once the user edits the title by hand |
| author | string \| null | |
| siteName | string \| null | |
| excerpt | string \| null | ≤ 400 chars plain text |
| imageUrl | string \| null | lead image |
| publishedAt | Timestamp \| null | |
| wordCount | number \| null | |
| readingMinutes | number \| null | ceil(wordCount / 230) |
| categoryId | string \| null | id in `categories` |
| tags | string[] | lowercase, trimmed, no `#`, max 32 chars each, max 30 tags |
| note | string | free text note on the document |
| progress | number | 0..1 reading position |
| fetchStatus | `'uploading' \| 'pending' \| 'processing' \| 'done' \| 'error'` | |
| fetchError | string \| null | human-readable |
| contentChunks | number | number of `content/{n}` docs (0 = no content) |
| file | `{ path: string, name: string, contentType: string, size: number } \| null` | Storage object for pdf/epub (uploaded or downloaded) |
| feedId | string \| null | |
| paper | `{ arxivId?: string, doi?: string, authors?: string[], venue?: string, year?: number, pdfUrl?: string, abstract?: string } \| null` | |
| createdAt, updatedAt | Timestamp | |
| lastOpenedAt | Timestamp \| null | |
| archivedAt | Timestamp \| null | |

Client-writable fields: everything except `contentChunks`, `fetchError`,
`file` (client may set `file` only while `fetchStatus == 'uploading'` or when
creating), `paper`. The server (Admin SDK) bypasses rules.

### `users/{uid}/items/{itemId}/content/{n}` — server-written

`{ index: number, html: string }` — sanitized HTML of the readable content, split
into chunks ≤ 800 KB so a single doc stays under Firestore's 1 MB limit. Read
in order `0..contentChunks-1` and concatenated. Allowed HTML: p, h1–h6, a(href),
img(src, alt), figure, figcaption, blockquote, pre, code, ul, ol, li, em, strong,
b, i, u, s, sub, sup, br, hr, table/thead/tbody/tr/th/td, span, div, section,
article, aside, details, summary, math-ish (`math` passes through), `mark`. No
scripts, styles, event handlers, iframes. Links absolute. Images absolute URLs.
For tweets the HTML is a simple blockquote-like structure with author, text,
images and quoted tweet. For papers: abstract + full text when available.
For PDFs: extracted text as `<p>` per paragraph with `<h2 data-page="N">Page N</h2>` markers (the reader can also render the original PDF from `file`).
For EPUBs: chapters concatenated, each chapter wrapped in `<section data-chapter="N">` with an `<h1>` title; book images rewritten to Storage download URLs.

### `users/{uid}/highlights/{highlightId}`

`{ itemId, text, note, prefix, suffix, createdAt, updatedAt }` — `text` is the
highlighted plain text; `prefix`/`suffix` are up to 32 chars of surrounding text
used to re-anchor the highlight on render (text-quote selector).

### `users/{uid}/categories/{categoryId}`

`{ name: string, order: number, createdAt }`.

### `users/{uid}/feeds/{feedId}`

`{ url (the feed XML url), title, siteUrl, categoryId: string|null, tags: string[], fullText: boolean, lastFetchedAt, lastError: string|null, createdAt, etag?: string, lastModified?: string }`.
Created by callable `addFeed` (client may update title/categoryId/tags/fullText, and delete).
Feed items are written by the server as items with `location:'feed'`,
`feedId`, id = `f_` + first 24 hex of sha1(feedId + '|' + (guid || link)).
Only entries newer than the last 30 days (or the latest 20 on first fetch) are added.

### `users/{uid}/search/{itemId}` — server-written search index

`{ kw: string[] }` — unique normalized terms (lowercase, NFKD-stripped
diacritics, length 2..32, stopwords removed) from title, author, siteName,
tags, note, and content text; max 4000 terms. Queried server-side by the
`search` callable only.

### `users/{uid}/apiKeys/{keyId}` — mirror for listing

`{ name, prefix (first 6 chars of key), createdAt, lastUsedAt }` — keyId is the
sha256 hex of the key. Server-written only (clients may read and delete via callable).

### Top-level (server-only, rules deny all client access)

- `loginCodes/{sha256(code)}` — `{ uid, expiresAt, used: boolean, createdAt }`.
- `apiKeys/{sha256(key)}` — `{ uid, name, createdAt }`.
- `rateLimits/{bucket}` — `{ count, windowStart }`.

## Cloud Storage layout

- `users/{uid}/uploads/{itemId}/{fileName}` — user uploads (pdf/epub, ≤ 100 MB), client-writable by owner.
- `users/{uid}/files/{itemId}/...` — server-written derived files (downloaded PDFs, EPUB images). Owner can read.

## Cloud Functions (all `us-central1`, names exact)

Callables (firebase-functions v2 `onCall`), all except `redeemLoginCode` require auth:

| name | request | response |
|---|---|---|
| `createLoginCode` | `{}` | `{ code: string, expiresAt: number(ms) }` — 8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, valid 10 min, single use |
| `redeemLoginCode` | `{ code: string }` | `{ token: string }` custom auth token; codes compared case-insensitively, spaces/dashes ignored; rate limited per IP |
| `createApiKey` | `{ name: string }` | `{ id: string, key: string }` key = `rl_` + 40 random base62 chars, shown once |
| `revokeApiKey` | `{ id: string }` | `{ ok: true }` |
| `search` | `{ q: string, limit?: number }` | `{ ids: string[] }` item ids whose index contains ALL terms (prefix match not required) |
| `addFeed` | `{ url: string, categoryId?: string\|null, tags?: string[] }` | `{ id: string, title: string, added: number }` — discovers feed from HTML pages (`<link rel=alternate>`), validates, fetches entries |
| `refreshFeeds` | `{ feedId?: string }` | `{ added: number }` |
| `importOpml` | `{ opml: string }` | `{ feeds: number, failed: string[] }` |
| `saveUrl` | `{ url: string, tags?: string[], categoryId?: string\|null, title?: string }` | `{ id: string }` server-side create (used by share flows when convenient) |

Triggers / others:

- `processItem` — `onDocumentWritten('users/{uid}/items/{itemId}')`. Runs when
  after.fetchStatus == 'pending' and (no before or before.fetchStatus != 'pending').
  Sets `processing`, extracts (from `file` if present, else `url`), writes content
  chunks, metadata, search index, sets `done`/`error`. Also re-indexes search
  when title/tags/note change on a `done` item (cheap: metadata only + existing content text).
  Timeout 300 s, memory 1 GiB.
- `cleanupItem` — `onDocumentDeleted('users/{uid}/items/{itemId}')`: delete content
  subcollection, search doc, highlights for the item, storage under uploads/{itemId} and files/{itemId}.
- `pollFeeds` — `onSchedule('every 60 minutes')`: refresh all feeds (collection group `feeds`), bounded concurrency.
- `api` — `onRequest` HTTP, served at `/api/**` via Hosting rewrite:
  - `POST /api/save` JSON `{url, title?, tags?, category?}` or form/text body; `GET /api/save?url=..&key=..`
  - Auth: `Authorization: Bearer <apiKey>` or `?key=`.
  - Responds `{ ok: true, id }` (JSON) or, for GET with `Accept: text/html`, a tiny "Saved ✓" HTML page.
  - CORS: allow all origins (key-based auth, no cookies).

Extraction rules (functions/src/extract):

- X/Twitter (`x.com`, `twitter.com`, `mobile.twitter.com`, `fxtwitter.com`, `vxtwitter.com` `/…/status/{id}`):
  use `https://api.fxtwitter.com/status/{id}` (JSON) → text, author, media,
  quote; fallback `https://publish.twitter.com/oembed?url=…`. type `tweet`,
  title = `@handle: first 80 chars`. If the post is an X "article", include its text.
- arXiv (`arxiv.org/abs|pdf|html/{id}`): metadata from `https://export.arxiv.org/api/query?id_list={id}`;
  content from `https://arxiv.org/html/{id}` (readability) when it exists, else the PDF text; type `paper`.
- DOI (`doi.org/…` or bare `10.xxxx/…`): Crossref `https://api.crossref.org/works/{doi}` metadata, then try readability on the resolved landing page; type `paper`.
- PDF (content-type application/pdf or `.pdf`): download (≤ 50 MB) to `users/{uid}/files/{itemId}/original.pdf`, set `file`, extract text with `unpdf`; type `pdf` (or `paper` if it looks academic: has "Abstract" + "References").
- EPUB (uploads): unzip, parse OPF spine, sanitize chapters, upload images to Storage, metadata from OPF (title, creator); type `epub`.
- YouTube/Vimeo: oEmbed metadata, type `video`, content = description if available + thumbnail.
- Generic: fetch HTML (UA of a desktop browser, 15 s timeout, ≤ 10 MB, follow redirects), `@mozilla/readability` on `jsdom`, sanitize with DOMPurify, absolutize URLs, lazy-image fixups (`data-src`), metadata from OpenGraph/JSON-LD.
- Outbound fetch honours `HTTPS_PROXY` (undici `EnvHttpProxyAgent`) when the env var is set.

## Web app

Stack: Vite, React 19, react-router (data-less `BrowserRouter`), plain CSS with
custom properties (no CSS framework), Firebase JS SDK v13 modular,
DOMPurify, pdfjs-dist, qrcode. PWA via vite-plugin-pwa with share_target.

### Routes

| path | page |
|---|---|
| `/` | Library list. Query params: `view=unread\|archive\|favorites\|all` (default unread), `cat`, `tag`, `type`, `sort=new\|old\|short\|long` |
| `/feed` | Feed list (view=new\|seen), header link to manage feeds |
| `/feeds` | Manage feeds: add by URL, list, edit category/tags/fullText, delete, refresh, OPML import/export |
| `/search?q=` | Search across everything (metadata instant client-side + full-text via `search` callable) |
| `/highlights` | All highlights grouped by item, export Markdown |
| `/item/:id` | Reader |
| `/settings` | Appearance (theme, reader typography), categories, tags, link a device (code + QR), API keys + bookmarklet + iOS Shortcut instructions, import (URL list / Pocket-Instapaper CSV / OPML), export JSON, sign out |
| `/login` | Google sign-in + "Enter code from another device" |
| `/link?code=` | Auto-redeem code (target of QR) |
| `/app-login?return=readlater://login` | used by the native app's "Sign in with Google": sign in, create code, redirect to `return` with `?code=` |
| `/add?url=&title=&text=` | share target / bookmarklet landing: saves, then shows the item |

Unauthenticated users are redirected to `/login` (except `/login`, `/link`, `/app-login`).

### Look & feel

Minimal, typographic, monochrome with one accent. Themes: `system`, `light`,
`dark`, `eink` (pure #000 on #fff, no greys under #555 for text, no shadows,
no transitions/animations, borders instead of fills, bigger tap targets,
paginated reader by default). Theme applied via `data-theme` on `<html>`;
`prefers-reduced-motion` respected. Layout: a top bar (app name, nav: Library ·
Feed · Search · Highlights · Settings, and a "+ Add" button), content column
max 760px. Must look good at 360px width. No modals that rely on hover.

### Reader

- Typography prefs (per device, localStorage): font family (serif/sans/mono), size (14–28px), line height, width, justify.
- Modes: scroll or paginated (CSS multi-column pages; tap left third = previous, right third = next, middle = toggle toolbar; keys ←/→/PageUp/PageDown/Space; `hwpage` window event from native volume keys `{detail:{dir:1|-1}}`).
- Progress saved (debounced 2 s) to `progress`, restored on open.
- Toolbar: back, archive/unarchive, favorite, tags & category editor, note, open original, font settings, more (refetch, delete, save-to-library for feed items).
- Highlights: select text → "Highlight" button (+ optional note); stored per spec; re-applied with `<mark data-hid>` by text-quote matching; tap a mark to edit note/delete.
- PDF items: toggle between "Text" (extracted content) and "Original" (pdf.js canvas, one page at a time, fit width, prev/next).
- EPUB items: render the content HTML with a chapter list (from `section[data-chapter] > h1`).
- Opening an item sets `lastOpenedAt`; feed items opened are marked `status:'archived'` (seen) only when the user taps "mark seen"/next — not automatically.

### Keyboard shortcuts (desktop)

List: `j/k` move, `Enter`/`o` open, `e` archive, `s` favorite, `/` search, `a` add.
Reader: `e` archive, `s` favorite, `h` highlight selection, `Esc` back.

## Native (Capacitor 8)

- App id `app.readlater.reader`, name `Readlater`, webDir `dist`, URL scheme `readlater`.
- Android: intent filters for `ACTION_SEND` text/plain (share a link) and
  `application/pdf`, `application/epub+zip` (share/open a file); deep link
  `readlater://login?code=…`; volume up/down → `window.dispatchEvent(new CustomEvent('hwpage',{detail:{dir}}))`
  only while `window.__readerActive === true` (otherwise default volume behaviour);
  e-ink friendly: no splash animation.
- iOS: URL scheme `readlater`; sharing via the iOS Shortcut + API key documented in Settings.
- `src/native.ts` exports `initNative(navigate: (path: string) => void): void` and
  `isNative(): boolean`, `openExternal(url)`, and `nativeGoogleSignIn(): Promise<void>`
  (opens `${PUBLIC_URL}/app-login?return=readlater://login` in the system browser).
  Shared text/URLs navigate to `/add?url=…`; shared files call `uploadFile()` from `lib/data.ts`.

## Config

Web reads Firebase config from `import.meta.env.VITE_FIREBASE_CONFIG` (JSON
string) or, if absent, from `/__/firebase/init.json` (served automatically by
Firebase Hosting). `VITE_PUBLIC_URL` = public origin of the hosted app (used
by native for the Google sign-in hand-off and by the bookmarklet/shortcut
docs; defaults to `window.location.origin` on web). `VITE_USE_EMULATORS=1`
connects to local emulators (ports from firebase.json).

## Shared modules already written (build on them, don't rewrite)

- `functions/src/admin.ts` — `db`, `bucket()`, `adminAuth()`, `REGION`.
- `functions/src/http.ts` — `fetchBuffer/fetchText/fetchJson` (proxy-aware, timeouts, size caps, SSRF guard), `decodeBody`, `FetchError`, `BROWSER_UA`.
- `functions/src/content.ts` — `chunkHtml`, `writeContent(itemRef, html) → chunks`, `readContent(itemRef)`.
- `functions/src/searchIndex.ts` — `tokenize`, `buildKeywords({meta, body})`, `queryTerms`, `htmlToPlainText`.
- `functions/src/extract/types.ts` — `Extracted`, `PaperMeta`, `UploadImage`.
- `web/src/lib/firebase.ts`, `web/src/lib/data.ts` (all data access + hooks), `web/src/lib/types.ts`, `web/src/lib/prefs.ts` (per-device prefs, themes), `web/src/styles.css` (themes + primitives), `web/src/main.tsx`.

### Extraction module contract (`functions/src/extract/index.ts`)

```ts
export function extractUrl(url: string): Promise<Extracted>;           // dispatches tweet / arxiv / doi / pdf / video / generic
export function extractPdf(buf: Buffer, opts: { url?: string; name?: string }): Promise<Extracted>;
export function extractEpub(buf: Buffer, opts: { uploadImage: UploadImage }): Promise<Extracted>;
export function sanitizeHtml(html: string, baseUrl?: string): string;  // DOMPurify allow-list per spec, absolutizes URLs
export function htmlToText(html: string): string;
export function makeExcerpt(text: string): string;                     // ≤ 400 chars, word boundary
```
Errors are thrown as `Error` with a short human-readable message (shown to the user).

### Feeds module contract (`functions/src/feeds/index.ts`)

Exports the deployed function objects `addFeed`, `refreshFeeds`, `importOpml`, `pollFeeds`
plus pure helpers `parseFeed(xmlOrJson: string, baseUrl: string): ParsedFeed`, `discoverFeedUrls(html: string, baseUrl: string): string[]`, `parseOpml(opml: string): {title, xmlUrl, htmlUrl}[]`.
Feed items: content = sanitized entry HTML (`content:encoded` / atom content / summary) via `writeContent`, `fetchStatus:'done'` —
or, when the feed has `fullText: true`, `fetchStatus:'pending'` so `processItem` extracts the full page.
Feed items also get a search index doc (use `buildKeywords`). Feed `tags`/`categoryId` are copied onto new items.

### Function index (`functions/src/index.ts`)

Re-exports every deployed function: `processItem, cleanupItem, createLoginCode, redeemLoginCode, createApiKey, revokeApiKey, search, saveUrl, api` (core) and `addFeed, refreshFeeds, importOpml, pollFeeds` (from `./feeds`).

## CSS conventions (web)

Variables: `--bg --fg --muted --faint --border --surface --hover --accent --accent-fg --mark --mark-fg --danger --ok --radius --tap --font-ui --font-serif --font-sans --font-mono --page-width --transition`.
Primitives in `styles.css`: `.page .stack .row .spacer .muted .small .truncate .btn .btn-primary .btn-ghost .btn-danger .btn-icon .btn.active .input .select .textarea .chip .chip.active .card .section-title .dialog-backdrop .dialog .toast .empty .error-text`.
Theme on `<html data-theme="system|light|dark|eink" data-scheme="light|dark">`. Feature CSS goes into its own file next to the feature
(e.g. `src/reader/reader.css`, `src/pages/settings.css`) and is imported by that feature's TSX. Never use colour literals in feature CSS — use variables,
so the e-ink theme stays pure black/white. Icons: inline SVG or plain text/Unicode, no icon fonts.

### Web module ownership & fixed paths

- `src/App.tsx` (routes, auth gate, top bar, global keyboard shortcuts, calls `initNative(navigate)` from `src/native.ts`).
- Page default exports: `src/pages/Library.tsx`, `Feed.tsx`, `Feeds.tsx`, `Search.tsx`, `Highlights.tsx`, `Settings.tsx`, `Login.tsx`, `Link.tsx`, `AppLogin.tsx`, `Add.tsx`; reader `src/reader/Reader.tsx`.
- Shared components in `src/components/` (e.g. `ItemList`, `ItemRow`, `TagInput`, `CategorySelect`, `AddDialog`, `Dialog`, `Toast`/`useToast`, `TopBar`).
  Exported names/props of these are documented in a comment at the top of each file.
