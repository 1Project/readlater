/** Small pure helpers shared by the core Cloud Functions (no Firebase imports here, so they are unit-testable). */
import { createHash, randomInt } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Cryptographically random string over `alphabet` (unbiased, via crypto.randomInt). */
export function randomString(length: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Truncate to at most n characters (adds an ellipsis when cut). */
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ---------------------------------------------------------------------------
// Item helpers — kept identical in behaviour to web/src/lib/data.ts (functions must not import web code).

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

export function normalizeTags(tags: unknown): string[] {
  const list = typeof tags === 'string' ? tags.split(',') : Array.isArray(tags) ? tags : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 30);
}

/** Pull the first http(s) URL out of arbitrary shared text (also accepts bare DOIs and bare domains). */
export function urlFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[).,;!?]+$/, '');
  const t = text.trim();
  if (/^10\.\d{4,9}\/\S+$/.test(t)) return `https://doi.org/${t}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

/** Validate and normalise a URL to save. Returns null when it is not a usable http(s) URL. */
export function cleanSaveUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const found = urlFromText(raw.slice(0, 4096));
  if (!found) return null;
  try {
    const u = new URL(found);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return found.length <= 2048 ? found : null;
  } catch {
    return null;
  }
}

export type ItemType = 'article' | 'tweet' | 'paper' | 'pdf' | 'epub' | 'video' | 'other';

export function guessType(url: string): ItemType {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^mobile\./, '');
    if (/^(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(host) && /\/status(es)?\/\d+/.test(u.pathname)) return 'tweet';
    if (host === 'arxiv.org' || host === 'doi.org' || host.endsWith('.semanticscholar.org') || host === 'openreview.net') return 'paper';
    if (/\.pdf$/i.test(u.pathname)) return 'pdf';
    if (/\.epub$/i.test(u.pathname)) return 'epub';
    if (/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)vimeo\.com$/.test(host)) return 'video';
  } catch {
    /* ignore */
  }
  return 'article';
}

export function placeholderTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return url;
  }
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const readingMinutes = (words: number): number => Math.ceil(words / 230);

/** Client IP of an HTTP request (Cloud Functions sits behind Google's front end, which sets x-forwarded-for). */
export function clientIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string {
  const xff = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

/** Public download URL for a Storage object carrying a firebaseStorageDownloadTokens token. */
export function storageDownloadUrl(bucketName: string, path: string, token: string, emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST): string {
  const origin = emulatorHost ? `http://${emulatorHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : 'https://firebasestorage.googleapis.com';
  return `${origin}/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

/** Turn an arbitrary (possibly nested) file name into a single safe Storage path segment. */
export function safeFileName(name: string, fallback = 'file'): string {
  const s = name
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120);
  return s || fallback;
}

/** Ids present in every list, in the order of the shortest list. */
export function intersectIds(lists: string[][]): string[] {
  if (!lists.length) return [];
  const sorted = [...lists].sort((a, b) => a.length - b.length);
  const rest = sorted.slice(1).map((l) => new Set(l));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of sorted[0]) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (rest.every((s) => s.has(id))) out.push(id);
  }
  return out;
}

/** Run promises with a deadline; rejects with `message` on timeout. */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
