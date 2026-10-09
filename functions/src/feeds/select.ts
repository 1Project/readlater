/**
 * Pure feed-refresh logic: item ids, which entries are new, and the item fields for an entry.
 * No Firebase access here, so it is unit-testable.
 */
import { createHash } from 'node:crypto';
import { countWords, htmlToText, makeExcerpt } from '../extract/text';
import { guessType, hostOf, normalizeTags, placeholderTitle, readingMinutes, type ItemType } from '../util';
import type { ParsedEntry } from './parse';

/** Entries taken on a feed's first successful fetch. */
export const FIRST_FETCH_LIMIT = 20;
/** Later fetches only add entries published within this window. */
export const MAX_AGE_MS = 30 * 86_400_000;
/** Undated entries added per refresh (feeds without dates can rotate many entries). */
export const MAX_UNDATED_PER_REFRESH = 50;
/** Hard cap on items added per refresh (e.g. busy arXiv listings). */
export const MAX_NEW_PER_REFRESH = 200;
/** Entry content shorter than this is treated as a teaser: the full page is extracted instead. */
export const TEASER_WORDS = 20;
/** pollFeeds skips feeds fetched more recently than this. */
export const MIN_POLL_INTERVAL_MS = 45 * 60_000;

/** Item id for a feed entry: `f_` + first 24 hex chars of sha1(feedId + '|' + (guid || link)). */
export function feedItemId(feedId: string, guidOrLink: string): string {
  return `f_${createHash('sha1').update(`${feedId}|${guidOrLink}`, 'utf8').digest('hex').slice(0, 24)}`;
}

export interface Candidate {
  id: string;
  entry: ParsedEntry;
}

/**
 * Entries worth considering for this refresh (before checking which already exist):
 * first fetch → the newest FIRST_FETCH_LIMIT; later → entries from the last 30 days plus undated ones.
 * Entries without guid and link are skipped; duplicate ids keep the first occurrence. Newest first when dated.
 */
export function candidateEntries(feedId: string, entries: ParsedEntry[], firstFetch: boolean, now: Date = new Date()): Candidate[] {
  const seen = new Set<string>();
  const list: Candidate[] = [];
  for (const entry of entries) {
    const key = entry.guid || entry.link;
    if (!key) continue;
    const id = feedItemId(feedId, key);
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ id, entry });
  }
  // Feeds are conventionally newest-first; only reorder when every entry is dated.
  if (list.length && list.every((c) => c.entry.publishedAt)) {
    list.sort((a, b) => b.entry.publishedAt!.getTime() - a.entry.publishedAt!.getTime());
  }
  if (firstFetch) return list.slice(0, FIRST_FETCH_LIMIT);
  const cutoff = now.getTime() - MAX_AGE_MS;
  return list.filter((c) => !c.entry.publishedAt || c.entry.publishedAt.getTime() >= cutoff);
}

/** Drop candidates that already exist, then apply the per-refresh caps. */
export function capNewEntries(cands: Candidate[], existing: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  let undated = 0;
  for (const c of cands) {
    if (existing.has(c.id)) continue;
    if (!c.entry.publishedAt) {
      if (undated >= MAX_UNDATED_PER_REFRESH) continue;
      undated++;
    }
    out.push(c);
    if (out.length >= MAX_NEW_PER_REFRESH) break;
  }
  return out;
}

/** candidateEntries + capNewEntries in one step. */
export function selectNewEntries(
  feedId: string,
  entries: ParsedEntry[],
  opts: { firstFetch: boolean; existing?: Set<string>; now?: Date },
): Candidate[] {
  return capNewEntries(candidateEntries(feedId, entries, opts.firstFetch, opts.now), opts.existing ?? new Set());
}

/** Item type from the link: YouTube/Vimeo → video, arXiv/DOI → paper, X status → tweet, otherwise article. */
export function feedItemType(link: string | null): ItemType {
  if (!link) return 'article';
  const t = guessType(link);
  // pdf/epub need a stored file; a feed item starts as an article (processItem corrects it when it extracts).
  return t === 'pdf' || t === 'epub' ? 'article' : t;
}

export interface FeedSettings {
  title: string;
  url: string;
  tags: string[];
  categoryId: string | null;
  fullText: boolean;
}

export interface FeedItemPlan {
  /** Item fields (merged over the newItemData defaults by the caller; publishedAt is a Date here). */
  fields: Record<string, unknown> & { publishedAt: Date | null; fetchStatus: 'pending' | 'done' };
  /** Sanitized content HTML to store ('' when the item will be extracted by processItem). */
  html: string;
  /** Plain text of `html` (for the search index). */
  text: string;
}

/**
 * Plan the item for a new feed entry. `sanitizedHtml` is the entry HTML after sanitizeHtml().
 * Items are left `pending` (full-page extraction by processItem) when the feed is full-text, or when the
 * entry only carries a teaser and links to a page.
 */
export function planFeedItem(feedId: string, feed: FeedSettings, siteName: string | null, entry: ParsedEntry, sanitizedHtml: string): FeedItemPlan {
  const text = htmlToText(sanitizedHtml);
  const words = countWords(text);
  const link = entry.link;
  // Bare URLs do not count as content (e.g. Hacker News: "Article URL: … Comments URL: … Points: 12").
  const proseWords = countWords(text.replace(/\bhttps?:\/\/\S+/g, ' '));
  const pending = !!link && (feed.fullText || proseWords < TEASER_WORDS);
  const excerpt = text ? makeExcerpt(text) : '';
  const fallbackTitle = text ? makeExcerpt(text, 80) : '';
  const title = entry.title || fallbackTitle || (link ? placeholderTitle(link) : '') || siteName || 'Untitled';
  return {
    fields: {
      url: link,
      type: feedItemType(link),
      location: 'feed',
      status: 'unread',
      title,
      titleLocked: false,
      author: entry.author,
      siteName: siteName || (link ? hostOf(link) : null) || null,
      excerpt: excerpt || null,
      imageUrl: entry.imageUrl,
      publishedAt: entry.publishedAt,
      tags: normalizeTags(feed.tags ?? []),
      categoryId: typeof feed.categoryId === 'string' && feed.categoryId ? feed.categoryId : null,
      feedId,
      fetchStatus: pending ? 'pending' : 'done',
      wordCount: pending || !words ? null : words,
      readingMinutes: pending || !words ? null : readingMinutes(words),
    },
    html: pending ? '' : sanitizedHtml,
    text: pending ? '' : text,
  };
}

/** Should pollFeeds refresh a feed last fetched at `last`? */
export function isDue(last: Date | null, now: number = Date.now()): boolean {
  return !last || now - last.getTime() >= MIN_POLL_INTERVAL_MS;
}
