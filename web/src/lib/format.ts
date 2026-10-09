/**
 * Small, pure formatting helpers shared by pages, components and the reader.
 *
 * Exports:
 *   type DateLike = { toDate(): Date } | Date | number (ms) | null | undefined   (Firestore Timestamp fits)
 *   toDate(ts: DateLike): Date | null
 *   relativeTime(ts: DateLike, now?: number): string   "just now", "5m ago", "3h ago", "2d ago", else formatDate()
 *   formatDate(ts: DateLike, now?: number): string     "Mar 4" (this year) or "Mar 4, 2024"; '' for null
 *   formatDateTime(ts: DateLike): string               "Mar 4, 2024, 14:05"; '' for null
 *   readingTime(item: { readingMinutes?, wordCount? }): string   "5 min"; '' when unknown
 *   hostname(url: string | null | undefined): string   "example.com" (no www.); '' when invalid
 *   typeLabel(type: ItemType): string                  "Article", "Post", "Paper", "PDF", "EPUB", "Video", "Other"
 *   formatBytes(bytes: number): string                 "512 B", "1.4 MB"
 *   itemSource(item): string                           best "who/where" label: author for posts/papers/books, else site name or host
 */
import type { Item, ItemType } from './types';

export type DateLike = { toDate(): Date } | Date | number | null | undefined;

export function toDate(ts: DateLike): Date | null {
  if (ts == null) return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') return Number.isFinite(ts) ? new Date(ts) : null;
  if (typeof ts.toDate === 'function') {
    const d = ts.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(ts: DateLike, now: number = Date.now()): string {
  const d = toDate(ts);
  if (!d) return '';
  const diff = now - d.getTime();
  if (diff < -MIN) return formatDate(d, now); // future dates (e.g. clock skew or scheduled posts)
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return formatDate(d, now);
}

export function formatDate(ts: DateLike, now: number = Date.now()): string {
  const d = toDate(ts);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(ts: DateLike): string {
  const d = toDate(ts);
  if (!d) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function readingTime(item: Partial<Pick<Item, 'readingMinutes' | 'wordCount'>>): string {
  let mins = item.readingMinutes ?? null;
  if ((mins == null || mins <= 0) && item.wordCount && item.wordCount > 0) mins = Math.ceil(item.wordCount / 230);
  if (mins == null || mins <= 0) return '';
  if (mins < 60) return `${Math.max(1, Math.round(mins))} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function hostname(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const TYPE_LABELS: Record<ItemType, string> = {
  article: 'Article',
  tweet: 'Post',
  paper: 'Paper',
  pdf: 'PDF',
  epub: 'EPUB',
  video: 'Video',
  other: 'Other',
};

export function typeLabel(type: ItemType): string {
  return TYPE_LABELS[type] ?? 'Other';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function itemSource(item: Pick<Item, 'type' | 'author' | 'siteName' | 'url'> & { file?: Item['file'] }): string {
  const host = hostname(item.url);
  const authorFirst = item.type === 'tweet' || item.type === 'paper' || item.type === 'epub' || item.type === 'pdf';
  const parts = authorFirst ? [item.author, item.siteName, host] : [item.siteName, host, item.author];
  return parts.find((p): p is string => !!p && p.trim().length > 0)?.trim() ?? '';
}
