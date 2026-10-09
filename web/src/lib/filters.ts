/**
 * Pure list helpers used by the Library, Feed and Search pages: filtering, sorting and
 * client-side metadata search with relevance scoring. No React, no Firebase.
 *
 * Exports:
 *   type LibraryView = 'unread' | 'archive' | 'favorites' | 'all'
 *   type FeedView = 'new' | 'seen'
 *   type TypeFilter = 'all' | 'article' | 'tweet' | 'paper' | 'pdf' | 'epub' | 'video'
 *   type SortKey = 'new' | 'old' | 'short' | 'long'
 *   type SearchScope = 'all' | 'library' | 'feed' | 'archive'
 *   type DateField = 'createdAt' | 'publishedAt' | 'archivedAt'
 *   interface ItemFilter { location?, view?, categoryId?, tag?, type?, feedId? }
 *   LIBRARY_VIEWS, FEED_VIEWS, TYPE_FILTERS, SORT_KEYS, SEARCH_SCOPES   ({ value, label }[] for UI)
 *   parseLibraryView / parseFeedView / parseTypeFilter / parseSort / parseScope (string | null) → value (with default)
 *   matchesView(item, view): boolean
 *   matchesType(item, type): boolean           'article' also matches 'other'; 'pdf' matches pdf items only
 *   filterItems(items, filter): Item[]
 *   sortItems(items, sort, dateField?): Item[] new array; unknown lengths sort last; null dates count as "now"
 *   inScope(item, scope): boolean
 *   normalizeText(s): string                    lowercase, diacritics stripped, whitespace collapsed
 *   parseSearchQuery(q): { terms: string[]; tags: string[] }   `#foo` terms only match tags
 *   scoreItem(item, query): number              0 = no match (every term must match somewhere)
 *   searchItems(items, q): Item[]               matches only, best first, ties newest first
 */
import type { Item, ItemLocation, ItemType } from './types';

export type LibraryView = 'unread' | 'archive' | 'favorites' | 'all';
export type FeedView = 'new' | 'seen';
export type TypeFilter = 'all' | Exclude<ItemType, 'other'>;
export type SortKey = 'new' | 'old' | 'short' | 'long';
export type SearchScope = 'all' | 'library' | 'feed' | 'archive';
export type DateField = 'createdAt' | 'publishedAt' | 'archivedAt';

export interface ItemFilter {
  location?: ItemLocation;
  /** Library views apply to library items, feed views to feed items. */
  view?: LibraryView | FeedView;
  categoryId?: string | null;
  tag?: string | null;
  type?: TypeFilter | null;
  feedId?: string | null;
}

export const LIBRARY_VIEWS: { value: LibraryView; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'archive', label: 'Archive' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'all', label: 'All' },
];

export const FEED_VIEWS: { value: FeedView; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'seen', label: 'Seen' },
];

export const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'article', label: 'Articles' },
  { value: 'tweet', label: 'Posts' },
  { value: 'paper', label: 'Papers' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'epub', label: 'Books' },
  { value: 'video', label: 'Videos' },
];

export const SORT_KEYS: { value: SortKey; label: string }[] = [
  { value: 'new', label: 'Newest' },
  { value: 'old', label: 'Oldest' },
  { value: 'short', label: 'Shortest' },
  { value: 'long', label: 'Longest' },
];

export const SEARCH_SCOPES: { value: SearchScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'library', label: 'Library' },
  { value: 'feed', label: 'Feed' },
  { value: 'archive', label: 'Archive' },
];

function parseOne<T extends string>(list: { value: T }[], raw: string | null | undefined, fallback: T): T {
  return list.find((x) => x.value === raw)?.value ?? fallback;
}

export const parseLibraryView = (raw: string | null | undefined): LibraryView => parseOne(LIBRARY_VIEWS, raw, 'unread');
export const parseFeedView = (raw: string | null | undefined): FeedView => parseOne(FEED_VIEWS, raw, 'new');
export const parseTypeFilter = (raw: string | null | undefined): TypeFilter => parseOne(TYPE_FILTERS, raw, 'all');
export const parseSort = (raw: string | null | undefined): SortKey => parseOne(SORT_KEYS, raw, 'new');
export const parseScope = (raw: string | null | undefined): SearchScope => parseOne(SEARCH_SCOPES, raw, 'all');

export function matchesView(item: Item, view: LibraryView | FeedView): boolean {
  switch (view) {
    case 'unread':
    case 'new':
      return item.status === 'unread';
    case 'archive':
    case 'seen':
      return item.status === 'archived';
    case 'favorites':
      return item.favorite;
    case 'all':
      return true;
  }
}

export function matchesType(item: Item, type: TypeFilter | null | undefined): boolean {
  if (!type || type === 'all') return true;
  if (type === 'article') return item.type === 'article' || item.type === 'other';
  return item.type === type;
}

export function filterItems(items: Item[], f: ItemFilter): Item[] {
  return items.filter(
    (it) =>
      (!f.location || it.location === f.location) &&
      (!f.view || matchesView(it, f.view)) &&
      (!f.categoryId || it.categoryId === f.categoryId) &&
      (!f.tag || it.tags.includes(f.tag)) &&
      (!f.feedId || it.feedId === f.feedId) &&
      matchesType(it, f.type),
  );
}

function millis(ts: { toMillis?: () => number; toDate?: () => Date } | null | undefined): number | null {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  return null;
}

/** Sort time of an item. A pending server timestamp (null createdAt) means "just now". */
export function itemTime(item: Item, field: DateField = 'createdAt'): number {
  const primary = field === 'createdAt' ? null : millis(item[field]);
  return primary ?? millis(item.createdAt) ?? Number.MAX_SAFE_INTEGER;
}

function itemLength(item: Item): number | null {
  if (item.wordCount && item.wordCount > 0) return item.wordCount;
  if (item.readingMinutes && item.readingMinutes > 0) return item.readingMinutes * 230;
  return null;
}

export function sortItems(items: Item[], sort: SortKey, dateField: DateField = 'createdAt'): Item[] {
  const byNew = (a: Item, b: Item) => itemTime(b, dateField) - itemTime(a, dateField) || a.id.localeCompare(b.id);
  const out = [...items];
  switch (sort) {
    case 'new':
      return out.sort(byNew);
    case 'old':
      return out.sort((a, b) => -byNew(a, b));
    case 'short':
    case 'long': {
      const dir = sort === 'short' ? 1 : -1;
      return out.sort((a, b) => {
        const la = itemLength(a);
        const lb = itemLength(b);
        if (la == null && lb == null) return byNew(a, b);
        if (la == null) return 1;
        if (lb == null) return -1;
        return (la - lb) * dir || byNew(a, b);
      });
    }
  }
}

export function inScope(item: Item, scope: SearchScope): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'library':
      return item.location === 'library' && item.status === 'unread';
    case 'archive':
      return item.location === 'library' && item.status === 'archived';
    case 'feed':
      return item.location === 'feed';
  }
}

// ---------------------------------------------------------------------------
// Search

export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchQuery {
  /** Free-text terms; each must match some field. */
  terms: string[];
  /** `#tag` terms; each must prefix-match one of the item's tags. */
  tags: string[];
  /** The whole free-text query, for phrase bonuses. */
  phrase: string;
}

export function parseSearchQuery(q: string): SearchQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  for (const raw of normalizeText(q).split(' ')) {
    if (!raw) continue;
    if (raw.startsWith('#')) {
      const t = raw.replace(/^#+/, '');
      if (t) tags.push(t);
    } else {
      // Drop surrounding punctuation but keep inner characters (e.g. "c++", "node.js", URLs).
      const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, '');
      if (t) terms.push(t);
    }
  }
  return { terms: [...new Set(terms)], tags: [...new Set(tags)], phrase: terms.join(' ') };
}

interface Field {
  text: string;
  weight: number;
}

function fieldsOf(item: Item): Field[] {
  return [
    { text: normalizeText(item.title), weight: 10 },
    { text: normalizeText(item.tags.join(' ')), weight: 8 },
    { text: normalizeText([item.author, ...(item.paper?.authors ?? [])].filter(Boolean).join(' ')), weight: 6 },
    { text: normalizeText(item.siteName), weight: 4 },
    { text: normalizeText(item.url), weight: 3 },
    { text: normalizeText(item.note), weight: 3 },
    { text: normalizeText(item.excerpt), weight: 2 },
    { text: normalizeText(item.file?.name), weight: 2 },
  ];
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Score one term in one field: 0 = absent, otherwise higher for word-start / whole-word matches. */
function termScore(text: string, term: string): number {
  let best = 0;
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(term, from);
    if (i < 0) break;
    const start = !isWordChar(text[i - 1]);
    const end = !isWordChar(text[i + term.length]);
    const s = start && end ? 3 : start ? 2 : 1;
    if (s > best) best = s;
    if (best === 3) break;
    from = i + 1;
  }
  return best;
}

export function scoreItem(item: Item, query: SearchQuery): number {
  if (!query.terms.length && !query.tags.length) return 0;
  for (const t of query.tags) {
    if (!item.tags.some((tag) => normalizeText(tag).startsWith(t))) return 0;
  }
  let score = query.tags.length * 8;
  if (!query.terms.length) return score;
  const fields = fieldsOf(item);
  for (const term of query.terms) {
    let termTotal = 0;
    for (const f of fields) {
      if (!f.text) continue;
      const s = termScore(f.text, term);
      if (s) termTotal += f.weight * s;
    }
    if (!termTotal) return 0;
    score += termTotal;
  }
  const title = fields[0].text;
  if (query.terms.length > 1 && title.includes(query.phrase)) score += 20;
  if (title === query.phrase) score += 30;
  else if (title.startsWith(`${query.phrase} `)) score += 10;
  return score;
}

export function searchItems(items: Item[], q: string): Item[] {
  const query = parseSearchQuery(q);
  if (!query.terms.length && !query.tags.length) return [];
  const scored: { item: Item; score: number; time: number }[] = [];
  for (const item of items) {
    const score = scoreItem(item, query);
    if (score > 0) scored.push({ item, score, time: itemTime(item) });
  }
  scored.sort((a, b) => b.score - a.score || b.time - a.time || a.item.id.localeCompare(b.item.id));
  return scored.map((s) => s.item);
}
