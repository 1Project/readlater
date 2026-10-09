import { describe, expect, it } from 'vitest';
import {
  MAX_SHARE_HTML_BYTES,
  SHARE_TOKEN_RE,
  generateShareToken,
  orderHighlights,
  shareUrl,
  truncateHtml,
} from '../src/shares';
import { publicUrl } from '../src/integrations';

describe('share tokens', () => {
  it('are 22 base62 characters and unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateShareToken();
      expect(t).toMatch(/^[A-Za-z0-9]{22}$/);
      expect(SHARE_TOKEN_RE.test(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
    expect(SHARE_TOKEN_RE.test('short')).toBe(false);
    expect(SHARE_TOKEN_RE.test('a'.repeat(21) + '-')).toBe(false);
  });

  it('url uses PUBLIC_URL, else the default Hosting domain', () => {
    expect(shareUrl('T0k', 'https://read.example.org')).toBe('https://read.example.org/s/T0k');
    const saved = { PUBLIC_URL: process.env.PUBLIC_URL, GCLOUD_PROJECT: process.env.GCLOUD_PROJECT };
    try {
      process.env.PUBLIC_URL = 'https://read.example.org/';
      expect(shareUrl('abc')).toBe('https://read.example.org/s/abc');
      delete process.env.PUBLIC_URL;
      process.env.GCLOUD_PROJECT = 'my-proj';
      expect(publicUrl()).toBe('https://my-proj.web.app');
      expect(shareUrl('abc')).toBe('https://my-proj.web.app/s/abc');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('truncateHtml', () => {
  it('leaves small HTML untouched', () => {
    expect(truncateHtml('<p>Hi</p>')).toEqual({ html: '<p>Hi</p>', truncated: false });
  });

  it('cuts after a complete block, never inside a tag, within the byte budget', () => {
    const para = (i: number) => `<p class="x">Paragraph ${i} with <a href="https://example.com/${i}">a link</a> and some text.</p>`;
    const html = Array.from({ length: 50 }, (_, i) => para(i)).join('');
    const { html: out, truncated } = truncateHtml(html, 1000);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1000);
    const body = out.replace(/<p><em>This shared copy is shortened\.<\/em><\/p>$/, '');
    expect(body).not.toBe(out);
    expect(body.endsWith('</p>')).toBe(true);
    expect(html.startsWith(body)).toBe(true);
  });

  it('counts multi-byte characters as bytes and never splits them', () => {
    const html = '<p>' + 'ä€😀'.repeat(400) + '</p><p>' + 'ü'.repeat(400) + '</p>';
    const { html: out } = truncateHtml(html, 2000);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2000);
    expect(out).not.toMatch(/�/);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('drops a partial tag when a single tag is longer than what is left', () => {
    const html = '<p>abc</p><img src="https://example.com/' + 'x'.repeat(5000) + '.png"><p>tail</p>';
    const { html: out } = truncateHtml(html, 300);
    expect(out.startsWith('<p>abc</p>')).toBe(true);
    expect(out).not.toContain('<img');
  });

  it('the default budget keeps a share doc under the Firestore limit', () => {
    const big = '<p>' + 'word '.repeat(300_000) + '</p>';
    const { html } = truncateHtml(big);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_SHARE_HTML_BYTES);
    expect(MAX_SHARE_HTML_BYTES).toBeLessThan(1_000_000);
  });
});

describe('orderHighlights', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
  it('orders by position in the text, unknown ones last by creation time', () => {
    const list = [
      { text: 'Eta theta', note: '', createdAt: 1 },
      { text: 'not in the text', note: 'n2', createdAt: 5 },
      { text: 'Alpha beta', note: 'first', createdAt: 9 },
      { text: 'missing too', note: '', createdAt: 2 },
      { text: 'Delta  epsilon', note: '', createdAt: 3 },
    ];
    expect(orderHighlights(list, text)).toEqual([
      { text: 'Alpha beta', note: 'first' },
      { text: 'Delta  epsilon', note: '' },
      { text: 'Eta theta', note: '' },
      { text: 'missing too', note: '' },
      { text: 'not in the text', note: 'n2' },
    ]);
  });

  it('respects the byte budget and skips empty highlights', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ text: 'x'.repeat(100), note: '', createdAt: i }));
    expect(orderHighlights(list, '', 500)).toHaveLength(4);
    expect(orderHighlights([{ text: '', note: 'n', createdAt: 0 }], '')).toEqual([]);
  });
});
