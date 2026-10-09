import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractHtml } from '../src/extract';
import { isViewerShell } from '../src/extract/index';
import { fixture, mockFetch } from './fixtures/extract/mockFetch';
import { makePdf } from './fixtures/extract/makePdf';

afterEach(() => vi.restoreAllMocks());

/** What the extension sends for a members-only article: the full rendered text plus paywall leftovers. */
const CAPTURED_PAYWALLED = fixture('article.html').replace(
  '<script type="application/ld+json">',
  '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><script type="application/ld+json">',
);

describe('extractHtml (browser capture)', () => {
  it('runs the generic pipeline on the captured HTML without any network access', async () => {
    const spy = mockFetch([]);
    const r = await extractHtml(CAPTURED_PAYWALLED, 'https://example.com/essays/reading-slowly');
    expect(r.type).toBe('article');
    expect(r.title).toBe('The Quiet Art of Reading Slowly');
    expect(r.author).toBe('Ada Lovelace, Charles Babbage');
    expect(r.html).toContain('There is a particular pleasure');
    expect(r.html).toContain('src="https://example.com/images/fig2-1200.jpg"'); // lazy image fixed
    expect(r.html).not.toContain('rl-note'); // never an archive note for a capture
    expect(r.wordCount).toBeGreaterThan(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('strips a spoofed note class from captured pages', async () => {
    mockFetch([]);
    const html = fixture('article.html').replace('<p>There is a particular pleasure', '<p class="rl-note">There is a particular pleasure');
    const r = await extractHtml(html, 'https://example.com/essays/reading-slowly');
    expect(r.html).not.toContain('rl-note');
  });

  it('prefers the tweet extractor for X (the captured app shell is useless), with the capture as fallback', async () => {
    const spy = mockFetch([['https://api.fxtwitter.com/status/1585341984679469056', { body: fixture('fxtwitter-video.json'), type: 'application/json' }]]);
    const shell = '<html><head><title>X</title></head><body><div id="react-root"></div></body></html>';
    const r = await extractHtml(shell, 'https://x.com/elonmusk/status/1585341984679469056');
    expect(r.type).toBe('tweet');
    expect(r.title).toBe('@elonmusk: Entering Twitter HQ – let that sink in!');
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain('https://api.fxtwitter.com/status/1585341984679469056');

    vi.restoreAllMocks();
    mockFetch([]);
    const rendered =
      '<html><head><title>Elon Musk on X: "Entering Twitter HQ" / X</title><meta property="og:description" content="Entering Twitter HQ – let that sink in!"></head>' +
      '<body><main><article><div><span>Entering Twitter HQ – let that sink in!</span></div></article></main></body></html>';
    const fb = await extractHtml(rendered, 'https://x.com/elonmusk/status/1585341984679469056');
    expect(fb.text).toContain('Entering Twitter HQ');
    await expect(extractHtml(shell.replace('<title>X</title>', ''), 'https://x.com/elonmusk/status/1')).rejects.toThrow(/Could not load this post|not found/);
  });

  it('prefers the arXiv path, falling back to the captured abstract page', async () => {
    mockFetch([
      [/^https:\/\/export\.arxiv\.org\/api\/query\?id_list=2401\.12345&/, { body: fixture('arxiv-atom.xml'), type: 'application/atom+xml' }],
      ['https://arxiv.org/html/2401.12345', { body: fixture('arxiv-latexml.html') }],
    ]);
    const r = await extractHtml('<html><body><h1>abs page</h1></body></html>', 'https://arxiv.org/abs/2401.12345');
    expect(r.type).toBe('paper');
    expect(r.title).toBe('Distributionally Robust Receive Combining');
    expect(r.html.startsWith('<section><h2>Abstract</h2>')).toBe(true);

    vi.restoreAllMocks();
    mockFetch([]);
    const fb = await extractHtml(fixture('arxiv-abs-old.html'), 'https://arxiv.org/abs/hep-th/9901001');
    expect(fb.title).toBe('String Junctions and Their Duals in Heterotic String Theory');
  });

  it('fetches the file for PDF viewer shells and the page for empty captures', async () => {
    const pdf = makePdf({ pages: [[{ text: 'A Small Report', y: 720, size: 22 }, { text: 'Body text of the report goes here.', y: 680 }]] });
    const chromeViewer =
      '<html><head></head><body style="height: 100%; width: 100%; overflow: hidden; margin:0px; background-color: rgb(82, 86, 89);">' +
      '<embed name="X" style="position:absolute; left: 0; top: 0;" width="100%" height="100%" src="about:blank" type="application/pdf" internalid="X"></body></html>';
    expect(isViewerShell(chromeViewer, 'https://files.example/view?id=7')).toBe(true);
    expect(isViewerShell('<p>x</p>', 'https://files.example/report.PDF')).toBe(true);
    expect(isViewerShell(fixture('article.html'), 'https://example.com/a')).toBe(false);

    mockFetch([
      ['https://files.example/view?id=7', { body: pdf, type: 'application/pdf' }],
      ['https://spa.example/post/1', { body: fixture('article.html') }],
    ]);
    const r = await extractHtml(chromeViewer, 'https://files.example/view?id=7');
    expect(r.type).toBe('pdf');
    expect(r.file?.contentType).toBe('application/pdf');

    const empty = '<html><head></head><body><div id="app"></div></body></html>';
    const s = await extractHtml(empty, 'https://spa.example/post/1');
    expect(s.title).toBe('The Quiet Art of Reading Slowly');
  });

  it('reports the capture error when the fallback fetch fails too, and rejects oversized pages', async () => {
    mockFetch([]);
    await expect(extractHtml('<html><body></body></html>', 'https://spa.example/nothing')).rejects.toThrow(/No readable content/);
    await expect(extractHtml('x'.repeat(10 * 1024 * 1024 + 1), 'https://example.com/')).rejects.toThrow(/too large/);
    await expect(extractHtml('<p>x</p>', 'notaurl with spaces')).rejects.toThrow(/valid URL/);
  });
});
