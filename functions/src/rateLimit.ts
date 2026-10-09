/** Fixed-window rate limiting backed by `rateLimits/{bucket}` documents (server-only collection). */
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './admin';
import { sha256 } from './util';

export interface WindowState {
  count: number;
  windowStart: number; // ms epoch
}

export interface WindowDecision {
  allowed: boolean;
  next: WindowState;
  /** ms until the current window resets */
  retryAfterMs: number;
}

/** Pure fixed-window step: counts one hit if allowed. */
export function stepWindow(prev: WindowState | null | undefined, now: number, windowMs: number, max: number): WindowDecision {
  const fresh = !prev || !Number.isFinite(prev.windowStart) || now - prev.windowStart >= windowMs || prev.windowStart > now;
  const state: WindowState = fresh ? { count: 0, windowStart: now } : { count: prev!.count, windowStart: prev!.windowStart };
  const retryAfterMs = Math.max(0, state.windowStart + windowMs - now);
  if (state.count >= max) return { allowed: false, next: state, retryAfterMs };
  return { allowed: true, next: { count: state.count + 1, windowStart: state.windowStart }, retryAfterMs };
}

/** Firestore-safe document id for a bucket key (keys may contain IPs, slashes etc.). */
export function bucketDocId(key: string): string {
  const scope = key.split(':')[0].replace(/[^\w-]/g, '').slice(0, 40) || 'rl';
  return `${scope}_${sha256(key).slice(0, 40)}`;
}

/**
 * Count one hit against `key`. Returns the decision; nothing is written when the limit is already reached.
 * `expiresAt` lets a Firestore TTL policy on rateLimits.expiresAt garbage-collect old buckets.
 */
export async function hit(key: string, max: number, windowMs: number): Promise<WindowDecision> {
  const ref = db.collection('rateLimits').doc(bucketDocId(key));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? { count: Number(snap.get('count') ?? 0), windowStart: Number(snap.get('windowStart') ?? 0) } : null;
    const now = Date.now();
    const d = stepWindow(prev, now, windowMs, max);
    if (d.allowed) {
      tx.set(ref, { ...d.next, expiresAt: Timestamp.fromMillis(d.next.windowStart + windowMs * 2) });
    }
    return d;
  });
}

/** Throw a callable `resource-exhausted` error when the limit is reached. */
export async function enforce(key: string, max: number, windowMs: number, message = 'Too many requests, please try again later'): Promise<void> {
  const d = await hit(key, max, windowMs);
  if (!d.allowed) throw new HttpsError('resource-exhausted', message);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
