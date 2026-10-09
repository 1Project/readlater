import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFromHtml, extractUrl } from '../src/extract';
import { metaRefreshTarget } from '../src/extract/generic';
import { extractMeta } from '../src/extract/meta';
import { parseHtml } from '../src/extract/html';
import { fixture, mockFetch } from './fixtures/extract/mockFetch';
import { makePdf } from './fixtures/extract/makePdf';

afterEach(() => vi.restoreAllMocks());

describe('extractMeta', () => {
  it('reads OpenGraph and JSON-LD', () => {
    const dom = parseHtml(fixture('article.html'), 'https://example.com/essays/reading-slowly?utm_source=x');
    const m = extractMeta(dom.window.document, 'https://example.com/essays/reading-slowly');
    expect(m.title).toBe('The Quiet Art of Reading Slowly');
    expect(m.siteName).toBe('The Example Review');
    expect(m.author).toBe('Ada Lovelace, Charles Babbage');
    expect(m.publishedAt?.toISOString()).toBe('2024-03-05T09:30:00.000Z');
    expect(m.imageUrl).toBe('https://example.com/images/lead.jpg');
    expect(m.canonicalUrl).toBe('https://example.com/essays/reading-slowly');
    expect(m.description).toMatch(/^Why slowing down/);
    expect(m.lang).toBe('en');
  });

  it('falls back to a cleaned <title> and meta author', () => {
    const dom = parseHtml(
      '<html><head><title>Understanding the Event Loop in Depth | Dev Notes</title><meta name="author" content="By Sam Lee"></head><body><h1>A</h1><h1>B</h1></body></html>',
      'https://dev.example/x',
    );
    const m = extractMeta(dom.window.document, 'https://dev.example/x');
    expect(m.title).toBe('Understanding the Event Loop in Depth');
    expect(m.author).toBe('Sam Lee');
  });
});

describe('extractFromHtml', () => {
  const url = 'https://example.com/essays/reading-slowly';

  it('extracts a clean article with metadata', () => {
    const r = extractFromHtml(fixture('article.html'), url);
    expect(r.type).toBe('article');
    expect(r.title).toBe('The Quiet Art of Reading Slowly');
    expect(r.author).toBe('Ada Lovelace, Charles Babbage');
    expect(r.siteName).toBe('The Example Review');
    expect(r.publishedAt?.toISOString()).toBe('2024-03-05T09:30:00.000Z');
    expect(r.imageUrl).toBe('https://example.com/images/lead.jpg');
    expect(r.canonicalUrl).toBe(url);
    expect(r.excerpt).toBe('Why slowing down might be the most radical thing a reader can do.');
    // content
    expect(r.html).toContain('There is a particular pleasure');
    expect(r.html).toContain('<a href="https://example.com/glossary/reader">reader</a>');
    expect(r.html).toContain('src="https://example.com/images/figure-1.jpg"');
    expect(r.html).toContain('src="https://example.com/images/fig2-1200.jpg"');
    expect(r.html).toContain('src="https://example.com/images/noscript-figure.jpg"');
    expect(r.html).toContain('<blockquote>');
    expect(r.html).not.toMatch(/javascript:|onclick|<script|<iframe|pixel\.wp\.com|<p>\s*<\/p>|Home|Related|©/);
    expect(r.html).not.toContain('<h1>'); // duplicate title removed
    expect(r.text).toContain('That sentence is the whole point');
    expect(r.wordCount).toBeGreaterThan(200);
    expect(r.wordCount).toBeLessThan(330);
    expect(r.excerpt!.length).toBeLessThanOrEqual(400);
  });

  it('falls back to the meta description for script-rendered pages', () => {
    const r = extractFromHtml(fixture('thin-page.html'), 'https://app.acme.dev/dashboard');
    expect(r.title).toBe('Dashboard - Acme App');
    expect(r.html).toBe('<p>Acme helps teams ship faster with a shared dashboard for everything.</p>');
    expect(r.siteName).toBe('app.acme.dev');
  });

  it('throws a readable error for empty pages', () => {
    expect(() => extractFromHtml('<html><body><script>1</script></body></html>', 'https://x.dev/')).toThrow(/No readable content/);
  });

  it('marks pages with citation metadata as papers', () => {
    const r = extractFromHtml(fixture('arxiv-abs-old.html'), 'https://arxiv.org/abs/hep-th/9901001');
    expect(r.type).toBe('paper');
    expect(r.title).toBe('String Junctions and Their Duals in Heterotic String Theory');
    expect(r.paper).toMatchObject({ doi: '10.1143/PTP.101.1155', arxivId: 'hep-th/9901001', authors: ['Yosuke Imamura'], year: 1999 });
    expect(r.paper?.pdfUrl).toBe('https://arxiv.org/pdf/hep-th/9901001');
  });

  it('keeps <font>-wrapped footnote markers inside <br>-separated paragraphs', () => {
    const para = (n: number) =>
      `Paragraph ${n} talks about the work you choose and how to find something you have a natural aptitude for and a deep interest in, at some length so it counts as prose.`;
    const html = `<html><head><title>Essay</title></head><body><table><tr><td><font size="2" face="verdana">
      ${para(1)}<br><br>${para(2)}
      <font color="#999999">[<a href="#f1n"><font color="#dddddd">1</font></a>]</font><br><br>${para(3)}<br><br>${para(4)}
      </font></td></tr></table></body></html>`;
    const r = extractFromHtml(html, 'https://essays.example/essay.html');
    expect(r.html).not.toContain('<font');
    expect(r.html).toMatch(/Paragraph 2[^<]*\[(<[^>]+>)*1(<\/[^>]+>)*\]\s*<\/p>/);
  });

  it('detects meta refresh redirects only on empty pages', () => {
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="0; url=/next">', 'https://a.com/x')).toBe('https://a.com/next');
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="30">', 'https://a.com/x')).toBeNull();
    expect(metaRefreshTarget(`<meta http-equiv="refresh" content="0;url=/n"><p>${'long text '.repeat(80)}</p>`, 'https://a.com/x')).toBeNull();
  });
});

describe('extractUrl (generic, mocked network)', () => {
  it('fetches HTML and follows meta refresh', async () => {
    const spy = mockFetch([
      ['https://short.example/abc', { body: '<html><head><meta http-equiv="refresh" content="0;URL=\'https://example.com/essays/reading-slowly\'"></head><body></body></html>' }],
      ['https://example.com/essays/reading-slowly', { body: fixture('article.html') }],
    ]);
    const r = await extractUrl('short.example/abc');
    expect(r.title).toBe('The Quiet Art of Reading Slowly');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('decodes legacy charsets', async () => {
    const html = Buffer.from('<html><head><title>Café crème</title></head><body><article><p>' + 'Le café est très bon. '.repeat(30) + '</p></article></body></html>', 'latin1');
    mockFetch([['https://fr.example/', { body: html, type: 'text/html; charset=iso-8859-1' }]]);
    const r = await extractUrl('https://fr.example/');
    expect(r.title).toBe('Café crème');
    expect(r.text).toContain('très bon');
  });

  it('sniffs PDFs by content and returns the file', async () => {
    const pdf = makePdf({ pages: [[{ text: 'A Small Report', y: 720, size: 22 }, { text: 'Body text of the report goes here.', y: 680 }]] });
    mockFetch([['https://files.example/download?id=7', { body: pdf, type: 'application/octet-stream' }]]);
    const r = await extractUrl('https://files.example/download?id=7');
    expect(r.type).toBe('pdf');
    expect(r.title).toBe('A Small Report');
    expect(r.file?.contentType).toBe('application/pdf');
    expect(r.file?.buffer.equals(pdf)).toBe(true);
    expect(r.html).toContain('<h2 data-page="1">Page 1</h2>');
  });

  it('wraps plain text in <pre>', async () => {
    mockFetch([['https://www.rfc-editor.org/rfc/rfc1149.txt', { body: 'Standard for the transmission of IP datagrams on avian carriers\n\n<b>not html</b>', type: 'text/plain; charset=utf-8' }]]);
    const r = await extractUrl('https://www.rfc-editor.org/rfc/rfc1149.txt');
    expect(r.type).toBe('article');
    expect(r.title).toBe('rfc1149');
    expect(r.html).toBe('<pre>Standard for the transmission of IP datagrams on avian carriers\n\n&lt;b&gt;not html&lt;/b&gt;</pre>');
    expect(r.siteName).toBe('rfc-editor.org');
  });

  it('reports HTTP errors and unsupported types readably', async () => {
    mockFetch([
      ['https://gone.example/', { status: 404, body: 'nope' }],
      ['https://bin.example/file.zip', { body: new Uint8Array([1, 2, 3]), type: 'application/zip' }],
    ]);
    await expect(extractUrl('https://gone.example/')).rejects.toThrow('HTTP 404 fetching gone.example');
    await expect(extractUrl('https://bin.example/file.zip')).rejects.toThrow('Unsupported content type: application/zip');
  });

  it('refuses private addresses and bad input', async () => {
    const spy = mockFetch([]);
    await expect(extractUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private address/);
    await expect(extractUrl('ftp://example.com/x')).rejects.toThrow(/http\(s\)/);
    await expect(extractUrl('   ')).rejects.toThrow(/No URL/);
    expect(spy).not.toHaveBeenCalled();
  });
});
