import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../src/extract';
import { NotAFeedError, looksLikeFeed, parseFeed } from '../src/feeds/parse';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures/feeds', name), 'utf8');
const BASE = 'https://feeds.example.com/x/feed.xml';

describe('parseFeed: RSS 2.0', () => {
  const feed = parseFeed(fx('rss2.xml'), BASE);

  it('reads channel metadata', () => {
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example & Co Blog');
    expect(feed.siteUrl).toBe('https://blog.example.com/');
    expect(feed.entries).toHaveLength(3);
  });

  it('prefers content:encoded (CDATA) and media:content image', () => {
    const e = feed.entries[0];
    expect(e.guid).toBe('post-7');
    expect(e.link).toBe('https://blog.example.com/posts/cafe?id=7'); // utm_* stripped
    expect(e.title).toBe('Café “quotes” & bold title');
    expect(e.author).toBe('Ada Lovelace');
    expect(e.publishedAt?.toISOString()).toBe('2026-10-06T09:30:00.000Z');
    expect(e.html).toContain('<em>content</em>');
    expect(e.html).not.toContain('teaser');
    expect(e.imageUrl).toBe('https://cdn.example.com/media/cafe.jpg');
    expect(e.contentBase).toBe('https://blog.example.com/posts/cafe?id=7');
  });

  it('decodes escaped HTML descriptions, double-encoded titles, email authors and enclosure images', () => {
    const e = feed.entries[1];
    expect(e.title).toBe('Escaped HTML description & entities');
    expect(e.html).toBe('<p>Hello &amp; welcome &mdash; <strong>friends</strong></p>');
    expect(e.author).toBe('Grace Hopper');
    expect(e.imageUrl).toBe('https://cdn.example.com/media/escaped.png');
  });

  it('uses a permalink guid as link and turns plain text into paragraphs', () => {
    const e = feed.entries[2];
    expect(e.link).toBe('https://blog.example.com/posts/guid-only');
    expect(e.publishedAt).toBeNull();
    expect(e.author).toBeNull();
    expect(e.html).toBe('<p>Plain text body<br>with a newline</p>');
  });

  it('produces sanitizable content with absolute URLs', () => {
    const e = feed.entries[0];
    const clean = sanitizeHtml(e.html, e.contentBase ?? undefined);
    expect(clean).not.toContain('<script');
    expect(clean).toContain('https://blog.example.com/img/hero.png');
    expect(clean).toContain('https://blog.example.com/rel/link');
  });

  it('handles a single item (non-array) with missing fields and a relative link', () => {
    const f = parseFeed(fx('rss-single.xml'), BASE);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ guid: null, link: 'https://single.example.org/only-item', title: '', author: null, publishedAt: null, imageUrl: null });
    expect(f.entries[0].html).toBe('<p>Just one entry, no title or date.</p>');
  });

  it('handles a channel without items and HTML entities in XML', () => {
    const f = parseFeed('<rss version="2.0"><channel><title>Caf&eacute; &rsquo;s</title></channel></rss>', BASE);
    expect(f.title).toBe('Café ’s');
    expect(f.entries).toEqual([]);
  });

  it('tolerates a DOCTYPE, stylesheet processing instruction, BOM and comments', () => {
    const xml = `\uFEFF<?xml version="1.0"?>\n<?xml-stylesheet type="text/xsl" href="/rss.xsl"?>\n<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">
      <!-- generated --><rss version="0.91"><channel><title>Old</title><link>https://old.example.com/</link>
      <item><title>Legacy</title><link>https://old.example.com/1</link><description>Text</description></item></channel></rss>`;
    const f = parseFeed(xml, BASE);
    expect(f.title).toBe('Old');
    expect(f.entries[0]).toMatchObject({ title: 'Legacy', link: 'https://old.example.com/1', html: '<p>Text</p>' });
  });

  it('prefers feedburner:origLink and ignores non-permalink guids as links', () => {
    const xml = `<rss xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0"><channel><title>t</title>
      <item><title>a</title><link>https://feeds.feedburner.com/~r/x/1</link><feedburner:origLink>https://real.example.com/a</feedburner:origLink></item>
      <item><title>b</title><guid isPermaLink="false">https://not-a-link.example.com/b</guid></item></channel></rss>`;
    const f = parseFeed(xml, BASE);
    expect(f.entries[0].link).toBe('https://real.example.com/a');
    expect(f.entries[1].link).toBeNull();
    expect(f.entries[1].guid).toBe('https://not-a-link.example.com/b');
  });
});

describe('parseFeed: RSS 1.0 (RDF)', () => {
  it('reads items that sit next to the channel', () => {
    const f = parseFeed(fx('rdf.xml'), BASE);
    expect(f.format).toBe('rdf');
    expect(f.title).toBe('RDF Site');
    expect(f.siteUrl).toBe('https://rdf.example.net/');
    expect(f.entries.map((e) => e.link)).toEqual(['https://rdf.example.net/a', 'https://rdf.example.net/b']);
    expect(f.entries[0]).toMatchObject({ guid: 'https://rdf.example.net/a', title: 'First RDF item', author: 'Alan Turing' });
    expect(f.entries[0].publishedAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(f.entries[0].html).toBe('<p>Description of the first item.</p>');
    expect(f.entries[1].html).toBe('');
  });
});

describe('parseFeed: Atom 1.0', () => {
  const f = parseFeed(fx('atom.xml'), BASE);

  it('reads feed metadata and resolves xml:base', () => {
    expect(f.format).toBe('atom');
    expect(f.title).toBe('Atom & Eve');
    expect(f.siteUrl).toBe('https://atom.example.com/blog/');
    expect(f.entries).toHaveLength(3);
  });

  it('keeps inline XHTML content and html titles as text', () => {
    const e = f.entries[0];
    expect(e.guid).toBe('tag:atom.example.com,2026:1');
    expect(e.link).toBe('https://atom.example.com/blog/posts/xhtml');
    expect(e.title).toBe('Emphasised title');
    expect(e.author).toBe('Entry Author');
    expect(e.publishedAt?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(e.html).toContain('<p>Inline <strong>XHTML</strong> &amp; more.</p>');
    expect(e.html).not.toContain('xmlns');
    expect(e.imageUrl).toBe('https://atom.example.com/img/x.jpg');
    expect(e.contentBase).toBe('https://atom.example.com/blog/');
    expect(sanitizeHtml(e.html, e.contentBase ?? undefined)).toContain('https://atom.example.com/blog/pics/one.png');
  });

  it('decodes type="html" content once, falls back to updated and the feed author', () => {
    const e = f.entries[1];
    expect(e.html).toBe('<p>Escaped &lt;html&gt; content</p>');
    expect(e.author).toBe('Feed Author');
    expect(e.publishedAt?.toISOString()).toBe('2026-10-06T10:00:00.000Z');
  });

  it('escapes type="text" summaries and picks the alternate link', () => {
    const e = f.entries[2];
    expect(e.link).toBe('https://atom.example.com/blog/posts/text');
    expect(e.html).toBe('<p>Line one &lt;not a tag&gt;</p><p>Line two</p>');
  });

  it('parses YouTube channel feeds (media:group description + thumbnail)', () => {
    const y = parseFeed(fx('youtube.xml'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(y.title).toBe('Veritasium');
    expect(y.siteUrl).toBe('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA');
    const e = y.entries[0];
    expect(e.link).toBe('https://www.youtube.com/watch?v=ONAuUyml0yI');
    expect(e.title).toBe("We're trying something new...");
    expect(e.imageUrl).toBe('https://i4.ytimg.com/vi/ONAuUyml0yI/hqdefault.jpg');
    expect(e.html).toBe('<p>Our mission is to get to the truth.</p><p>Watch more at <a href="https://example.com/more">https://example.com/more</a></p>');
  });

  it('handles prefixed <atom:feed> documents and a single entry', () => {
    const xml = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Prefixed</atom:title>
      <atom:link href="https://p.example.com/"/><atom:entry><atom:id>urn:1</atom:id><atom:title>One</atom:title>
      <atom:link href="/one"/><atom:updated>2026-10-01T00:00:00Z</atom:updated><atom:summary>Hi</atom:summary></atom:entry></atom:feed>`;
    const p = parseFeed(xml, 'https://p.example.com/feed');
    expect(p.title).toBe('Prefixed');
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ guid: 'urn:1', title: 'One', link: 'https://p.example.com/one', html: '<p>Hi</p>' });
  });
});

describe('parseFeed: JSON Feed', () => {
  it('reads items, authors, images and text content', () => {
    const f = parseFeed(fx('feed.json'), 'https://json.example.com/feed.json');
    expect(f.format).toBe('json');
    expect(f.title).toBe('JSON Example');
    expect(f.siteUrl).toBe('https://json.example.com/');
    expect(f.entries[0]).toMatchObject({
      guid: '2',
      link: 'https://json.example.com/2',
      title: 'HTML item',
      author: 'Item Person',
      html: '<p>Hello <b>JSON</b></p>',
      imageUrl: 'https://json.example.com/images/2.png',
    });
    expect(f.entries[1]).toMatchObject({ title: '', author: 'Feed Person', html: '<p>A microblog post without a title.</p><p>Second paragraph.</p>' });
    expect(f.entries[1].publishedAt?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });
});

describe('parseFeed: rejects non-feeds', () => {
  it('throws NotAFeedError for HTML, arbitrary JSON, text and empty input', () => {
    expect(() => parseFeed('<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>', BASE)).toThrow(NotAFeedError);
    expect(() => parseFeed('{"hello": "world"}', BASE)).toThrow(NotAFeedError);
    expect(() => parseFeed('{not json', BASE)).toThrow(NotAFeedError);
    expect(() => parseFeed('just text', BASE)).toThrow(NotAFeedError);
    expect(() => parseFeed('', BASE)).toThrow(NotAFeedError);
    expect(looksLikeFeed(fx('rss2.xml'))).toBe(true);
    expect(looksLikeFeed(fx('page.html'))).toBe(false);
  });
});
