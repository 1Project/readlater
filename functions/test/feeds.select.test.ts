import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ParsedEntry } from '../src/feeds/parse';
import {
  FIRST_FETCH_LIMIT,
  MAX_NEW_PER_REFRESH,
  MAX_UNDATED_PER_REFRESH,
  candidateEntries,
  capNewEntries,
  feedItemId,
  feedItemType,
  firstFetchLeftovers,
  isDue,
  planFeedItem,
  selectNewEntries,
  type FeedSettings,
} from '../src/feeds/select';

const NOW = new Date('2026-10-09T12:00:00Z');
const DAY = 86_400_000;

function entry(i: number, daysAgo: number | null, extra: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    guid: `guid-${i}`,
    link: `https://example.com/p/${i}`,
    title: `Post ${i}`,
    author: null,
    publishedAt: daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY),
    html: '',
    contentBase: null,
    imageUrl: null,
    ...extra,
  };
}

describe('feedItemId', () => {
  it('is f_ + first 24 hex of sha1(feedId|guid) and stable', () => {
    const expected = 'f_' + createHash('sha1').update('feedA|guid-1').digest('hex').slice(0, 24);
    expect(feedItemId('feedA', 'guid-1')).toBe(expected);
    expect(feedItemId('feedA', 'guid-1')).toBe(feedItemId('feedA', 'guid-1'));
    expect(feedItemId('feedA', 'guid-1')).toMatch(/^f_[0-9a-f]{24}$/);
    expect(feedItemId('feedB', 'guid-1')).not.toBe(feedItemId('feedA', 'guid-1'));
  });

  it('uses the guid, falling back to the link', () => {
    const [withGuid] = candidateEntries('F', [entry(1, 1)], true, NOW);
    expect(withGuid.id).toBe(feedItemId('F', 'guid-1'));
    const [noGuid] = candidateEntries('F', [entry(2, 1, { guid: null })], true, NOW);
    expect(noGuid.id).toBe(feedItemId('F', 'https://example.com/p/2'));
  });
});

describe('selecting new entries', () => {
  it('first fetch: only the newest 20, newest first, regardless of age', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(i, ((i * 7) % 50) + 100)); // shuffled, all > 30 days old
    const sel = selectNewEntries('F', entries, { firstFetch: true, now: NOW });
    expect(sel).toHaveLength(FIRST_FETCH_LIMIT);
    const times = sel.map((c) => c.entry.publishedAt!.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(times[0]).toBe(NOW.getTime() - 100 * DAY);
  });

  it('first fetch with undated entries keeps document order', () => {
    const entries = [entry(1, null), entry(2, 5), entry(3, 1)];
    expect(selectNewEntries('F', entries, { firstFetch: true, now: NOW }).map((c) => c.entry.guid)).toEqual(['guid-1', 'guid-2', 'guid-3']);
  });

  it('later fetches: entries from the last 30 days plus undated, minus existing ones', () => {
    const entries = [entry(1, 1), entry(2, 29), entry(3, 31), entry(4, null), entry(5, 400)];
    const existing = new Set([feedItemId('F', 'guid-1')]);
    const sel = selectNewEntries('F', entries, { firstFetch: false, existing, now: NOW });
    expect(sel.map((c) => c.entry.guid)).toEqual(['guid-2', 'guid-4']);
  });

  it('caps undated entries at 50 and all entries at 200 per refresh', () => {
    const undated = Array.from({ length: 80 }, (_, i) => entry(i, null));
    expect(selectNewEntries('F', undated, { firstFetch: false, now: NOW })).toHaveLength(MAX_UNDATED_PER_REFRESH);
    const dated = Array.from({ length: 300 }, (_, i) => entry(i, (i % 20) + 0.5));
    expect(selectNewEntries('F', dated, { firstFetch: false, now: NOW })).toHaveLength(MAX_NEW_PER_REFRESH);
  });

  it('skips entries without guid or link and duplicate ids', () => {
    const entries = [entry(1, 1), entry(1, 2), entry(2, 1, { guid: null, link: null })];
    expect(candidateEntries('F', entries, false, NOW)).toHaveLength(1);
  });

  it('capNewEntries only removes existing ids', () => {
    const cands = candidateEntries('F', [entry(1, 1), entry(2, 2)], false, NOW);
    expect(capNewEntries(cands, new Set([cands[1].id]))).toEqual([cands[0]]);
  });
});

describe('feedItemType', () => {
  it('maps hosts to item types', () => {
    expect(feedItemType('https://www.youtube.com/watch?v=abc')).toBe('video');
    expect(feedItemType('https://arxiv.org/abs/2610.10550')).toBe('paper');
    expect(feedItemType('https://x.com/someone/status/123456')).toBe('tweet');
    expect(feedItemType('https://x.com/someone')).toBe('article');
    expect(feedItemType('https://example.com/file.pdf')).toBe('article');
    expect(feedItemType(null)).toBe('article');
  });
});

describe('planFeedItem', () => {
  const feed: FeedSettings = { title: 'My Feed', url: 'https://example.com/feed', tags: ['News', '#tech'], categoryId: 'cat1', fullText: false };
  const longHtml = `<p>${'word '.repeat(300)}</p>`;

  it('stores entry content directly (done) with metadata from the feed', () => {
    const e = entry(1, 1, { author: 'Ann', imageUrl: 'https://example.com/i.png' });
    const p = planFeedItem('F', feed, 'My Feed', e, longHtml);
    expect(p.fields).toMatchObject({
      url: 'https://example.com/p/1',
      type: 'article',
      location: 'feed',
      status: 'unread',
      title: 'Post 1',
      titleLocked: false,
      author: 'Ann',
      siteName: 'My Feed',
      imageUrl: 'https://example.com/i.png',
      tags: ['news', 'tech'],
      categoryId: 'cat1',
      feedId: 'F',
      fetchStatus: 'done',
      wordCount: 300,
      readingMinutes: 2,
    });
    expect(p.fields.publishedAt).toEqual(e.publishedAt);
    expect((p.fields.excerpt as string).length).toBeLessThanOrEqual(400);
    expect(p.html).toBe(longHtml);
    expect(p.text.startsWith('word word')).toBe(true);
  });

  it('leaves full-text feeds and teaser-only entries pending for processItem', () => {
    const full = planFeedItem('F', { ...feed, fullText: true }, 'My Feed', entry(1, 1), longHtml);
    expect(full.fields.fetchStatus).toBe('pending');
    expect(full.html).toBe('');
    expect(full.fields.wordCount).toBeNull();
    const teaser = planFeedItem('F', feed, 'My Feed', entry(2, 1), '<p>Comments: 12</p>');
    expect(teaser.fields.fetchStatus).toBe('pending');
    expect(teaser.fields.excerpt).toBe('Comments: 12');
    const hn =
      '<p>Article URL: <a href="https://techcrunch.com/2026/10/08/some-long-article-slug-with-many-words-in-it/">https://techcrunch.com/2026/10/08/some-long-article-slug-with-many-words-in-it/</a></p>' +
      '<p>Comments URL: <a href="https://news.ycombinator.com/item?id=50018350">https://news.ycombinator.com/item?id=50018350</a></p><p>Points: 12</p><p># Comments: 3</p>';
    expect(planFeedItem('F', feed, 'HN', entry(3, 1), hn).fields.fetchStatus).toBe('pending');
  });

  it('keeps short content when there is no link to extract', () => {
    const p = planFeedItem('F', feed, 'My Feed', entry(3, 1, { link: null, title: '' }), '<p>A short microblog note.</p>');
    expect(p.fields.fetchStatus).toBe('done');
    expect(p.fields.url).toBeNull();
    expect(p.fields.title).toBe('A short microblog note.');
  });

  it('falls back to a URL-based title and null category', () => {
    const p = planFeedItem('F', { ...feed, categoryId: null }, null, entry(4, 1, { title: '' }), '');
    expect(p.fields.title).toBe('example.com/p/4');
    expect(p.fields.categoryId).toBeNull();
    expect(p.fields.siteName).toBe('example.com');
  });
});

describe('isDue', () => {
  it('skips feeds fetched less than 45 minutes ago', () => {
    const now = NOW.getTime();
    expect(isDue(null, now)).toBe(true);
    expect(isDue(new Date(now - 44 * 60_000), now)).toBe(false);
    expect(isDue(new Date(now - 46 * 60_000), now)).toBe(true);
  });
});

describe('first-fetch backlog (later refreshes must not add what the first fetch skipped)', () => {
  // 60 posts, one every 12 hours: the first fetch takes the newest 20.
  const HALF_DAY = 0.5;
  const entries = Array.from({ length: 60 }, (_, i) => entry(i, i * HALF_DAY));

  it('a second fetch with no new posts adds nothing once the watermark and seen ids are applied', () => {
    const first = selectNewEntries('F', entries, { firstFetch: true, now: NOW });
    expect(first).toHaveLength(20);
    const { since, rest } = firstFetchLeftovers('F', entries, NOW);
    expect(since?.getTime()).toBe(NOW.getTime() - 19 * HALF_DAY * DAY);
    expect(rest).toEqual([]); // every skipped entry is dated and older than the watermark
    const existing = new Set(first.map((c) => c.id));
    const second = selectNewEntries('F', entries, { firstFetch: false, now: new Date(NOW.getTime() + 3_600_000), existing, since });
    expect(second).toEqual([]);
    // Without the watermark the bug reappears (40 old posts).
    expect(selectNewEntries('F', entries, { firstFetch: false, now: NOW, existing })).toHaveLength(40);
  });

  it('new posts after the first fetch are still added', () => {
    const { since } = firstFetchLeftovers('F', entries, NOW);
    const later = new Date(NOW.getTime() + DAY);
    const fresh = entry(100, -0.5); // published half a day after NOW
    const existing = new Set(selectNewEntries('F', entries, { firstFetch: true, now: NOW }).map((c) => c.id));
    const sel = selectNewEntries('F', [fresh, ...entries], { firstFetch: false, now: later, existing, since });
    expect(sel.map((c) => c.entry.guid)).toEqual(['guid-100']);
  });

  it('undated skipped entries are returned to be marked as seen (they have no date to compare)', () => {
    const undated = Array.from({ length: 30 }, (_, i) => entry(i, null));
    const { since, rest } = firstFetchLeftovers('F', undated, NOW);
    expect(since).toBeNull();
    expect(rest.map((c) => c.entry.guid)).toEqual(undated.slice(20).map((e) => e.guid));
    const existing = new Set(selectNewEntries('F', undated, { firstFetch: true, now: NOW }).map((c) => c.id));
    for (const c of rest) existing.add(c.id);
    expect(selectNewEntries('F', undated, { firstFetch: false, now: NOW, existing })).toEqual([]);
  });

  it('nothing is left behind when the feed fits the first fetch', () => {
    expect(firstFetchLeftovers('F', entries.slice(0, 20), NOW)).toEqual({ since: null, rest: [] });
  });
});
