/**
 * Feed discovery: find feed URLs for a web page (advertised <link rel="alternate">, well-known sites, common paths).
 * Pure (no network) so it is unit-testable; the caller fetches candidates in order.
 */
import { decodeHTML as decodeEntities } from 'entities';
import { httpUrl } from '../extract/html';

const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/feed+json', 'application/rdf+xml', 'application/json'];

/** Paths tried (relative to the page's directory, then the site root) when a page advertises nothing. */
export const FALLBACK_PATHS = ['feed', 'rss', 'atom.xml', 'index.xml', 'feed.xml', 'rss.xml'];

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?>$/, '').matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function baseHref(html: string, pageUrl: string): string {
  const m = /<base\b[^>]*>/i.exec(html);
  if (!m) return pageUrl;
  return httpUrl(attrsOf(m[0]).href, pageUrl) ?? pageUrl;
}

const YT_CHANNEL = /^UC[\w-]{22}$/;

/** Feed URLs that can be derived from the URL alone (YouTube, Substack, Medium, Reddit, GitHub). */
export function feedUrlsFromUrl(pageUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  const host = hostOf(u);
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const out: string[] = [];

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    if (segs[0] === 'channel' && segs[1] && YT_CHANNEL.test(segs[1])) out.push(`https://www.youtube.com/feeds/videos.xml?channel_id=${segs[1]}`);
    else if (segs[0] === 'playlist' && list) out.push(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(list)}`);
    else if (segs[0] === 'user' && segs[1]) out.push(`https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(segs[1])}`);
  } else if (host.endsWith('.substack.com') && host !== 'www.substack.com') {
    out.push(`https://${u.hostname.toLowerCase()}/feed`);
  } else if (host === 'medium.com') {
    const s0 = segs[0];
    if (s0 === 'feed') return [];
    if (s0 === 'tag' && segs[1]) out.push(`https://medium.com/feed/tag/${encodeURIComponent(segs[1])}`);
    else if (s0 && !['p', 'm', 'me', 'search', 'plans', 'about', 'membership', 'creators', 'topics'].includes(s0)) {
      out.push(`https://medium.com/feed/${s0.startsWith('@') ? `@${encodeURIComponent(s0.slice(1))}` : encodeURIComponent(s0)}`);
    }
  } else if (host.endsWith('.medium.com') && !host.startsWith('help.') && !host.startsWith('policy.')) {
    out.push(`https://${u.hostname.toLowerCase()}/feed`);
  } else if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
    if (!u.pathname.endsWith('.rss')) {
      const path = u.pathname.replace(/\/+$/, '').replace(/^\/u\//, '/user/');
      out.push(`https://www.reddit.com${path}/.rss`);
    }
  } else if (host === 'github.com') {
    const reserved = ['orgs', 'settings', 'topics', 'explore', 'marketplace', 'features', 'about', 'login', 'search', 'trending', 'sponsors', 'notifications'];
    if (segs[0] && !reserved.includes(segs[0]) && !/\.atom$/.test(u.pathname)) {
      if (segs[1]) out.push(`https://github.com/${segs[0]}/${segs[1].replace(/\.git$/, '')}/releases.atom`);
      else out.push(`https://github.com/${segs[0]}.atom`);
    }
  }
  return out;
}

/** YouTube channel id from a channel/handle/video page's HTML. */
export function youtubeChannelId(html: string): string | null {
  const patterns = [
    /<meta\s+itemprop=["']channelId["']\s+content=["'](UC[\w-]{22})["']/i,
    /<meta\s+itemprop=["']identifier["']\s+content=["'](UC[\w-]{22})["']/i,
    /<link\s+rel=["']canonical["']\s+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})["']/i,
    /"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /"browseId"\s*:\s*"(UC[\w-]{22})"/,
    /"channelId"\s*:\s*"(UC[\w-]{22})"/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

/** Feeds advertised with <link rel="alternate" type="…rss+xml|atom+xml|feed+json"> (comment feeds last). */
export function advertisedFeeds(html: string, pageUrl: string): string[] {
  const base = baseHref(html, pageUrl);
  const main: string[] = [];
  const comments: string[] = [];
  const head = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    const type = (a.type ?? '').toLowerCase().split(';')[0].trim();
    if (!rel.includes('alternate') || !FEED_TYPES.includes(type)) continue;
    // Plain application/json alternates are usually REST API links (e.g. WordPress /wp-json/); keep only explicit feeds.
    if (type === 'application/json' && !/feed/i.test(`${a.title ?? ''} ${a.href ?? ''}`)) continue;
    const href = httpUrl(a.href, base);
    if (!href) continue;
    const isComments = /comment/i.test(a.title ?? '') || /\/comments\/feed\/?$/i.test(href);
    (isComments ? comments : main).push(href);
  }
  return [...main, ...comments];
}

/** Common feed locations relative to the page's directory and the site root. */
export function fallbackFeedUrls(pageUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  // A short path like /blog or /blog/news is treated as a section with its own feed; deeper paths are articles.
  const segs = u.pathname.split('/').filter(Boolean);
  const dirs = segs.length >= 1 && segs.length <= 2 && !/\.\w{2,5}$/.test(segs[segs.length - 1]) ? [`/${segs.join('/')}/`, '/'] : ['/'];
  for (const d of dirs) for (const p of FALLBACK_PATHS) out.push(`${u.origin}${d}${p}`);
  return out;
}

function sameish(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Candidate feed URLs for an HTML page, best first: well-known site rules, advertised alternates,
 * and — only when nothing is advertised — the common fallback paths. Never includes the page itself.
 */
export function discoverFeedUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [...feedUrlsFromUrl(baseUrl)];
  let host = '';
  try {
    host = hostOf(new URL(baseUrl));
  } catch {
    return out;
  }
  if (host === 'youtube.com') {
    const id = youtubeChannelId(html);
    if (id) out.push(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  }
  const advertised = advertisedFeeds(html, baseUrl);
  out.push(...advertised);
  if (!advertised.length && /substackcdn\.com|substack\.com\/api/i.test(html)) out.push(`${new URL(baseUrl).origin}/feed`);
  if (!out.length) out.push(...fallbackFeedUrls(baseUrl));
  return [...new Set(out)].filter((u) => !sameish(u, baseUrl));
}
