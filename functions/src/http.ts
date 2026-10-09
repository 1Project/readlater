/** Outbound HTTP helpers: proxy-aware fetch with timeouts and size limits. */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export interface FetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  headers: Headers;
  body: Buffer;
}

export class FetchError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  accept?: string;
}

/** Fetch a URL into a Buffer. Throws FetchError on non-2xx, timeout, or oversize bodies. */
export async function fetchBuffer(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const { timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024 } = opts;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs are supported');
  if (isPrivateHost(u.hostname)) throw new FetchError('Refusing to fetch a private address');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': BROWSER_UA,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status} fetching ${u.hostname}`, res.status);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) throw new FetchError(`Response too large (${Math.round(len / 1e6)} MB)`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          ctrl.abort();
          throw new FetchError(`Response too large (> ${Math.round(maxBytes / 1e6)} MB)`);
        }
        chunks.push(value);
      }
    }
    return {
      url: res.url || url,
      status: res.status,
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      headers: res.headers,
      body: Buffer.concat(chunks),
    };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if ((e as Error).name === 'AbortError') throw new FetchError(`Timed out fetching ${u.hostname}`);
    throw new FetchError(`Could not fetch ${u.hostname}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<FetchResult & { text: string }> {
  const r = await fetchBuffer(url, opts);
  return { ...r, text: decodeBody(r.body, r.contentType) };
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const r = await fetchBuffer(url, { accept: 'application/json', ...opts });
  return JSON.parse(r.body.toString('utf8')) as T;
}

/** Decode using the charset from content-type or <meta charset>, defaulting to utf-8. */
export function decodeBody(body: Buffer, contentType: string): string {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase()).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

/** Block obvious SSRF targets (metadata server, loopback, RFC1918 literals). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  return false;
}
