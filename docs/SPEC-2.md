# Readlater — wave 2 spec (integrations + "everything a modern read-it-later app has")

Extends docs/SPEC.md (which stays binding). Benchmarks: Readwise Reader, Omnivore,
Matter, Instapaper, Pocket. Keep the UI minimal: new features live behind the
reader toolbar, Settings sections, or small pages — no clutter on the list.

## 1. Ways to save (ingest)

| channel | how |
|---|---|
| Web/PWA | "+ Add" (URL, paste, PDF/EPUB upload, drag & drop) — wave 1 |
| Android/Boox app | share sheet (links, PDFs, EPUBs) — wave 1 |
| iOS | Shortcut + API key — wave 1 |
| **Chrome/Edge/Firefox extension** | `/extension` (Manifest V3). Toolbar button saves the current tab **including the rendered page HTML** (captures paywalled / logged-in pages), popup to add tags + category, context menus "Save page", "Save link", keyboard shortcut Alt+Shift+S, badge ✓ when the current URL is already saved. Auth: server URL + API key in the options page ("Create key" link opens `${PUBLIC_URL}/settings#extension`). |
| **Bookmarklets** (no extension) | Settings shows two draggable bookmarklets: (a) "Save to Readlater" — opens a small popup window to `GET /api/save?key=…&url=…&title=…` which saves and auto-closes (works on CSP-strict sites because it is `window.open`, no injected script); a key named "Bookmarklet" with scope `save` is created on demand (the page it runs on can read it, so it cannot read the library); (b) "Open in Readlater" — navigates to `/add?url=` (uses the web session, no key; /add asks before saving). |
| **Telegram bot** | send/forward any message with links (or a PDF/EPUB file) to the bot → saved. `#hashtags` in the message become tags. Commands `/start <linkToken>`, `/help`, `/latest` (5 newest unread with links), `/unlink`. Plain text without a link is saved as a "note" document (type `other`, content = message text). Replies "✓ Saved: <title>" (edits the reply with the real title once processed if available within ~20 s, else just "✓ Saved"). `/start` replies with the account the chat is now connected to. Editing a message updates a note, but never saves its links again. |
| **Email newsletters** | each user gets an address `<token>@<INBOUND_EMAIL_DOMAIN>`; inbound webhook `inboundEmail` accepts Mailgun routes (multipart), SendGrid Inbound Parse (multipart), and a JSON body from the provided Cloudflare Email Worker (`integrations/cloudflare-email-worker/`). Emails become items with `location:'feed'`, `type:'article'`, `siteName` = sender name, content = sanitized HTML body. Forwarding a single link-only email saves that link instead. |
| HTTP API | wave 1 `/api/save` + new endpoints below |

### HTTP API additions (`api` function)

- `POST /api/save` accepts optional `html` (string ≤ 5 MB, the rendered page) — server stores it at `users/{uid}/uploads/{itemId}/page.html` and sets `file: {path, name:'page.html', contentType:'text/html', size}`; `processItem` then runs the generic extractor on that HTML with `url` as base (no network fetch of the page; still fetches nothing else). Also accepts `note`, `location` ('library'|'feed').
- `GET /api/lookup?url=` → `{ saved: boolean, id?, status?, location? }`.
- `GET /api/tags` → `{ tags: string[] }` (most used first); `GET /api/categories` → `{ categories: {id,name}[] }`.
- `GET /api/items?status=unread&limit=20` → minimal list `{items:[{id,title,url,createdAt}]}`.
All key-authenticated, CORS `*`. Keys with scope `save` (createApiKey `{ name, scope: 'save' }`) get 403 on the read endpoints.

## 2. Organisation

- **Bulk actions**: list "Select" mode (checkboxes, select all visible) → Archive / Unarchive / Favorite / Add tag / Set category / Move to library / Delete.
- **Saved views**: `users/{uid}/views/{id}` `{ name, params (the Library/Search query string), order, createdAt }`; shown as extra tabs/chips on Library ("Views"), managed in Settings. Owner CRUD.
- **Auto rules**: `users/{uid}/rules/{id}` `{ name, enabled, match: { field: 'domain'|'url'|'title'|'feed'|'type'|'source', op: 'is'|'contains'|'endsWith', value }, actions: { addTags?: string[], categoryId?: string|null, location?: 'library'|'feed', favorite?: boolean, archive?: boolean }, createdAt }`. Applied server-side once, when an item is first processed (processItem, feed poller, telegram, email, api). Item gets `rulesApplied: true`. Owner CRUD.
- `source` field on items (new, optional, server or client set): `'web'|'app'|'extension'|'bookmarklet'|'api'|'telegram'|'email'|'feed'|'import'`.

## 3. Reading

- **Text-to-speech** ("Listen"): reader toolbar button → player bar (play/pause, back/forward paragraph, speed 0.75–2×, voice); highlights the current paragraph; continues across paragraphs; resumes from the visible paragraph. Web: Web Speech API. Android/iOS app: `@capacitor-community/text-to-speech` (or the current Capacitor-8-compatible equivalent).
- **Auto-archive at end** (setting, default off) and "Next unread" button at the end of every article.
- **Sepia theme** (in addition to system/light/dark/eink) and fonts: bundled **Literata** (e-book serif) and **Atkinson Hyperlegible** (via @fontsource, woff2, latin subset) next to system serif/sans/mono.
- **Highlight colours**: `color: 'yellow'|'green'|'blue'|'pink'` (default yellow) on highlights; in the eink theme colours map to underline styles (solid / double / dotted / wavy).
- **Wayback fallback**: if a page fetch fails (4xx/5xx/blocked) or extracted text < 200 words while the page looks paywalled, try the latest snapshot from `https://archive.org/wayback/available?url=` and note "Loaded from the Internet Archive" at the top of the content.
- **YouTube**: fetch the transcript (timedtext / caption tracks from the watch page's `ytInitialPlayerResponse`) and render it as paragraphs with timestamps linking to the video; fall back to description.
- **X threads**: when the post is part of a self-thread by the same author (fxtwitter `conversation`/replies if available), include the thread; otherwise single post.

## 4. Highlights & knowledge

- **Daily review** page `/review`: 5 random highlights per day (seeded by date), each with its document title, "Open in document" (`/item/:id?hl=<highlightId>`, which opens the reader at the highlight), and keyboard/tap next. Linked from Highlights, whose quotes link the same way. Highlights and the review show each highlight's colour (e-ink: border styles).
- Export highlights: Markdown (wave 1), plus per-document "Copy as Markdown" (Obsidian-friendly: front-matter with title/url/author/tags, `> highlight` blocks with notes) from the reader's highlights panel.

## 5. AI (optional — enabled when the `ANTHROPIC_API_KEY` secret is set)

Callable `ai({ itemId, action: 'summarize'|'ask'|'suggestTags', question? })`:
- `summarize` → `{ summary }` (5–8 bullet key points + one-line TL;DR), cached on the item as `aiSummary: { text, createdAt }`.
- `ask` → `{ answer }` grounded only in the document text (quote the relevant passage).
- `suggestTags` → `{ tags: string[] }` from the user's existing tags preferred.
Uses the Anthropic Messages API (see the claude-api skill for current model ids and SDK usage). Rate limit 100 calls/day/user. Long documents truncated to a sane token budget.
Reader: "Summary" and "Ask" in the toolbar's More menu / a side panel; hidden when AI is disabled.

## 6. Sharing & export

- **Public share link**: reader More → "Share public link" → callable `createShare({itemId, includeHighlights})` → `{ token, url: ${PUBLIC_URL}/s/{token} }`; stored in top-level `shares/{token}` `{ owner, title, author, siteName, url, html, highlights: [{text,note}], createdAt }` (public read, server write; `owner` = sha256(`uid/itemId`), so readers learn neither id; older snapshots with plain `uid`/`itemId` are still honoured); `revokeShare({token})`. Public route `/s/:token` renders a clean read-only page (no auth). Item gets `shareToken`.
- **Export as EPUB** (great for e-readers): callable `exportEpub({ itemIds })` → builds an EPUB 3 (one chapter per item, images inlined when small, highlights as notes) in `users/{uid}/exports/{id}.epub` and returns a download URL. Reader More → "Download as EPUB"; Library select mode → "Export EPUB".

## 7. Insight

- **Stats** page `/stats` (linked from Settings and the Library footer): items saved / finished per week (last 12 weeks, simple bar table — no chart library), words read, current reading streak (days with an archived item), top tags, top sites, highlights count.

## 8. Feature flags

Callable `getConfig()` (no auth needed) → `{ ai: boolean, telegramBot: string|null, inboundEmailDomain: string|null }` derived from function env/secrets; the web caches it for the session and hides unavailable features. Telegram link: callable `createTelegramLink()` → `{ url: 'https://t.me/<bot>?start=<token>' }` (token stored in `telegramLinks/{token}` {uid, expiresAt}); `telegramChats/{chatId}` `{ uid, username, linkedAt }`; mirror `users/{uid}/integrations/telegram` `{ chatId, username, linkedAt }` for the Settings UI; callable `unlinkTelegram()`. Email address: callable `getInboundEmail()` → `{ address }` (creates `inboundAddresses/{token}` {uid} once, mirror in `users/{uid}/integrations/email`).

Secrets / env (Cloud Functions, set by scripts/setup.sh — all optional):
`TELEGRAM_BOT_TOKEN` (secret), `TELEGRAM_WEBHOOK_SECRET` (secret), `TELEGRAM_BOT_USERNAME` (env), `INBOUND_EMAIL_DOMAIN` (env), `INBOUND_EMAIL_SECRET` (secret, shared with the webhook as `?secret=` or header), `ANTHROPIC_API_KEY` (secret).

## 9. Contracts as built

The exact names and shapes the parts of wave 2 rely on (in addition to the sections above).

**Callables** (all `us-central1`):

| name | request | response |
|---|---|---|
| `getConfig` | `{}` (no auth) | `{ ai, telegramBot, inboundEmailDomain }` |
| `createTelegramLink` | `{}` | `{ url }` — token valid 15 min, single use |
| `unlinkTelegram` | `{}` | `{ ok: true }` |
| `getInboundEmail` | `{ reset?: boolean }` | `{ address }` — `reset` replaces the address |
| `ai` | `{ itemId, action, question?, force? }` | summarize `{ summary, cached, model, createdAt (ms) }` · ask `{ answer, model }` · suggestTags `{ tags, model }`; errors `failed-precondition` (not configured), `resource-exhausted` (100/day; cached summaries are free) |
| `createShare` | `{ itemId, includeHighlights }` | `{ token, url }` — the web app builds the link from its own origin (`/s/{token}`); `url` uses `PUBLIC_URL` |
| `revokeShare` | `{ token }` | `{ ok: true }` — deletes `shares/{token}` and the item's `shareToken` |
| `exportEpub` | `{ itemIds }` (≤ 200) | `{ url, name }` — `users/{uid}/exports/{id}.epub`, older exports are removed after 7 days. The web client waits up to 560 s for this, `refreshFeeds` and `importOpml` (190 s for `addFeed`, 120 s for the rest) |
| `saveUrl` | adds `source?: 'web'\|'app'\|'import'\|'bookmarklet'` | unchanged |

**HTTP functions**: `telegram` (header `X-Telegram-Bot-Api-Secret-Token`; `GET ?action=setWebhook` with that
header registers `https://us-central1-<project>.cloudfunctions.net/telegram` and the command list) and
`inboundEmail` (header `X-Readlater-Secret` or `?secret=`). Both answer 404 while their integration is off.
`POST /api/save` also answers `existing: boolean`; a `GET` with `Accept: text/html` returns a page that closes
itself (bookmarklet popup).

**Firestore**: `aiSummary: { text, createdAt, model }`; `shares/{token}` also has `updatedAt`;
server-only item fields of a processing run: `processingAt`, `processingRun`, `processAttempts`, `retryAt`
(SPEC.md `processItem` / `sweepItems`); feed doc `since` and `users/{uid}/feedSeen/{itemId} { feedId, expiresAt }`
(SPEC.md feeds); `apiKeys` (top level and mirror) carry `scope`; `loginCodes` may carry `challenge`. TTL policies
on `expiresAt` of `loginCodes`, `rateLimits`, `telegramLinks`, `telegramUpdates`, `emailDedupe` and `feedSeen` are
declared in `firestore.indexes.json` (so `firebase deploy --force` keeps them), as are the collection-group
indexes on `items.processingAt` / `items.retryAt` that `sweepItems` queries;
`users/{uid}/integrations/telegram { chatId, username, linkedAt }` where `username` is the chat's display name,
ready to show (`@handle`, else the chat title or the person's name); `users/{uid}/integrations/email
{ token, address, createdAt }`. `telegramUpdates` and `emailDedupe` documents carry `expiresAt` (TTL policy).
Saved views and rules carry exactly the fields of §2 (no `updatedAt`); rule names ≤ 100 characters, match
values 1–500.

**Configuration**: plain values in `functions/.env.<project>` (git-ignored; written by `scripts/setup.sh`, and
from the `FUNCTIONS_ENV` repository variable in GitHub Actions): `AI_ENABLED=1`, `TELEGRAM_BOT_USERNAME`,
`INBOUND_EMAIL_DOMAIN`, optional `PUBLIC_URL`, `ANTHROPIC_MODEL`. Secrets in Secret Manager:
`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INBOUND_EMAIL_SECRET`. A secret is bound
to the functions only while its flag is set (`AI_ENABLED`, `TELEGRAM_BOT_USERNAME`, `INBOUND_EMAIL_DOMAIN`), or
when listed in `READLATER_SECRETS`. Tests and gateways: `TELEGRAM_API_BASE`, `ANTHROPIC_BASE_URL`.

**Content HTML**: the only class kept by the sanitisers is `<p class="rl-note">` (an extractor note such as
"Loaded from the Internet Archive …"). YouTube transcript paragraphs start with a timestamp link
(`…watch?v=ID&t=123s`); X threads include `<p><small>Thread · N posts</small></p>`.
