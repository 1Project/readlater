/**
 * End-to-end ingest tests against the Firebase emulators (functions, firestore, auth, storage), with a mock
 * Telegram Bot API on localhost. Skipped unless INGEST_EMULATOR=1.
 *
 * The functions must run with this configuration, e.g. in functions/.env.<project> for a project id used
 * only for this run (the emulator loads it next to .env.local):
 *   TELEGRAM_BOT_TOKEN=123456:TEST-TOKEN
 *   TELEGRAM_WEBHOOK_SECRET=tg-webhook-secret
 *   TELEGRAM_BOT_USERNAME=readlater_test_bot
 *   TELEGRAM_API_BASE=http://127.0.0.1:18321        (INGEST_TG_PORT, the mock server started here)
 *   INBOUND_EMAIL_DOMAIN=in.example.com
 *   INBOUND_EMAIL_SECRET=mail-secret
 *   (+ HTTPS_PROXY / NO_PROXY=localhost,127.0.0.1 when behind a proxy: example.com is fetched for real)
 * and this process needs FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST,
 * GCLOUD_PROJECT and INGEST_FUNCTIONS_URL (e.g. http://127.0.0.1:5001/<project>/us-central1).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makePdf } from './fixtures/extract/makePdf';
import { mockFetch } from './fixtures/extract/mockFetch';

const ON = process.env.INGEST_EMULATOR === '1';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-ingest';
const FN = process.env.INGEST_FUNCTIONS_URL ?? `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}/identitytoolkit.googleapis.com/v1`;
const TG_PORT = Number(process.env.INGEST_TG_PORT ?? 18321);
const TG_TOKEN = '123456:TEST-TOKEN';
const TG_SECRET = 'tg-webhook-secret';
const MAIL_SECRET = 'mail-secret';
const DOMAIN = 'in.example.com';

type Admin = typeof import('../src/admin');
let admin: Admin;

// ---------------------------------------------------------------------------- mock Telegram Bot API

interface TgCall {
  method: string;
  body: Record<string, any>;
}
const tgCalls: TgCall[] = [];
let nextMessageId = 1000;
const PDF = makePdf({
  pages: [[{ text: 'Telegram Paper Title', y: 700, size: 20 }, { text: 'This document arrived through the Telegram bot.', y: 650 }]],
  info: { Title: 'Telegram Paper Title' },
});
let server: Server;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function startMockTelegram(): Promise<void> {
  server = createServer(async (req, res) => {
    const url = req.url ?? '';
    if (url === `/file/bot${TG_TOKEN}/documents/file_1.pdf`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PDF);
      return;
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m || m[1] !== TG_TOKEN) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, description: 'Not Found' }));
      return;
    }
    const body = JSON.parse((await readBody(req)) || '{}');
    tgCalls.push({ method: m[2], body });
    let result: unknown = true;
    if (m[2] === 'sendMessage') result = { message_id: nextMessageId++, chat: { id: body.chat_id }, text: body.text };
    if (m[2] === 'getFile') result = { file_id: body.file_id, file_path: 'documents/file_1.pdf', file_size: PDF.length };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return new Promise((r) => server.listen(TG_PORT, '127.0.0.1', () => r()));
}

// ---------------------------------------------------------------------------- helpers

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function call<T = any>(name: string, data: unknown, idToken?: string): Promise<T> {
  const r = await postJson(`${FN}/${name}`, { data }, idToken ? { authorization: `Bearer ${idToken}` } : {});
  if (r.status !== 200) throw new Error(`${name} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.result as T;
}

async function createUser(): Promise<{ uid: string; idToken: string; email: string }> {
  const email = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const r = await postJson(`${AUTH}/accounts:signUp?key=demo-key`, { email, password: 'ingest-password', returnSecureToken: true });
  return { uid: r.json.localId, idToken: r.json.idToken, email };
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

let updateId = 1;
const tgUpdate = (message: Record<string, unknown>) => ({ update_id: updateId++, message: { message_id: updateId * 10, date: Math.floor(Date.now() / 1000), ...message } });
const sendUpdate = (update: unknown, secret = TG_SECRET) => postJson(`${FN}/telegram`, update, { 'x-telegram-bot-api-secret-token': secret });

const user = (uid: string) => admin.db.collection('users').doc(uid);
async function itemsWhere(uid: string, field: string, value: unknown) {
  const snap = await user(uid).collection('items').where(field, '==', value).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
}
async function contentOf(uid: string, id: string): Promise<string> {
  const snap = await user(uid).collection('items').doc(id).collection('content').get();
  return snap.docs.map((d) => String(d.get('html'))).join('');
}
const callsSince = (n: number) => tgCalls.slice(n);

// ---------------------------------------------------------------------------- tests

describe.skipIf(!ON)('ingest on the emulators', () => {
  let u: { uid: string; idToken: string; email: string };
  const CHAT = 700_000 + Math.floor(Math.random() * 1000);

  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = PROJECT;
    admin = await import('../src/admin');
    await startMockTelegram();
    u = await createUser();
    // Auto rules: example.com links get a tag; emails become favorites.
    await user(u.uid).collection('rules').add({
      name: 'Example',
      enabled: true,
      match: { field: 'domain', op: 'is', value: 'example.com' },
      actions: { addTags: ['auto'] },
      createdAt: new Date(),
    });
    await user(u.uid).collection('rules').add({
      name: 'Newsletters',
      enabled: true,
      match: { field: 'source', op: 'is', value: 'email' },
      actions: { favorite: true },
      createdAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('getConfig reports the configured integrations', async () => {
    expect(await call('getConfig', {})).toEqual({ ai: false, telegramBot: 'readlater_test_bot', inboundEmailDomain: DOMAIN });
  });

  it('links a Telegram chat with /start <token>', async () => {
    const { url } = await call<{ url: string }>('createTelegramLink', {}, u.idToken);
    const token = /^https:\/\/t\.me\/readlater_test_bot\?start=([A-Za-z0-9]{24})$/.exec(url)?.[1];
    expect(token).toBeTruthy();

    // Wrong secret → 401, nothing happens.
    expect((await sendUpdate(tgUpdate({ chat: { id: CHAT, type: 'private' }, text: `/start ${token}` }), 'nope')).status).toBe(401);

    const n = tgCalls.length;
    const r = await sendUpdate(tgUpdate({ chat: { id: CHAT, type: 'private', username: 'tester' }, from: { id: CHAT, first_name: 'T', username: 'tester' }, text: `/start ${token}` }));
    expect(r.status).toBe(200);
    const chat = await admin.db.collection('telegramChats').doc(String(CHAT)).get();
    expect(chat.get('uid')).toBe(u.uid);
    const mirror = await user(u.uid).collection('integrations').doc('telegram').get();
    expect(mirror.data()).toMatchObject({ chatId: CHAT, username: '@tester' });
    expect((await admin.db.collection('telegramLinks').doc(token!).get()).exists).toBe(false);
    const sent = callsSince(n).find((c) => c.method === 'sendMessage');
    expect(sent?.body).toMatchObject({ chat_id: CHAT, reply_to_message_id: expect.any(Number) });
    expect(sent?.body.text).toMatch(/Connected/);
    // It names the account, so a link from someone else cannot quietly connect this chat to their library.
    expect(sent?.body.text).toContain(u.email);

    // A used token cannot be reused.
    const n2 = tgCalls.length;
    await sendUpdate(tgUpdate({ chat: { id: CHAT + 1, type: 'private' }, text: `/start ${token}` }));
    expect(callsSince(n2).find((c) => c.method === 'sendMessage')?.body.text).toMatch(/expired/);
  });

  it('answers unlinked chats with instructions', async () => {
    const n = tgCalls.length;
    const r = await sendUpdate(tgUpdate({ chat: { id: 1234, type: 'private' }, text: 'https://example.com/' }));
    expect(r.status).toBe(200);
    expect(callsSince(n).find((c) => c.method === 'sendMessage')?.body.text).toBe('Open Readlater → Settings → Telegram to connect this chat.');
  });

  it('saves a link from a message, with #hashtags as tags, and edits the reply with the title', async () => {
    const n = tgCalls.length;
    const r = await sendUpdate(
      tgUpdate({ chat: { id: CHAT, type: 'private' }, text: 'Look at this https://example.com/ #Reading', entities: [{ type: 'url', offset: 13, length: 20 }] }),
    );
    expect(r.status).toBe(200);
    const [item] = await itemsWhere(u.uid, 'url', 'https://example.com/');
    expect(item).toMatchObject({ source: 'telegram', location: 'library' });
    expect(item.tags).toEqual(expect.arrayContaining(['reading']));
    const calls = callsSince(n);
    expect(calls.find((c) => c.method === 'sendMessage')?.body.text).toMatch(/^✓ Saved/);
    // processItem ran within the wait: the reply was edited with the real title, and rules were applied.
    const done = await waitFor('processed', async () => {
      const [it] = await itemsWhere(u.uid, 'url', 'https://example.com/');
      return it.fetchStatus === 'done' ? it : null;
    });
    expect(done.title).toBe('Example Domain');
    expect(done.rulesApplied).toBe(true);
    expect(done.tags).toEqual(expect.arrayContaining(['reading', 'auto']));
    expect(calls.find((c) => c.method === 'editMessageText')?.body.text).toBe('✓ Saved: Example Domain');

    // Editing that message later does not save its links again (an archived item stays archived, no reply).
    await user(u.uid).collection('items').doc(done.id).update({ status: 'archived' });
    const n2 = tgCalls.length;
    const edited = await sendUpdate({
      update_id: updateId++,
      edited_message: { message_id: 4242, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, text: 'Look at this https://example.com/ #Reading #more' },
    });
    expect(edited.status).toBe(200);
    expect((await user(u.uid).collection('items').doc(done.id).get()).get('status')).toBe('archived');
    expect(callsSince(n2).filter((c) => c.method === 'sendMessage')).toEqual([]);
    await user(u.uid).collection('items').doc(done.id).update({ status: 'unread' });
  }, 90_000);

  it('saves a PDF document sent to the bot', async () => {
    const r = await sendUpdate(
      tgUpdate({ chat: { id: CHAT, type: 'private' }, caption: '#papers', document: { file_id: 'PDF1', file_name: 'telegram-paper.pdf', mime_type: 'application/pdf', file_size: PDF.length } }),
    );
    expect(r.status).toBe(200);
    expect(tgCalls.some((c) => c.method === 'getFile' && c.body.file_id === 'PDF1')).toBe(true);
    const item = await waitFor('pdf processed', async () => {
      const list = (await itemsWhere(u.uid, 'source', 'telegram')).filter((i) => i.file?.name === 'telegram-paper.pdf');
      return list[0]?.fetchStatus === 'done' ? list[0] : null;
    });
    expect(item).toMatchObject({ type: 'pdf', tags: ['papers'], file: { contentType: 'application/pdf', size: PDF.length } });
    expect(item.file.path).toBe(`users/${u.uid}/uploads/${item.id}/telegram-paper.pdf`);
    expect(await contentOf(u.uid, item.id)).toContain('arrived through the Telegram bot');
  }, 90_000);

  it('saves plain text as a note and lists /latest', async () => {
    const n = tgCalls.length;
    await sendUpdate(tgUpdate({ chat: { id: CHAT, type: 'private' }, text: 'Remember the milk\n\nand the eggs #todo' }));
    const [note] = (await itemsWhere(u.uid, 'type', 'other')).filter((i) => i.source === 'telegram');
    expect(note).toMatchObject({ title: 'Remember the milk', fetchStatus: 'done', tags: ['todo'], contentChunks: 1, rulesApplied: true });
    expect(await contentOf(u.uid, note.id)).toBe('<p>Remember the milk</p><p>and the eggs</p>');
    expect((await user(u.uid).collection('search').doc(note.id).get()).get('kw')).toEqual(expect.arrayContaining(['remember', 'milk', 'eggs']));
    expect(callsSince(n).find((c) => c.method === 'sendMessage')?.body.text).toBe('✓ Saved note: Remember the milk');

    const m = tgCalls.length;
    await sendUpdate(tgUpdate({ chat: { id: CHAT, type: 'private' }, text: '/latest' }));
    const latest = callsSince(m).find((c) => c.method === 'sendMessage')?.body.text as string;
    expect(latest).toContain('Example Domain\nhttps://example.com/');
    expect(latest).toContain('Remember the milk');
  }, 60_000);

  it('inbound email: Mailgun, SendGrid and the Cloudflare worker JSON; dedupe; link-only mail', async () => {
    const { address } = await call<{ address: string }>('getInboundEmail', {}, u.idToken);
    expect(address).toMatch(/^[a-z2-7]{10}@in\.example\.com$/);
    expect((await call<{ address: string }>('getInboundEmail', {}, u.idToken)).address).toBe(address);

    const fd = (fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.append(k, v);
      return f;
    };
    // Wrong secret.
    const bad = await fetch(`${FN}/inboundEmail?secret=nope`, { method: 'POST', body: fd({ recipient: address }) });
    expect(bad.status).toBe(401);

    // Mailgun (secret in the query string).
    const mg = await fetch(`${FN}/inboundEmail?secret=${MAIL_SECRET}`, {
      method: 'POST',
      body: fd({
        recipient: address,
        from: 'Mailgun Weekly <weekly@mg.example.org>',
        subject: 'Mailgun issue',
        'body-html': `<p>Mailgun newsletter body with plenty of words for a proper article.</p><p>${'More text here. '.repeat(10)}</p>`,
        'body-plain': 'Mailgun newsletter body',
        'Message-Id': '<mg-int-1@mg.example.org>',
      }),
    });
    expect(mg.status).toBe(200);
    const mgJson = await mg.json();
    expect(mgJson).toMatchObject({ ok: true, id: expect.any(String) });
    const mgItem = (await user(u.uid).collection('items').doc(mgJson.id).get()).data()!;
    expect(mgItem).toMatchObject({
      location: 'feed',
      type: 'article',
      source: 'email',
      title: 'Mailgun issue',
      siteName: 'Mailgun Weekly',
      author: 'Mailgun Weekly',
      fetchStatus: 'done',
      favorite: true, // rule: source is email
      rulesApplied: true,
    });
    expect(await contentOf(u.uid, mgJson.id)).toContain('Mailgun newsletter body');

    // Same Message-ID again → duplicate.
    const again = await fetch(`${FN}/inboundEmail?secret=${MAIL_SECRET}`, {
      method: 'POST',
      body: fd({ recipient: address, from: 'x@y.org', subject: 'Mailgun issue', 'body-plain': 'x', 'Message-Id': '<mg-int-1@mg.example.org>' }),
    });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });

    // SendGrid (secret in the header, envelope recipients).
    const sg = await fetch(`${FN}/inboundEmail`, {
      method: 'POST',
      headers: { 'x-readlater-secret': MAIL_SECRET },
      body: fd({
        to: 'List <list@lists.example.org>',
        from: 'SendGrid Digest <digest@sg.example.org>',
        subject: 'SendGrid digest',
        html: `<h1>Digest</h1><p>${'SendGrid digest words. '.repeat(12)}</p>`,
        text: 'SendGrid digest words.',
        envelope: JSON.stringify({ to: [address], from: 'bounce@sg.example.org' }),
        headers: 'Message-ID: <sg-int-1@sg.example.org>\nSubject: SendGrid digest',
        charsets: JSON.stringify({ html: 'UTF-8', text: 'UTF-8', subject: 'UTF-8' }),
      }),
    });
    const sgJson = await sg.json();
    expect(sgJson).toMatchObject({ ok: true });
    expect((await user(u.uid).collection('items').doc(sgJson.id).get()).data()).toMatchObject({ siteName: 'SendGrid Digest', source: 'email', location: 'feed' });

    // Cloudflare worker JSON with the raw MIME message.
    const eml = readFileSync(join(__dirname, 'fixtures', 'ingest', 'newsletter.eml'), 'utf8').replace(/abcdefghij@in\.example\.com/g, address);
    const cf = await postJson(`${FN}/inboundEmail`, { to: address, from: 'news@dispatch.example.com', raw: Buffer.from(eml).toString('base64') }, { 'x-readlater-secret': MAIL_SECRET });
    expect(cf.json).toMatchObject({ ok: true });
    const cfItem = (await user(u.uid).collection('items').doc(cf.json.id).get()).data()!;
    expect(cfItem).toMatchObject({ title: 'Café culture — issue 42', siteName: 'The Dispatch', location: 'feed' });
    expect(await contentOf(u.uid, cf.json.id)).not.toContain('Preheader');

    // A mailed link is saved as that link (library, pending → processed).
    const link = await postJson(
      `${FN}/inboundEmail`,
      { to: address, from: 'me@example.org', subject: 'fwd', text: 'https://example.com/?from=mail\n\nSent from my iPhone' },
      { 'x-readlater-secret': MAIL_SECRET },
    );
    expect(link.json).toMatchObject({ ok: true, link: true });
    expect((await user(u.uid).collection('items').doc(link.json.id).get()).data()).toMatchObject({ url: 'https://example.com/?from=mail', source: 'email', location: 'library' });

    // A new address replaces the old one, which stops working.
    const { address: fresh } = await call<{ address: string }>('getInboundEmail', { reset: true }, u.idToken);
    expect(fresh).not.toBe(address);
    const old = await postJson(`${FN}/inboundEmail`, { to: address, from: 'a@b.c', subject: 's', text: 'hello there friend' }, { 'x-readlater-secret': MAIL_SECRET });
    expect(old.json).toEqual({ ok: false, error: 'Unknown address' });
    expect((await user(u.uid).collection('integrations').doc('email').get()).get('address')).toBe(fresh);

    // Unknown address → ok:false (no retry).
    const unknown = await postJson(`${FN}/inboundEmail`, { to: `zzzzzzzzzz@${DOMAIN}`, from: 'a@b.c', subject: 's', text: 'hello there' }, { 'x-readlater-secret': MAIL_SECRET });
    expect(unknown).toEqual({ status: 200, json: { ok: false, error: 'Unknown address' } });
  }, 90_000);

  it('HTTP API: categories by id or name, lookup, tags, categories, items, html capture', async () => {
    const { key } = await call<{ key: string }>('createApiKey', { name: 'ingest test' }, u.idToken);
    const auth = { authorization: `Bearer ${key}` };
    const work = await user(u.uid).collection('categories').add({ name: 'Work', order: 1, createdAt: new Date() });
    const get = async (path: string) => {
      const res = await fetch(`${FN}/api${path}`, { headers: auth });
      return { status: res.status, json: await res.json() };
    };

    // Extension-style save: category id in both fields, captured HTML, note, source.
    const html = `<!doctype html><html><head><title>Captured Members-Only Story</title>
      <meta property="og:site_name" content="Paywalled Times"></head><body><article><h1>Captured Members-Only Story</h1>
      ${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} of the captured page: only the logged-in browser could see this text, and the server never fetches it.</p>`).join('')}
      <img src="/images/lead.jpg" alt="Lead"></article></body></html>`;
    const captured = await postJson(
      `${FN}/api/save`,
      { url: 'https://example.com/members/only-story', source: 'extension', html, category: work.id, categoryId: work.id, tags: ['Captured'], note: 'from the extension' },
      auth,
    );
    expect(captured).toMatchObject({ status: 200, json: { ok: true, existing: false } });
    const id = captured.json.id as string;
    const item = await waitFor('captured page processed', async () => {
      const d = (await user(u.uid).collection('items').doc(id).get()).data();
      return d && (d.fetchStatus === 'done' || d.fetchStatus === 'error') ? d : null;
    });
    expect(item).toMatchObject({
      fetchStatus: 'done',
      title: 'Captured Members-Only Story',
      siteName: 'Paywalled Times',
      categoryId: work.id,
      note: 'from the extension',
      source: 'extension',
      file: { path: `users/${u.uid}/uploads/${id}/page.html`, name: 'page.html', contentType: 'text/html' },
    });
    expect(item.tags).toEqual(['captured', 'auto']);
    const content = await contentOf(u.uid, id);
    expect(content).toContain('only the logged-in browser could see this text');
    expect(content).toContain('src="https://example.com/images/lead.jpg"');

    // Category by name: an existing name is reused, a new name is created; null clears.
    const byName = await postJson(`${FN}/api/save`, { url: 'https://example.org/by-name', category: 'work' }, auth);
    expect((await user(u.uid).collection('items').doc(byName.json.id).get()).get('categoryId')).toBe(work.id);
    const created = await postJson(`${FN}/api/save`, { url: 'https://example.org/new-cat', category: 'Reading list' }, auth);
    const newCat = (await user(u.uid).collection('items').doc(created.json.id).get()).get('categoryId');
    expect((await user(u.uid).collection('categories').doc(newCat).get()).get('name')).toBe('Reading list');
    // Re-save: merges tags, applies category null and note, returns the same id.
    const resave = await postJson(`${FN}/api/save`, { url: 'https://example.org/new-cat', tags: ['more'], category: null, categoryId: null, note: 'n2' }, auth);
    expect(resave.json).toMatchObject({ ok: true, id: created.json.id, existing: true });
    expect((await user(u.uid).collection('items').doc(created.json.id).get()).data()).toMatchObject({ categoryId: null, note: 'n2', tags: ['more'] });

    // Lookup (trailing-slash tolerant), unknown URL, bad URL.
    expect(await get(`/lookup?url=${encodeURIComponent('https://example.com/members/only-story/')}`)).toEqual({
      status: 200,
      json: { saved: true, id, status: 'unread', location: 'library' },
    });
    expect((await get(`/lookup?url=${encodeURIComponent('https://nowhere.example.net/x')}`)).json).toEqual({ saved: false });
    expect((await get('/lookup?url=notaurl')).status).toBe(400);

    const tags = await get('/tags');
    expect(tags.json.tags[0]).toBe('auto'); // most used: example.com items (Telegram link + captured page)
    expect(tags.json.tags).toEqual(expect.arrayContaining(['reading', 'captured', 'papers', 'todo', 'more']));
    expect((await get('/categories')).json).toEqual({ categories: [{ id: work.id, name: 'Work' }, { id: newCat, name: 'Reading list' }] });

    const items = await get('/items?status=unread&limit=3');
    expect(items.json.items).toHaveLength(3);
    expect(items.json.items[0]).toMatchObject({ id: created.json.id, url: 'https://example.org/new-cat', createdAt: expect.any(String) });
    expect(Object.keys(items.json.items[0]).sort()).toEqual(['createdAt', 'id', 'title', 'url']);
    // Feed items (emails) are not in the library list.
    const all = await get('/items?limit=100');
    expect(all.json.items.every((i: { title: string }) => i.title !== 'Mailgun issue')).toBe(true);

    // Errors: no key, oversize HTML.
    expect((await fetch(`${FN}/api/tags`)).status).toBe(401);
    const big = await postJson(`${FN}/api/save`, { url: 'https://example.com/big', html: 'x'.repeat(5 * 1024 * 1024 + 10) }, auth);
    expect(big.status).toBe(413);
  }, 120_000);

  it('feed poller: new entries carry source feed and get the auto rules', async () => {
    await user(u.uid).collection('rules').add({
      name: 'Feed',
      enabled: true,
      match: { field: 'feed', op: 'contains', value: 'integration' },
      actions: { addTags: ['from-feed'], archive: true },
      createdAt: new Date(),
    });
    const feedUrl = 'https://rules-feed.example.com/feed.xml';
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <title>Integration Rules Feed</title><link>https://rules-feed.example.com/</link>
      <item><title>Ruled entry</title><guid>ruled-1</guid><link>https://rules-feed.example.com/ruled-1</link>
      <pubDate>${new Date().toUTCString()}</pubDate><content:encoded><![CDATA[<p>${words}</p>]]></content:encoded></item>
    </channel></rss>`;
    const feedRef = await user(u.uid).collection('feeds').add({ url: feedUrl, title: '', siteUrl: null, categoryId: null, tags: ['rss'], fullText: false, lastFetchedAt: null, lastError: null });
    const { refreshFeed } = await import('../src/feeds/poll');
    mockFetch([[feedUrl, { body: rss, type: 'application/rss+xml' }]]);
    try {
      expect(await refreshFeed(u.uid, await feedRef.get())).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
    const [entry] = await itemsWhere(u.uid, 'feedId', feedRef.id);
    expect(entry).toMatchObject({ source: 'feed', location: 'feed', status: 'archived', rulesApplied: true, fetchStatus: 'done', tags: ['rss', 'auto', 'from-feed'] }); // 'auto': the domain rule covers subdomains
  });

  it('/unlink disconnects the chat', async () => {
    const n = tgCalls.length;
    await sendUpdate(tgUpdate({ chat: { id: CHAT, type: 'private' }, text: '/unlink' }));
    expect(callsSince(n).find((c) => c.method === 'sendMessage')?.body.text).toMatch(/^Disconnected/);
    expect((await admin.db.collection('telegramChats').doc(String(CHAT)).get()).exists).toBe(false);
    expect((await user(u.uid).collection('integrations').doc('telegram').get()).exists).toBe(false);
  });
});
