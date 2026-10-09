import { describe, expect, it } from 'vitest';
import { countWords, htmlToText, makeExcerpt, sanitizeHtml } from '../src/extract';
import { bestFromSrcset, parseSrcset } from '../src/extract/sanitize';
import { cleanDocTitle, stripSiteName, joinAuthors, cleanAuthor } from '../src/extract/meta';
import { toDate } from '../src/extract/html';

describe('sanitizeHtml', () => {
  it('removes scripts, styles, iframes, event handlers and javascript: URLs', () => {
    const out = sanitizeHtml(
      '<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="JaVaScRiPt:alert(1)">bad2</a></p>' +
        '<script>alert(1)</script><style>p{}</style><iframe src="https://e.com"></iframe>' +
        '<img src="x" onerror="alert(1)"><svg><script>1</script></svg><form><input value="x"><p>form text</p></form>',
      'https://example.com/a/',
    );
    expect(out).not.toMatch(/script|style|iframe|onclick|onerror|javascript:|<svg|<input|<form/i);
    expect(out).toContain('<p>Hi bad bad2</p>');
    expect(out).toContain('form text');
    expect(out).toContain('<img src="https://example.com/a/x">');
  });

  it('absolutizes links and images, drops relative URLs without a base and in-page anchors', () => {
    const html = '<p><a href="/b">rel</a> <a href="#fn1">fn</a> <a href="mailto:a@b.c">mail</a> <img src="//cdn.x.com/i.png" alt="i"></p>';
    expect(sanitizeHtml(html, 'https://example.com/a/page')).toBe(
      '<p><a href="https://example.com/b">rel</a> fn <a href="mailto:a@b.c">mail</a> <img src="https://cdn.x.com/i.png" alt="i"></p>',
    );
    expect(sanitizeHtml('<p><a href="/b">rel</a><img src="/i.png">x</p>')).toBe('<p>relx</p>');
  });

  it('keeps the allow-listed structure and data-page/data-chapter only', () => {
    const out = sanitizeHtml(
      '<section data-chapter="2" class="c" id="x" style="color:red"><h2 data-page="3" data-foo="1">T</h2>' +
        '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>' +
        '<details><summary>s</summary>d</details><mark>m</mark><pre><code>c</code></pre></section>',
    );
    expect(out).toBe(
      '<section data-chapter="2"><h2 data-page="3">T</h2><table><thead><tr><th colspan="2">h</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody></table><details><summary>s</summary>d</details><mark>m</mark>' +
        '<pre><code>c</code></pre></section>',
    );
  });

  it('keeps MathML but drops TeX annotations', () => {
    const out = sanitizeHtml('<p>x <math display="inline"><semantics><msup><mi>a</mi><mn>2</mn></msup><annotation encoding="application/x-tex">a^2</annotation></semantics></math></p>');
    expect(out).toContain('<math display="inline"><semantics><msup><mi>a</mi><mn>2</mn></msup></semantics></math>');
    expect(out).not.toContain('a^2');
  });

  it('drops empty paragraphs and tracking pixels, fixes lazy images', () => {
    const out = sanitizeHtml(
      '<p></p><p> &nbsp; </p><div><span></span></div><p>text</p>' +
        '<img src="https://pixel.wp.com/g.gif" alt=""><img src="https://e.com/p.gif" width="1" height="1">' +
        '<img src="data:image/gif;base64,AAA" data-src="/real.jpg" alt="lazy">' +
        '<img data-srcset="/s.jpg 300w, /l.jpg 1200w, /xl.jpg 4000w" alt="set">' +
        '<picture><source srcset="/p1.webp 1x, /p2.webp 2x"><img alt="pic"></picture>' +
        '<img src="/placeholder.gif" alt="ph"><noscript><img src="/ns.jpg" alt="ns"></noscript>',
      'https://e.com/',
    );
    expect(out).toBe(
      '<p>text</p><img src="https://e.com/real.jpg" alt="lazy"><img alt="set" src="https://e.com/l.jpg">' +
        '<img alt="pic" src="https://e.com/p2.webp"><img src="https://e.com/ns.jpg" alt="ns">',
    );
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml('<p> </p>')).toBe('');
  });
});

describe('srcset', () => {
  it('parses candidates including URLs with commas', () => {
    expect(parseSrcset('a.jpg 1x, b.jpg 2x')).toEqual([
      { url: 'a.jpg', w: 0, x: 1 },
      { url: 'b.jpg', w: 0, x: 2 },
    ]);
    expect(parseSrcset('https://x.com/i,w_300.jpg 300w,https://x.com/i,w_900.jpg 900w').map((c) => c.url)).toEqual([
      'https://x.com/i,w_300.jpg',
      'https://x.com/i,w_900.jpg',
    ]);
    expect(bestFromSrcset('s.jpg 300w, m.jpg 900w, l.jpg 2400w')).toBe('m.jpg');
    expect(bestFromSrcset('l.jpg 2400w, xl.jpg 3000w')).toBe('l.jpg');
  });
});

describe('text helpers', () => {
  it('htmlToText separates blocks and decodes entities', () => {
    expect(htmlToText('<h1>Title</h1><p>One &amp; two&nbsp;three &#8212; &#x2019;s</p><ul><li>a</li><li>b</li></ul><script>x</script>')).toBe(
      'Title\n\nOne & two three — ’s\n\na\n\nb',
    );
    expect(htmlToText('<p>a<br>b</p>')).toBe('a\n\nb');
    expect(htmlToText('')).toBe('');
  });

  it('makeExcerpt caps at 400 chars on a word boundary', () => {
    const long = 'word '.repeat(200);
    const ex = makeExcerpt(long);
    expect(ex.length).toBeLessThanOrEqual(400);
    expect(ex.endsWith('word…')).toBe(true);
    expect(makeExcerpt('  short   text ')).toBe('short text');
    expect(makeExcerpt('x'.repeat(1000)).length).toBe(400);
  });

  it('countWords handles punctuation and CJK', () => {
    expect(countWords("It's a well-known fact, isn't it?")).toBe(6);
    expect(countWords('日本語のテキスト and English')).toBe(10);
    expect(countWords('')).toBe(0);
  });

  it('toDate validates and parses common formats', () => {
    expect(toDate('2024/03/05')?.toISOString()).toBe('2024-03-05T00:00:00.000Z');
    expect(toDate('D:20240102030405Z')?.toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(toDate('2014')?.getUTCFullYear()).toBe(2014);
    expect(toDate('not a date')).toBeNull();
    expect(toDate('0001-01-01T00:00:00Z')).toBeNull();
    expect(toDate('1818-01-01')?.getUTCFullYear()).toBe(1818);
    expect(toDate(Date.now() + 30 * 86400_000)).toBeNull();
  });
});

describe('title/author cleanup', () => {
  it('strips site names and separators', () => {
    expect(stripSiteName('Great Post | My Blog', 'My Blog')).toBe('Great Post');
    expect(stripSiteName('My Blog — Great Post', 'My Blog')).toBe('Great Post');
    expect(cleanDocTitle('How to Read a Book Well - Example', null)).toBe('How to Read a Book Well');
    expect(cleanDocTitle('Rust - Wikipedia', null)).toBe('Rust - Wikipedia');
  });

  it('cleans authors', () => {
    expect(cleanAuthor('By Jane Doe')).toBe('Jane Doe');
    expect(cleanAuthor('https://facebook.com/jane')).toBeNull();
    expect(joinAuthors(['A', 'B', 'a', 'C', 'D', 'E'])).toBe('A, B, C et al.');
  });
});
