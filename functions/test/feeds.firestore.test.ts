/**
 * Firestore integration tests for feed refresh/subscribe. They run only against the Firestore emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-readlater npx vitest run test/feeds.firestore.test.ts
 * (or via `firebase emulators:exec --only firestore`). Without the emulator they are skipped.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mockFetch } from './fixtures/extract/mockFetch';

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
if (EMU) process.env.GCLOUD_PROJECT ??= 'demo-readlater';

type Mods = {
  admin: typeof import('../src/admin');
  poll: typeof import('../src/feeds/poll');
  sub: typeof import('../src/feeds/subscribe');
  select: typeof import('../src/feeds/select');
};
let m: Mods;

const para = (n: number) => `<p>${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}</p>`;
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toUTCString();

function rss(items: { guid: string; title: string; daysAgo: number; words?: number; link?: string }[]): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <title>Integration Feed</title><link>https://int.example.com/</link>
    ${items
      .map(
        (i) => `<item><title>${i.title}</title><guid isPermaLink="false">${i.guid}</guid><link>${i.link ?? `https://int.example.com/${i.guid}`}</link>
        <pubDate>${day(i.daysAgo)}</pubDate><content:encoded><![CDATA[${para(i.words ?? 120)}]]></content:encoded></item>`,
      )
      .join('')}
  </channel></rss>`;
}

describe.skipIf(!EMU)('feeds against the Firestore emulator', () => {
  const uid = `u_${Date.now()}`;

  beforeAll(async () => {
    m = {
      admin: await import('../src/admin'),
      poll: await import('../src/feeds/poll'),
      sub: await import('../src/feeds/subscribe'),
      select: await import('../src/feeds/select'),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const user = () => m.admin.db.collection('users').doc(uid);

  it('subscribes, ingests, refreshes conditionally and only adds new entries', async () => {
    const feedUrl = 'https://int.example.com/feed.xml';
    const first = rss([
      { guid: 'a', title: 'Alpha', daysAgo: 1 },
      { guid: 'b', title: 'Beta', daysAgo: 2, words: 5 }, // teaser → pending
      { guid: 'c', title: 'Gamma', daysAgo: 40 },
    ]);
    mockFetch([[feedUrl, { body: first, type: 'application/rss+xml', headers: { etag: '"e1"' } }]]);
    const cat = await user().collection('categories').add({ name: 'News', order: 1 });
    const res = await m.sub.addFeedForUser(uid, { url: feedUrl, tags: ['Tech'], categoryId: cat.id });
    expect(res).toMatchObject({ title: 'Integration Feed', added: 3, existing: false });

    const feedRef = user().collection('feeds').doc(res.id);
    const feed = (await feedRef.get()).data()!;
    expect(feed).toMatchObject({ url: feedUrl, title: 'Integration Feed', siteUrl: 'https://int.example.com/', etag: '"e1"', lastError: null, fullText: false, tags: ['tech'], categoryId: cat.id });
    expect(feed.lastFetchedAt).toBeTruthy();

    const idA = m.select.feedItemId(res.id, 'a');
    const a = (await user().collection('items').doc(idA).get()).data()!;
    expect(a).toMatchObject({
      url: 'https://int.example.com/a',
      location: 'feed',
      status: 'unread',
      title: 'Alpha',
      siteName: 'Integration Feed',
      feedId: res.id,
      fetchStatus: 'done',
      contentChunks: 1,
      wordCount: 120,
      tags: ['tech'],
      categoryId: cat.id,
      favorite: false,
      progress: 0,
      note: '',
      file: null,
    });
    const content = await user().collection('items').doc(idA).collection('content').doc('0').get();
    expect(content.get('html')).toContain('word119');
    const kw = (await user().collection('search').doc(idA).get()).get('kw') as string[];
    expect(kw).toEqual(expect.arrayContaining(['alpha', 'integration', 'word0', 'tech']));

    const b = (await user().collection('items').doc(m.select.feedItemId(res.id, 'b')).get()).data()!;
    expect(b.fetchStatus).toBe('pending');
    expect((await user().collection('search').doc(m.select.feedItemId(res.id, 'b')).get()).exists).toBe(false);

    // Duplicate subscription returns the existing feed.
    mockFetch([[feedUrl, { body: first, type: 'application/rss+xml' }]]);
    const dup = await m.sub.addFeedForUser(uid, { url: feedUrl });
    expect(dup).toMatchObject({ id: res.id, existing: true, added: 0 });

    // 304 Not Modified: nothing added, validators sent.
    vi.restoreAllMocks();
    const spy304 = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 304 }));
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(0);
    expect(((spy304.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['if-none-match']).toBe('"e1"');

    // Later refresh: only new, recent entries; old unseen ones (> 30 days) and already-saved URLs are skipped.
    vi.restoreAllMocks();
    await user().collection('items').doc('lib1').set({ url: 'https://int.example.com/saved', location: 'library' });
    const second = rss([
      { guid: 'd', title: 'Delta', daysAgo: 0 },
      { guid: 'saved', title: 'Already saved', daysAgo: 0 },
      { guid: 'a', title: 'Alpha', daysAgo: 1 },
      { guid: 'old', title: 'Old', daysAgo: 45 },
    ]);
    mockFetch([[feedUrl, { body: second, type: 'application/rss+xml' }]]);
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(1);
    expect((await user().collection('items').doc(m.select.feedItemId(res.id, 'd')).get()).exists).toBe(true);
    expect((await user().collection('items').doc(m.select.feedItemId(res.id, 'old')).get()).exists).toBe(false);
    expect((await feedRef.get()).get('etag')).toBeUndefined();

    // Errors are recorded on the feed, not thrown.
    vi.restoreAllMocks();
    mockFetch([[feedUrl, { status: 500, body: 'down' }]]);
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(0);
    expect((await feedRef.get()).get('lastError')).toMatch(/HTTP 500/);
  });

  it('a refresh neither re-adds deleted entries nor the backlog the first fetch skipped', async () => {
    const { feedSeenRef, seenDoc } = await import('../src/feeds/seen');
    const feedRef = user().collection('feeds').doc('backlog');
    await feedRef.set({ url: 'https://bl.example.com/rss', title: 'BL', siteUrl: null, categoryId: null, tags: [], fullText: false, lastFetchedAt: null, lastError: null });
    // 30 posts, one every 12 hours: the first fetch takes the newest 20.
    const posts = Array.from({ length: 30 }, (_, i) => ({ guid: `p${i}`, title: `Post ${i}`, daysAgo: i / 2 }));
    mockFetch([['https://bl.example.com/rss', { body: rss(posts), type: 'application/rss+xml' }]]);
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(20);
    expect((await feedRef.get()).get('since')).toBeTruthy();
    // The user deletes one entry (cleanupItem leaves a feedSeen tombstone).
    const gone = m.select.feedItemId('backlog', 'p3');
    await user().collection('items').doc(gone).delete();
    await feedSeenRef(uid, gone).set(seenDoc('backlog'));
    // Same feed again (no ETag): nothing comes back.
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(0);
    expect((await user().collection('items').doc(gone).get()).exists).toBe(false);
    expect((await user().collection('items').doc(m.select.feedItemId('backlog', 'p25')).get()).exists).toBe(false);
    // A new post still arrives.
    vi.restoreAllMocks();
    mockFetch([['https://bl.example.com/rss', { body: rss([{ guid: 'new', title: 'New', daysAgo: 0 }, ...posts]), type: 'application/rss+xml' }]]);
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(1);
  });

  it('full-text feeds leave every new item pending', async () => {
    const feedRef = user().collection('feeds').doc('ft');
    await feedRef.set({ url: 'https://ft.example.com/rss', title: 'FT', siteUrl: null, categoryId: null, tags: [], fullText: true, lastFetchedAt: null, lastError: null });
    mockFetch([['https://ft.example.com/rss', { body: rss([{ guid: 'x', title: 'X', daysAgo: 1, link: 'https://ft.example.com/x' }]), type: 'application/rss+xml' }]]);
    expect(await m.poll.refreshFeed(uid, await feedRef.get())).toBe(1);
    const item = (await user().collection('items').doc(m.select.feedItemId('ft', 'x')).get()).data()!;
    expect(item).toMatchObject({ fetchStatus: 'pending', contentChunks: 0, siteName: 'FT', url: 'https://ft.example.com/x' });
  });

  it('pollFeeds refreshes due feeds and skips recently fetched ones', async () => {
    const { pollFeeds } = await import('../src/feeds');
    const { Timestamp } = await import('firebase-admin/firestore');
    const other = m.admin.db.collection('users').doc(`${uid}_2`).collection('feeds');
    await other.doc('due').set({ url: 'https://due.example.com/rss', title: '', siteUrl: null, categoryId: null, tags: [], fullText: false, lastFetchedAt: Timestamp.fromMillis(Date.now() - 2 * 3600_000), lastError: null });
    await other.doc('recent').set({ url: 'https://recent.example.com/rss', title: 'R', siteUrl: null, categoryId: null, tags: [], fullText: false, lastFetchedAt: Timestamp.fromMillis(Date.now() - 10 * 60_000), lastError: null });
    const spy = mockFetch([['https://due.example.com/rss', { body: rss([{ guid: 'p', title: 'Polled', daysAgo: 0 }]), type: 'application/rss+xml' }]]);
    await pollFeeds.run({ scheduleTime: new Date().toISOString() });
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://due.example.com/rss');
    expect(urls).not.toContain('https://recent.example.com/rss');
    expect((await other.doc('due').get()).get('title')).toBe('Integration Feed');
    const item = await m.admin.db.collection('users').doc(`${uid}_2`).collection('items').doc(m.select.feedItemId('due', 'p')).get();
    expect(item.get('title')).toBe('Polled');
  });
});
