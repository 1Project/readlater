import { describe, expect, it } from 'vitest';
import { hasChapters, sanitizeContent } from './sanitize';

describe('sanitizeContent', () => {
  it('removes scripts, styles, handlers and iframes', () => {
    const out = sanitizeContent(
      '<p onclick="x()" style="color:red">Hi<script>alert(1)</script></p><iframe src="https://e.com"></iframe><style>p{}</style>',
    );
    expect(out).toBe('<p>Hi</p>');
  });

  it('forces links to open in a new tab and drops javascript: links', () => {
    const out = sanitizeContent('<a href="https://example.com/x">ok</a> <a href="javascript:alert(1)">bad</a>');
    const div = document.createElement('div');
    div.innerHTML = out;
    const [ok, bad] = [...div.querySelectorAll('a')];
    expect(ok.getAttribute('target')).toBe('_blank');
    expect(ok.getAttribute('rel')).toBe('noopener noreferrer');
    expect(bad.hasAttribute('href')).toBe(false);
    expect(bad.hasAttribute('target')).toBe(false);
  });

  it('makes images lazy and drops unsafe sources', () => {
    const div = document.createElement('div');
    div.innerHTML = sanitizeContent('<img src="https://e.com/a.png" alt="A" width="10"><img src="javascript:1">');
    const imgs = div.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('loading')).toBe('lazy');
    expect(imgs[0].getAttribute('decoding')).toBe('async');
    expect(imgs[0].hasAttribute('width')).toBe(false);
    expect(imgs[0].getAttribute('alt')).toBe('A');
  });

  it('keeps chapter and page markers', () => {
    const out = sanitizeContent('<section data-chapter="1" data-x="y"><h1>One</h1></section><h2 data-page="3">Page 3</h2>');
    expect(out).toContain('data-chapter="1"');
    expect(out).toContain('data-page="3"');
    expect(out).not.toContain('data-x');
    expect(hasChapters(out)).toBe(true);
    expect(hasChapters('<p>x</p>')).toBe(false);
  });

  it('keeps tables, code and marks', () => {
    const html = '<table><tbody><tr><td>1</td></tr></tbody></table><pre><code>x</code></pre><mark>m</mark>';
    expect(sanitizeContent(html)).toBe(html);
  });
});
