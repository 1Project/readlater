/**
 * HTTP API (`/api/**` via Hosting rewrite, or the function URL directly).
 *   GET  /api/health                       → { ok: true }
 *   POST /api/save   JSON {url,title?,tags?,category?} | form-encoded | text/plain containing a URL
 *   GET  /api/save?url=…&key=…[&title=&tags=&category=]
 * Auth: `Authorization: Bearer <key>` or `key` (query/body). CORS open (no cookies).
 */
import './options';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onRequest } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { isApiKeyFormat } from './apiKeys';
import { hit, HOUR } from './rateLimit';
import { categoryIdByName, saveForUser } from './saveUrl';
import { escapeHtml, normalizeTags, sha256, urlFromText } from './util';

export interface SaveParams {
  key: string | null;
  url: string | null;
  title: string | null;
  tags: string[];
  category: string | null;
}

export interface RawRequest {
  method: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

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
  text = text.slice(0, 100_000);
  if (!text.trim()) return {};
  if (ct.includes('json') || /^\s*\{/.test(text)) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through to text handling */
    }
  }
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

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const HTTPS_TO_STATUS: Record<string, number> = { 'invalid-argument': 400, 'not-found': 404, 'resource-exhausted': 429, unauthenticated: 401, 'permission-denied': 403 };

export const api = onRequest({ region: REGION, cors: false, timeoutSeconds: 60 }, async (req, res) => {
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
  const html = wantsHtml(req.method, String(req.headers.accept ?? ''));
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
    if (route !== '/save') throw new ApiError(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
    const p = parseSaveRequest({ method: req.method, query: req.query as Record<string, unknown>, headers: req.headers, body: req.body, rawBody: req.rawBody });
    if (!p.key) throw new ApiError(401, 'Missing API key');
    if (!isApiKeyFormat(p.key)) throw new ApiError(401, 'Invalid API key');
    const keyId = sha256(p.key);
    const keySnap = await db.collection('apiKeys').doc(keyId).get();
    const uid = keySnap.exists ? String(keySnap.get('uid') ?? '') : '';
    if (!uid) throw new ApiError(401, 'Invalid API key');
    const rl = await hit(`apikey:${keyId}`, 120, HOUR);
    if (!rl.allowed) {
      res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
      throw new ApiError(429, 'Rate limit exceeded (120 saves per hour)');
    }
    await db
      .collection('users').doc(uid).collection('apiKeys').doc(keyId)
      .update({ lastUsedAt: FieldValue.serverTimestamp() })
      .catch((e: unknown) => logger.warn('lastUsedAt update failed', e));
    if (!p.url) throw new ApiError(400, 'A valid http(s) URL is required');
    const categoryId = p.category ? await categoryIdByName(uid, p.category) : undefined;
    const saved = await saveForUser(uid, { url: p.url, title: p.title, tags: p.tags, categoryId });
    if (html) {
      res.status(200).type('html').send(savedPage(saved.title, true, viaHosting ? `/item/${encodeURIComponent(saved.id)}` : null));
    } else {
      res.status(200).json({ ok: true, id: saved.id });
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message);
    if (e instanceof HttpsError) return fail(HTTPS_TO_STATUS[e.code] ?? 500, e.message);
    logger.error('api error', e);
    fail(500, 'Internal error');
  }
});
