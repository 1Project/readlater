import { describe, expect, it } from 'vitest';
import {
  canonicalViewParams,
  describeViewParams,
  filterItems,
  inScope,
  itemTime,
  matchesType,
  normalizeText,
  parseFeedView,
  parseLibraryView,
  parseScope,
  parseSearchQuery,
  parseSort,
  parseTypeFilter,
  scoreItem,
  searchItems,
  sortItems,
  textSnippet,
} from './filters';
import type { Item } from './types';

const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }) as unknown as Item['createdAt'];

let seq = 0;
function mk(p: Partial<Item> & { created?: number | null; published?: number; archived?: number }): Item {
  seq++;
  const { created, published, archived, ...rest } = p;
  return {
    id: `i${seq}`,
    url: `https://example.com/${seq}`,
    type: 'article',
    location: 'library',
    status: 'unread',
    favorite: false,
    title: `Item ${seq}`,
    titleLocked: false,
    author: null,
    siteName: null,
    excerpt: null,
    imageUrl: null,
    publishedAt: published != null ? ts(published) : null,
    wordCount: null,
    readingMinutes: null,
    categoryId: null,
    tags: [],
    note: '',
    progress: 0,
    fetchStatus: 'done',
    fetchError: null,
    contentChunks: 0,
    file: null,
    feedId: null,
    paper: null,
    createdAt: created === null ? null : ts(created ?? seq * 1000),
    updatedAt: null,
    lastOpenedAt: null,
    archivedAt: archived != null ? ts(archived) : null,
    ...rest,
  };
}

describe('param parsers', () => {
  it('fall back to defaults for unknown values', () => {
    expect(parseLibraryView(null)).toBe('unread');
    expect(parseLibraryView('archive')).toBe('archive');
    expect(parseLibraryView('bogus')).toBe('unread');
    expect(parseFeedView('seen')).toBe('seen');
    expect(parseFeedView(undefined)).toBe('new');
    expect(parseTypeFilter('epub')).toBe('epub');
    expect(parseTypeFilter('other')).toBe('all');
    expect(parseSort('long')).toBe('long');
    expect(parseSort('opened')).toBe('opened');
    expect(parseSort('')).toBe('new');
    expect(parseScope('feed')).toBe('feed');
    expect(parseScope('x')).toBe('all');
  });
});

describe('filterItems', () => {
  const a = mk({ tags: ['ai', 'ml'], categoryId: 'c1' });
  const b = mk({ status: 'archived', favorite: true, type: 'paper', tags: ['ai'] });
  const c = mk({ location: 'feed', feedId: 'f1', categoryId: 'c1' });
  const d = mk({ location: 'feed', feedId: 'f2', status: 'archived' });
  const e = mk({ type: 'other', fetchStatus: 'pending' });
  const all = [a, b, c, d, e];

  it('filters by location and library view', () => {
    expect(filterItems(all, { location: 'library', view: 'unread' })).toEqual([a, e]);
    expect(filterItems(all, { location: 'library', view: 'archive' })).toEqual([b]);
    expect(filterItems(all, { location: 'library', view: 'favorites' })).toEqual([b]);
    expect(filterItems(all, { location: 'library', view: 'all' })).toEqual([a, b, e]);
  });

  it('filters feed items by view and feed', () => {
    expect(filterItems(all, { location: 'feed', view: 'new' })).toEqual([c]);
    expect(filterItems(all, { location: 'feed', view: 'seen' })).toEqual([d]);
    expect(filterItems(all, { location: 'feed', feedId: 'f2' })).toEqual([d]);
  });

  it('filters by category, tag and type', () => {
    expect(filterItems(all, { categoryId: 'c1' })).toEqual([a, c]);
    expect(filterItems(all, { tag: 'ai' })).toEqual([a, b]);
    expect(filterItems(all, { tag: 'ml', location: 'library', view: 'archive' })).toEqual([]);
    expect(filterItems(all, { type: 'paper' })).toEqual([b]);
    expect(filterItems(all, { type: 'all', categoryId: null, tag: null })).toEqual(all);
  });

  it('keeps items that are still processing', () => {
    expect(filterItems(all, { location: 'library', view: 'unread', type: 'article' })).toContain(e);
  });

  it('matchesType maps articles to article + other', () => {
    expect(matchesType(mk({ type: 'other' }), 'article')).toBe(true);
    expect(matchesType(mk({ type: 'epub' }), 'article')).toBe(false);
    expect(matchesType(mk({ type: 'epub' }), 'epub')).toBe(true);
    expect(matchesType(mk({ type: 'video' }), null)).toBe(true);
  });
});

describe('sortItems', () => {
  const old = mk({ created: 1000, wordCount: 5000 });
  const mid = mk({ created: 2000, readingMinutes: 2 });
  const fresh = mk({ created: 3000 });
  const pending = mk({ created: null, wordCount: 100 });
  const list = [mid, old, pending, fresh];

  it('sorts newest / oldest with pending timestamps first', () => {
    expect(sortItems(list, 'new')).toEqual([pending, fresh, mid, old]);
    expect(sortItems(list, 'old')).toEqual([old, mid, fresh, pending]);
  });

  it('sorts by length with unknown lengths last', () => {
    expect(sortItems(list, 'short')).toEqual([pending, mid, old, fresh]);
    expect(sortItems(list, 'long')).toEqual([old, mid, pending, fresh]);
  });

  it('sorts by recently opened (continue reading), never-opened items last', () => {
    const a = mk({ created: 1000, lastOpenedAt: ts(50_000) });
    const b = mk({ created: 2000, lastOpenedAt: ts(90_000) });
    const c = mk({ created: 3000 });
    const d = mk({ created: 4000 });
    expect(sortItems([a, c, b, d], 'opened')).toEqual([b, a, d, c]);
  });

  it('does not mutate the input', () => {
    const copy = [...list];
    sortItems(list, 'old');
    expect(list).toEqual(copy);
  });

  it('can sort by another date field with createdAt fallback', () => {
    const x = mk({ created: 1000, archived: 9000 });
    const y = mk({ created: 5000 });
    expect(sortItems([y, x], 'new', 'archivedAt')).toEqual([x, y]);
    expect(itemTime(y, 'publishedAt')).toBe(5000);
    const p = mk({ created: 1, published: 7000 });
    expect(itemTime(p, 'publishedAt')).toBe(7000);
  });
});

describe('inScope', () => {
  it('splits items into library / archive / feed', () => {
    const lib = mk({});
    const arch = mk({ status: 'archived' });
    const feed = mk({ location: 'feed', status: 'archived' });
    expect([lib, arch, feed].map((i) => inScope(i, 'library'))).toEqual([true, false, false]);
    expect([lib, arch, feed].map((i) => inScope(i, 'archive'))).toEqual([false, true, false]);
    expect([lib, arch, feed].map((i) => inScope(i, 'feed'))).toEqual([false, false, true]);
    expect([lib, arch, feed].every((i) => inScope(i, 'all'))).toBe(true);
  });
});

describe('search', () => {
  it('normalizes text', () => {
    expect(normalizeText('  Crème  Brûlée\n')).toBe('creme brulee');
    expect(normalizeText(null)).toBe('');
  });

  it('parses terms and #tags', () => {
    expect(parseSearchQuery('  Rust, #Lang  async!! rust ')).toEqual({ terms: ['rust', 'async'], tags: ['lang'], phrase: 'rust async rust' });
    expect(parseSearchQuery('#')).toEqual({ terms: [], tags: [], phrase: '' });
  });

  const rust = mk({ title: 'Async Rust in practice', author: 'Jane Doe', tags: ['programming'], created: 100 });
  const tagOnly = mk({ title: 'Weekly notes', tags: ['rust'], created: 200 });
  const excerpt = mk({ title: 'Systems', excerpt: 'We rewrote it in rust last year', created: 300 });
  const accent = mk({ title: 'Café culture', siteName: 'Le Monde', created: 400 });
  const noteItem = mk({ title: 'Something', note: 'Recommended by Bob', url: 'https://blog.example.org/x', created: 500 });
  const items = [rust, tagOnly, excerpt, accent, noteItem];

  it('requires every term to match and ranks title matches first', () => {
    expect(searchItems(items, 'rust')).toEqual([rust, tagOnly, excerpt]);
    expect(searchItems(items, 'rust async')).toEqual([rust]);
    expect(searchItems(items, 'rust python')).toEqual([]);
  });

  it('matches diacritics-insensitively and across metadata fields', () => {
    expect(searchItems(items, 'cafe')).toEqual([accent]);
    expect(searchItems(items, 'monde')).toEqual([accent]);
    expect(searchItems(items, 'bob')).toEqual([noteItem]);
    expect(searchItems(items, 'blog.example')).toEqual([noteItem]);
    expect(searchItems(items, 'jane')).toEqual([rust]);
  });

  it('supports #tag filters (prefix match)', () => {
    expect(searchItems(items, '#prog')).toEqual([rust]);
    expect(searchItems(items, '#rust weekly')).toEqual([tagOnly]);
    expect(searchItems(items, '#nothing')).toEqual([]);
  });

  it('prefers whole-word and word-start matches', () => {
    const word = mk({ title: 'The cat sat', created: 1 });
    const inner = mk({ title: 'Concatenate strings', created: 2 });
    const prefix = mk({ title: 'Catalog of things', created: 3 });
    expect(searchItems([inner, prefix, word], 'cat')).toEqual([word, prefix, inner]);
  });

  it('breaks score ties by recency', () => {
    const older = mk({ title: 'Go tips', created: 10 });
    const newer = mk({ title: 'Go tips', created: 20 });
    expect(searchItems([older, newer], 'go tips')).toEqual([newer, older]);
  });

  it('returns nothing for empty queries and scores 0 for misses', () => {
    expect(searchItems(items, '   ')).toEqual([]);
    expect(scoreItem(rust, parseSearchQuery('zebra'))).toBe(0);
    expect(scoreItem(rust, parseSearchQuery('rust'))).toBeGreaterThan(0);
  });
});

describe('saved view params', () => {
  it('canonicalises a Library query string', () => {
    expect(canonicalViewParams('?tag=ai&view=unread&sort=new&type=all&x=1')).toBe('tag=ai');
    expect(canonicalViewParams(new URLSearchParams('view=archive&cat=c1&sort=long&type=paper'))).toBe('cat=c1&sort=long&type=paper&view=archive');
    expect(canonicalViewParams('view=bogus&sort=bogus&type=bogus&tag=')).toBe('');
    expect(canonicalViewParams('tag=a b')).toBe('tag=a+b');
  });

  it('describes a view', () => {
    const cats = [{ id: 'c1', name: 'Essays' }];
    expect(describeViewParams('view=archive&cat=c1&tag=ai&type=paper&sort=long', cats)).toBe('Archive · Essays · #ai · Papers · Longest');
    expect(describeViewParams('cat=gone')).toBe('Category');
    expect(describeViewParams('')).toBe('Unread');
  });
});

describe('textSnippet', () => {
  const text = 'The quick brown fox jumps over the lazy dog. Electronic paper, also called e-ink, is a display that reflects light like ordinary paper. Café culture is nice.';
  it('finds the first term, ignoring case and accents, with context cut at words', () => {
    const s = textSnippet(text, ['reflects'], 30)!;
    expect(s.match).toBe('reflects');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect(`${s.before}${s.match}${s.after}`.replace(/…/g, '')).toContain('display that reflects light');
    expect(textSnippet(text, ['cafe'])!.match).toBe('Café');
    expect(textSnippet(text, ['electronic'], 500)).toEqual({ before: 'The quick brown fox jumps over the lazy dog. ', match: 'Electronic', after: text.slice(text.indexOf('Electronic') + 10) });
  });
  it('returns null without a match', () => {
    expect(textSnippet(text, ['zebra'])).toBeNull();
    expect(textSnippet('', ['x'])).toBeNull();
  });
});
