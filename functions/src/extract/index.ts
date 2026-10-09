/**
 * Extraction module (see docs/SPEC.md "Extraction rules").
 *
 * extractUrl dispatches: X/Twitter → arXiv → DOI → YouTube/Vimeo → generic (which itself sniffs PDF/EPUB/text,
 * and falls back to the Internet Archive for dead, blocked or paywalled pages).
 * extractHtml extracts a page captured by the browser extension (no fetch of the page itself).
 * All network access goes through ../http (proxy-aware, SSRF guard, size and time limits).
 * Errors are plain `Error`s with short human-readable messages.
 */
import { extractArxiv, parseArxivInput } from './arxiv';
import { extractDoi, parseDoi } from './doi';
import { MAX_HTML_BYTES, extractFromHtml, extractGeneric, type ExtractUrlOptions } from './generic';
import { htmlToText } from './text';
import { extractTweet, parseTweetUrl } from './tweet';
import { extractVideo, parseVideoUrl } from './video';
import type { Extracted } from './types';

export { extractPdf } from './pdf';
export { extractEpub } from './epub';
export { sanitizeHtml } from './sanitize';
export { htmlToText, makeExcerpt, countWords } from './text';
export { extractFromHtml, extractFromArchive, type ExtractUrlOptions } from './generic';
export { parseTweetUrl } from './tweet';
export { parseArxivInput } from './arxiv';
export { parseDoi } from './doi';
export { parseVideoUrl } from './video';
export type { Extracted, PaperMeta, UploadImage, ItemType } from './types';

/** Normalise user input into an absolute http(s) URL (adds https:// when the scheme is missing). */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('No URL given');
  if (/^\/\//.test(s)) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links can be saved');
  return u.href;
}

/** Extract any URL (or bare DOI / `arXiv:ID`). `opts.uploadImage` is only used when the URL is an EPUB. */
export async function extractUrl(url: string, opts: ExtractUrlOptions = {}): Promise<Extracted> {
  const input = url.trim();
  const arxivBare = /^arxiv:/i.test(input) ? parseArxivInput(input) : null;
  if (arxivBare) return extractArxiv(arxivBare);
  if (!/^https?:/i.test(input)) {
    const doi = parseDoi(input);
    if (doi) return extractDoi(doi);
  }
  const normalized = normalizeUrl(input);

  const tweetId = parseTweetUrl(normalized);
  if (tweetId) return extractTweet(tweetId);

  const arxiv = parseArxivInput(normalized);
  if (arxiv) return extractArxiv(arxiv);

  const doi = parseDoi(normalized);
  if (doi) return extractDoi(doi);

  const video = parseVideoUrl(normalized);
  if (video) return extractVideo(video);

  return extractGeneric(normalized, opts);
}

/** Browser PDF viewers (Chrome's <embed>, Firefox's pdf.js) capture as a shell without the document's text. */
export function isViewerShell(html: string, url: string): boolean {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    path = '';
  }
  if (/\.(pdf|epub)$/i.test(path)) return true;
  if (!/<embed\b[^>]*type=["']application\/(?:pdf|x-google-chrome-pdf)["']|resource:\/\/pdf\.js|id=["']viewerContainer["']/i.test(html)) return false;
  return htmlToText(html.replace(/<head[\s\S]*?<\/head>/i, '')).length < 2000;
}

/**
 * Extract a page captured by the browser extension (the rendered DOM, possibly logged-in or paywalled
 * content) with `url` as its base. Runs the generic pipeline (metadata, Readability, sanitising, lazy
 * images) on `html` without fetching the page, except where the capture is not the content:
 *  - X/Twitter posts use the FxTwitter path (the app shell is useless; the capture is the fallback);
 *  - arXiv uses the arXiv path (full paper instead of the abstract page; the capture is the fallback);
 *  - YouTube/Vimeo use the video path, reading the player data and captions from the capture;
 *  - PDF/EPUB viewer shells, and captures with no readable content, are fetched like a saved URL.
 */
export async function extractHtml(html: string, url: string, opts: ExtractUrlOptions = {}): Promise<Extracted> {
  const normalized = normalizeUrl(url);
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('The saved page is too large to extract (over 10 MB)');

  const fromCapture = () => extractFromHtml(html, normalized);

  const tweetId = parseTweetUrl(normalized);
  if (tweetId) {
    try {
      return await extractTweet(tweetId);
    } catch (e) {
      try {
        return fromCapture();
      } catch {
        throw e;
      }
    }
  }

  const arxiv = parseArxivInput(normalized);
  if (arxiv) {
    try {
      return await extractArxiv(arxiv);
    } catch (e) {
      try {
        return fromCapture();
      } catch {
        throw e;
      }
    }
  }

  const video = parseVideoUrl(normalized);
  if (video) return extractVideo(video, { pageHtml: html });

  if (isViewerShell(html, normalized)) return extractUrl(normalized, opts);

  try {
    return fromCapture();
  } catch (e) {
    // Nothing readable in the capture (e.g. a page still loading): fetch it like a saved URL.
    try {
      return await extractUrl(normalized, opts);
    } catch {
      throw e;
    }
  }
}
