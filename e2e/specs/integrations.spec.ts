/**
 * Wave-2 integrations end to end (docs/SPEC-2.md), against the real functions on the emulators:
 *
 *  1. getConfig reports the configured integrations (no sign-in needed) and Settings offers them.
 *  2. The browser extension's API contract: POST /api/save with the captured page HTML (extracted without
 *     fetching the page), category by name and by id, the popup's re-POST, lookup / tags / categories /
 *     items, CORS preflight and the 5 MB limit. The reader shows the captured text.
 *  3. An auto rule is applied when a saved page is processed.
 *  4. The "Save to Readlater" bookmarklet from Settings saves the page it runs on in a popup that closes itself.
 *  5. Telegram: link a chat, save a link (reply edited with the real title), save a note, /latest.
 *  6. Inbound email: JSON, Mailgun, SendGrid and raw-MIME (Cloudflare worker) bodies, duplicates, a mailed link.
 *  7. AI: Summarize in the reader (fake Anthropic API), the summary is cached, Ask is grounded in the document.
 *  8. A public share link created in the reader opens signed out, with highlights; turning it off removes it.
 *  9. exportEpub returns a downloadable EPUB that extractEpub reads back.
 *
 * global-setup.ts configures the integrations through functions/.env.local (helpers/integrations.ts); the
 * Telegram Bot API and the Anthropic API are local fakes started here. When the emulators run without those
 * settings (e.g. reused emulators started by hand), the tests are skipped.
 */
import { createRequire } from 'node:module';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { currentUser, googleSignIn, newAccount, newContext } from '../helpers/app';
import { callFunction, FUNCTIONS, getDoc, HOSTING, listDocs, setDoc, waitFor } from '../helpers/emulators';
import {
  EMAIL_DOMAIN,
  EMAIL_SECRET,
  FAKE_SUMMARY,
  fakeAnthropic,
  fakeTelegram,
  TELEGRAM_BOT,
  TELEGRAM_SECRET,
  type FakeApi,
} from '../helpers/integrations';

test.describe.configure({ mode: 'serial' });

const require = createRequire(import.meta.url);

const PROCESSING = 90_000;
const CAPTURE_URL = 'https://members.capture.e2e.test/2026/lighthouse-keepers';
const CAPTURE_TITLE = 'The Last Lighthouse Keepers';
/** Appears only in the captured HTML: the page itself does not exist on the internet. */
const CAPTURE_PHRASE = 'barometric logbook of the northern lamp';

/** A long-enough article page as a browser extension would capture it. */
function articlePage(title: string, phrase: string): string {
  const para = (i: number) =>
    `<p>Paragraph ${i}. The keepers wrote every change of weather into the ${phrase}, hour after hour, through ` +
    `winters when no ship came near the rocks. Their notes describe wind, swell, fog and the colour of the sky at ` +
    `dusk, and they are still read by people who study how storms form over the cold northern water.</p>`;
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title} | Members</title>` +
    `<meta property="og:title" content="${title}"><meta name="author" content="Mara Quill"></head><body>` +
    `<header><nav><a href="/">Home</a> <a href="/subscribe">Subscribe</a></nav></header>` +
    `<main><article><h1>${title}</h1>${Array.from({ length: 8 }, (_, i) => para(i + 1)).join('')}</article></main>` +
    `<footer>© Members only</footer></body></html>`
  );
}

let telegram: FakeApi;
let anthropic: FakeApi;
let context: BrowserContext;
let page: Page;
let user: { uid: string; idToken: string };
let apiKey = '';
let configured = false;
let captureId = '';

test.beforeAll(async ({ browser }) => {
  telegram = fakeTelegram();
  anthropic = fakeAnthropic();
  await Promise.all([telegram.start(), anthropic.start()]);
  context = await newContext(browser);
  page = await context.newPage();
  await googleSignIn(page, newAccount());
  const u = await currentUser(page);
  user = { uid: u.uid, idToken: u.idToken };
  const cfg = await callFunction<{ ai: boolean; telegramBot: string | null; inboundEmailDomain: string | null }>('getConfig', {});
  configured = cfg.ai && cfg.telegramBot === TELEGRAM_BOT && cfg.inboundEmailDomain === EMAIL_DOMAIN;
  if (configured) apiKey = (await callFunction<{ key: string }>('createApiKey', { name: 'Browser extension' }, user)).key;
});

test.afterAll(async () => {
  await context?.close();
  await Promise.all([telegram?.stop(), anthropic?.stop()]);
});

test.beforeEach(() => {
  test.skip(!configured, 'The emulators run without the integration test settings (start them through the e2e global setup).');
});

/** Calls the HTTP API through Hosting (/api/**), like the extension and the bookmarklet do. */
async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${HOSTING}/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${apiKey}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, json };
}

const itemPath = (id: string) => `users/${user.uid}/items/${id}`;

async function waitForItem(id: string, what: string, check: (d: Record<string, unknown>) => boolean, timeout = PROCESSING): Promise<Record<string, unknown>> {
  return waitFor(
    what,
    async () => {
      const d = await getDoc(itemPath(id));
      return d && check(d) ? d : null;
    },
    timeout,
  );
}

async function findItem(what: string, check: (d: Record<string, unknown>) => boolean, timeout = PROCESSING): Promise<{ id: string; data: Record<string, unknown> }> {
  return waitFor(what, async () => (await listDocs(`users/${user.uid}/items`)).find((d) => check(d.data)) ?? null, timeout);
}

async function contentHtml(id: string): Promise<string> {
  const chunks = await listDocs(`${itemPath(id)}/content`);
  return chunks
    .sort((a, b) => Number(a.data.index) - Number(b.data.index))
    .map((c) => String(c.data.html))
    .join('');
}

async function openMoreAction(p: Page, name: string): Promise<void> {
  await p.getByRole('button', { name: 'More actions' }).click();
  await p.getByRole('menuitem', { name }).click();
}

test('1. getConfig reports the integrations without sign-in, and Settings offers them', async () => {
  const cfg = await callFunction<Record<string, unknown>>('getConfig', {});
  expect(cfg).toEqual({ ai: true, telegramBot: TELEGRAM_BOT, inboundEmailDomain: EMAIL_DOMAIN });

  await page.goto('/settings#telegram');
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await page.goto('/settings#email');
  await page.getByRole('button', { name: 'Create my address' }).click();
  await expect(page.locator('#email code.set-key')).toHaveText(new RegExp(`^[a-z2-7]{10}@${EMAIL_DOMAIN.replace(/\./g, '\\.')}$`));
});

test('2. Extension contract: captured HTML is extracted without a fetch; lookup, tags, categories, items', async () => {
  // CORS preflight from an extension origin.
  const pre = await fetch(`${HOSTING}/api/save`, {
    method: 'OPTIONS',
    headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  });
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-origin')).toBe('*');

  expect((await api('/categories')).json).toEqual({ categories: [] });
  expect((await api(`/lookup?url=${encodeURIComponent(CAPTURE_URL)}`)).json).toEqual({ saved: false });

  // The toolbar button: url + title + rendered HTML + tags; `category` by name creates the category.
  const saved = await api('/save', {
    body: { url: CAPTURE_URL, title: `${CAPTURE_TITLE} | Members`, html: articlePage(CAPTURE_TITLE, CAPTURE_PHRASE), tags: ['paywalled'], category: 'Long reads', source: 'extension' },
  });
  expect(saved.status).toBe(200);
  expect(saved.json).toMatchObject({ ok: true, existing: false });
  captureId = String(saved.json.id);

  const item = await waitForItem(captureId, 'the captured page to be processed', (d) => d.fetchStatus === 'done' || d.fetchStatus === 'error');
  expect(item.fetchError ?? null).toBeNull();
  expect(item).toMatchObject({ fetchStatus: 'done', source: 'extension', title: CAPTURE_TITLE, author: 'Mara Quill', url: CAPTURE_URL, tags: ['paywalled'] });
  expect(item.file).toMatchObject({ name: 'page.html', contentType: 'text/html', path: `users/${user.uid}/uploads/${captureId}/page.html` });
  expect(Number(item.wordCount)).toBeGreaterThan(300);
  expect(await contentHtml(captureId)).toContain(CAPTURE_PHRASE);

  const cats = (await api('/categories')).json.categories as { id: string; name: string }[];
  expect(cats.map((c) => c.name)).toEqual(['Long reads']);
  expect(item.categoryId).toBe(cats[0].id);

  // The popup's re-POST: same URL, the full tag list, the category as an id (`category` and `categoryId`), a note.
  const update = await api('/save', {
    body: { url: CAPTURE_URL, source: 'extension', tags: ['paywalled', 'history'], category: cats[0].id, categoryId: cats[0].id, note: 'From the popup' },
  });
  expect(update.json).toMatchObject({ ok: true, id: captureId, existing: true });
  const updated = await waitForItem(captureId, 'the popup update', (d) => d.note === 'From the popup');
  expect(updated).toMatchObject({ tags: ['paywalled', 'history'], categoryId: cats[0].id });
  expect((await api('/categories')).json.categories).toHaveLength(1);

  expect((await api(`/lookup?url=${encodeURIComponent(CAPTURE_URL)}`)).json).toEqual({ saved: true, id: captureId, status: 'unread', location: 'library' });
  expect((await api('/tags')).json.tags).toEqual(expect.arrayContaining(['paywalled', 'history']));
  const items = (await api('/items?status=unread&limit=5')).json.items as { id: string; title: string; url: string }[];
  expect(items.find((i) => i.id === captureId)).toMatchObject({ title: CAPTURE_TITLE, url: CAPTURE_URL });

  // Over 5 MB of HTML: 413, and the extension then retries with the URL only.
  const huge = await api('/save', { body: { url: 'https://members.capture.e2e.test/huge', html: `<p>${'x'.repeat(5 * 1024 * 1024)}</p>`, source: 'extension' } });
  expect(huge.status).toBe(413);
  expect((await api('/save', { headers: { authorization: 'Bearer rl_wrong' }, body: { url: CAPTURE_URL } })).status).toBe(401);

  // The reader shows the captured text.
  await page.goto(`/item/${captureId}`);
  await expect(page.locator('.reader-content')).toContainText(CAPTURE_PHRASE);
});

test('3. An auto rule tags and favorites a matching page when it is processed', async () => {
  // The shape Settings › Auto rules writes (docs/SPEC-2.md §2).
  await setDoc(`users/${user.uid}/rules/e2e-rule`, {
    name: 'Rules test site',
    enabled: true,
    match: { field: 'domain', op: 'endsWith', value: 'rules.e2e.test' },
    actions: { addTags: ['auto-rule'], favorite: true },
    createdAt: new Date(),
  });
  const saved = await api('/save', { body: { url: 'https://news.rules.e2e.test/post', html: articlePage('Rules Apply Here', 'tide table'), tags: ['mine'], source: 'extension' } });
  const item = await waitForItem(String(saved.json.id), 'the rule item to be processed', (d) => d.fetchStatus === 'done');
  expect(item).toMatchObject({ rulesApplied: true, favorite: true, tags: ['mine', 'auto-rule'] });

  const other = await api('/save', { body: { url: 'https://elsewhere.e2e.test/post', html: articlePage('No Rules Here', 'tide table'), source: 'extension' } });
  const plain = await waitForItem(String(other.json.id), 'the other item to be processed', (d) => d.fetchStatus === 'done');
  expect(plain).toMatchObject({ rulesApplied: true, favorite: false, tags: [] });
});

test('4. The "Save to Readlater" bookmarklet saves the page it runs on and its popup closes itself', async () => {
  await page.goto('/settings#bookmarklets');
  const section = page.locator('#bookmarklets');
  await section.getByRole('button', { name: 'Generate' }).click();
  const link = section.locator('a.set-bookmarklet', { hasText: 'Save to Readlater' });
  await expect(link).toHaveAttribute('href', /^javascript:/);
  const href = (await link.getAttribute('href'))!;

  const PAGE = 'https://blog.bookmarklet.e2e.test/a-post-to-save';
  const other = await context.newPage();
  await other.route('https://blog.bookmarklet.e2e.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>A Post To Save</title><h1>A post to save</h1>' }),
  );
  await other.goto(PAGE);
  // Clicking a bookmark runs its javascript: URL in the page; browsers percent-decode it first.
  const [popup] = await Promise.all([other.waitForEvent('popup'), other.evaluate((code) => (0, eval)(code), decodeURIComponent(href.slice('javascript:'.length)))]);
  await expect(popup.getByRole('heading', { name: 'Saved ✓' })).toBeVisible();
  await expect(popup.getByText('A Post To Save')).toBeVisible();
  await popup.waitForEvent('close', { timeout: 10_000 });
  await other.close();

  const found = await findItem('the bookmarklet item', (d) => d.url === PAGE, 20_000);
  expect(found.data).toMatchObject({ source: 'bookmarklet', title: 'A Post To Save', location: 'library' });

  // The pages it runs on can read its key, so the key can only save: reading the library is refused.
  const key = /key=(rl_[A-Za-z0-9]{40})/.exec(decodeURIComponent(href))![1];
  const read = await fetch(`${HOSTING}/api/items?key=${key}`);
  expect(read.status).toBe(403);
  expect((await fetch(`${HOSTING}/api/lookup?url=${encodeURIComponent(PAGE)}`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
});

test('5. Telegram: link a chat, save a link (reply edited with the title), save a note, /latest', async () => {
  const CHAT = 4242001;
  let updateId = 9_000_000 + Math.floor(Math.random() * 100_000);
  const send = async (text: string, secret = TELEGRAM_SECRET) => {
    const entities: { type: string; offset: number; length: number }[] = [];
    const cmd = /^\/\w+/.exec(text);
    if (cmd) entities.push({ type: 'bot_command', offset: 0, length: cmd[0].length });
    for (const m of text.matchAll(/https?:\/\/\S+/g)) entities.push({ type: 'url', offset: m.index!, length: m[0].length });
    const res = await fetch(`${FUNCTIONS}/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT, type: 'private', username: 'e2e_reader', first_name: 'Ada' },
          from: { id: CHAT, is_bot: false, username: 'e2e_reader', first_name: 'Ada' },
          text,
          entities,
        },
      }),
    });
    return res.status;
  };
  const repliesTo = () => telegram.calls.filter((c) => c.body.chat_id === CHAT).map((c) => String(c.body.text ?? ''));

  expect(await send('hello', 'wrong-secret')).toBe(401);

  const { url } = await callFunction<{ url: string }>('createTelegramLink', {}, user);
  const token = new RegExp(`^https://t\\.me/${TELEGRAM_BOT}\\?start=([A-Za-z0-9]+)$`).exec(url)?.[1];
  expect(token, url).toBeTruthy();
  expect(await send(`/start ${token}`)).toBe(200);
  const mirror = await waitFor('the Telegram link', () => getDoc(`users/${user.uid}/integrations/telegram`));
  expect(mirror).toMatchObject({ chatId: CHAT, username: '@e2e_reader' });
  expect(repliesTo().some((t) => t.startsWith('✓ Connected to Readlater'))).toBe(true);

  await page.goto('/settings#telegram');
  await expect(page.locator('#telegram')).toContainText('Connected as @e2e_reader');

  expect(await send('Worth reading https://example.com/?from=telegram #tg-e2e')).toBe(200);
  const link = await findItem('the link from Telegram', (d) => d.url === 'https://example.com/?from=telegram');
  expect(link.data).toMatchObject({ source: 'telegram', tags: ['tg-e2e'] });
  await waitFor('the reply with the title', async () => repliesTo().some((t) => t === '✓ Saved: Example Domain'), 60_000);

  expect(await send('Remember to call the harbour master about the new lamp #todo')).toBe(200);
  const note = await findItem('the note from Telegram', (d) => d.source === 'telegram' && d.type === 'other');
  expect(note.data).toMatchObject({ siteName: 'Telegram', tags: ['todo'], fetchStatus: 'done' });
  expect(await contentHtml(note.id)).toContain('call the harbour master');

  expect(await send('/latest')).toBe(200);
  await waitFor('the /latest answer', async () => repliesTo().some((t) => t.includes('https://example.com/?from=telegram')), 20_000);
});

test('6. Inbound email: JSON, Mailgun, SendGrid and raw MIME; duplicates are dropped; a mailed link is saved', async () => {
  const { address } = await callFunction<{ address: string }>('getInboundEmail', {}, user);
  expect(address).toMatch(new RegExp(`@${EMAIL_DOMAIN.replace(/\./g, '\\.')}$`));
  const post = async (body: BodyInit, headers: Record<string, string> = {}, secret = EMAIL_SECRET) => {
    const res = await fetch(`${FUNCTIONS}/inboundEmail`, { method: 'POST', headers: { 'x-readlater-secret': secret, ...headers }, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const issue = (n: number) => `<h1>Issue ${n}</h1><p>This week the lighthouse newsletter covers storm season, the new lamp and the keepers' logbooks. ` + 'More news from the coast. '.repeat(20) + '</p>';

  expect((await post(JSON.stringify({ to: address, subject: 'x', html: '<p>x</p>' }), { 'content-type': 'application/json' }, 'wrong')).status).toBe(401);

  // Plain JSON (any sender, or the Cloudflare worker without raw).
  const json = JSON.stringify({ to: address, from: 'Lighthouse Weekly <news@lighthouse.e2e.test>', subject: 'Issue 12: Storm season', html: issue(12), messageId: '<issue12@lighthouse.e2e.test>' });
  const r1 = await post(json, { 'content-type': 'application/json' });
  expect(r1.json).toMatchObject({ ok: true });
  expect((await post(json, { 'content-type': 'application/json' })).json).toMatchObject({ duplicate: true });
  const item = await waitForItem(String(r1.json.id), 'the JSON newsletter', (d) => d.fetchStatus === 'done');
  expect(item).toMatchObject({ location: 'feed', type: 'article', siteName: 'Lighthouse Weekly', source: 'email', title: 'Issue 12: Storm season' });

  // Mailgun route (multipart/form-data).
  const mg = new FormData();
  mg.set('recipient', address);
  mg.set('sender', 'digest@mailgun.e2e.test');
  mg.set('from', 'Coastal Digest <digest@mailgun.e2e.test>');
  mg.set('subject', 'Coastal Digest 3');
  mg.set('body-html', issue(3));
  mg.set('body-plain', 'Issue 3');
  mg.set('Message-Id', '<digest3@mailgun.e2e.test>');
  expect((await post(mg)).json).toMatchObject({ ok: true });

  // SendGrid Inbound Parse, default (parsed) mode.
  const sg = new FormData();
  sg.set('to', address);
  sg.set('from', 'Harbour Notes <notes@sendgrid.e2e.test>');
  sg.set('subject', 'Harbour Notes 7');
  sg.set('html', issue(7));
  sg.set('text', 'Issue 7');
  sg.set('envelope', JSON.stringify({ to: [address], from: 'notes@sendgrid.e2e.test' }));
  sg.set('headers', 'Message-ID: <notes7@sendgrid.e2e.test>\nDate: Fri, 9 Oct 2026 08:00:00 +0000\n');
  sg.set('charsets', JSON.stringify({ to: 'UTF-8', html: 'UTF-8', subject: 'UTF-8', from: 'UTF-8', text: 'UTF-8' }));
  expect((await post(sg)).json).toMatchObject({ ok: true });

  // Cloudflare Email Worker: the raw MIME message, base64.
  const mime = [
    `To: ${address}`,
    'From: Tide Letters <tides@cf.e2e.test>',
    'Subject: Tide Letter 9',
    'Message-ID: <tides9@cf.e2e.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    issue(9),
  ].join('\r\n');
  const raw = JSON.stringify({ to: address, from: 'tides@cf.e2e.test', raw: Buffer.from(mime).toString('base64') });
  expect((await post(raw, { 'content-type': 'application/json' })).json).toMatchObject({ ok: true });

  for (const [title, siteName] of [
    ['Coastal Digest 3', 'Coastal Digest'],
    ['Harbour Notes 7', 'Harbour Notes'],
    ['Tide Letter 9', 'Tide Letters'],
  ]) {
    const found = await findItem(title, (d) => d.title === title && d.fetchStatus === 'done', 20_000);
    expect(found.data).toMatchObject({ location: 'feed', siteName, source: 'email' });
  }

  // A link mailed to yourself saves the link (to the Library).
  const fwd = JSON.stringify({ to: address, from: 'Ada <ada@e2e.test>', subject: 'Fwd: read this', html: '<p><a href="https://example.com/?from=email">https://example.com/?from=email</a></p>' });
  expect((await post(fwd, { 'content-type': 'application/json' })).json).toMatchObject({ ok: true });
  const mailed = await findItem('the mailed link', (d) => d.url === 'https://example.com/?from=email', 20_000);
  expect(mailed.data).toMatchObject({ source: 'email', location: 'library' });

  await page.goto('/feed');
  await expect(page.locator('article.item-row .item-title', { hasText: 'Issue 12: Storm season' })).toBeVisible();
});

test('7. AI: Summarize in the reader, the summary is cached, Ask is grounded in the document', async () => {
  await page.goto(`/item/${captureId}`);
  await expect(page.locator('.reader-content')).toContainText(CAPTURE_PHRASE);
  await openMoreAction(page, 'Summarize');
  const panel = page.getByRole('dialog', { name: 'Summary' });
  await expect(panel).toContainText('Keepers record storms');
  expect(anthropic.callsTo('messages')).toHaveLength(1);
  const sent = JSON.stringify(anthropic.calls[0].body);
  expect(sent).toContain(CAPTURE_PHRASE);

  const again = await callFunction<{ summary: string; cached: boolean }>('ai', { itemId: captureId, action: 'summarize' }, user);
  expect(again).toMatchObject({ summary: FAKE_SUMMARY, cached: true });
  expect(anthropic.callsTo('messages')).toHaveLength(1);
  expect((await getDoc(itemPath(captureId)))?.aiSummary).toMatchObject({ text: FAKE_SUMMARY });

  const ask = await callFunction<{ answer: string }>('ai', { itemId: captureId, action: 'ask', question: 'What did the keepers write down?' }, user);
  expect(ask.answer).toBe(FAKE_SUMMARY);
  expect(anthropic.callsTo('messages')).toHaveLength(2);
  expect(JSON.stringify(anthropic.calls[1].body)).toContain('What did the keepers write down?');
});

test('8. A public share link opens signed out with highlights, and stops working when turned off', async ({ browser }) => {
  await setDoc(`users/${user.uid}/highlights/e2e-share-hl`, {
    itemId: captureId,
    text: CAPTURE_PHRASE,
    note: 'Shared note on the logbook',
    prefix: 'into the ',
    suffix: ', hour aft',
    color: 'green',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await page.goto(`/item/${captureId}`);
  await expect(page.locator('.reader-content mark')).not.toHaveCount(0);
  await openMoreAction(page, 'Share public link…');
  const dialog = page.getByRole('dialog', { name: 'Share public link' });
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const input = dialog.locator('input.share-link');
  await expect(input).toHaveValue(new RegExp(`^${HOSTING.replace(/[.:/]/g, '\\$&')}/s/[A-Za-z0-9_-]+$`));
  const shareUrl = await input.inputValue();
  const token = shareUrl.split('/s/')[1];
  expect((await getDoc(itemPath(captureId)))?.shareToken).toBe(token);

  const visitor = await browser.newContext({ baseURL: HOSTING });
  const v = await visitor.newPage();
  await v.goto(shareUrl);
  await expect(v.getByRole('heading', { name: CAPTURE_TITLE })).toBeVisible();
  await expect(v.locator('.reader-content')).toContainText(CAPTURE_PHRASE);
  await expect(v.getByText('Shared note on the logbook')).toBeVisible();
  await expect(v.getByText('Saved with')).toBeVisible();

  await dialog.getByRole('button', { name: 'Turn off link' }).click();
  await expect(dialog.getByRole('button', { name: 'Create link' })).toBeVisible();
  await waitFor('the share to be deleted', async () => (await getDoc(`shares/${token}`)) === null, 20_000);
  await v.reload();
  await expect(v.getByRole('heading', { name: 'Link not found' })).toBeVisible();
  await visitor.close();
  await dialog.getByRole('button', { name: 'Done' }).click();
});

test('9. exportEpub returns a downloadable EPUB that extractEpub reads back', async () => {
  const rulesItem = await findItem('the rules item', (d) => d.url === 'https://news.rules.e2e.test/post');
  const res = await callFunction<{ url: string; name: string }>('exportEpub', { itemIds: [captureId, rulesItem.id] }, user);
  expect(res.name).toMatch(/\.epub$/);
  const download = await fetch(res.url);
  expect(download.status).toBe(200);
  const buf = Buffer.from(await download.arrayBuffer());

  const zip = await JSZip.loadAsync(buf);
  expect(Object.keys(zip.files)[0]).toBe('mimetype');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');

  const { extractEpub } = require('../../functions/lib/extract/index.js') as {
    extractEpub: (b: Buffer, o: { uploadImage: (name: string, data: Uint8Array, type: string) => Promise<string> }) => Promise<{ html: string; title: string | null }>;
  };
  const book = await extractEpub(buf, { uploadImage: async (name) => `https://images.e2e.test/${name}` });
  expect(book.html).toContain(CAPTURE_PHRASE);
  expect(book.html).toContain('Rules Apply Here');
  expect(book.html).toContain('Shared note on the logbook');
});
