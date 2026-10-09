/** Subscribing to feeds: resolve a user-entered URL to a feed, create the feed doc, ingest its entries. */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { db } from '../admin';
import { normalizeUrl } from '../extract';
import { fetchText } from '../http';
import { errorMessage } from '../processLogic';
import { hostOf, normalizeTags } from '../util';
import { discoverFeedUrls, feedUrlsFromUrl } from './discover';
import { parseFeed } from './parse';
import { FEED_ACCEPT, FEED_MAX_BYTES, ingestFeed, type FeedData, type FetchedFeed } from './poll';

export const MAX_FEEDS = 500;
/** Discovery candidates fetched at most per addFeed. */
const MAX_CANDIDATES = 12;
const PAGE_TIMEOUT_MS = 15_000;
const CANDIDATE_TIMEOUT_MS = 10_000;

const PAGE_ACCEPT = `${FEED_ACCEPT.replace(', */*;q=0.5', '')}, text/html;q=0.8, */*;q=0.5`;

export const feedsCol = (uid: string) => db.collection('users').doc(uid).collection('feeds');

export interface ResolvedFeed extends FetchedFeed {
  /** The URL to store and poll. */
  feedUrl: string;
}

/** Fetch a URL; returns the parsed feed, or the HTML (for discovery) when it is not a feed. */
async function probe(url: string, timeoutMs: number): Promise<{ feed: ResolvedFeed | null; html: string; finalUrl: string }> {
  const res = await fetchText(url, { accept: PAGE_ACCEPT, timeoutMs, maxBytes: FEED_MAX_BYTES });
  try {
    const parsed = parseFeed(res.text, res.url);
    return {
      feed: { feedUrl: url, parsed, finalUrl: res.url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') },
      html: '',
      finalUrl: res.url,
    };
  } catch {
    return { feed: null, html: /html/.test(res.contentType) || /<html|<head|<link/i.test(res.text.slice(0, 4096)) ? res.text : '', finalUrl: res.url };
  }
}

/**
 * Turn a user-entered URL (feed URL, web page, YouTube/Substack/Medium/Reddit/GitHub URL) into a parsed feed.
 * Throws HttpsError('not-found') when no feed can be found.
 */
export async function resolveFeed(input: string): Promise<ResolvedFeed> {
  let pageError: unknown = null;
  let html = '';
  let finalUrl = input;
  try {
    const r = await probe(input, PAGE_TIMEOUT_MS);
    if (r.feed) return r.feed;
    html = r.html;
    finalUrl = r.finalUrl;
  } catch (e) {
    pageError = e;
  }
  const candidates = [...new Set([...feedUrlsFromUrl(input), ...(html ? discoverFeedUrls(html, finalUrl) : feedUrlsFromUrl(finalUrl))])]
    .filter((u) => u !== input)
    .slice(0, MAX_CANDIDATES);
  for (const url of candidates) {
    try {
      const r = await probe(url, CANDIDATE_TIMEOUT_MS);
      if (r.feed) return r.feed;
    } catch {
      /* try the next candidate */
    }
  }
  if (pageError && !candidates.length) throw new HttpsError('unavailable', errorMessage(pageError));
  throw new HttpsError('not-found', 'No RSS, Atom or JSON feed found at this address');
}

async function findFeedByUrl(uid: string, url: string): Promise<{ id: string; title: string } | null> {
  const snap = await feedsCol(uid).where('url', '==', url).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, title: String(d.get('title') ?? '') };
}

export async function validCategoryId(uid: string, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !id || id.length > 128 || id.includes('/')) return null;
  const snap = await db.collection('users').doc(uid).collection('categories').doc(id).get();
  return snap.exists ? id : null;
}

export interface AddFeedInput {
  url: string;
  categoryId?: string | null;
  tags?: string[];
  /** Preferred title (e.g. from an OPML file); the feed's own title is used when empty. */
  title?: string;
}

export interface AddFeedResult {
  id: string;
  title: string;
  added: number;
  existing: boolean;
}

/** Normalise user input to an http(s) URL or throw invalid-argument. */
export function cleanFeedInput(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new HttpsError('invalid-argument', 'Enter a feed or website URL');
  try {
    return normalizeUrl(raw.trim().replace(/^feed:(\/\/)?/i, (_m, slashes: string | undefined) => (slashes ? 'https://' : '')));
  } catch (e) {
    throw new HttpsError('invalid-argument', errorMessage(e));
  }
}

/**
 * Subscribe a user to a feed. Duplicates (same feed URL) return the existing feed with `existing: true`.
 * `opts.checkLimit` (default true) enforces MAX_FEEDS.
 */
export async function addFeedForUser(uid: string, input: AddFeedInput, opts: { checkLimit?: boolean } = {}): Promise<AddFeedResult> {
  const url = cleanFeedInput(input.url);
  const pre = await findFeedByUrl(uid, url);
  if (pre) return { ...pre, added: 0, existing: true };
  if (opts.checkLimit !== false) {
    const count = (await feedsCol(uid).count().get()).data().count;
    if (count >= MAX_FEEDS) throw new HttpsError('resource-exhausted', `You can follow at most ${MAX_FEEDS} feeds`);
  }
  const resolved = await resolveFeed(url);
  if (resolved.feedUrl !== url) {
    const dup = await findFeedByUrl(uid, resolved.feedUrl);
    if (dup) return { ...dup, added: 0, existing: true };
  }
  const categoryId = await validCategoryId(uid, input.categoryId);
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || resolved.parsed.title || hostOf(resolved.parsed.siteUrl ?? resolved.feedUrl);
  const ref = feedsCol(uid).doc();
  const data: FeedData = {
    url: resolved.feedUrl,
    title,
    siteUrl: resolved.parsed.siteUrl,
    categoryId,
    tags: normalizeTags(input.tags ?? []),
    fullText: false,
    lastFetchedAt: null,
    lastError: null,
  };
  await ref.set({ ...data, createdAt: FieldValue.serverTimestamp() });
  let added = 0;
  try {
    added = await ingestFeed(uid, ref, data, resolved);
  } catch (e) {
    logger.warn('initial feed ingest failed', { uid, feedId: ref.id, error: (e as Error).message });
    await ref.update({ lastError: errorMessage(e) }).catch(() => undefined);
  }
  return { id: ref.id, title, added, existing: false };
}

/** Create a feed doc without fetching (used when an OPML import runs out of time; pollFeeds fetches it later). */
export async function addFeedUnverified(uid: string, feed: { xmlUrl: string; title: string; htmlUrl: string | null }): Promise<string> {
  const ref = feedsCol(uid).doc();
  const data: FeedData = {
    url: feed.xmlUrl,
    title: feed.title || hostOf(feed.htmlUrl ?? feed.xmlUrl),
    siteUrl: feed.htmlUrl,
    categoryId: null,
    tags: [],
    fullText: false,
    lastFetchedAt: null,
    lastError: null,
  };
  await ref.set({ ...data, createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}
