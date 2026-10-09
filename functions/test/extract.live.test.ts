/**
 * Opt-in live extraction checks against the real internet: `LIVE=1 npx vitest run test/extract.live.test.ts`.
 * Skipped by default so CI stays offline and deterministic.
 */
import { describe, expect, it } from 'vitest';
import { extractUrl } from '../src/extract';

const live = !!process.env.LIVE;

function summary(r: Awaited<ReturnType<typeof extractUrl>>) {
  return {
    type: r.type,
    title: r.title,
    author: r.author,
    siteName: r.siteName,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    imageUrl: r.imageUrl,
    wordCount: r.wordCount,
    htmlBytes: r.html.length,
    excerpt: r.excerpt?.slice(0, 120),
    paper: r.paper ? { ...r.paper, abstract: r.paper.abstract?.slice(0, 60) } : null,
    file: r.file ? { name: r.file.name, contentType: r.file.contentType, size: r.file.buffer.length } : null,
  };
}

const log = (label: string, r: Awaited<ReturnType<typeof extractUrl>>) =>
  process.stderr.write(`\n[live] ${label}: ${JSON.stringify(summary(r), null, 1)}\n`);

describe.skipIf(!live)('live extraction', () => {
  it('extracts a real article', async () => {
    const r = await extractUrl('https://paulgraham.com/greatwork.html');
    log('article', r);
    expect(r.type).toBe('article');
    expect(r.title).toMatch(/Great Work/i);
    expect(r.wordCount).toBeGreaterThan(5000);
    expect(r.html).toContain('<p>');
  }, 60_000);

  it('extracts a real tweet via FxTwitter', async () => {
    const r = await extractUrl('https://x.com/elonmusk/status/1585341984679469056');
    log('tweet', r);
    expect(r.type).toBe('tweet');
    expect(r.title).toMatch(/^@elonmusk: Entering Twitter HQ/);
    expect(r.author).toBe('Elon Musk (@elonmusk)');
    expect(r.html).toContain('watch on X');
  }, 60_000);

  it('extracts an arXiv paper', async () => {
    const r = await extractUrl('https://arxiv.org/abs/2401.12345');
    log('arxiv', r);
    expect(r.type).toBe('paper');
    expect(r.title).toBe('Distributionally Robust Receive Combining');
    expect(r.paper?.arxivId).toBe('2401.12345');
    expect(r.html.startsWith('<section><h2>Abstract</h2>')).toBe(true);
    expect(r.wordCount).toBeGreaterThan(3000);
  }, 120_000);

  it('extracts a DOI', async () => {
    const r = await extractUrl('10.7554/eLife.00013');
    log('doi', r);
    expect(r.type).toBe('paper');
    expect(r.title).toMatch(/sulfonolipid/);
    expect(r.html).toContain('Abstract');
  }, 120_000);

  it('extracts a PDF by URL', async () => {
    const r = await extractUrl('https://bitcoin.org/bitcoin.pdf');
    log('pdf', r);
    expect(r.type).toBe('paper');
    expect(r.title).toMatch(/Bitcoin/);
    expect(r.file?.contentType).toBe('application/pdf');
    expect(r.html).toContain('data-page="1"');
  }, 60_000);

  it('extracts a YouTube video', async () => {
    const r = await extractUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    log('video', r);
    expect(r.type).toBe('video');
    expect(r.title).toMatch(/Never Gonna Give You Up/);
    expect(r.imageUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
  }, 60_000);

  it('falls back to the Internet Archive for a dead page (archive.org may rate-limit this network)', async () => {
    const url = 'https://www.google.com/reader/about/';
    try {
      const r = await extractUrl(url);
      log('wayback (dead page)', r);
      expect(r.html.startsWith('<p class="rl-note"><em>Loaded from the Internet Archive snapshot of ')).toBe(true);
      expect(r.canonicalUrl).toBe(url);
      expect(r.wordCount).toBeGreaterThan(20);
    } catch (e) {
      // No reachable archive: the original error must come through unchanged.
      process.stderr.write(`\n[live] wayback (dead page): ${(e as Error).message}\n`);
      expect((e as Error).message).toBe('HTTP 404 fetching www.google.com');
    }
  }, 120_000);

  it('falls back to the Internet Archive for a blocked/paywalled page', async () => {
    const url = 'https://www.economist.com/finance-and-economics/2024/01/04/the-world-economy-in-2024';
    try {
      const r = await extractUrl(url);
      log('wayback (paywalled)', r);
      expect(r.html).toContain('class="rl-note"');
    } catch (e) {
      process.stderr.write(`\n[live] wayback (paywalled): ${(e as Error).message}\n`);
      expect((e as Error).message).toMatch(/^HTTP 4\d\d fetching www\.economist\.com$/);
    }
  }, 120_000);

  it('adds a YouTube transcript when YouTube allows it', async () => {
    const r = await extractUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    log('youtube transcript', r);
    const hasTranscript = r.html.includes('<h2>Transcript');
    process.stderr.write(`\n[live] youtube transcript: ${hasTranscript ? 'yes' : 'no (blocked / bot check)'}\n`);
    expect(r.type).toBe('video');
    if (hasTranscript) {
      expect(r.html).toMatch(/<p><a href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=\d+s">\d+:\d\d<\/a> /);
      expect(r.text).toMatch(/strangers/i);
    }
  }, 120_000);

  it('extracts an X self-thread', async () => {
    const r = await extractUrl('https://x.com/naval/status/1002103360646823936');
    log('x thread', r);
    expect(r.title).toMatch(/^@naval: How to Get Rich/);
    expect(r.html).toMatch(/Thread · (\d+) posts/);
    expect(Number(/Thread · (\d+) posts/.exec(r.html)![1])).toBeGreaterThan(30);
    expect(r.text).toContain('Seek wealth, not money or status');
  }, 120_000);
});
