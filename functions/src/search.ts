/** Full-text search over the per-user keyword index (users/{uid}/search/{itemId}). */
import './options';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { queryTerms } from './searchIndex';
import { intersectIds } from './util';

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

export function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** Item ids whose index contains every term. Each term is queried ids-only (select()) and the sets intersected. */
export async function searchIds(uid: string, terms: string[], limit: number): Promise<string[]> {
  if (!terms.length) return [];
  const col = db.collection('users').doc(uid).collection('search');
  const lists = await Promise.all(
    terms.map(async (t) => (await col.where('kw', 'array-contains', t).select().get()).docs.map((d) => d.id)),
  );
  return intersectIds(lists).slice(0, limit);
}

export const search = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const data = (request.data ?? {}) as { q?: unknown; limit?: unknown };
  const q = typeof data.q === 'string' ? data.q.slice(0, 500) : '';
  const terms = queryTerms(q);
  if (!terms.length) return { ids: [] as string[] };
  return { ids: await searchIds(uid, terms, clampLimit(data.limit)) };
});
