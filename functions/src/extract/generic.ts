/** Generic web page extraction: fetch → content-type sniffing → Readability on jsdom → sanitize. */
import { Readability } from '@mozilla/readability';
import { fetchBuffer, decodeBody, type FetchResult } from '../http';
import { extractEpub } from './epub';
import { collapseWs, escapeHtml, fileNameFromUrl, httpUrl, parseHtml, titleFromFileName } from './html';
import { cleanAuthor, extractMeta, type PageMeta } from './meta';
import { extractPdf } from './pdf';
import { NOTE_CLASS, fixLazyImages, sanitizeHtml } from './sanitize';
import { finalize, htmlToText } from './text';
import type { Extracted, UploadImage } from './types';
import { fetchSnapshot, isArchiveWorthyError, looksBlocked, looksPaywalled, markArchived } from './wayback';

export interface ExtractUrlOptions {
  /** Used when a URL turns out to be an EPUB; without it, book images are dropped. */
  uploadImage?: UploadImage;
  /** Try the Internet Archive when the page is dead, blocked or paywalled (default true). */
  wayback?: boolean;
}

export const MAX_HTML_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Below this many words a paywalled or blocked page is retried from the Internet Archive. */
export const ARCHIVE_MIN_WORDS = 200;

/**
 * Fetch any URL and extract it, delegating PDFs/EPUBs to their extractors. When the fetch fails (HTTP error,
 * timeout, dead host) or the page is a short paywall/bot-wall stub, the latest Wayback snapshot is used instead.
 */
export async function extractGeneric(url: string, opts: ExtractUrlOptions = {}): Promise<Extracted> {
  const wayback = opts.wayback !== false;
  let res: FetchResult;
  try {
    res = await fetchBuffer(url, { maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000 });
  } catch (e) {
    if (wayback && isArchiveWorthyError(e)) {
      const archived = await extractFromArchive(url, opts);
      if (archived) return archived;
    }
    throw e;
  }
  const r = await extractFromResponse(res, opts, 0);
  if (wayback && r.wordCount < ARCHIVE_MIN_WORDS && looksLikeHtml(res.contentType, res.body)) {
    const html = decodeBody(res.body, res.contentType);
    if (looksBlocked(html) || looksPaywalled(html, r.text)) {
      const archived = await extractFromArchive(url, opts);
      if (archived && archived.wordCount > r.wordCount * 1.5) return archived;
    }
  }
  return r;
}

/** Extract the latest Internet Archive snapshot of `url`, or null when there is none / it is unusable. */
export async function extractFromArchive(url: string, opts: ExtractUrlOptions = {}): Promise<Extracted | null> {
  const snap = await fetchSnapshot(url);
  if (!snap) return null;
  try {
    // `id_` snapshots are the original bytes: extract them against the original URL (depth 2: no meta-refresh hops).
    const r = await extractFromResponse({ ...snap.res, url: snap.snapshot.original }, opts, 2);
    return r.text || r.html ? markArchived(r, snap.snapshot, url) : null;
  } catch {
    return null;
  }
}

export function isPdf(contentType: string, body: Buffer): boolean {
  if (contentType.includes('application/pdf') || contentType.includes('application/x-pdf')) return true;
  return body.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

export function isEpub(contentType: string, body: Buffer): boolean {
  if (contentType.includes('application/epub+zip')) return true;
  return body.subarray(0, 2).toString('latin1') === 'PK' && body.subarray(0, 100).toString('latin1').includes('mimetypeapplication/epub+zip');
}

function looksLikeHtml(contentType: string, body: Buffer): boolean {
  if (/text\/html|application\/xhtml\+xml/.test(contentType)) return true;
  if (contentType && !/^(text\/plain|application\/octet-stream|binary\/octet-stream)/.test(contentType)) return false;
  return /^\s*(<!doctype html|<html|<head|<body|<meta|<!--)/i.test(body.subarray(0, 512).toString('latin1'));
}

/** Extract from an already-fetched response (also used by the DOI landing-page flow). */
export async function extractFromResponse(res: FetchResult, opts: ExtractUrlOptions = {}, depth = 0): Promise<Extracted> {
  const ct = res.contentType;
  const finalUrl = res.url;
  if (isPdf(ct, res.body)) {
    return extractPdf(res.body, { url: finalUrl, name: fileNameFromUrl(finalUrl) ?? undefined });
  }
  if (isEpub(ct, res.body)) {
    const name = fileNameFromUrl(finalUrl) ?? 'book.epub';
    const r = await extractEpub(res.body, { uploadImage: opts.uploadImage ?? (async () => ''), name });
    return { ...r, file: { buffer: res.body, contentType: 'application/epub+zip', name: /\.epub$/i.test(name) ? name : `${name}.epub` } };
  }
  if (looksLikeHtml(ct, res.body)) {
    if (res.body.length > MAX_HTML_BYTES) throw new Error('Page is too large to extract (over 10 MB)');
    const html = decodeBody(res.body, ct);
    const refresh = depth < 2 ? metaRefreshTarget(html, finalUrl) : null;
    if (refresh) {
      try {
        const next = await fetchBuffer(refresh, { maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000 });
        return await extractFromResponse(next, opts, depth + 1);
      } catch {
        // fall through to the current page
      }
    }
    return extractFromHtml(html, finalUrl);
  }
  if (ct.startsWith('image/')) {
    const name = fileNameFromUrl(finalUrl);
    return finalize({
      type: 'other',
      html: `<figure><img src="${escapeHtml(finalUrl)}" alt="${escapeHtml(name ?? '')}"></figure>`,
      title: titleFromFileName(name) ?? new URL(finalUrl).hostname,
      siteName: new URL(finalUrl).hostname.replace(/^www\./, ''),
      imageUrl: finalUrl,
    });
  }
  if (/^text\/|application\/(json|xml|javascript|x-yaml|yaml|x-tex|ld\+json)|\+xml|\+json/.test(ct)) {
    if (res.body.length > MAX_HTML_BYTES) throw new Error('File is too large to extract (over 10 MB)');
    return extractPlainText(decodeBody(res.body, ct), finalUrl);
  }
  throw new Error(`Unsupported content type: ${ct.split(';')[0] || 'unknown'}`);
}

/** Non-HTML text (plain text, markdown, JSON, …) wrapped in <pre>. */
export function extractPlainText(text: string, url: string): Extracted {
  const name = fileNameFromUrl(url);
  const firstLine = collapseWs(text.split('\n').find((l) => l.trim()) ?? '');
  const title = titleFromFileName(name) ?? (firstLine.length <= 120 ? firstLine : null) ?? new URL(url).hostname;
  return finalize({
    type: 'article',
    html: text.trim() ? `<pre>${escapeHtml(text.replace(/\r\n?/g, '\n'))}</pre>` : '',
    text: text.trim(),
    title,
    siteName: new URL(url).hostname.replace(/^www\./, ''),
  });
}

/** `<meta http-equiv="refresh" content="0; url=…">` on an otherwise empty page. */
export function metaRefreshTarget(html: string, baseUrl: string): string | null {
  const m = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i.exec(html.slice(0, 20_000));
  if (!m) return null;
  const content = /content=["']?\s*\d*\s*;?\s*url\s*=\s*['"]?([^"'>\s]+)/i.exec(m[0]);
  if (!content) return null;
  const textLen = htmlToText(html.replace(/<head[\s\S]*?<\/head>/i, '')).length;
  if (textLen > 500) return null;
  const target = httpUrl(content[1], baseUrl);
  return target && target !== baseUrl ? target : null;
}

const JUNK_SELECTORS = [
  'script', 'style', 'noscript:not(:has(img))', 'template', 'iframe', 'form', 'nav', 'header', 'footer', 'aside',
  'button', 'svg', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]', '[hidden]',
  '.share', '.social', '.newsletter', '.advert', '.ad', '.ads', '.cookie', '.related',
];

/** Best-effort main content when Readability fails. */
function fallbackMainHtml(body: Element): string {
  for (const sel of JUNK_SELECTORS) {
    try {
      body.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // selector not supported by this jsdom version — skip
    }
  }
  const main =
    body.querySelector('main article') ??
    body.querySelector('article') ??
    body.querySelector('main, [role="main"]') ??
    body.querySelector('#content, .content, #main, .post, .entry-content') ??
    body;
  return main.innerHTML;
}

function normTitle(s: string): string {
  return collapseWs(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Remove a leading heading that just repeats the title. */
function dropDuplicateTitle(root: Element, title: string | null): void {
  if (!title) return;
  const t = normTitle(title);
  const first = root.querySelector('h1, h2');
  if (!first) return;
  // Only when it is (near) the start of the content.
  const before = (root.textContent ?? '').indexOf(first.textContent ?? '');
  if (before > 200) return;
  if (normTitle(first.textContent ?? '') === t) first.remove();
}

function firstImage(html: string): string | null {
  const m = /<img[^>]+src="(https?:\/\/[^"]+)"/i.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

export interface HtmlExtractOptions {
  /** Optional pre-processing of the parsed document before Readability (site-specific cleanup). */
  prepare?: (doc: Document) => void;
}

/**
 * Replace <font> elements by their children. Readability does not count <font> as phrasing content, so on
 * old-style pages (paragraphs separated by <br><br>, e.g. paulgraham.com) a <font>-wrapped footnote marker
 * would end the paragraph and be left dangling between paragraphs.
 */
export function unwrapFonts(root: Element): void {
  for (const font of Array.from(root.querySelectorAll('font'))) font.replaceWith(...Array.from(font.childNodes));
}

/** Extract an article from an HTML string (pure; no network). */
export function extractFromHtml(html: string, url: string, opts: HtmlExtractOptions = {}): Extracted {
  const dom = parseHtml(html, url);
  try {
    const doc = dom.window.document;
    const base = doc.baseURI || url;
    const meta: PageMeta = extractMeta(doc, url);
    // The note class is reserved for our own notes (e.g. "Loaded from the Internet Archive").
    doc.querySelectorAll(`.${NOTE_CLASS}`).forEach((el) => el.classList.remove(NOTE_CLASS));
    opts.prepare?.(doc);
    if (doc.body) {
      fixLazyImages(doc.body);
      unwrapFonts(doc.body);
    }
    const bodyClone = doc.body ? (doc.body.cloneNode(true) as Element) : null;

    let contentEl: Element | null = null;
    let rTitle: string | null = null;
    let rByline: string | null = null;
    let rExcerpt: string | null = null;
    let rSite: string | null = null;
    let rPublished: string | null = null;
    try {
      const reader = new Readability(doc, {
        charThreshold: 250,
        keepClasses: false,
        serializer: (el: Node) => el as unknown as string,
      });
      const r = reader.parse();
      if (r) {
        contentEl = r.content as unknown as Element;
        rTitle = r.title ?? null;
        rByline = r.byline ?? null;
        rExcerpt = r.excerpt ?? null;
        rSite = r.siteName ?? null;
        rPublished = r.publishedTime ?? null;
      }
    } catch {
      contentEl = null;
    }

    const title = meta.title ?? (rTitle ? collapseWs(rTitle) : null);
    let html2 = '';
    if (contentEl && typeof (contentEl as Element).querySelector === 'function') {
      dropDuplicateTitle(contentEl, title);
      html2 = sanitizeHtml(contentEl.innerHTML, base);
    }
    let text = htmlToText(html2);
    if (text.length < 200 && bodyClone) {
      const fb = sanitizeHtml(fallbackMainHtml(bodyClone), base);
      const fbText = htmlToText(fb);
      if (fbText.length > text.length * 1.5) {
        html2 = fb;
        text = fbText;
      }
    }
    const description = meta.description ?? rExcerpt;
    if (!text && description) {
      html2 = `<p>${escapeHtml(description)}</p>`;
      text = description;
    }
    if (!text && !title) throw new Error('No readable content found on this page (it may require JavaScript or a login)');

    const host = new URL(url).hostname.replace(/^www\./, '');
    // Ignore canonical links that point at a site's home page (a common CMS misconfiguration).
    let canonicalUrl = meta.canonicalUrl;
    if (canonicalUrl && new URL(canonicalUrl).pathname === '/' && new URL(url).pathname !== '/') canonicalUrl = null;
    const c = meta.citation;
    const isPaper = !!c && (!!c.doi || !!c.arxivId || !!c.pdfUrl);
    return finalize({
      type: isPaper ? 'paper' : meta.ogType?.startsWith('video') ? 'video' : 'article',
      html: html2,
      text,
      title: title ?? host,
      author: meta.author ?? cleanAuthor(rByline) ?? (c?.authors.length ? c.authors.slice(0, 3).join(', ') + (c.authors.length > 3 ? ' et al.' : '') : null),
      siteName: meta.siteName ?? rSite ?? host,
      description,
      imageUrl: meta.imageUrl ?? firstImage(html2),
      publishedAt: meta.publishedAt ?? rPublished,
      canonicalUrl: canonicalUrl ?? url,
      paper: isPaper && c
        ? {
            ...(c.doi ? { doi: c.doi } : {}),
            ...(c.arxivId ? { arxivId: c.arxivId } : {}),
            ...(c.authors.length ? { authors: c.authors } : {}),
            ...(c.journal ? { venue: c.journal } : {}),
            ...(c.date ? { year: c.date.getUTCFullYear() } : {}),
            ...(c.pdfUrl ? { pdfUrl: c.pdfUrl } : {}),
            ...(c.abstract ? { abstract: c.abstract } : {}),
          }
        : null,
    });
  } finally {
    dom.window.close();
  }
}
