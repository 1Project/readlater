/** arXiv papers: Atom API metadata + LaTeXML HTML (or PDF text) content. */
import { XMLParser } from 'fast-xml-parser';
import { FetchError, fetchBuffer, fetchText } from '../http';
import { MAX_FILE_BYTES, extractFromHtml } from './generic';
import { collapseWs, escapeHtml, parseHtml, toDate } from './html';
import { extractMeta } from './meta';
import { extractPdf } from './pdf';
import { sanitizeHtml } from './sanitize';
import { finalize } from './text';
import type { Extracted, PaperMeta } from './types';

const NEW_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_ID = /^([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

export interface ArxivRef {
  /** Id as given, including a version suffix when present (e.g. 2401.12345v2). */
  id: string;
  /** Id without version. */
  baseId: string;
}

function matchId(s: string): ArxivRef | null {
  const t = s.replace(/\.pdf$/i, '').replace(/\/+$/, '');
  const m = NEW_ID.exec(t) ?? OLD_ID.exec(t);
  return m ? { id: m[1] + (m[2] ?? ''), baseId: m[1] } : null;
}

/** Recognise arXiv URLs (abs/pdf/html/format) and `arXiv:ID` strings. */
export function parseArxivInput(input: string): ArxivRef | null {
  const s = input.trim();
  const pref = /^arxiv:\s*(\S+)$/i.exec(s);
  if (pref) return matchId(pref[1]);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^(?:www\.|export\.|browse\.)?arxiv\.org$/i.test(u.hostname)) return null;
  const m = /^\/(?:abs|pdf|html|format|ps)\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  // /html/2401.12345v1/x1.png etc.: take the id part only.
  const path = decodeURIComponent(m[1]);
  const newStyle = /^(\d{4}\.\d{4,5}(?:v\d+)?)/.exec(path);
  if (newStyle) return matchId(newStyle[1]);
  const oldStyle = /^([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/.exec(path);
  return oldStyle ? matchId(oldStyle[1]) : null;
}

export interface ArxivMeta {
  title: string;
  abstract: string;
  authors: string[];
  published: Date | null;
  pdfUrl: string | null;
  doi: string | null;
  journalRef: string | null;
  category: string | null;
}

const atom = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['entry', 'author', 'link', 'category'].includes(name),
});

/** Parse the export.arxiv.org Atom response. Returns null when there is no entry; throws on API errors. Pure. */
export function parseArxivAtom(xml: string): ArxivMeta | null {
  const doc = atom.parse(xml) as { feed?: { entry?: Record<string, unknown>[] } };
  const entry = doc.feed?.entry?.[0];
  if (!entry) return null;
  const id = String(entry.id ?? '');
  if (/\/api\/errors/.test(id)) throw new Error(`arXiv: ${collapseWs(String(entry.summary ?? 'invalid id'))}`);
  const links = (entry.link as Record<string, string>[] | undefined) ?? [];
  const pdf = links.find((l) => l['@_title'] === 'pdf' || l['@_type'] === 'application/pdf');
  const authors = ((entry.author as { name?: unknown }[] | undefined) ?? []).map((a) => collapseWs(String(a.name ?? ''))).filter(Boolean);
  const primary = entry.primary_category as Record<string, string> | undefined;
  return {
    title: collapseWs(String(entry.title ?? '')),
    abstract: collapseWs(String(entry.summary ?? '')),
    authors,
    published: toDate(String(entry.published ?? '')),
    pdfUrl: pdf?.['@_href']?.replace(/^http:/, 'https:') ?? null,
    doi: entry.doi ? collapseWs(String(entry.doi)) : null,
    journalRef: entry.journal_ref ? collapseWs(String(entry.journal_ref)) : null,
    category: primary?.['@_term'] ?? null,
  };
}

/** Metadata from the abs page's citation_* tags (fallback when the API is rate-limited). */
export function parseArxivAbsPage(html: string, url: string): ArxivMeta | null {
  const dom = parseHtml(html, url);
  try {
    const meta = extractMeta(dom.window.document, url);
    const c = meta.citation;
    if (!c?.title) return null;
    return {
      title: c.title,
      abstract: collapseWs(c.abstract ?? meta.description ?? ''),
      authors: c.authors,
      published: c.date,
      pdfUrl: c.pdfUrl,
      doi: c.doi && !c.doi.includes('arXiv') ? c.doi : null,
      journalRef: null,
      category: null,
    };
  } finally {
    dom.window.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchArxivMeta(ref: ArxivRef): Promise<ArxivMeta> {
  const api = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.id)}&max_results=1`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchText(api, { accept: 'application/atom+xml', timeoutMs: 15_000 });
      const meta = parseArxivAtom(r.text);
      if (meta && meta.title) return meta;
      break;
    } catch (e) {
      if (e instanceof FetchError && (e.status === 429 || e.status === 503) && attempt === 0) {
        await sleep(3500);
        continue;
      }
      if (!(e instanceof FetchError)) throw e; // API reported an invalid id
      break;
    }
  }
  const absUrl = `https://arxiv.org/abs/${ref.id}`;
  const r = await fetchText(absUrl).catch((e: unknown) => {
    if (e instanceof FetchError && e.status === 404) throw new Error(`arXiv paper ${ref.id} was not found`);
    throw e;
  });
  const meta = parseArxivAbsPage(r.text, r.url);
  if (!meta) throw new Error(`Could not read arXiv metadata for ${ref.id}`);
  return meta;
}

/** Clean an arXiv LaTeXML HTML page into content HTML (without title/authors/abstract). Pure. */
export function arxivHtmlContent(html: string, url: string): string {
  const dom = parseHtml(html, url);
  try {
    const doc = dom.window.document;
    const article = doc.querySelector('article.ltx_document') ?? doc.querySelector('.ltx_page_content') ?? null;
    if (!article) {
      // Not LaTeXML output: run the generic pipeline instead.
      return extractFromHtml(html, url).html;
    }
    article
      .querySelectorAll(
        '.ltx_title_document, .ltx_authors, .ltx_abstract, .ltx_dates, .ltx_page_header, .ltx_page_footer, .ltx_role_affiliation, .ltx_tag_note, nav, header, footer, .package-alerts, .ltx_ERROR, button',
      )
      .forEach((el) => el.remove());
    article.querySelectorAll('.ltx_note_frontmatter').forEach((el) => el.remove());
    // Footnotes are rendered inline by LaTeXML and hidden with CSS; show them as small parentheticals.
    for (const note of Array.from(article.querySelectorAll('.ltx_note'))) {
      const content = note.querySelector('.ltx_note_content');
      content?.querySelectorAll('.ltx_note_mark, .ltx_note_type').forEach((el) => el.remove());
      const small = doc.createElement('small');
      if (content && collapseWs(content.textContent)) {
        small.append(' (', ...Array.from(content.childNodes), ')');
        note.replaceWith(small);
      } else note.remove();
    }
    return sanitizeHtml(article.innerHTML, doc.baseURI || url);
  } finally {
    dom.window.close();
  }
}

function paperHtml(meta: ArxivMeta, body: string): string {
  const abs = meta.abstract ? `<section><h2>Abstract</h2><p>${escapeHtml(meta.abstract)}</p></section>` : '';
  return abs + body;
}

export async function extractArxiv(ref: ArxivRef): Promise<Extracted> {
  const meta = await fetchArxivMeta(ref);
  const pdfUrl = meta.pdfUrl ?? `https://arxiv.org/pdf/${ref.id}`;
  let body = '';
  let file: Extracted['file'] = null;

  try {
    const r = await fetchText(`https://arxiv.org/html/${ref.id}`, { timeoutMs: 30_000 });
    if (r.contentType.includes('html') && r.text.includes('ltx_')) body = arxivHtmlContent(r.text, r.url);
  } catch {
    body = '';
  }
  if (!body) {
    try {
      const r = await fetchBuffer(pdfUrl, { maxBytes: MAX_FILE_BYTES, timeoutMs: 60_000, accept: 'application/pdf' });
      const pdf = await extractPdf(r.body, { url: r.url, name: `${ref.id.replace(/\//g, '_')}.pdf` });
      body = pdf.html;
      file = pdf.file ?? null;
    } catch {
      body = '';
    }
  }

  const year = meta.published?.getUTCFullYear();
  const paper: PaperMeta = {
    arxivId: ref.baseId,
    authors: meta.authors,
    pdfUrl,
    ...(meta.abstract ? { abstract: meta.abstract } : {}),
    ...(meta.doi ? { doi: meta.doi } : {}),
    ...(meta.journalRef ? { venue: meta.journalRef } : {}),
    ...(year ? { year } : {}),
  };
  const author = meta.authors.length > 3 ? `${meta.authors.slice(0, 3).join(', ')} et al.` : meta.authors.join(', ') || null;
  return finalize({
    type: 'paper',
    html: paperHtml(meta, body),
    title: meta.title,
    author,
    siteName: 'arXiv',
    description: meta.abstract,
    imageUrl: null,
    publishedAt: meta.published,
    canonicalUrl: `https://arxiv.org/abs/${ref.baseId}`,
    paper,
    file,
  });
}
