/** DOIs: Crossref metadata + readable landing page, falling back to the abstract. */
import { FetchError, fetchBuffer, fetchJson } from '../http';
import { MAX_FILE_BYTES, extractFromResponse } from './generic';
import { collapseWs } from './html';
import { sanitizeHtml } from './sanitize';
import { countWords, finalize, htmlToText } from './text';
import type { Extracted, PaperMeta } from './types';

const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** DOI from a doi.org URL, `doi:` string, or bare `10.xxxx/…`; else null. */
export function parseDoi(input: string): string | null {
  let s = input.trim();
  s = s.replace(/^doi:\s*/i, '');
  if (DOI_RE.test(s)) return s.replace(/[.,;]+$/, '');
  try {
    const u = new URL(s);
    if (!/^(?:www\.|dx\.)?doi\.org$/i.test(u.hostname)) return null;
    const path = decodeURIComponent(u.pathname.slice(1));
    return DOI_RE.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** Crossref JATS abstract → sanitized HTML paragraphs. Pure. */
export function jatsToHtml(jats: string): string {
  const html = jats
    .replace(/<jats:title>\s*(abstract|summary)\s*<\/jats:title>/gi, '')
    .replace(/<(\/?)jats:title\b[^>]*>/gi, '<$1h3>')
    .replace(/<(\/?)jats:p\b[^>]*>/gi, '<$1p>')
    .replace(/<(\/?)jats:(italic|i)\b[^>]*>/gi, '<$1em>')
    .replace(/<(\/?)jats:(bold|b)\b[^>]*>/gi, '<$1strong>')
    .replace(/<(\/?)jats:sup\b[^>]*>/gi, '<$1sup>')
    .replace(/<(\/?)jats:sub\b[^>]*>/gi, '<$1sub>')
    .replace(/<(\/?)jats:list-item\b[^>]*>/gi, '<$1li>')
    .replace(/<(\/?)jats:list\b[^>]*>/gi, '<$1ul>')
    .replace(/<\/?jats:[^>]*>/gi, '')
    .replace(/<\/?(sec|abstract)\b[^>]*>/gi, '');
  const wrapped = /<p\b/i.test(html) ? html : `<p>${html}</p>`;
  return sanitizeHtml(wrapped);
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  subtitle?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  'container-title'?: string[];
  publisher?: string;
  abstract?: string;
  URL?: string;
  published?: { 'date-parts'?: number[][] };
  issued?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  link?: { URL: string; 'content-type'?: string }[];
}

export interface CrossrefMeta {
  doi: string;
  title: string | null;
  authors: string[];
  venue: string | null;
  publisher: string | null;
  published: Date | null;
  abstractHtml: string;
  pdfUrl: string | null;
}

function dateParts(d?: { 'date-parts'?: number[][] }): Date | null {
  const p = d?.['date-parts']?.[0];
  if (!p || !p[0]) return null;
  const dt = new Date(Date.UTC(p[0], (p[1] ?? 1) - 1, p[2] ?? 1));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Crossref `message` → normalised metadata. Pure. */
export function parseCrossref(w: CrossrefWork, doi: string): CrossrefMeta {
  const title = collapseWs([w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(': ')) || null;
  const authors = (w.author ?? [])
    .map((a) => collapseWs(a.name ?? [a.given, a.family].filter(Boolean).join(' ')))
    .filter(Boolean);
  return {
    doi: doi || w.DOI || '',
    title: title ? htmlToText(title).replace(/\s+/g, ' ') : null,
    authors,
    venue: w['container-title']?.[0] ? collapseWs(w['container-title'][0]) : null,
    publisher: w.publisher ? collapseWs(w.publisher) : null,
    published: dateParts(w.published) ?? dateParts(w['published-online']) ?? dateParts(w['published-print']) ?? dateParts(w.issued),
    abstractHtml: w.abstract ? jatsToHtml(w.abstract) : '',
    pdfUrl: w.link?.find((l) => l['content-type'] === 'application/pdf')?.URL ?? null,
  };
}

const THIN_WORDS = 150;

/** Combine Crossref metadata with the landing-page extraction. Pure. */
export function mergeDoi(doi: string, cr: CrossrefMeta | null, landing: Extracted | null): Extracted {
  const absText = cr?.abstractHtml ? htmlToText(cr.abstractHtml) : '';
  // A landing page that is not clearly longer than the abstract is a paywall/abstract page.
  const landingOk = !!landing && landing.wordCount >= Math.max(THIN_WORDS, countWords(absText) * 1.5);
  let html = '';
  if (landingOk) {
    const probe = collapseWs(absText).slice(0, 80).toLowerCase();
    const dup = probe.length > 20 && collapseWs(landing!.text).toLowerCase().includes(probe);
    html = (absText && !dup ? `<section><h2>Abstract</h2>${cr!.abstractHtml}</section>` : '') + landing!.html;
  } else if (absText) {
    html = `<section><h2>Abstract</h2>${cr!.abstractHtml}</section>`;
  } else if (landing) {
    html = landing.html;
  }
  const authors = cr?.authors.length ? cr.authors : landing?.paper?.authors ?? [];
  const year = (cr?.published ?? landing?.publishedAt)?.getUTCFullYear();
  const paper: PaperMeta = {
    ...(landing?.paper ?? {}),
    doi: cr?.doi ?? doi,
    ...(authors.length ? { authors } : {}),
    ...(cr?.venue ? { venue: cr.venue } : {}),
    ...(year ? { year } : {}),
    ...(cr?.pdfUrl ? { pdfUrl: cr.pdfUrl } : {}),
    ...(absText ? { abstract: absText.replace(/\s+/g, ' ').trim() } : {}),
  };
  const author = authors.length > 3 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ') || landing?.author || null;
  return finalize({
    type: 'paper',
    html,
    title: cr?.title ?? landing?.title ?? doi,
    author,
    siteName: cr?.venue ?? cr?.publisher ?? landing?.siteName ?? null,
    description: absText || landing?.excerpt || null,
    imageUrl: landing?.imageUrl ?? null,
    publishedAt: cr?.published ?? landing?.publishedAt ?? null,
    canonicalUrl: `https://doi.org/${cr?.doi ?? doi}`,
    paper,
    file: landing?.file ?? null,
  });
}

export async function extractDoi(doi: string): Promise<Extracted> {
  let cr: CrossrefMeta | null = null;
  try {
    const r = await fetchJson<{ message?: CrossrefWork }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'user-agent': 'Readlater/1.0 (read-it-later app)' },
    });
    if (r.message) cr = parseCrossref(r.message, doi);
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
  }
  let landing: Extracted | null = null;
  try {
    const res = await fetchBuffer(`https://doi.org/${doi}`, { maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000 });
    landing = await extractFromResponse(res);
  } catch {
    landing = null;
  }
  if (!cr && !landing) throw new Error(`Could not resolve DOI ${doi}`);
  return mergeDoi(doi, cr, landing);
}
