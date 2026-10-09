/**
 * HTTP API (`/api/**` via Hosting rewrite, or the function URL directly).
 *   GET  /api/health                       → { ok: true }
 *   POST /api/save   JSON {url, title?, tags?, category?, categoryId?, note?, location?, source?, html?}
 *                    | form-encoded | text/plain containing a URL
 *   GET  /api/save?url=…&key=…[&title=&tags=&category=&note=&source=]
 *   GET  /api/lookup?url=…                 → { saved, id?, status?, location? }
 *   GET  /api/tags                         → { tags: string[] } (most used first)
 *   GET  /api/categories                   → { categories: {id, name}[] }
 *   GET  /api/items?status=unread&limit=20 → { items: {id, title, url, createdAt}[] } (library, newest first)
 * Auth: `Authorization: Bearer <key>` or `key` (query/body). CORS open (no cookies).
 *
 * `html` (≤ 5 MB) is the rendered page sent by the browser extension: it is stored as
 * users/{uid}/uploads/{itemId}/page.html and processItem extracts it instead of fetching the page.
 * `category` may be a category id or a name (a name that matches no category creates it); `categoryId` must
 * be an id. null clears the category.
 */
import './options';
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onRequest } from 'firebase-functions/v2/https';
import { bucket, db, REGION } from './admin';
import { isApiKeyFormat, keyScope } from './apiKeys';
import { hit, HOUR, MINUTE } from './rateLimit';
import { writeContent } from './content';
import { countWords, htmlToText, makeExcerpt } from './extract';
import { errorMessage, itemKeywords } from './processLogic';
import { loadRules, ruleContext, withRules } from './rules';
import { categoryIdByName, newItemData } from './saveUrl';
import { cleanSaveUrl, escapeHtml, guessType, normalizeTags, placeholderTitle, readingMinutes, sha256, urlFromText } from './util';

export interface SaveParams {
  key: string | null;
  url: string | null;
  title: string | null;
  tags: string[];
  category: string | null;
}

export type ItemSource = 'web' | 'app' | 'extension' | 'bookmarklet' | 'api' | 'telegram' | 'email' | 'feed' | 'import';
export const API_SOURCES = ['extension', 'bookmarklet', 'api'] as const;

/** Extra save fields (wave 2). Presence matters: undefined = not given. */
export interface SaveExtras {
  html: string | null;
  note: string | undefined;
  location: 'library' | 'feed' | undefined;
  source: (typeof API_SOURCES)[number];
  /** A category id (null = clear). */
  categoryId: string | null | undefined;
  /** A category id or name (null = clear). */
  category: string | null | undefined;
}

export interface RawRequest {
  method: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_NOTE_CHARS = 20_000;
const MAX_TEXT_BODY = 100_000;
const MAX_JSON_BODY = 8 * 1024 * 1024;

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown): string | null => {
  const x = first(v);
  return typeof x === 'string' && x.trim() ? x.trim() : null;
};
const header = (h: RawRequest['headers'], name: string): string => {
  const v = h[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/** Route of a request path, whether it came through the Hosting rewrite (/api/save) or directly (/save). */
export function routeOf(path: string): string {
  let p = (path || '/').replace(/\/+$/, '') || '/';
  if (p === '/api') p = '/';
  else if (p.startsWith('/api/')) p = p.slice(4);
  return p;
}

/** Turn a request body (already parsed object, string or Buffer) into a flat field map. */
export function bodyFields(body: unknown, rawBody: Buffer | undefined, contentType: string): Record<string, unknown> {
  const ct = contentType.toLowerCase();
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && Object.keys(body).length) return body as Record<string, unknown>;
  let text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
  if (!text && rawBody?.length) text = rawBody.toString('utf8');
  if (!text.trim()) return {};
  if ((ct.includes('json') || /^\s*\{/.test(text)) && text.length <= MAX_JSON_BODY) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through to text handling */
    }
  }
  text = text.slice(0, MAX_TEXT_BODY);
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return { text };
}

/** Extract save parameters from query string, headers and body (body wins over query). */
export function parseSaveRequest(r: RawRequest): SaveParams {
  const b = bodyFields(r.body, r.rawBody, header(r.headers, 'content-type'));
  const q = r.query ?? {};
  const pick = (k: string) => str(b[k]) ?? str(q[k]);
  const auth = header(r.headers, 'authorization');
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] ?? null;
  const rawUrl = pick('url') ?? pick('link') ?? pick('text');
  const tagsRaw = b.tags ?? q.tags;
  const tagsList = Array.isArray(tagsRaw) ? tagsRaw.flatMap((t) => (typeof t === 'string' ? t.split(',') : [])) : tagsRaw;
  return {
    key: bearer ?? pick('key'),
    url: rawUrl ? urlFromText(rawUrl) : null,
    title: pick('title')?.slice(0, 300) ?? null,
    tags: normalizeTags(tagsList),
    category: pick('category')?.slice(0, 60) ?? null,
  };
}

/** A category reference that may be absent (undefined), cleared (null / '') or set. */
function categoryRef(fields: Record<string, unknown>, query: Record<string, unknown>, k: string): string | null | undefined {
  const v = k in fields ? fields[k] : k in query ? first(query[k]) : undefined;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 128) : null;
}

/** The wave-2 fields of a save request (html, note, location, source, category id/name). */
export function parseSaveExtras(r: RawRequest): SaveExtras {
  const b = bodyFields(r.body, r.rawBody, header(r.headers, 'content-type'));
  const q = r.query ?? {};
  const html = typeof b.html === 'string' && b.html.trim() ? b.html : null;
  const noteRaw = 'note' in b ? b.note : first(q.note);
  const loc = str(b.location) ?? str(q.location);
  const src = (str(b.source) ?? str(q.source) ?? '').toLowerCase();
  return {
    html,
    note: typeof noteRaw === 'string' ? noteRaw.trim().slice(0, MAX_NOTE_CHARS) : undefined,
    location: loc === 'library' || loc === 'feed' ? loc : undefined,
    source: (API_SOURCES as readonly string[]).includes(src) ? (src as SaveExtras['source']) : 'api',
    categoryId: categoryRef(b, q, 'categoryId'),
    category: categoryRef(b, q, 'category'),
  };
}

export function wantsHtml(method: string, accept: string): boolean {
  return method === 'GET' && /text\/html/i.test(accept);
}

export function savedPage(title: string, ok: boolean, link?: string | null): string {
  const heading = ok ? 'Saved ✓' : 'Not saved';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} · Readlater</title>
<style>html{background:#fff;color:#000}body{font:18px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:32px 16px;max-width:560px}
h1{font-size:24px;margin:0 0 8px}p{margin:0 0 16px;overflow-wrap:anywhere}a{color:#000;display:inline-block;padding:12px 0;font-weight:600}</style>
</head><body><h1>${heading}</h1><p>${escapeHtml(title)}</p>${link ? `<a href="${escapeHtml(link)}">Open in Readlater</a>` : ''}
${ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script>' : ''}</body></html>`;
}

// ---------------------------------------------------------------------------- saving (shared by api, telegram, email)

const userDoc = (uid: string) => db.collection('users').doc(uid);
const isDocId = (id: string) => !!id && id.length <= 128 && !id.includes('/');

/**
 * Resolve a category reference: an existing category id wins, otherwise it is treated as a name (found
 * case-insensitively or created). null/'' clears; undefined leaves the category unchanged.
 */
export async function resolveCategory(uid: string, ref: string | null | undefined, opts: { allowName: boolean }): Promise<string | null | undefined> {
  if (ref === undefined || ref === null) return ref;
  if (isDocId(ref)) {
    const snap = await userDoc(uid).collection('categories').doc(ref).get();
    if (snap.exists) return ref;
  }
  if (!opts.allowName) return undefined;
  return categoryIdByName(uid, ref.slice(0, 60));
}

/** Category for a save request: `categoryId` (id) first, then `category` (id or name). */
export async function categoryForSave(uid: string, x: Pick<SaveExtras, 'categoryId' | 'category'>): Promise<string | null | undefined> {
  if (x.categoryId === null) return null;
  if (x.categoryId !== undefined) {
    const byId = await resolveCategory(uid, x.categoryId, { allowName: false });
    if (byId !== undefined) return byId;
  }
  return resolveCategory(uid, x.category, { allowName: true });
}

export interface IncomingLink {
  url: string;
  title?: string | null;
  tags?: string[];
  /** Resolved category id; undefined = leave unchanged (existing) / none (new). */
  categoryId?: string | null;
  /** undefined = leave unchanged (existing) / '' (new). */
  note?: string;
  location?: 'library' | 'feed';
  source: ItemSource;
  /** Rendered page HTML to extract instead of fetching the page (≤ MAX_HTML_BYTES). */
  html?: string | null;
}

export interface SavedLink {
  id: string;
  title: string;
  existing: boolean;
  /** Item status after the save (the processing state, for callers that wait for a title). */
  fetchStatus: string;
}

async function storeHtml(uid: string, itemId: string, html: string): Promise<{ path: string; name: string; contentType: string; size: number }> {
  const buf = Buffer.from(html, 'utf8');
  if (buf.length > MAX_HTML_BYTES) throw new HttpsError('invalid-argument', 'The page HTML is larger than 5 MB');
  const path = `users/${uid}/uploads/${itemId}/page.html`;
  await bucket().file(path).save(buf, { resumable: false, contentType: 'text/html; charset=utf-8', metadata: { cacheControl: 'private, max-age=0' } });
  return { path, name: 'page.html', contentType: 'text/html', size: buf.length };
}

/**
 * Save a link for a user. An existing item with the same URL is moved to the library and marked unread
 * (tags merged, category and note applied when given) — like the web client's addUrl(). When `html` is given
 * and the existing item failed to load, it is re-processed from that HTML.
 */
export async function saveIncomingLink(uid: string, input: IncomingLink): Promise<SavedLink> {
  const url = cleanSaveUrl(input.url);
  if (!url) throw new HttpsError('invalid-argument', 'A valid http(s) URL is required');
  const tags = normalizeTags(input.tags ?? []);
  const html = input.html || null;
  if (html && Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new HttpsError('invalid-argument', 'The page HTML is larger than 5 MB');
  const items = userDoc(uid).collection('items');
  const dup = await items.where('url', '==', url).limit(1).get();
  if (!dup.empty) {
    const d = dup.docs[0];
    const cur = d.data();
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (!(cur.location === 'feed' && input.location === 'feed')) Object.assign(patch, { location: 'library', status: 'unread', archivedAt: null });
    if (tags.length) patch.tags = normalizeTags([...((cur.tags as string[] | undefined) ?? []), ...tags]);
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.note !== undefined) patch.note = input.note.slice(0, MAX_NOTE_CHARS);
    const file = cur.file as { contentType?: string } | null | undefined;
    let fetchStatus = String(cur.fetchStatus ?? '');
    if (html && cur.fetchStatus === 'error' && (!file || file.contentType === 'text/html')) {
      patch.file = await storeHtml(uid, d.id, html);
      patch.fetchStatus = fetchStatus = 'pending';
      patch.fetchError = null;
    }
    await d.ref.update(patch);
    return { id: d.id, title: String(cur.title ?? '') || placeholderTitle(url), existing: true, fetchStatus };
  }
  const ref = items.doc();
  const title = (typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '') || placeholderTitle(url);
  const file = html ? await storeHtml(uid, ref.id, html) : null;
  await ref.set(
    newItemData({
      url,
      type: guessType(url),
      title,
      tags,
      categoryId: input.categoryId ?? null,
      note: (input.note ?? '').slice(0, MAX_NOTE_CHARS),
      location: input.location ?? 'library',
      source: input.source,
      file,
      fetchStatus: 'pending',
    }),
  );
  return { id: ref.id, title, existing: false, fetchStatus: 'pending' };
}

export interface ContentItem {
  /** Fixed item id (e.g. derived from a Telegram message); a new id when omitted. */
  id?: string;
  /** Item fields over the newItemData() defaults (url, type, title, author, siteName, location, tags, source, …). */
  fields: Record<string, unknown>;
  /** Sanitized content HTML. */
  html: string;
}

/**
 * Create an item whose content is already known (a Telegram note, an email newsletter): no extraction, the
 * content is written directly, the item is indexed for search and the user's auto rules are applied.
 * With an `id` that already exists, the content and metadata are replaced (title only while not locked).
 */
export async function saveContentItem(uid: string, input: ContentItem): Promise<{ id: string; title: string; existing: boolean }> {
  const items = userDoc(uid).collection('items');
  const ref = input.id ? items.doc(input.id) : items.doc();
  const text = htmlToText(input.html);
  const words = countWords(text);
  const meta: Record<string, unknown> = {
    ...input.fields,
    excerpt: text ? makeExcerpt(text) : null,
    wordCount: words || null,
    readingMinutes: words ? readingMinutes(words) : null,
  };
  const title = String(meta.title ?? '') || 'Untitled';
  const existing = input.id ? await ref.get() : null;
  let item: Record<string, unknown>;
  if (existing?.exists) {
    const cur = existing.data() ?? {};
    const patch: Record<string, unknown> = { ...meta, fetchStatus: 'processing', processingAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    if (cur.titleLocked === true) delete patch.title;
    // Keep the user's organisation of an item that already exists.
    for (const k of ['location', 'status', 'favorite', 'categoryId', 'note', 'createdAt', 'source']) delete patch[k];
    patch.tags = normalizeTags([...((cur.tags as string[] | undefined) ?? []), ...normalizeTags(meta.tags)]);
    await ref.update(patch);
    item = { ...cur, ...patch };
  } else {
    const rules = await loadRules(uid).catch((e: unknown) => {
      logger.warn('loading rules failed', { uid, error: (e as Error).message });
      return null;
    });
    // processingAt lets sweepItems recover the item if this function dies before the content is written.
    const fields = newItemData({ ...meta, title, fetchStatus: 'processing', processingAt: FieldValue.serverTimestamp() });
    item = rules ? withRules(rules, fields, await ruleContext(uid, rules, fields).catch(() => ({}))) : fields;
    await ref.create(item);
  }
  try {
    const chunks = await writeContent(ref, input.html);
    const batch = db.batch();
    batch.update(ref, { fetchStatus: 'done', fetchError: null, contentChunks: chunks, processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    batch.set(userDoc(uid).collection('search').doc(ref.id), { kw: itemKeywords(item, text) });
    await batch.commit();
  } catch (e) {
    await ref
      .update({ fetchStatus: 'error', fetchError: errorMessage(e), processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
      .catch(() => undefined);
    throw e;
  }
  return { id: ref.id, title: String(item.title ?? title), existing: !!existing?.exists };
}

// ---------------------------------------------------------------------------- read endpoints

/** URL spellings that count as "the same page" for lookup (trailing slash). */
export function lookupVariants(url: string): string[] {
  const out = [url];
  try {
    const u = new URL(url);
    if (!u.search && !u.hash) out.push(url.endsWith('/') ? url.slice(0, -1) : `${url}/`);
  } catch {
    /* ignore */
  }
  return [...new Set(out.filter(Boolean))];
}

async function lookup(uid: string, rawUrl: string | null): Promise<Record<string, unknown>> {
  const url = cleanSaveUrl(rawUrl ?? '');
  if (!url) throw new ApiError(400, 'A valid http(s) URL is required');
  const snap = await userDoc(uid).collection('items').where('url', 'in', lookupVariants(url)).select('status', 'location').limit(1).get();
  if (snap.empty) return { saved: false };
  const d = snap.docs[0];
  return { saved: true, id: d.id, status: d.get('status') ?? null, location: d.get('location') ?? null };
}

/** Tag counts → tags sorted by use (then alphabetically). */
export function rankTags(lists: unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const t of l) if (typeof t === 'string' && t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

const TAG_SCAN_LIMIT = 5000;

async function listTags(uid: string): Promise<string[]> {
  const snap = await userDoc(uid).collection('items').orderBy('createdAt', 'desc').select('tags').limit(TAG_SCAN_LIMIT).get();
  return rankTags(snap.docs.map((d) => d.get('tags')));
}

async function listCategories(uid: string): Promise<{ id: string; name: string }[]> {
  const snap = await userDoc(uid).collection('categories').get();
  return snap.docs
    .map((d) => ({ id: d.id, name: String(d.get('name') ?? ''), order: Number(d.get('order') ?? 0) }))
    .filter((c) => c.name)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }));
}

export interface ItemsQuery {
  status: 'unread' | 'archived' | 'all';
  location: 'library' | 'feed';
  limit: number;
}

export function parseItemsQuery(q: Record<string, unknown>): ItemsQuery {
  const s = str(q.status);
  const loc = str(q.location);
  const n = Number(str(q.limit) ?? 20);
  return {
    status: s === 'archived' || s === 'all' ? s : 'unread',
    location: loc === 'feed' ? 'feed' : 'library',
    limit: Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 20,
  };
}

const ITEMS_PAGE = 200;
const ITEMS_SCAN_LIMIT = 3000;

/**
 * Newest items matching a status/location. Scans by createdAt (single-field index, no composite index needed)
 * and filters in memory, reading at most ITEMS_SCAN_LIMIT documents.
 */
export async function listItems(uid: string, q: ItemsQuery): Promise<{ id: string; title: string; url: string | null; createdAt: string | null }[]> {
  const out: { id: string; title: string; url: string | null; createdAt: string | null }[] = [];
  const col = userDoc(uid).collection('items');
  let cursor: QueryDocumentSnapshot | null = null;
  for (let scanned = 0; scanned < ITEMS_SCAN_LIMIT && out.length < q.limit; ) {
    let query = col.orderBy('createdAt', 'desc').select('title', 'url', 'createdAt', 'status', 'location').limit(ITEMS_PAGE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    for (const d of snap.docs) {
      if (d.get('location') !== q.location) continue;
      if (q.status !== 'all' && d.get('status') !== q.status) continue;
      const created = d.get('createdAt');
      out.push({
        id: d.id,
        title: String(d.get('title') ?? ''),
        url: typeof d.get('url') === 'string' ? d.get('url') : null,
        createdAt: created instanceof Timestamp ? created.toDate().toISOString() : null,
      });
      if (out.length >= q.limit) break;
    }
    scanned += snap.size;
    if (snap.size < ITEMS_PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

// ---------------------------------------------------------------------------- handler

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const HTTPS_TO_STATUS: Record<string, number> = { 'invalid-argument': 400, 'not-found': 404, 'resource-exhausted': 429, unauthenticated: 401, 'permission-denied': 403 };
const READ_ROUTES = new Set(['/lookup', '/tags', '/categories', '/items']);
const LAST_USED_EVERY_MS = 10 * MINUTE;

/** Resolve the API key to a uid; records lastUsedAt (every save, reads at most every 10 minutes). */
async function authenticate(key: string | null, isSave: boolean): Promise<{ uid: string; keyId: string }> {
  if (!key) throw new ApiError(401, 'Missing API key');
  if (!isApiKeyFormat(key)) throw new ApiError(401, 'Invalid API key');
  const keyId = sha256(key);
  const keySnap = await db.collection('apiKeys').doc(keyId).get();
  const uid = keySnap.exists ? String(keySnap.get('uid') ?? '') : '';
  if (!uid) throw new ApiError(401, 'Invalid API key');
  // Save-only keys (the bookmarklet's) never read the library.
  if (!isSave && keyScope({ scope: keySnap.get('scope'), name: keySnap.get('name') }) !== 'all') throw new ApiError(403, 'This API key can only save');
  const last = keySnap.get('lastUsedAt');
  if (isSave || !(last instanceof Timestamp) || Date.now() - last.toMillis() > LAST_USED_EVERY_MS) {
    const now = FieldValue.serverTimestamp();
    await Promise.all([
      keySnap.ref.update({ lastUsedAt: now }),
      db.collection('users').doc(uid).collection('apiKeys').doc(keyId).update({ lastUsedAt: now }),
    ]).catch((e: unknown) => logger.warn('lastUsedAt update failed', e));
  }
  return { uid, keyId };
}

async function limit(key: string, max: number, res: { set: (k: string, v: string) => unknown }, message: string): Promise<void> {
  const rl = await hit(key, max, HOUR);
  if (!rl.allowed) {
    res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
    throw new ApiError(429, message);
  }
}

export const api = onRequest({ region: REGION, cors: false, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  const route = routeOf(req.path);
  const html = wantsHtml(req.method, String(req.headers.accept ?? '')) && route === '/save';
  const viaHosting = (req.path || '').startsWith('/api/');
  const fail = (status: number, error: string) => {
    if (html) res.status(status).type('html').send(savedPage(error, false));
    else res.status(status).json({ ok: false, error });
  };
  try {
    if (route === '/health') {
      if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
      res.json({ ok: true });
      return;
    }
    const raw: RawRequest = { method: req.method, query: req.query as Record<string, unknown>, headers: req.headers, body: req.body, rawBody: req.rawBody };
    if (READ_ROUTES.has(route)) {
      if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
      const { uid, keyId } = await authenticate(parseSaveRequest(raw).key, false);
      await limit(`apikeyread:${keyId}`, 3000, res, 'Rate limit exceeded (3000 requests per hour)');
      const q = req.query as Record<string, unknown>;
      if (route === '/lookup') res.json(await lookup(uid, str(q.url)));
      else if (route === '/tags') res.json({ tags: await listTags(uid) });
      else if (route === '/categories') res.json({ categories: await listCategories(uid) });
      else res.json({ items: await listItems(uid, parseItemsQuery(q)) });
      return;
    }
    if (route !== '/save') throw new ApiError(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
    const p = parseSaveRequest(raw);
    const { uid, keyId } = await authenticate(p.key, true);
    await limit(`apikey:${keyId}`, 120, res, 'Rate limit exceeded (120 saves per hour)');
    if (!p.url) throw new ApiError(400, 'A valid http(s) URL is required');
    const x = parseSaveExtras(raw);
    if (x.html && req.method === 'POST' && Buffer.byteLength(x.html, 'utf8') > MAX_HTML_BYTES) throw new ApiError(413, 'The page HTML is larger than 5 MB');
    const saved = await saveIncomingLink(uid, {
      url: p.url,
      title: p.title,
      tags: p.tags,
      categoryId: await categoryForSave(uid, x),
      note: x.note,
      location: x.location,
      source: x.source,
      html: req.method === 'POST' ? x.html : null,
    });
    if (html) {
      res.status(200).type('html').send(savedPage(saved.title, true, viaHosting ? `/item/${encodeURIComponent(saved.id)}` : null));
    } else {
      res.status(200).json({ ok: true, id: saved.id, existing: saved.existing });
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message);
    if (e instanceof HttpsError) return fail(HTTPS_TO_STATUS[e.code] ?? 500, e.message);
    logger.error('api error', e);
    fail(500, 'Internal error');
  }
});
