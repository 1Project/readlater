import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, sanitizeHtml } from '../src/extract';
import { FetchError } from '../src/http';
import {
  archiveNote,
  isArchiveWorthyError,
  looksBlocked,
  looksPaywalled,
  parseAvailability,
  parseSnapshotUrl,
  snapshotDate,
  snapshotUrl,
} from '../src/extract/wayback';
import { fixture, mockFetch } from './fixtures/extract/mockFetch';

afterEach(() => vi.restoreAllMocks());

const URL1 = 'https://news.example/2024/03/the-story';
const TS = '20240305093000';
const AVAILABLE = JSON.stringify({
  url: URL1,
  archived_snapshots: { closest: { status: '200', available: true, url: `http://web.archive.org/web/${TS}/${URL1}`, timestamp: TS } },
});
const SNAPSHOT = `https://web.archive.org/web/${TS}id_/${URL1}`;

const PAYWALLED = `<!doctype html><html><head><title>The story | News</title>
<meta property="og:title" content="The story">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"The story","isAccessibleForFree":false}</script>
</head><body><article><h1>The story</h1><p>The first two sentences of a long story are free to read for everyone.</p>
<div class="paywall"><p>Subscribe to continue reading.</p></div></article></body></html>`;

describe('wayback helpers', () => {
  it('parses snapshot URLs and builds the id_ form', () => {
    expect(parseSnapshotUrl(`http://web.archive.org/web/${TS}/${URL1}`)).toEqual({ timestamp: TS, original: URL1 });
    expect(parseSnapshotUrl(`https://web.archive.org/web/${TS}id_/http://old.example/a?b=1`)).toEqual({ timestamp: TS, original: 'http://old.example/a?b=1' });
    expect(parseSnapshotUrl(`https://web.archive.org/web/${TS}/http:/old.example/a`)?.original).toBe('http://old.example/a');
    expect(parseSnapshotUrl('https://example.com/')).toBeNull();
    expect(snapshotUrl({ timestamp: TS, original: URL1 })).toBe(SNAPSHOT);
  });

  it('reads the availability API answer', () => {
    expect(parseAvailability(JSON.parse(AVAILABLE), URL1)).toEqual({ timestamp: TS, original: URL1 });
    expect(parseAvailability({ archived_snapshots: {} }, URL1)).toBeNull();
    expect(parseAvailability({ archived_snapshots: { closest: { status: '404', available: true, url: `http://web.archive.org/web/${TS}/${URL1}` } } }, URL1)).toBeNull();
  });

  it('formats the note (and the sanitizer keeps only that class, only on <p>)', () => {
    expect(snapshotDate(TS)).toBe('March 5, 2024');
    const note = archiveNote(TS);
    expect(note).toBe('<p class="rl-note"><em>Loaded from the Internet Archive snapshot of March 5, 2024.</em></p>');
    expect(sanitizeHtml(note)).toBe(note);
    expect(sanitizeHtml('<p class="rl-note x">a</p><div class="rl-note">b</div><p class="lead">c</p>')).toBe('<p>a</p><div>b</div><p>c</p>');
  });

  it('classifies errors and pages', () => {
    expect(isArchiveWorthyError(new FetchError('HTTP 404 fetching x', 404))).toBe(true);
    expect(isArchiveWorthyError(new FetchError('HTTP 503 fetching x', 503))).toBe(true);
    expect(isArchiveWorthyError(new FetchError('Timed out fetching x'))).toBe(true);
    expect(isArchiveWorthyError(new FetchError('Could not fetch x: getaddrinfo ENOTFOUND'))).toBe(true);
    expect(isArchiveWorthyError(new FetchError('Refusing to fetch a private address'))).toBe(false);
    expect(isArchiveWorthyError(new FetchError('Response too large (60 MB)'))).toBe(false);
    expect(isArchiveWorthyError(new Error('boom'))).toBe(false);

    expect(looksPaywalled(PAYWALLED, '')).toBe(true);
    expect(looksPaywalled('<div class="article-body premium-content">x</div>', '')).toBe(true);
    expect(looksPaywalled('<p>short</p>', 'Already a subscriber? Sign in')).toBe(true);
    expect(looksPaywalled(fixture('article.html'), 'A free essay.')).toBe(false);
    expect(looksBlocked('<html><head><title>Just a moment...</title></head><body></body></html>')).toBe(true);
    expect(looksBlocked('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>')).toBe(true);
    expect(looksBlocked(fixture('article.html'))).toBe(false);
  });
});

describe('wayback fallback (mocked network)', () => {
  it('extracts the snapshot when the page is gone, keeping the original URL', async () => {
    const spy = mockFetch([
      [URL1, { status: 404, body: 'gone' }],
      [/^https:\/\/archive\.org\/wayback\/available\?url=/, { body: AVAILABLE, type: 'application/json' }],
      [SNAPSHOT, { body: fixture('article.html') }],
    ]);
    const r = await extractUrl(URL1);
    expect(r.title).toBe('The Quiet Art of Reading Slowly');
    expect(r.canonicalUrl).toBe(URL1);
    expect(r.html.startsWith('<p class="rl-note"><em>Loaded from the Internet Archive snapshot of March 5, 2024.</em></p>')).toBe(true);
    expect(r.text).not.toContain('Internet Archive');
    expect(r.html).toContain('There is a particular pleasure');
    // relative images resolve against the original page, then load from the archive
    expect(r.html).toContain(`src="https://web.archive.org/web/${TS}im_/https://news.example/images/figure-1.jpg"`);
    expect(r.imageUrl).toBe(`https://web.archive.org/web/${TS}im_/https://news.example/images/lead.jpg`);
    expect(r.wordCount).toBeGreaterThan(200);
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toBe(`https://archive.org/wayback/available?url=${encodeURIComponent(URL1)}`);
    expect(urls[2]).toBe(SNAPSHOT);
  });

  it('uses the snapshot for a short paywalled page', async () => {
    mockFetch([
      [URL1, { body: PAYWALLED }],
      [/^https:\/\/archive\.org\/wayback\/available\?url=/, { body: AVAILABLE, type: 'application/json' }],
      [SNAPSHOT, { body: fixture('article.html') }],
    ]);
    const r = await extractUrl(URL1);
    expect(r.html).toContain('class="rl-note"');
    expect(r.wordCount).toBeGreaterThan(200);
  });

  it('keeps the live page when the snapshot is no better, and does not ask for free short pages', async () => {
    const spy = mockFetch([
      [URL1, { body: PAYWALLED }],
      [/^https:\/\/archive\.org\/wayback\/available\?url=/, { body: AVAILABLE, type: 'application/json' }],
      [SNAPSHOT, { body: PAYWALLED }],
      ['https://free.example/short', { body: '<html><head><title>Short note</title></head><body><article><p>Just a short free note about reading.</p></article></body></html>' }],
    ]);
    const r = await extractUrl(URL1);
    expect(r.html).not.toContain('rl-note');
    expect(r.text).toContain('free to read');
    spy.mockClear();
    const s = await extractUrl('https://free.example/short');
    expect(s.title).toBe('Short note');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the redirect form when the availability API is rate limited', async () => {
    const latest = `https://web.archive.org/web/2id_/${URL1}`;
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === URL1) return new Response('down', { status: 503 });
      if (url.startsWith('https://archive.org/wayback/available')) return new Response('Too Many Requests', { status: 429 });
      if (url === latest) {
        // Wayback redirects to the latest capture; the final URL carries its timestamp.
        const res = new Response(fixture('article.html'), { headers: { 'content-type': 'text/html' } });
        Object.defineProperty(res, 'url', { value: `https://web.archive.org/web/20230102030405id_/${URL1}` });
        return res;
      }
      return new Response('not found', { status: 404 });
    });
    const r = await extractUrl(URL1);
    expect(r.title).toBe('The Quiet Art of Reading Slowly');
    expect(r.html).toContain('snapshot of January 2, 2023.');
    expect(calls).toEqual([URL1, `https://archive.org/wayback/available?url=${encodeURIComponent(URL1)}`, latest]);
  });

  it('rethrows the original error when nothing is archived', async () => {
    mockFetch([
      [URL1, { status: 404, body: 'gone' }],
      [/^https:\/\/archive\.org\/wayback\/available\?url=/, { body: '{"archived_snapshots":{}}', type: 'application/json' }],
    ]);
    await expect(extractUrl(URL1)).rejects.toThrow('HTTP 404 fetching news.example');
  });

  it('can be disabled', async () => {
    const spy = mockFetch([[URL1, { status: 404, body: 'gone' }]]);
    const { extractGeneric } = await import('../src/extract/generic');
    await expect(extractGeneric(URL1, { wayback: false })).rejects.toThrow('HTTP 404');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
