/**
 * Pure import / export helpers (no React, no Firebase) used by Settings, Feeds and Highlights.
 *
 * Exports:
 *   interface ImportEntry { url; title?; tags: string[]; archived: boolean; favorite: boolean; addedAt?: number (ms) }
 *   type ImportFormat = 'urls' | 'pocket-csv' | 'pocket-html' | 'instapaper-csv' | 'readwise-csv' | 'csv' | 'bookmarks-html' | 'opml'
 *   interface ParsedImport { format: ImportFormat; entries: ImportEntry[]; skipped: number }
 *   FORMAT_LABELS: Record<ImportFormat, string>
 *   parseCsv(text): string[][]                       RFC 4180 (quoted fields, "" escapes, CRLF/LF, BOM)
 *   parseUrlList(text): ImportEntry[]                one or more links per line; bare domains get https://
 *   parsePocketCsv / parseInstapaperCsv / parseReadwiseCsv / parseGenericCsv (rows: string[][]): ParsedImport
 *   parsePocketHtml(html) / parseBookmarksHtml(html): ParsedImport
 *   detectFormat(fileName, text): ImportFormat
 *   parseImport(fileName, text): ParsedImport        detect + parse ('opml' returns no entries: send the text to importOpml)
 *   urlKey(url): string                              comparison key (no fragment / tracking params / trailing slash, host lowercased, no www.)
 *   dedupeEntries(entries, existingUrls): { fresh: ImportEntry[]; duplicates: number }
 *                                                    drops links already saved and repeats in the file (merging their tags
 *                                                    and flags), sorted oldest first so the newest ends up on top
 *   cleanTag(tag): string                            same normalisation as lib/data normalizeTag
 *   interface HighlightGroup { title; url: string | null; author?: string | null; highlights: { text; note; createdAt?: Date | null }[] }
 *   highlightsToMarkdown(groups, exportedAt?: Date): string
 */

export interface ImportEntry {
  url: string;
  title?: string;
  tags: string[];
  archived: boolean;
  favorite: boolean;
  /** When it was originally saved (ms since epoch), if known. */
  addedAt?: number;
}

export type ImportFormat = 'urls' | 'pocket-csv' | 'pocket-html' | 'instapaper-csv' | 'readwise-csv' | 'csv' | 'bookmarks-html' | 'opml';

export interface ParsedImport {
  format: ImportFormat;
  entries: ImportEntry[];
  /** Rows that were not imported (no valid link, or Readwise feed items). */
  skipped: number;
}

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  urls: 'List of links',
  'pocket-csv': 'Pocket export (CSV)',
  'pocket-html': 'Pocket export (HTML)',
  'instapaper-csv': 'Instapaper export (CSV)',
  'readwise-csv': 'Readwise Reader export (CSV)',
  csv: 'CSV with a URL column',
  'bookmarks-html': 'Browser bookmarks (HTML)',
  opml: 'OPML feed list',
};

// ---------------------------------------------------------------------------
// Small helpers

export function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const n = cleanTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 30);
}

/** Return a normalised http(s) URL or null. */
function validUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Seconds or milliseconds since epoch, or a date string → ms. */
function parseTime(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function cleanTitle(raw: string | null | undefined, url: string): string | undefined {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t === url) return undefined;
  return t.slice(0, 500);
}

/** Split a tag field: "a|b", "a,b", "a;b", "['a', 'b']", '["a","b"]'. */
function splitTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let s = raw.trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
    return cleanTags(
      s
        .split(',')
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    );
  }
  return cleanTags(s.split(/[|,;]/));
}

// ---------------------------------------------------------------------------
// CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

type Getter = (row: string[], ...names: string[]) => string;

function headerIndex(rows: string[][]): { get: Getter; headers: string[] } {
  const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const get: Getter = (row, ...names) => {
    for (const name of names) {
      const i = headers.indexOf(name);
      if (i >= 0 && row[i] != null) return row[i];
    }
    return '';
  };
  return { get, headers };
}

export function parsePocketCsv(rows: string[][]): ParsedImport {
  const { get } = headerIndex(rows);
  const entries: ImportEntry[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const url = validUrl(get(row, 'url', 'given_url', 'resolved_url'));
    if (!url) {
      skipped++;
      continue;
    }
    const status = get(row, 'status').trim().toLowerCase();
    entries.push({
      url,
      title: cleanTitle(get(row, 'title', 'given_title', 'resolved_title'), url),
      tags: splitTags(get(row, 'tags')),
      archived: status === 'archive' || status === 'archived' || status === 'read' || status === '1',
      favorite: ['1', 'true', 'yes'].includes(get(row, 'favorite').trim().toLowerCase()),
      addedAt: parseTime(get(row, 'time_added')),
    });
  }
  return { format: 'pocket-csv', entries, skipped };
}

export function parseInstapaperCsv(rows: string[][]): ParsedImport {
  const { get } = headerIndex(rows);
  const entries: ImportEntry[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const url = validUrl(get(row, 'url'));
    if (!url) {
      skipped++;
      continue;
    }
    const folder = get(row, 'folder').trim();
    const f = folder.toLowerCase();
    const tags = splitTags(get(row, 'tags'));
    // Custom folders become tags ("Unread", "Archive" and "Starred" are Instapaper's built-in ones).
    if (folder && !['unread', 'archive', 'starred'].includes(f)) tags.unshift(...cleanTags([folder]));
    entries.push({
      url,
      title: cleanTitle(get(row, 'title'), url),
      tags: cleanTags(tags),
      archived: f === 'archive',
      favorite: f === 'starred',
      addedAt: parseTime(get(row, 'timestamp')),
    });
  }
  return { format: 'instapaper-csv', entries, skipped };
}

export function parseReadwiseCsv(rows: string[][]): ParsedImport {
  const { get } = headerIndex(rows);
  const entries: ImportEntry[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const location = get(row, 'location').trim().toLowerCase();
    const url = validUrl(get(row, 'url', 'source url'));
    // Feed entries in Reader are unread RSS items, not saved documents: leave them out.
    if (!url || location === 'feed') {
      skipped++;
      continue;
    }
    entries.push({
      url,
      title: cleanTitle(get(row, 'title'), url),
      tags: splitTags(get(row, 'document tags', 'tags')),
      archived: location === 'archive',
      favorite: location === 'shortlist',
      addedAt: parseTime(get(row, 'saved date', 'created date', 'saved_at')),
    });
  }
  return { format: 'readwise-csv', entries, skipped };
}

/** Any CSV with a url/link column (title and tags columns are used when present). */
export function parseGenericCsv(rows: string[][]): ParsedImport {
  const { get, headers } = headerIndex(rows);
  const urlCol = headers.findIndex((h) => h === 'url' || h === 'link' || h === 'href' || h === 'address');
  const entries: ImportEntry[] = [];
  let skipped = 0;
  const body = urlCol >= 0 ? rows.slice(1) : rows;
  for (const row of body) {
    const url = urlCol >= 0 ? validUrl(row[urlCol]) : validUrl(row.find((f) => validUrl(f)) ?? '');
    if (!url) {
      skipped++;
      continue;
    }
    entries.push({
      url,
      title: urlCol >= 0 ? cleanTitle(get(row, 'title', 'name'), url) : undefined,
      tags: urlCol >= 0 ? splitTags(get(row, 'tags', 'labels')) : [],
      archived: false,
      favorite: false,
      addedAt: urlCol >= 0 ? parseTime(get(row, 'created', 'date', 'added', 'time_added', 'timestamp')) : undefined,
    });
  }
  return { format: 'csv', entries, skipped };
}

// ---------------------------------------------------------------------------
// Plain lists of links

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

export function parseUrlList(text: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const found = line.match(URL_RE);
    const candidates = found ? found.map((u) => u.replace(/[).,;!?\]]+$/, '')) : DOMAIN_RE.test(line) ? [`https://${line}`] : [];
    for (const c of candidates) {
      const url = validUrl(c);
      if (url) out.push({ url, tags: [], archived: false, favorite: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML (Pocket legacy export, Netscape bookmarks)

function parseHtmlDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Pocket's legacy `ril_export.html`: `<h1>Unread</h1><ul><li><a href time_added tags>…</a></li></ul><h1>Read Archive</h1>…`.
 */
export function parsePocketHtml(html: string): ParsedImport {
  const doc = parseHtmlDoc(html);
  const entries: ImportEntry[] = [];
  let skipped = 0;
  let archived = false;
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 1 /* NodeFilter.SHOW_ELEMENT */);
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      archived = /archive|read/i.test(node.textContent ?? '') && !/unread/i.test(node.textContent ?? '');
    } else if (tag === 'a') {
      const url = validUrl(node.getAttribute('href'));
      if (!url) {
        skipped++;
        continue;
      }
      entries.push({
        url,
        title: cleanTitle(node.textContent, url),
        tags: splitTags(node.getAttribute('tags')),
        archived,
        favorite: false,
        addedAt: parseTime(node.getAttribute('time_added')),
      });
    }
  }
  return { format: 'pocket-html', entries, skipped };
}

/** Netscape bookmark file (exported by every browser, Pinboard, Raindrop…). Folders are not mapped. */
export function parseBookmarksHtml(html: string): ParsedImport {
  const doc = parseHtmlDoc(html);
  const entries: ImportEntry[] = [];
  let skipped = 0;
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const url = validUrl(a.getAttribute('href'));
    if (!url) {
      skipped++;
      continue;
    }
    const toread = a.getAttribute('toread');
    entries.push({
      url,
      title: cleanTitle(a.textContent, url),
      tags: splitTags(a.getAttribute('tags')),
      // Pinboard marks unread bookmarks with TOREAD="1"; everything else is a plain bookmark.
      archived: toread === '0',
      favorite: false,
      addedAt: parseTime(a.getAttribute('add_date') ?? a.getAttribute('time_added')),
    });
  }
  return { format: 'bookmarks-html', entries, skipped };
}

// ---------------------------------------------------------------------------
// Detection

export function detectFormat(fileName: string, text: string): ImportFormat {
  const name = fileName.toLowerCase();
  const head = text.slice(0, 4000);
  if (name.endsWith('.opml') || /<opml[\s>]/i.test(head)) return 'opml';
  if (/^\s*<(!doctype|html|head|body|dl|h1|ul|meta|title)/i.test(head) || name.endsWith('.html') || name.endsWith('.htm')) {
    if (/NETSCAPE-Bookmark-file/i.test(head)) return 'bookmarks-html';
    if (/<title>\s*Pocket Export/i.test(head) || (/time_added=/i.test(text) && /<h1>\s*(unread|read archive)/i.test(text))) return 'pocket-html';
    return 'bookmarks-html';
  }
  const firstLine = (text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim()) ?? '').toLowerCase();
  const looksCsv = name.endsWith('.csv') || (firstLine.includes(',') && !/^https?:\/\/\S+$/.test(firstLine.trim()));
  if (looksCsv) {
    const headers = (parseCsv(firstLine)[0] ?? []).map((h) => h.trim());
    const has = (h: string) => headers.includes(h);
    if (has('url') && has('folder') && (has('selection') || has('timestamp'))) return 'instapaper-csv';
    if ((has('url') || has('source url')) && (has('document tags') || (has('location') && has('saved date')))) return 'readwise-csv';
    if (has('url') && (has('time_added') || has('cursor'))) return 'pocket-csv';
    return 'csv';
  }
  return 'urls';
}

export function parseImport(fileName: string, text: string): ParsedImport {
  const format = detectFormat(fileName, text);
  switch (format) {
    case 'opml':
      return { format, entries: [], skipped: 0 };
    case 'pocket-html':
      return parsePocketHtml(text);
    case 'bookmarks-html':
      return parseBookmarksHtml(text);
    case 'pocket-csv':
      return parsePocketCsv(parseCsv(text));
    case 'instapaper-csv':
      return parseInstapaperCsv(parseCsv(text));
    case 'readwise-csv':
      return parseReadwiseCsv(parseCsv(text));
    case 'csv':
      return parseGenericCsv(parseCsv(text));
    case 'urls':
      return { format, entries: parseUrlList(text), skipped: 0 };
  }
}

// ---------------------------------------------------------------------------
// De-duplication

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi)$/i;

export function urlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    let s = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}`;
    const q = u.searchParams.toString();
    if (q) s += `?${q}`;
    return s;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function dedupeEntries(entries: ImportEntry[], existingUrls: Iterable<string | null | undefined>): { fresh: ImportEntry[]; duplicates: number } {
  const existing = new Set<string>();
  for (const u of existingUrls) if (u) existing.add(urlKey(u));
  const seen = new Map<string, ImportEntry>();
  let duplicates = 0;
  for (const e of entries) {
    const key = urlKey(e.url);
    if (existing.has(key)) {
      duplicates++;
      continue;
    }
    const prev = seen.get(key);
    if (prev) {
      duplicates++;
      prev.tags = cleanTags([...prev.tags, ...e.tags]);
      prev.archived = prev.archived || e.archived;
      prev.favorite = prev.favorite || e.favorite;
      prev.title = prev.title ?? e.title;
      if (e.addedAt != null && (prev.addedAt == null || e.addedAt < prev.addedAt)) prev.addedAt = e.addedAt;
      continue;
    }
    seen.set(key, { ...e, tags: cleanTags(e.tags) });
  }
  const fresh = [...seen.values()];
  // Oldest first, so the most recently saved link becomes the newest item. Unknown dates keep file order.
  const indexed = fresh.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    if (a.e.addedAt == null || b.e.addedAt == null) return a.i - b.i;
    return a.e.addedAt - b.e.addedAt || a.i - b.i;
  });
  return { fresh: indexed.map((x) => x.e), duplicates };
}

// ---------------------------------------------------------------------------
// Highlights → Markdown

export interface HighlightGroup {
  title: string;
  url: string | null;
  author?: string | null;
  highlights: { text: string; note: string; createdAt?: Date | null }[];
}

function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((l) => (l.trim() ? `> ${l.trim()}` : '>'))
    .join('\n');
}

function mdEscapeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]#])/g, '\\$1');
}

export function highlightsToMarkdown(groups: HighlightGroup[], exportedAt: Date = new Date()): string {
  const parts: string[] = [`# Readlater highlights`, '', `Exported ${exportedAt.toISOString().slice(0, 10)}`];
  for (const g of groups) {
    if (!g.highlights.length) continue;
    parts.push('', `## ${mdEscapeTitle(g.title || g.url || 'Untitled')}`, '');
    const meta: string[] = [];
    if (g.author) meta.push(`Author: ${g.author.trim()}`);
    if (g.url) meta.push(`Source: <${g.url}>`);
    if (meta.length) parts.push(meta.join('  \n'), '');
    g.highlights.forEach((h, i) => {
      if (i > 0) parts.push('');
      parts.push(quote(h.text));
      if (h.note.trim()) parts.push('', `**Note:** ${h.note.trim().replace(/\r?\n/g, '  \n')}`);
    });
  }
  return parts.join('\n') + '\n';
}
