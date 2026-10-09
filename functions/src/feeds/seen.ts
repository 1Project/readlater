/**
 * Feed entries the user must not get (again): `users/{uid}/feedSeen/{itemId}` `{ feedId, expiresAt }`
 * (server-only; a TTL policy on expiresAt removes them). Written when a feed item is deleted (cleanupItem),
 * and on a feed's first fetch for the older entries beyond FIRST_FETCH_LIMIT that a later refresh would
 * otherwise still pick up (undated ones, or ones newer than the feed's `since` watermark).
 */
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { db } from '../admin';

/** Long enough that a dated entry has left the 30-day window; undated entries rarely stay in a feed this long. */
export const FEED_SEEN_TTL_MS = 400 * 86_400_000;

export const feedSeenRef = (uid: string, itemId: string): DocumentReference => db.collection('users').doc(uid).collection('feedSeen').doc(itemId);

export function seenDoc(feedId: string, now = Date.now()): { feedId: string; expiresAt: Timestamp } {
  return { feedId, expiresAt: Timestamp.fromMillis(now + FEED_SEEN_TTL_MS) };
}

/** Ids among `ids` that are marked as seen. */
export async function seenIds(uid: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const refs = ids.slice(i, i + 100).map((id) => feedSeenRef(uid, id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs, { fieldMask: ['feedId'] });
    for (const s of snaps) if (s.exists) found.add(s.id);
  }
  return found;
}

/** Mark entries as seen (best effort, bulk). */
export async function markSeen(uid: string, feedId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const w = db.bulkWriter();
  const doc = seenDoc(feedId);
  for (const id of ids) w.set(feedSeenRef(uid, id), doc).catch(() => undefined);
  await w.close();
}
