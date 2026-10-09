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
});
