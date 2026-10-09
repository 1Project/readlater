/** Fetching a feed and turning its new entries into `location:'feed'` items. */
import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { db } from '../admin';
import { writeContent } from '../content';
import { sanitizeHtml } from '../extract';
import { mapLimit } from '../extract/html';
import { FetchError, fetchText } from '../http';
import { errorMessage, itemKeywords } from '../processLogic';
import { loadRules, withRules, type Rule } from '../rules';
import { newItemData } from '../saveUrl';
import { hostOf } from '../util';
import { parseFeed, type ParsedFeed } from './parse';
import { candidateEntries, capNewEntries, firstFetchLeftovers, planFeedItem, type Candidate, type FeedSettings } from './select';
import { markSeen, seenIds } from './seen';

/** Stored shape of users/{uid}/feeds/{feedId}. */
export interface FeedData {
  url: string;
  title: string;
  siteUrl: string | null;
  categoryId: string | null;
  tags: string[];
  fullText: boolean;
  lastFetchedAt: Timestamp | null;
  lastError: string | null;
  createdAt?: Timestamp;
  etag?: string;
  lastModified?: string;
  /** Watermark set by the first fetch: older dated entries are never added (docs/SPEC-2.md §9). */
  since?: Timestamp;
}

export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/rdf+xml;q=0.9, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5';
export const FEED_MAX_BYTES = 8 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 20_000;

const userDoc = (uid: string) => db.collection('users').doc(uid);

export interface FetchedFeed {
  parsed: ParsedFeed;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
}

/** Normalise a stored feed doc (tolerates missing/invalid fields written by clients). */
export function feedDataOf(raw: Record<string, unknown> | undefined): FeedData | null {
  if (!raw || typeof raw.url !== 'string' || !raw.url) return null;
  return {
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : '',
    siteUrl: typeof raw.siteUrl === 'string' ? raw.siteUrl : null,
    categoryId: typeof raw.categoryId === 'string' && raw.categoryId ? raw.categoryId : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    fullText: raw.fullText === true,
    lastFetchedAt: raw.lastFetchedAt instanceof Timestamp ? raw.lastFetchedAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    etag: typeof raw.etag === 'string' && raw.etag ? raw.etag : undefined,
    lastModified: typeof raw.lastModified === 'string' && raw.lastModified ? raw.lastModified : undefined,
    since: raw.since instanceof Timestamp ? raw.since : undefined,
  };
}

/** Ids among `ids` that already exist under users/{uid}/items, or were deleted / skipped before (feedSeen). */
async function knownIds(uid: string, ids: string[]): Promise<Set<string>> {
  const [items, seen] = await Promise.all([existingIds(uid, ids), seenIds(uid, ids)]);
  for (const id of seen) items.add(id);
  return items;
}

/** Ids among `ids` that already exist under users/{uid}/items. */
async function existingIds(uid: string, ids: string[]): Promise<Set<string>> {
  const items = userDoc(uid).collection('items');
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const refs = ids.slice(i, i + 100).map((id) => items.doc(id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs, { fieldMask: ['feedId'] });
    for (const s of snaps) if (s.exists) found.add(s.id);
  }
  return found;
}

/** URLs among `urls` the user already has as items (library or another feed), so entries are not duplicated. */
async function existingUrls(uid: string, urls: string[]): Promise<Set<string>> {
  const items = userDoc(uid).collection('items');
  const found = new Set<string>();
  const unique = [...new Set(urls)];
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    const snap = await items.where('url', 'in', chunk).select('url').get();
    for (const d of snap.docs) {
      const u = d.get('url');
      if (typeof u === 'string') found.add(u);
    }
  }
  return found;
}

function safeSanitize(html: string, base: string): string {
  if (!html) return '';
  try {
    return sanitizeHtml(html, base);
  } catch (e) {
    logger.warn('feed entry sanitize failed', { error: (e as Error).message });
    return '';
  }
}

/**
 * Create one item for a feed entry. Returns false when it already existed.
 * `rules` (the user's auto rules, null when they could not be read) are applied to the new item right away.
 */
async function writeEntry(
  uid: string,
  feedId: string,
  feed: FeedSettings,
  siteName: string | null,
  base: string,
  c: Candidate,
  rules: Rule[] | null,
): Promise<boolean> {
  const user = userDoc(uid);
  const ref = user.collection('items').doc(c.id);
  const plan = planFeedItem(feedId, feed, siteName, c.entry, safeSanitize(c.entry.html, c.entry.contentBase ?? c.entry.link ?? base));
  const { publishedAt, fetchStatus, ...rest } = plan.fields;
  const fields = newItemData({
    ...rest,
    source: 'feed',
    publishedAt: publishedAt ? Timestamp.fromDate(publishedAt) : null,
    // Content is written after the doc exists; 'processing' keeps processItem from picking it up meanwhile
    // (processingAt lets sweepItems recover the item if this function dies before it is done).
    fetchStatus: fetchStatus === 'pending' ? 'pending' : 'processing',
    ...(fetchStatus === 'pending' ? {} : { processingAt: FieldValue.serverTimestamp() }),
  });
  const data = rules ? withRules(rules, fields, { feedTitle: feed.title || siteName }) : fields;
  try {
    await ref.create(data);
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS: a concurrent refresh created it
    throw e;
  }
  if (fetchStatus === 'pending') return true; // processItem extracts the page and indexes it
  try {
    const chunks = await writeContent(ref, plan.html);
    const batch = db.batch();
    batch.update(ref, { fetchStatus: 'done', contentChunks: chunks, processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    batch.set(user.collection('search').doc(c.id), { kw: itemKeywords(data, plan.text) });
    await batch.commit();
  } catch (e) {
    // Hand the item to processItem rather than leaving it stuck in 'processing'.
    logger.warn('feed entry content write failed', { uid, feedId, id: c.id, error: (e as Error).message });
    await ref.update(
      c.entry.link
        ? { fetchStatus: 'pending', processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }
        : { fetchStatus: 'error', fetchError: errorMessage(e), processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
    );
  }
  return true;
}

/** Add the new entries of an already-fetched feed and update the feed doc. Returns the number of items added. */
export async function ingestFeed(uid: string, ref: DocumentReference, feed: FeedData, fetched: FetchedFeed): Promise<number> {
  const { parsed } = fetched;
  const firstFetch = !feed.lastFetchedAt;
  const cands = candidateEntries(ref.id, parsed.entries, firstFetch, new Date(), feed.since?.toDate() ?? null);
  const exist = await knownIds(uid, cands.map((c) => c.id));
  let selected = capNewEntries(cands, exist);
  const links = selected.map((c) => c.entry.link).filter((l): l is string => !!l);
  if (links.length) {
    const have = await existingUrls(uid, links);
    selected = selected.filter((c) => !c.entry.link || !have.has(c.entry.link));
  }
  const siteName = feed.title || parsed.title || hostOf(parsed.siteUrl ?? feed.url) || null;
  const settings: FeedSettings = { title: feed.title, url: feed.url, tags: feed.tags, categoryId: feed.categoryId, fullText: feed.fullText };
  const base = parsed.siteUrl ?? fetched.finalUrl;
  let added = 0;
  const rules = selected.length
    ? await loadRules(uid).catch((e: unknown) => {
        logger.warn('loading rules failed', { uid, error: (e as Error).message });
        return null;
      })
    : null;
  // Oldest first, so creation order roughly follows publication order.
  await mapLimit([...selected].reverse(), 4, async (c) => {
    try {
      if (await writeEntry(uid, ref.id, settings, siteName, base, c, rules)) added++;
    } catch (e) {
      logger.warn('feed entry write failed', { uid, feedId: ref.id, id: c.id, error: (e as Error).message });
    }
  });
  const patch: Record<string, unknown> = {
    lastFetchedAt: FieldValue.serverTimestamp(),
    lastError: null,
    etag: fetched.etag ?? FieldValue.delete(),
    lastModified: fetched.lastModified ?? FieldValue.delete(),
  };
  if (firstFetch) {
    // Keep later refreshes from adding the backlog this first fetch skipped (FIRST_FETCH_LIMIT).
    const { since, rest } = firstFetchLeftovers(ref.id, parsed.entries);
    if (since) patch.since = Timestamp.fromDate(since);
    await markSeen(uid, ref.id, rest.map((c) => c.id)).catch((e: unknown) => logger.warn('marking skipped entries failed', { uid, feedId: ref.id, error: String(e) }));
  }
  if (!feed.title && parsed.title) patch.title = parsed.title;
  if (!feed.siteUrl && parsed.siteUrl) patch.siteUrl = parsed.siteUrl;
  await updateIfExists(ref, patch);
  return added;
}

async function updateIfExists(ref: DocumentReference, patch: Record<string, unknown>): Promise<void> {
  try {
    await ref.update(patch);
  } catch (e) {
    if ((e as { code?: number }).code !== 5) throw e; // NOT_FOUND: the feed was deleted meanwhile
  }
}

/** Fetch and parse a feed URL (optionally conditional). Returns null on HTTP 304 Not Modified. */
export async function fetchFeed(url: string, cond: { etag?: string; lastModified?: string } = {}, timeoutMs = FEED_TIMEOUT_MS): Promise<FetchedFeed | null> {
  const headers: Record<string, string> = {};
  if (cond.etag) headers['if-none-match'] = cond.etag;
  if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;
  let res;
  try {
    res = await fetchText(url, { accept: FEED_ACCEPT, headers, timeoutMs, maxBytes: FEED_MAX_BYTES });
  } catch (e) {
    if (e instanceof FetchError && e.status === 304) return null;
    throw e;
  }
  return {
    parsed: parseFeed(res.text, res.url),
    finalUrl: res.url,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/**
 * Refresh one feed: conditional GET, parse, add new entries, update the feed doc.
 * Never throws for fetch/parse problems — they are recorded in the feed's `lastError`. Returns items added.
 */
export async function refreshFeed(uid: string, feedDoc: DocumentSnapshot): Promise<number> {
  const feed = feedDataOf(feedDoc.data());
  if (!feed) return 0;
  const ref = feedDoc.ref;
  try {
    const fetched = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
    if (!fetched) {
      await updateIfExists(ref, { lastFetchedAt: FieldValue.serverTimestamp(), lastError: null });
      return 0;
    }
    return await ingestFeed(uid, ref, feed, fetched);
  } catch (e) {
    const msg = errorMessage(e);
    logger.info('feed refresh failed', { uid, feedId: ref.id, url: feed.url, error: msg });
    // Keep lastFetchedAt null until the first success, so that fetch still counts as the "first" one.
    await updateIfExists(ref, { lastError: msg, ...(feed.lastFetchedAt ? { lastFetchedAt: FieldValue.serverTimestamp() } : {}) }).catch(() => undefined);
    return 0;
  }
}
