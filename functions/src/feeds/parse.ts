/**
 * Feed parsing: RSS 2.0 (and 0.9x), RSS 1.0 / RDF, Atom 1.0 and JSON Feed 1.x → one normalised shape.
 * Pure (no network, no Firebase) so it is unit-testable.
 */
import { XMLParser } from 'fast-xml-parser';
import { collapseWs, escapeHtml, httpUrl, textToHtml, toDate } from '../extract/html';
import { decodeHTML as decodeEntities } from 'entities';

export interface ParsedEntry {
  /** Stable identifier from the feed (RSS guid, Atom id, RDF about, JSON id); null when the feed gives none. */
  guid: string | null;
  /** Absolute http(s) link to the entry's page. */
  link: string | null;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  /** Unsanitized entry HTML (content:encoded > content > description/summary). Sanitize before storing. */
  html: string;
  /** Base URL for relative links/images in `html` (Atom xml:base, else the entry link). */
  contentBase: string | null;
  imageUrl: string | null;
}

export interface ParsedFeed {
  format: 'rss' | 'rdf' | 'atom' | 'json';
  title: string;
  siteUrl: string | null;
  description: string | null;
  entries: ParsedEntry[];
}

/** Hard cap on parsed entries (protects against huge archive feeds). */
export const MAX_ENTRIES = 1000;

type Obj = Record<string, unknown>;

/** Elements whose inner markup is kept raw, so we can tell escaped HTML, CDATA and inline XHTML apart. */
const RAW_TAGS = ['title', 'description', 'summary', 'content', 'content:encoded', 'subtitle'];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  stopNodes: RAW_TAGS.map((t) => `*.${t}`),
});

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function attr(v: unknown, name: string): string {
  const o = first(v);
  if (!isObj(o)) return '';
  const a = o[`@_${name}`];
  return typeof a === 'string' ? a.trim() : '';
}

/** Text of a parsed (non-raw) node. */
function txt(v: unknown): string {
  const o = first(v);
  if (o === undefined || o === null) return '';
  if (typeof o === 'string') return o.trim();
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (isObj(o) && '#text' in o) return txt(o['#text']);
  return '';
}

/** Inner content of a raw (stop) node, plus its `type` attribute. */
function raw(v: unknown): { value: string; type: string } {
  const o = first(v);
  if (typeof o === 'string') return { value: o, type: '' };
  if (typeof o === 'number') return { value: String(o), type: '' };
  if (isObj(o)) {
    const t = o['#text'];
    return { value: typeof t === 'string' ? t : typeof t === 'number' ? String(t) : '', type: attr(o, 'type').toLowerCase() };
  }
  return { value: '', type: '' };
}

const MARKUP = /<\/?[a-z][\w:-]*[\s/>]|<!--/i;

/** Raw element text → string: CDATA sections verbatim, other text entity-decoded once unless it is literal markup. */
function unwrapRaw(value: string): string {
  let out = '';
  let last = 0;
  for (const m of value.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += decodePart(value.slice(last, m.index));
    out += m[1];
    last = (m.index ?? 0) + m[0].length;
  }
  return (out + decodePart(value.slice(last))).trim();
}

function decodePart(s: string): string {
  if (!s) return '';
  return MARKUP.test(s) ? s : decodeEntities(s);
}

/**
 * Turn the raw inner text of an element into an HTML string, honouring an Atom-style `type`
 * ('xhtml' = inline markup, 'html' = escaped HTML, 'text' = plain text; '' = guess from the content).
 */
function rawToHtml(value: string, type = ''): string {
  if (!value) return '';
  if (type === 'xhtml' || type === 'application/xhtml+xml') return value.trim().replace(/\s+xmlns(:\w+)?="[^"]*"/g, '');
  const out = unwrapRaw(value);
  if (type === 'text' || type === 'text/plain') return textToHtml(out);
  // Plain text (e.g. arXiv abstracts) becomes escaped paragraphs.
  return MARKUP.test(out) ? out : textToHtml(out);
}

/** Plain-text title from a raw node (handles html/xhtml titles and double-encoded entities like &amp;#8217;). */
function rawToText(v: unknown): string {
  const { value, type } = raw(v);
  if (!value) return '';
  let s = type === 'xhtml' ? value : unwrapRaw(value);
  if (type !== 'text' && MARKUP.test(s)) s = s.replace(/<[^>]*>/g, ' ');
  return collapseWs(decodeEntities(s));
}

function plainText(html: string): string {
  return collapseWs(decodeEntities(html.replace(/<[^>]*>/g, ' ')));
}

function cleanTitle(s: string): string {
  const t = collapseWs(s);
  return t.length > 300 ? `${t.slice(0, 299).trimEnd()}…` : t;
}

/** Absolute entry link without tracking parameters (utm_*, Medium's source=rss…). */
function entryLink(href: string | null | undefined, base: string | null): string | null {
  const u = httpUrl(href, base);
  if (!u || !u.includes('?')) return u;
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(k) || (k === 'source' && /^rss/i.test(url.searchParams.get(k) ?? ''))) url.searchParams.delete(k);
    }
    return url.href;
  } catch {
    return u;
  }
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

function firstImgInHtml(html: string, base: string | null): string | null {
  const m = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
  const src = m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
  if (!src || /^data:/i.test(src)) return null;
  const u = httpUrl(src, base);
  // Skip obvious tracking pixels / feed-flare images.
  if (!u || /feeds\.feedburner\.com\/~|\/pixel|1x1|stats\.wordpress\.com|\/~r\/|doubleclick/i.test(u)) return null;
  return u;
}

/** Image from media:* / enclosure / itunes:image elements of an RSS item or Atom entry. */
function mediaImage(item: Obj, base: string | null): string | null {
  const nodes: unknown[] = [];
  const groups = arr(item['media:group']).filter(isObj);
  for (const src of [item, ...groups]) {
    for (const c of arr(src['media:content'])) {
      const medium = attr(c, 'medium').toLowerCase();
      const type = attr(c, 'type').toLowerCase();
      const url = attr(c, 'url');
      if (medium === 'image' || type.startsWith('image/') || (!medium && !type && IMG_EXT.test(url))) nodes.push(url);
      // A video's thumbnail nested in media:content.
      for (const t of arr(isObj(c) ? c['media:thumbnail'] : undefined)) nodes.push(attr(t, 'url'));
    }
    for (const t of arr(src['media:thumbnail'])) nodes.push(attr(t, 'url'));
  }
  for (const e of arr(item.enclosure)) {
    const type = attr(e, 'type').toLowerCase();
    const url = attr(e, 'url');
    if (type.startsWith('image/') || (!type && IMG_EXT.test(url))) nodes.push(url);
  }
  // Atom <link rel="enclosure" type="image/*">
  for (const l of arr(item.link)) {
    if (attr(l, 'rel') === 'enclosure' && attr(l, 'type').toLowerCase().startsWith('image/')) nodes.push(attr(l, 'href'));
  }
  nodes.push(attr(item['itunes:image'], 'href'));
  const img = item.image;
  if (typeof img === 'string') nodes.push(img);
  else if (isObj(img)) nodes.push(txt(img.url) || attr(img, 'href') || attr(img, 'url'));
  for (const n of nodes) {
    const u = typeof n === 'string' ? httpUrl(n, base) : null;
    if (u) return u;
  }
  return null;
}

/** A Media RSS text field, directly on the item or inside <media:group> (YouTube puts descriptions there). */
function mediaField(item: Obj, name: string): string {
  const group = first(item['media:group']);
  return txt(item[name]) || (isObj(group) ? txt(group[name]) : '');
}

/** "jane@example.com (Jane Doe)" → "Jane Doe". */
function cleanAuthor(s: string): string | null {
  let a = collapseWs(s);
  const paren = /^\S+@\S+\s*\((.+)\)$/.exec(a);
  if (paren) a = paren[1].trim();
  else if (/^\S+@\S+\.\S+$/.test(a)) return null;
  a = plainText(a);
  if (!a) return null;
  return a.length > 200 ? a.slice(0, 200) : a;
}

function resolveBase(xmlBase: string, base: string | null): string | null {
  return xmlBase ? httpUrl(xmlBase, base) ?? base : base;
}

// ---------------------------------------------------------------------------
// RSS 2.0 / 0.9x and RSS 1.0 (RDF)

function rssEntry(it: Obj, base: string | null): ParsedEntry {
  const guidNode = first(it.guid);
  const guid = txt(guidNode) || attr(it, 'rdf:about') || null;
  const permalink = attr(guidNode, 'isPermaLink').toLowerCase() !== 'false';
  const linkText = txt(it['feedburner:origLink']) || txt(it.link) || attr(it.link, 'href');
  let link = entryLink(linkText, base);
  if (!link && guid && permalink) link = entryLink(guid, null);
  if (!link) link = entryLink(attr(it, 'rdf:about'), null);

  const encoded = raw(it['content:encoded']);
  const content = raw(it.content);
  const desc = raw(it.description);
  const summary = raw(it.summary);
  let html = rawToHtml(encoded.value) || rawToHtml(content.value, content.type) || rawToHtml(desc.value) || rawToHtml(summary.value, summary.type);
  if (!html) {
    const md = mediaField(it, 'media:description') || txt(it['itunes:summary']);
    if (md) html = textToHtml(md);
  }
  const author = cleanAuthor(txt(it['dc:creator']) || txt(it.author) || txt(it['itunes:author']) || '');
  const published = toDate(txt(it.pubDate) || txt(it['dc:date']) || txt(it.published) || txt(it.updated) || txt(it['atom:updated']) || null);
  return {
    guid,
    link,
    title: cleanTitle(rawToText(it.title) || mediaField(it, 'media:title')),
    author,
    publishedAt: published,
    html,
    contentBase: link ?? base,
    imageUrl: mediaImage(it, link ?? base) ?? firstImgInHtml(html, link ?? base),
  };
}

function parseRss(rss: Obj, baseUrl: string): ParsedFeed {
  const channel = (first(rss.channel) ?? {}) as Obj;
  const siteUrl = httpUrl(txt(channel.link) || attr(channel.link, 'href'), baseUrl);
  const base = siteUrl ?? baseUrl;
  // RSS 0.91/2.0 keep items in <channel>; a few feeds put them next to it.
  const items = [...arr(channel.item), ...arr(rss.item)].filter(isObj);
  return {
    format: 'rss',
    title: cleanTitle(rawToText(channel.title)),
    siteUrl,
    description: rawToText(channel.description) || null,
    entries: items.slice(0, MAX_ENTRIES).map((it) => rssEntry(it, base)),
  };
}

function parseRdf(rdf: Obj, baseUrl: string): ParsedFeed {
  const channel = (first(rdf.channel) ?? {}) as Obj;
  const siteUrl = httpUrl(txt(channel.link), baseUrl);
  const base = siteUrl ?? baseUrl;
  const items = [...arr(rdf.item), ...arr(channel.item).filter((i) => isObj(i) && ('title' in i || 'link' in i))].filter(isObj);
  return {
    format: 'rdf',
    title: cleanTitle(rawToText(channel.title)),
    siteUrl,
    description: rawToText(channel.description) || null,
    entries: items.slice(0, MAX_ENTRIES).map((it) => rssEntry(it, base)),
  };
}

// ---------------------------------------------------------------------------
// Atom 1.0

function atomLink(links: unknown, base: string | null): string | null {
  const list = arr(links);
  const score = (l: unknown): number => {
    const rel = attr(l, 'rel') || 'alternate';
    const type = attr(l, 'type').toLowerCase();
    if (rel !== 'alternate') return -1;
    if (!type || type.includes('html')) return 2;
    return 1;
  };
  let best: unknown = null;
  let bestScore = -1;
  for (const l of list) {
    const s = typeof l === 'string' ? 2 : score(l);
    if (s > bestScore) {
      best = l;
      bestScore = s;
    }
  }
  if (bestScore < 0) return null;
  const href = typeof best === 'string' ? best : attr(best, 'href') || txt(best);
  return httpUrl(href, base);
}

function atomAuthor(v: unknown): string | null {
  const names = arr(v)
    .map((a) => (isObj(a) ? txt(a.name) || txt(a) : typeof a === 'string' ? a : ''))
    .map((s) => collapseWs(s))
    .filter(Boolean);
  return names.length ? cleanAuthor(names.slice(0, 3).join(', ')) : null;
}

function atomEntry(e: Obj, feedBase: string | null, feedAuthor: string | null, feedBaseDeclared: boolean): ParsedEntry {
  const base = resolveBase(attr(e, 'xml:base'), feedBase);
  const link = entryLink(atomLink(e.link, base), null) ?? entryLink(txt(e.id), null);
  const contentXmlBase = attr(e.content, 'xml:base');
  // An explicit xml:base is authoritative for relative URLs in the content; otherwise the entry's page is the best guess.
  const contentBase = contentXmlBase
    ? resolveBase(contentXmlBase, base)
    : feedBaseDeclared || attr(e, 'xml:base')
      ? base
      : (link ?? base);
  const content = raw(e.content);
  const summary = raw(e.summary);
  // Atom's default type is "text", but many feeds omit it for escaped HTML, so an absent type is guessed.
  let html = (attr(e.content, 'src') ? '' : rawToHtml(content.value, content.type)) || rawToHtml(summary.value, summary.type);
  if (!html) {
    const md = mediaField(e, 'media:description');
    if (md) html = textToHtml(md);
  }
  return {
    guid: txt(e.id) || null,
    link,
    title: cleanTitle(rawToText(e.title) || mediaField(e, 'media:title')),
    author: atomAuthor(e.author) ?? cleanAuthor(txt(e['dc:creator'])) ?? feedAuthor,
    publishedAt: toDate(txt(e.published) || txt(e.issued) || txt(e.updated) || txt(e.modified) || txt(e['dc:date']) || null),
    html,
    contentBase,
    imageUrl: mediaImage(e, link ?? base) ?? firstImgInHtml(html, contentBase),
  };
}

function parseAtom(feed: Obj, baseUrl: string): ParsedFeed {
  const base = resolveBase(attr(feed, 'xml:base'), baseUrl);
  const siteUrl = atomLink(feed.link, base);
  const feedAuthor = atomAuthor(feed.author);
  return {
    format: 'atom',
    title: cleanTitle(rawToText(feed.title)),
    siteUrl,
    description: rawToText(feed.subtitle) || null,
    entries: arr(feed.entry)
      .filter(isObj)
      .slice(0, MAX_ENTRIES)
      .map((e) => atomEntry(e, base, feedAuthor, !!attr(feed, 'xml:base'))),
  };
}

/** Remove a namespace prefix from every element name (for feeds written as <atom:feed>…). */
function stripPrefix(v: unknown, prefix: string): unknown {
  if (Array.isArray(v)) return v.map((x) => stripPrefix(x, prefix));
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, val] of Object.entries(v)) out[k.startsWith(`${prefix}:`) ? k.slice(prefix.length + 1) : k] = stripPrefix(val, prefix);
  return out;
}

// ---------------------------------------------------------------------------
// JSON Feed 1.x

function jsonStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function jsonAuthor(o: Obj): string | null {
  const list = Array.isArray(o.authors) ? o.authors : o.author ? [o.author] : [];
  const names = list.map((a) => (isObj(a) ? jsonStr(a.name) : '')).filter(Boolean);
  return names.length ? cleanAuthor(names.slice(0, 3).join(', ')) : null;
}

function parseJsonFeed(j: Obj, baseUrl: string): ParsedFeed {
  const siteUrl = httpUrl(jsonStr(j.home_page_url), baseUrl);
  const base = siteUrl ?? baseUrl;
  const feedAuthor = jsonAuthor(j);
  const items = (Array.isArray(j.items) ? j.items : []).filter(isObj).slice(0, MAX_ENTRIES);
  return {
    format: 'json',
    title: cleanTitle(plainText(jsonStr(j.title))),
    siteUrl,
    description: plainText(jsonStr(j.description)) || null,
    entries: items.map((it) => {
      const link = entryLink(jsonStr(it.url), base) ?? entryLink(jsonStr(it.external_url), base) ?? entryLink(jsonStr(it.id), null);
      const contentHtml = jsonStr(it.content_html);
      const contentText = jsonStr(it.content_text);
      const summary = jsonStr(it.summary);
      const html = contentHtml || (contentText ? textToHtml(contentText) : summary ? `<p>${escapeHtml(summary)}</p>` : '');
      let imageUrl = httpUrl(jsonStr(it.image), link ?? base) ?? httpUrl(jsonStr(it.banner_image), link ?? base);
      if (!imageUrl && Array.isArray(it.attachments)) {
        const att = it.attachments.find((a) => isObj(a) && jsonStr(a.mime_type).startsWith('image/')) as Obj | undefined;
        if (att) imageUrl = httpUrl(jsonStr(att.url), link ?? base);
      }
      return {
        guid: jsonStr(it.id) || null,
        link,
        title: cleanTitle(plainText(jsonStr(it.title))),
        author: jsonAuthor(it) ?? feedAuthor,
        publishedAt: toDate(jsonStr(it.date_published) || jsonStr(it.date_modified) || null),
        html,
        contentBase: link ?? base,
        imageUrl: imageUrl ?? firstImgInHtml(html, link ?? base),
      };
    }),
  };
}

// ---------------------------------------------------------------------------

export class NotAFeedError extends Error {
  constructor(message = 'This address is not an RSS, Atom or JSON feed') {
    super(message);
  }
}

/** Parse feed text (XML or JSON). Throws NotAFeedError when the text is not a recognisable feed. */
export function parseFeed(xmlOrJson: string, baseUrl: string): ParsedFeed {
  const text = (xmlOrJson ?? '').replace(/^﻿/, '').trim();
  if (!text) throw new NotAFeedError('The feed is empty');
  if (text.startsWith('{')) {
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw new NotAFeedError();
    }
    if (isObj(j) && (/jsonfeed\.org\/version\//i.test(jsonStr(j.version)) || (Array.isArray(j.items) && ('title' in j || 'home_page_url' in j)))) {
      return parseJsonFeed(j, baseUrl);
    }
    throw new NotAFeedError();
  }
  if (!text.startsWith('<')) throw new NotAFeedError();
  let doc: Obj;
  try {
    doc = parser.parse(text) as Obj;
  } catch {
    throw new NotAFeedError('The feed is not valid XML');
  }
  for (const [key, val] of Object.entries(doc)) {
    if (key.startsWith('?') || key.startsWith('#') || !isObj(val)) continue;
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (local === 'rss') return parseRss(val, baseUrl);
    if (local === 'RDF') return parseRdf(val, baseUrl);
    if (local === 'feed') return parseAtom((key.includes(':') ? stripPrefix(val, key.slice(0, key.indexOf(':'))) : val) as Obj, baseUrl);
    if (local === 'channel' && 'item' in val) return parseRss({ channel: val }, baseUrl);
  }
  throw new NotAFeedError();
}

/** True if the text parses as a feed. */
export function looksLikeFeed(text: string): boolean {
  try {
    parseFeed(text, 'https://example.com/');
    return true;
  } catch {
    return false;
  }
}
