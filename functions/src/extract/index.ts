/**
 * Extraction module (see docs/SPEC.md "Extraction rules").
 *
 * extractUrl dispatches: X/Twitter → arXiv → DOI → YouTube/Vimeo → generic (which itself sniffs PDF/EPUB/text).
 * All network access goes through ../http (proxy-aware, SSRF guard, size and time limits).
 * Errors are plain `Error`s with short human-readable messages.
 */
import { extractArxiv, parseArxivInput } from './arxiv';
import { extractDoi, parseDoi } from './doi';
import { extractGeneric, type ExtractUrlOptions } from './generic';
import { extractTweet, parseTweetUrl } from './tweet';
import { extractVideo, parseVideoUrl } from './video';
import type { Extracted } from './types';

export { extractPdf } from './pdf';
export { extractEpub } from './epub';
export { sanitizeHtml } from './sanitize';
export { htmlToText, makeExcerpt, countWords } from './text';
export { extractFromHtml, type ExtractUrlOptions } from './generic';
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
