/** Plain-text helpers and the final assembly of an `Extracted` result. */
import { collapseWs, toDate } from './html';
import type { Extracted, ItemType, PaperMeta } from './types';

export const EXCERPT_MAX = 400;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', shy: '', zwj: '', zwnj: '', bull: '•', middot: '·', deg: '°', times: '×',
  minus: '−', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK_TAG =
  /<\/?(?:p|div|section|article|aside|main|header|footer|nav|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|figure|figcaption|table|caption|thead|tbody|tfoot|tr|td|th|br|hr|details|summary)\b[^>]*>/gi;

/** Convert HTML to plain text; block elements become line breaks, paragraphs separated by a blank line. */
export function htmlToText(html: string): string {
  if (!html) return '';
  const s = html
    .replace(/<(script|style|template|annotation|annotation-xml)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v  -   　]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** ≤ 400 chars of plain text, cut on a word boundary with an ellipsis. */
export function makeExcerpt(text: string, max = EXCERPT_MAX): string {
  const t = collapseWs(text);
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s,;:\-–—(\[{"'“‘]+$/, '');
  return `${cut}…`;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-]*/gu;

/** Word count; CJK ideographs/kana count as one word each. */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, ' ') : text;
  return cjk + (rest.match(WORD)?.length ?? 0);
}

/** Truncate text to n chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  const t = collapseWs(s);
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}

export interface Draft {
  type: ItemType;
  html: string;
  title?: string | null;
  author?: string | null;
  siteName?: string | null;
  description?: string | null;
  /** Explicit excerpt source; when set (even to null) it replaces the description/text heuristic. */
  excerpt?: string | null;
  imageUrl?: string | null;
  publishedAt?: Date | string | number | null;
  canonicalUrl?: string | null;
  paper?: PaperMeta | null;
  file?: Extracted['file'];
  /** Precomputed plain text (otherwise derived from html). */
  text?: string;
}

function clean(s: string | null | undefined, max = 500): string | null {
  const t = collapseWs(s);
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Build the final `Extracted` value: plain text, word count, excerpt, normalised metadata. */
export function finalize(d: Draft): Extracted {
  const text = d.text ?? htmlToText(d.html);
  const desc = collapseWs(d.description);
  const excerpt = makeExcerpt(d.excerpt !== undefined ? d.excerpt ?? '' : desc.length >= 30 ? desc : text || desc);
  const imageUrl = d.imageUrl && /^https?:\/\//i.test(d.imageUrl) ? d.imageUrl : null;
  return {
    type: d.type,
    title: clean(d.title, 300),
    author: clean(d.author, 200),
    siteName: clean(d.siteName, 100),
    excerpt: excerpt || null,
    imageUrl,
    publishedAt: toDate(d.publishedAt ?? null),
    html: d.html,
    text,
    wordCount: countWords(text),
    canonicalUrl: d.canonicalUrl ?? null,
    paper: d.paper ?? null,
    file: d.file ?? null,
  };
}
