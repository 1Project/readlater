import { describe, expect, it } from 'vitest';
import {
  computeStats,
  dailyHighlights,
  dayKey,
  libraryTotals,
  readingStreaks,
  seededRandom,
  seededShuffle,
  startOfWeek,
  topSites,
  topTags,
  weeklyActivity,
  wordsRead,
} from './stats';
import type { Item } from './types';

// Friday 9 Oct 2026, 15:00 local.
const NOW = new Date(2026, 9, 9, 15, 0);
const day = (offset: number, hour = 12) => new Date(2026, 9, 9 + offset, hour);
const ts = (d: Date) => ({ toDate: () => d });

type S = Parameters<typeof wordsRead>[0][number];
function it_(extra: Partial<Item> & { created?: Date; archived?: Date } = {}): S {
  const { created, archived, ...rest } = extra;
  return {
    location: 'library',
    status: archived ? 'archived' : 'unread',
    favorite: false,
    tags: [],
    wordCount: null,
    siteName: null,
    url: null,
    createdAt: created ? ts(created) : ts(day(0)),
    archivedAt: archived ? ts(archived) : null,
    ...rest,
  } as S;
}

describe('dates', () => {
  it('formats local day keys and finds Monday', () => {
    expect(dayKey(NOW)).toBe('2026-10-09');
    expect(dayKey(startOfWeek(NOW))).toBe('2026-10-05');
    expect(dayKey(startOfWeek(new Date(2026, 9, 5, 0, 0)))).toBe('2026-10-05'); // Monday itself
    expect(dayKey(startOfWeek(new Date(2026, 9, 11, 23, 59)))).toBe('2026-10-05'); // Sunday
  });
});

describe('weeklyActivity', () => {
  it('counts saved and finished library items per week, oldest first', () => {
    const items = [
      it_({ created: day(0) }),
      it_({ created: day(-1), archived: day(0) }),
      it_({ created: day(-7), archived: day(-6) }),
      it_({ created: day(-200) }), // older than 12 weeks
      it_({ created: day(0), location: 'feed', archived: day(0) }), // feed: ignored
      it_({ createdAt: null }), // pending server timestamp counts as now
    ];
    const weeks = weeklyActivity(items, NOW);
    expect(weeks).toHaveLength(12);
    expect(dayKey(weeks[11].start)).toBe('2026-10-05');
    expect(dayKey(weeks[0].start)).toBe('2026-07-20');
    expect(weeks[11]).toMatchObject({ saved: 3, finished: 1 });
    expect(weeks[10]).toMatchObject({ saved: 1, finished: 1 });
    expect(weeks.slice(0, 10).every((w) => w.saved === 0 && w.finished === 0)).toBe(true);
  });
});

describe('totals', () => {
  it('sums words of archived library items only', () => {
    const items = [
      it_({ wordCount: 1000, archived: day(0) }),
      it_({ wordCount: 500 }),
      it_({ wordCount: 300, archived: day(0), location: 'feed' }),
      it_({ wordCount: null, archived: day(0) }),
    ];
    expect(wordsRead(items)).toBe(1000);
  });

  it('counts library totals', () => {
    const items = [it_({ favorite: true }), it_({ archived: day(0) }), it_({ location: 'feed' })];
    expect(libraryTotals(items)).toEqual({ saved: 2, unread: 1, archived: 1, favorites: 1 });
  });

  it('ranks tags and sites', () => {
    const items = [
      it_({ tags: ['ai', 'go'], url: 'https://www.example.com/a' }),
      it_({ tags: ['ai'], siteName: 'The Blog', url: 'https://blog.example.org/x' }),
      it_({ tags: ['zz'], url: 'https://example.com/b' }),
      it_({ tags: ['feedtag'], location: 'feed', url: 'https://feed.example/' }),
    ];
    expect(topTags(items)).toEqual([
      { tag: 'ai', count: 2 },
      { tag: 'go', count: 1 },
      { tag: 'zz', count: 1 },
    ]);
    expect(topTags(items, 1)).toEqual([{ tag: 'ai', count: 2 }]);
    expect(topSites(items)).toEqual([
      { site: 'example.com', count: 2 },
      { site: 'The Blog', count: 1 },
    ]);
  });
});

describe('readingStreaks', () => {
  it('is zero without archived items', () => {
    expect(readingStreaks([it_()], NOW)).toEqual({ current: 0, longest: 0 });
  });

  it('counts the current streak ending today and the longest run', () => {
    const items = [day(0), day(-1), day(-1, 8), day(-2), day(-10), day(-11), day(-12), day(-13)].map((d) => it_({ archived: d }));
    expect(readingStreaks(items, NOW)).toEqual({ current: 3, longest: 4 });
  });

  it('keeps the streak alive until the end of today', () => {
    const items = [day(-1), day(-2)].map((d) => it_({ archived: d }));
    expect(readingStreaks(items, NOW)).toEqual({ current: 2, longest: 2 });
    expect(readingStreaks([it_({ archived: day(-2) })], NOW)).toEqual({ current: 0, longest: 1 });
  });

  it('handles month boundaries', () => {
    const items = [new Date(2026, 8, 30, 10), new Date(2026, 9, 1, 10)].map((d) => it_({ archived: d }));
    expect(readingStreaks(items, new Date(2026, 9, 1, 20)).current).toBe(2);
  });

  it('ignores feed items marked seen', () => {
    expect(readingStreaks([it_({ archived: day(0), location: 'feed' })], NOW)).toEqual({ current: 0, longest: 0 });
  });
});

describe('computeStats', () => {
  it('bundles everything', () => {
    const s = computeStats([it_({ archived: day(0), wordCount: 42, tags: ['x'] })], [{}, {}], NOW);
    expect(s.highlights).toBe(2);
    expect(s.wordsRead).toBe(42);
    expect(s.streak.current).toBe(1);
    expect(s.weeks).toHaveLength(12);
    expect(s.topTags[0].tag).toBe('x');
  });
});

describe('seeded randomness', () => {
  it('is deterministic per seed', () => {
    const a = seededRandom('2026-10-09');
    const b = seededRandom('2026-10-09');
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom('2026-10-10')()).not.toBe(xs[0]);
  });

  it('shuffles without losing elements', () => {
    const list = Array.from({ length: 20 }, (_, i) => i);
    const out = seededShuffle(list, 'x');
    expect(out).not.toBe(list);
    expect([...out].sort((p, q) => p - q)).toEqual(list);
    expect(seededShuffle(list, 'x')).toEqual(out);
  });

  it('picks the same daily highlights regardless of input order', () => {
    const hs = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}` }));
    const today = dailyHighlights(hs, NOW);
    expect(today).toHaveLength(5);
    expect(new Set(today.map((h) => h.id)).size).toBe(5);
    expect(dailyHighlights([...hs].reverse(), new Date(2026, 9, 9, 23, 59))).toEqual(today);
    expect(dailyHighlights(hs, day(1)).map((h) => h.id)).not.toEqual(today.map((h) => h.id));
    expect(dailyHighlights(hs, NOW, 5, 1).map((h) => h.id)).not.toEqual(today.map((h) => h.id));
    expect(dailyHighlights(hs.slice(0, 3), NOW)).toHaveLength(3);
    expect(dailyHighlights([], NOW)).toEqual([]);
  });
});
