/**
 * Feeds module (see docs/SPEC.md "Feeds module contract"): callables addFeed / refreshFeeds / importOpml,
 * the hourly pollFeeds schedule, and the pure parse/discover/OPML helpers.
 */
import '../options';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, REGION } from '../admin';
import { mapLimit } from '../extract/html';
import { normalizeTags } from '../util';
import { parseOpml } from './opml';
import { refreshFeed } from './poll';
import { isDue } from './select';
import { addFeedForUser, addFeedUnverified, feedsCol, MAX_FEEDS } from './subscribe';

export { parseFeed, type ParsedFeed, type ParsedEntry } from './parse';
export { discoverFeedUrls, feedUrlsFromUrl } from './discover';
export { parseOpml, type OpmlFeed } from './opml';
export { refreshFeed } from './poll';
export { feedItemId, selectNewEntries } from './select';

const MAX_OPML_BYTES = 2 * 1024 * 1024;

function requireUid(request: { auth?: { uid: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  return uid;
}

function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  const msg = e instanceof Error && e.message ? e.message : 'Something went wrong';
  return new HttpsError('internal', msg.slice(0, 300));
}

export const addFeed = onCall({ region: REGION, timeoutSeconds: 180, memory: '1GiB' }, async (request) => {
  const uid = requireUid(request);
  const data = (request.data ?? {}) as { url?: unknown; categoryId?: unknown; tags?: unknown };
  try {
    const res = await addFeedForUser(uid, {
      url: typeof data.url === 'string' ? data.url : '',
      categoryId: typeof data.categoryId === 'string' ? data.categoryId : null,
      tags: normalizeTags(data.tags),
    });
    return { id: res.id, title: res.title, added: res.added };
  } catch (e) {
    throw toHttpsError(e);
  }
});

/** Stop starting new feed fetches after this long (functions time out at 540 s). */
const REFRESH_BUDGET_MS = 470_000;

export const refreshFeeds = onCall({ region: REGION, timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const uid = requireUid(request);
  const data = (request.data ?? {}) as { feedId?: unknown };
  if (data.feedId !== undefined && data.feedId !== null) {
    if (typeof data.feedId !== 'string' || !data.feedId || data.feedId.includes('/')) throw new HttpsError('invalid-argument', 'Invalid feed id');
    const snap = await feedsCol(uid).doc(data.feedId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Feed not found');
    return { added: await refreshFeed(uid, snap) };
  }
  const snaps = await feedsCol(uid).get();
  const deadline = Date.now() + REFRESH_BUDGET_MS;
  let added = 0;
  await mapLimit(snaps.docs, 4, async (d) => {
    if (Date.now() > deadline) return;
    added += await refreshFeed(uid, d);
  });
  return { added };
});

/** After this long an OPML import stops fetching and just creates the remaining feeds (pollFeeds fetches them). */
const IMPORT_FETCH_BUDGET_MS = 380_000;

export const importOpml = onCall({ region: REGION, timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const uid = requireUid(request);
  const data = (request.data ?? {}) as { opml?: unknown };
  if (typeof data.opml !== 'string' || !data.opml.trim()) throw new HttpsError('invalid-argument', 'Choose an OPML file');
  if (Buffer.byteLength(data.opml, 'utf8') > MAX_OPML_BYTES) throw new HttpsError('invalid-argument', 'The OPML file is too large (max 2 MB)');
  let list;
  try {
    list = parseOpml(data.opml);
  } catch (e) {
    throw new HttpsError('invalid-argument', (e as Error).message);
  }
  if (!list.length) throw new HttpsError('invalid-argument', 'No feeds found in this OPML file');

  const current = await feedsCol(uid).select('url').get();
  const have = new Set(current.docs.map((d) => String(d.get('url') ?? '')));
  let slots = MAX_FEEDS - current.size;
  const deadline = Date.now() + IMPORT_FETCH_BUDGET_MS;
  const failed: string[] = [];
  let feeds = 0;
  await mapLimit(list, 4, async (f) => {
    if (have.has(f.xmlUrl)) return; // already subscribed
    if (slots <= 0) {
      failed.push(f.xmlUrl);
      return;
    }
    slots--;
    have.add(f.xmlUrl);
    try {
      if (Date.now() > deadline) {
        await addFeedUnverified(uid, f);
        feeds++;
        return;
      }
      const r = await addFeedForUser(uid, { url: f.xmlUrl, title: f.title }, { checkLimit: false });
      if (r.existing) slots++;
      else feeds++;
    } catch (e) {
      slots++;
      failed.push(f.xmlUrl);
      logger.info('opml feed failed', { uid, url: f.xmlUrl, error: (e as Error).message });
    }
  });
  return { feeds, failed };
});

/** Stop starting new fetches after this long in the scheduled run (timeout 540 s). */
const POLL_BUDGET_MS = 450_000;

export const pollFeeds = onSchedule({ schedule: 'every 60 minutes', region: REGION, timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const started = Date.now();
  const snap = await db.collectionGroup('feeds').get();
  const due = snap.docs
    .filter((d) => d.ref.parent.parent?.parent.id === 'users')
    .map((d) => ({ d, last: lastFetched(d) }))
    .filter((x) => isDue(x.last, started))
    .sort((a, b) => (a.last?.getTime() ?? 0) - (b.last?.getTime() ?? 0));
  let added = 0;
  let done = 0;
  await mapLimit(due, 6, async ({ d }) => {
    if (Date.now() - started > POLL_BUDGET_MS) return;
    added += await refreshFeed(d.ref.parent.parent!.id, d);
    done++;
  });
  logger.info('pollFeeds finished', { feeds: snap.size, due: due.length, refreshed: done, added, ms: Date.now() - started });
});

function lastFetched(d: QueryDocumentSnapshot): Date | null {
  const v = d.get('lastFetchedAt') as { toDate?: () => Date } | null | undefined;
  return v && typeof v.toDate === 'function' ? v.toDate() : null;
}
