/** Pure decision/patch logic for processItem (no Firebase app access, unit-tested). */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { Extracted } from './extract/types';
import { buildKeywords } from './searchIndex';
import { hostOf, readingMinutes, truncate } from './util';

export type ItemData = Record<string, unknown>;
export type Action = 'process' | 'reindex' | 'none';

export interface StoredFile {
  path: string;
  name: string;
  contentType: string;
  size: number;
}

const INDEXED_FIELDS = ['title', 'author', 'siteName', 'note', 'url', 'tags'] as const;

/**
 * Bookkeeping fields of a processing run (server-only; docs/SPEC-2.md §9):
 *   processingAt   when the item entered 'processing' (the sweeper re-queues runs that never finished)
 *   processingRun  id of the run that owns the item (only that run may write the result)
 *   processAttempts runs that did not finish, so far
 *   retryAt        a rate-limited item is queued again by the sweeper at this time
 */
export const PROCESSING_STALE_MS = 10 * 60_000;
/** Runs that may die (out of memory, timeout) before the item is marked as failed. */
export const MAX_PROCESS_ATTEMPTS = 3;
/** Items one user may have processed per hour; more wait (retryAt) and are queued again later. */
export const PROCESS_PER_HOUR = 300;
export const RATE_LIMITED_MESSAGE = 'Waiting: many pages were fetched in the last hour. This one is fetched automatically soon.';
export const STALLED_MESSAGE = 'Fetching this item did not finish (the page may be too large or too slow). Try again later.';

/** Clears the run bookkeeping; part of every final (done / error) patch. */
export function endRunFields(): ItemData {
  return { processingAt: FieldValue.delete(), processingRun: FieldValue.delete(), retryAt: FieldValue.delete() };
}

/**
 * Patch for an item found in 'processing' after its run should have ended: queue it again, or give up after
 * MAX_PROCESS_ATTEMPTS. Items without a URL or file (notes, newsletters whose save was interrupted) cannot be
 * fetched again. Returns null when the item is no longer stuck.
 */
export function stalePatch(cur: ItemData, now: number): ItemData | null {
  if (cur.fetchStatus !== 'processing') return null;
  const at = cur.processingAt as Timestamp | undefined;
  if (!at || typeof at.toMillis !== 'function' || now - at.toMillis() < PROCESSING_STALE_MS) return null;
  const attempts = (typeof cur.processAttempts === 'number' ? cur.processAttempts : 0) + 1;
  const fetchable = (typeof cur.url === 'string' && !!cur.url) || !!(cur.file as { path?: unknown } | null)?.path;
  if (!fetchable || attempts >= MAX_PROCESS_ATTEMPTS) {
    return { fetchStatus: 'error', fetchError: STALLED_MESSAGE, processAttempts: FieldValue.delete(), ...endRunFields(), updatedAt: FieldValue.serverTimestamp() };
  }
  return { fetchStatus: 'pending', processAttempts: attempts, ...endRunFields(), updatedAt: FieldValue.serverTimestamp() };
}

/** Patch to queue a rate-limited (error + retryAt) item again once its time has come; null when not due. */
export function retryPatch(cur: ItemData, now: number): ItemData | null {
  const at = cur.retryAt as Timestamp | undefined;
  if (cur.fetchStatus !== 'error' || !at || typeof at.toMillis !== 'function' || at.toMillis() > now) return null;
  return { fetchStatus: 'pending', fetchError: null, retryAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() };
}

/** What processItem should do for a write. Never reacts to its own writes (pending→processing→done). */
export function decideAction(before: ItemData | undefined, after: ItemData | undefined): Action {
  if (!after) return 'none';
  const st = after.fetchStatus;
  if (st === 'pending' && (!before || before.fetchStatus !== 'pending')) return 'process';
  if (before && (st === 'done' || st === 'error') && before.fetchStatus === st) {
    const changed = INDEXED_FIELDS.some((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
    if (changed) return 'reindex';
  }
  return 'none';
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Search keywords for an item: metadata first, then body text. */
export function itemKeywords(item: ItemData, bodyText: string): string[] {
  const tags = Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t) => typeof t === 'string').join(' ') : '';
  const paper = (item.paper ?? null) as { authors?: unknown } | null;
  const authors = Array.isArray(paper?.authors) ? (paper!.authors as unknown[]).filter((a) => typeof a === 'string').join(' ') : '';
  return buildKeywords({
    meta: [s(item.title), s(item.author), s(item.siteName), tags, s(item.note), hostOf(s(item.url) || null), authors],
    body: bodyText,
  });
}

/** Item fields to write after a successful extraction. `cur` is the item as it is now (user edits respected). */
export function donePatch(cur: ItemData, ex: Extracted, chunks: number, file: StoredFile | null): ItemData {
  const words = ex.wordCount > 0 ? ex.wordCount : 0;
  const published = ex.publishedAt && !Number.isNaN(ex.publishedAt.getTime()) ? Timestamp.fromDate(ex.publishedAt) : (cur.publishedAt ?? null);
  const patch: ItemData = {
    type: ex.type,
    author: ex.author ?? cur.author ?? null,
    siteName: ex.siteName ?? cur.siteName ?? null,
    excerpt: ex.excerpt ?? cur.excerpt ?? null,
    imageUrl: ex.imageUrl ?? cur.imageUrl ?? null,
    publishedAt: published,
    wordCount: words || null,
    readingMinutes: words ? readingMinutes(words) : null,
    contentChunks: chunks,
    paper: ex.paper ?? cur.paper ?? null,
    fetchStatus: 'done',
    fetchError: null,
    processAttempts: FieldValue.delete(),
    ...endRunFields(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!cur.titleLocked && ex.title && ex.title.trim()) patch.title = ex.title.trim();
  if (file) patch.file = file;
  return patch;
}

/** The item as it will look after the patch (for indexing). */
export function merged(cur: ItemData, patch: ItemData): ItemData {
  return { ...cur, ...patch };
}

/** Human-readable error message for fetchError (≤ 300 chars). */
export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return truncate(m.replace(/\s+/g, ' ').trim() || 'Could not extract this item', 300);
}

/** 'pdf' | 'epub' for a stored file, from content type, then extension, then magic bytes. */
export function fileKind(file: { name?: string; contentType?: string; path?: string }, head?: Buffer): 'pdf' | 'epub' | null {
  const ct = (file.contentType ?? '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('epub')) return 'epub';
  const name = (file.name || file.path || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.epub')) return 'epub';
  if (head) {
    if (head.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
    if (head.subarray(0, 2).toString('latin1') === 'PK') return 'epub';
  }
  return null;
}
