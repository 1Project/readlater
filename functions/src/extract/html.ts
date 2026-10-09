/** Small HTML/DOM helpers shared by the extractors. */
import { JSDOM, VirtualConsole } from 'jsdom';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Parse an HTML string with jsdom (no scripts, no subresources, console silenced). */
export function parseHtml(html: string, url?: string | null): JSDOM {
  let docUrl: string | undefined;
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') docUrl = u.href;
    } catch {
      docUrl = undefined;
    }
  }
  // Inline CSS is never needed for extraction and is expensive for jsdom to parse.
  const stripped = html.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  return new JSDOM(stripped, { url: docUrl, virtualConsole: new VirtualConsole() });
}

/** Parse XHTML (EPUB chapters); falls back to the HTML parser for malformed markup. */
export function parseXhtml(xml: string): JSDOM {
  try {
    return new JSDOM(xml, { contentType: 'application/xhtml+xml', virtualConsole: new VirtualConsole() });
  } catch {
    return new JSDOM(xml.replace(/^\s*<\?xml[^>]*>/, ''), { virtualConsole: new VirtualConsole() });
  }
}

/** Resolve a possibly-relative URL; returns null for anything that is not absolute http(s)/mailto. */
export function absolutize(href: string | null | undefined, base?: string | null): string | null {
  if (!href) return null;
  const h = href.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!h) return null;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
    return null;
  } catch {
    return null;
  }
}

/** Absolute http(s) URL or null. */
export function httpUrl(href: string | null | undefined, base?: string | null): string | null {
  const u = absolutize(href, base);
  return u && /^https?:/i.test(u) ? u : null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

/** Escape plain text and turn bare URLs into links (no newline handling). */
export function linkify(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    out += escapeHtml(text.slice(last, idx));
    const url = m[0];
    out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = idx + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * Convert already-escaped inline HTML containing newlines into paragraphs:
 * blank lines separate paragraphs, single newlines become <br>.
 */
export function newlinesToParagraphs(inlineHtml: string): string {
  return inlineHtml
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Plain text (with newlines) → linkified paragraphs. */
export function textToHtml(text: string): string {
  return newlinesToParagraphs(linkify(text));
}

export function collapseWs(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Last path segment of a URL, decoded, or null. */
export function fileNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!seg) return null;
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** Remove a file extension and turn separators into spaces ("my_paper-v2.pdf" → "my paper-v2"). */
export function titleFromFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim();
  return t || null;
}

/** Parse a date-ish value; returns null for invalid or implausible dates. */
export function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  let d: Date;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') d = new Date(v);
  else if (typeof v === 'string') {
    let s = v.trim();
    const slash = /^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/.exec(s);
    if (slash) s = `${slash[1]}-${slash[2].padStart(2, '0')}-${(slash[3] ?? '1').padStart(2, '0')}`;
    if (/^\d{4}$/.test(s)) s = `${s}-01-01`;
    if (/^\d{4}-\d{2}$/.test(s)) s = `${s}-01`;
    // PDF dates: D:YYYYMMDDHHmmSS
    const pdf = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
    if (pdf && /^D:/.test(s)) {
      s = `${pdf[1]}-${pdf[2] ?? '01'}-${pdf[3] ?? '01'}T${pdf[4] ?? '00'}:${pdf[5] ?? '00'}:${pdf[6] ?? '00'}Z`;
    }
    d = new Date(s);
  } else return null;
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  if (d.getUTCFullYear() < 1000 || t > Date.now() + 2 * 86_400_000) return null;
  return d;
}

/** Run async tasks with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
