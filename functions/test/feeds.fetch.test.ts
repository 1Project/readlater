import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from './fixtures/extract/mockFetch';
import { fetchFeed } from '../src/feeds/poll';
import { cleanFeedInput, resolveFeed } from '../src/feeds/subscribe';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures/feeds', name), 'utf8');
const RSS = 'application/rss+xml; charset=utf-8';

afterEach(() => {
  vi.restoreAllMocks();
});

function headersOf(spy: { mock: { calls: unknown[][] } }, call = 0): Record<string, string> {
  return (spy.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

describe('fetchFeed (conditional GET)', () => {
  it('sends If-None-Match / If-Modified-Since and returns null on 304', async () => {
    // 304 responses must have a null body, which the shared mockFetch helper cannot produce.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 304 }));
    const r = await fetchFeed('https://blog.example.com/feed', { etag: '"abc"', lastModified: 'Tue, 06 Oct 2026 09:30:00 GMT' });
    expect(r).toBeNull();
    const h = headersOf(spy);
    expect(h['if-none-match']).toBe('"abc"');
    expect(h['if-modified-since']).toBe('Tue, 06 Oct 2026 09:30:00 GMT');
  });

  it('parses a 200 response and returns validators', async () => {
    const spy = mockFetch([['https://blog.example.com/feed', { body: fx('rss2.xml'), type: RSS, headers: { etag: '"v2"', 'last-modified': 'Wed, 07 Oct 2026 00:00:00 GMT' } }]]);
    const r = await fetchFeed('https://blog.example.com/feed');
    expect(r?.parsed.title).toBe('Example & Co Blog');
    expect(r?.etag).toBe('"v2"');
    expect(r?.lastModified).toBe('Wed, 07 Oct 2026 00:00:00 GMT');
    expect(headersOf(spy)['if-none-match']).toBeUndefined();
  });

  it('throws for HTTP errors and non-feeds', async () => {
    mockFetch([
      ['https://gone.example.com/feed', { status: 410, body: 'gone' }],
      ['https://html.example.com/feed', { body: fx('page.html') }],
    ]);
    await expect(fetchFeed('https://gone.example.com/feed')).rejects.toThrow(/HTTP 410/);
    await expect(fetchFeed('https://html.example.com/feed')).rejects.toThrow(/not an RSS/);
  });
});

describe('resolveFeed (addFeed discovery)', () => {
  it('uses the URL directly when it is a feed', async () => {
    mockFetch([['https://blog.example.com/feed', { body: fx('rss2.xml'), type: RSS }]]);
    const r = await resolveFeed('https://blog.example.com/feed');
    expect(r.feedUrl).toBe('https://blog.example.com/feed');
    expect(r.parsed.entries).toHaveLength(3);
  });

  it('discovers an advertised feed from an HTML page, skipping failing candidates', async () => {
    const spy = mockFetch([
      [/^https:\/\/some\.example\.com\/blog\/post$/, { body: fx('page.html') }],
      ['https://some.example.com/feed/', { status: 500, body: 'oops' }],
      ['https://some.example.com/atom.xml?x=1&y=2', { body: fx('atom.xml'), type: 'application/atom+xml' }],
    ]);
    const r = await resolveFeed('https://some.example.com/blog/post');
    expect(r.feedUrl).toBe('https://some.example.com/atom.xml?x=1&y=2');
    expect(r.parsed.title).toBe('Atom & Eve');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('falls back to common paths when nothing is advertised', async () => {
    const spy = mockFetch([
      ['https://plain.example.com/atom.xml', { body: fx('atom.xml'), type: 'application/atom+xml' }],
      [/^https:\/\/plain\.example\.com\/$/, { body: '<html><head><title>Plain</title></head><body>hi</body></html>' }],
    ]);
    const r = await resolveFeed('https://plain.example.com/');
    expect(r.feedUrl).toBe('https://plain.example.com/atom.xml');
    // page, /feed, /rss, /atom.xml
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://plain.example.com/',
      'https://plain.example.com/feed',
      'https://plain.example.com/rss',
      'https://plain.example.com/atom.xml',
    ]);
  });

  it('still tries well-known feed URLs when the page itself cannot be fetched', async () => {
    mockFetch([
      ['https://www.reddit.com/r/rust/.rss', { body: fx('atom.xml'), type: 'application/atom+xml' }],
      ['https://www.reddit.com/r/rust', { status: 403, body: 'blocked' }],
    ]);
    const r = await resolveFeed('https://www.reddit.com/r/rust');
    expect(r.feedUrl).toBe('https://www.reddit.com/r/rust/.rss');
  });

  it('reports not-found when no candidate is a feed, and the fetch error when nothing can be tried', async () => {
    mockFetch([[/^https:\/\/nofeed\.example\.com\/$/, { body: '<html><head></head><body></body></html>' }]]);
    await expect(resolveFeed('https://nofeed.example.com/')).rejects.toMatchObject({ code: 'not-found' });
    vi.restoreAllMocks();
    mockFetch([]);
    await expect(resolveFeed('https://down.example.com/')).rejects.toMatchObject({ code: 'unavailable', message: 'HTTP 404 fetching down.example.com' });
  });
});

describe('cleanFeedInput', () => {
  it('normalises schemes and rejects junk', () => {
    expect(cleanFeedInput('example.com/feed')).toBe('https://example.com/feed');
    expect(cleanFeedInput('feed://example.com/rss')).toBe('https://example.com/rss');
    expect(cleanFeedInput('feed:https://example.com/rss')).toBe('https://example.com/rss');
    expect(() => cleanFeedInput('')).toThrow();
    expect(() => cleanFeedInput(42)).toThrow();
    expect(() => cleanFeedInput('ftp://example.com/x')).toThrow();
  });
});
