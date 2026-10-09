/**
 * Outbound HTTP helpers: proxy-aware fetch with timeouts, size limits and an SSRF guard.
 *
 * SSRF guard (every fetch of a user-supplied URL goes through fetchBuffer):
 * - only http(s); IP literals and host names of private / internal ranges are refused (isPrivateHost);
 * - redirects are followed by hand (at most MAX_REDIRECTS) and every Location is checked again;
 * - direct connections resolve the host name through safeLookup, which refuses private addresses at
 *   connect time, so DNS rebinding between a check and the connection cannot reach them;
 * - behind an HTTPS_PROXY (development) the proxy makes the connection: each host name is resolved
 *   first and refused when it points at a private address.
 *
 * A request that fails before any response arrives (connect timeout, reset, refused, DNS hiccup) is tried once
 * more while the timeout leaves room for it: every fetch here is a GET, so a retry cannot repeat a side effect.
 */
import { lookup as dnsLookup, promises as dnsPromises, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from 'undici';

const PROXIED = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);

if (PROXIED) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export const MAX_REDIRECTS = 10;
const PRIVATE_MESSAGE = 'Refusing to fetch a private address';

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

// ---------------------------------------------------------------------------- address checks

const blocked4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT (also cloud metadata, e.g. 100.100.100.200)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked4.addSubnet(net, prefix, 'ipv4');
}

const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (tunnels to an embedded IPv4 address)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** The 8 hextets of an IPv6 address (accepts an embedded dotted IPv4 tail), or null. */
export function parseIPv6(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    if (isIP(v4[1]) !== 4) return null;
    const [b0, b1, b2, b3] = v4[1].split('.').map(Number);
    a = `${a.slice(0, -v4[1].length)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved … addresses (IPv4 or IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare.split('%')[0]);
  if (kind === 4) return blocked4.check(bare, 'ipv4');
  if (kind !== 6) return true; // not an address: never treat it as public
  const h = parseIPv6(bare);
  if (!h) return true;
  // IPv4 inside IPv6: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d — check the IPv4 part.
  const zero = (n: number) => h.slice(0, n).every((x) => x === 0);
  const embedded =
    (zero(5) && h[5] === 0xffff) || (zero(6) && (h[6] !== 0 || h[7] > 1)) || (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0));
  if (embedded) {
    const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    return blocked4.check(v4, 'ipv4');
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  const canonical = h.map((x) => x.toString(16)).join(':');
  return blocked6.check(canonical, 'ipv6');
}

/**
 * Block obvious SSRF targets by name or literal address: internal names (no dot, localhost, *.internal,
 * *.local), and private / reserved IP literals in any notation the URL parser accepts.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  if (isIP(h.split('%')[0])) return isPrivateAddress(h);
  if (!h.includes('.')) return true; // "localhost", "metadata" and other search-domain names
  return h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.home.arpa');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup for outgoing connections that refuses host names resolving to any private address. */
export function safeLookup(hostname: string, options: LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts: LookupOptions = typeof options === 'function' ? {} : options;
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    if (!list.length) return cb(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
    if (list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(PRIVATE_MESSAGE), { code: 'EPRIVATEADDR' }), []);
    }
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

/** Behind a proxy: refuse a host name that resolves to a private address (unresolvable names are left to the proxy). */
async function checkResolvedHost(hostname: string): Promise<void> {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (isIP(h)) return;
  let list: LookupAddress[];
  try {
    list = await dnsPromises.lookup(h, { all: true });
  } catch {
    return;
  }
  if (list.some((a) => isPrivateAddress(a.address))) throw new FetchError(PRIVATE_MESSAGE);
}

let dispatcher: Dispatcher | null = null;
function guardedDispatcher(): Dispatcher {
  dispatcher ??= PROXIED ? new EnvHttpProxyAgent() : new Agent({ connect: { lookup: safeLookup } });
  return dispatcher;
}

/** The runtime's own fetch, captured at load time: tests that replace globalThis.fetch are honoured as is. */
const NATIVE_FETCH = globalThis.fetch;

function doFetch(url: string, init: RequestInit): Promise<Response> {
  if (globalThis.fetch !== NATIVE_FETCH) return globalThis.fetch(url, init);
  return undiciFetch(url, { ...(init as object), dispatcher: guardedDispatcher() } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/** Error codes of a request that failed before any response arrived, worth one more try. */
const RETRY_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
/** A retry is only started when at least this much of the fetch's timeout is left. */
const RETRY_MIN_LEFT_MS = 2_000;

function isTransient(e: unknown): boolean {
  for (let c = e as { code?: unknown; cause?: unknown; name?: unknown } | undefined, i = 0; c && i < 5; c = c.cause as typeof c, i++) {
    if (c.name === 'AbortError') return false;
    if (typeof c.code === 'string' && RETRY_CODES.has(c.code)) return true;
  }
  return false;
}

/** One request of a fetch, tried a second time after a transient connection failure. */
async function fetchHop(url: string, init: RequestInit, deadline: number): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    if (!isTransient(e) || init.signal?.aborted || deadline - Date.now() < RETRY_MIN_LEFT_MS) throw e;
    return doFetch(url, init);
  }
}

/** Check one URL of a fetch (the first one or a redirect target). */
async function assertFetchable(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs are supported');
  if (u.username || u.password) throw new FetchError('URLs with credentials are not supported');
  if (isPrivateHost(u.hostname)) throw new FetchError(PRIVATE_MESSAGE);
  if (PROXIED) await checkResolvedHost(u.hostname);
}

function causeChain(e: unknown): string {
  const parts: string[] = [];
  for (let c = e as { message?: string; cause?: unknown } | undefined, i = 0; c && i < 5; c = c.cause as typeof c, i++) {
    if (c.message) parts.push(c.message);
  }
  return parts.join(' ');
}

/** Fetch a URL into a Buffer. Throws FetchError on non-2xx, timeout, oversize bodies or private targets. */
export async function fetchBuffer(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const { timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024 } = opts;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchError('Invalid URL');
  }
  await assertFetchable(u);
  const ctrl = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {
    'user-agent': BROWSER_UA,
    accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    ...opts.headers,
  };
  try {
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await fetchHop(u.href, { redirect: 'manual', signal: ctrl.signal, headers }, deadline);
      const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new FetchError(`Too many redirects fetching ${u.hostname}`);
      let next: URL;
      try {
        next = new URL(location, u);
      } catch {
        throw new FetchError(`Invalid redirect from ${u.hostname}`);
      }
      await assertFetchable(next);
      u = next;
    }
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
      url: res.url || u.href,
      status: res.status,
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      headers: res.headers,
      body: Buffer.concat(chunks),
    };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if ((e as Error).name === 'AbortError') throw new FetchError(`Timed out fetching ${u.hostname}`);
    const why = causeChain(e);
    if (why.includes(PRIVATE_MESSAGE)) throw new FetchError(PRIVATE_MESSAGE);
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
