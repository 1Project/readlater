import { XMLValidator } from 'fast-xml-parser';
import { HttpsError } from 'firebase-functions/v2/https';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractEpub } from '../src/extract';
import {
  MAX_EXPORT_ITEMS,
  buildEpub,
  epubDate,
  exportName,
  ownStoragePath,
  parseItemIds,
  sniffImageType,
  stripInvalidXmlChars,
  type BookInput,
  type ChapterInput,
  type ImageFetcher,
} from '../src/exportEpub';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const pngOfSize = (n: number) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - PNG.length))]);

const chapter = (o: Partial<ChapterInput> = {}): ChapterInput => ({
  title: 'First article',
  author: 'Ann Writer',
  siteName: 'Example',
  url: 'https://example.com/a?x=1&y=2',
  html: '<p>Hello <strong>world</strong>.</p><figure><img src="https://img.example.com/a.png" alt="A"><figcaption>Cap</figcaption></figure><p>Line<br>break &amp; more</p>',
  highlights: [{ text: 'Hello world', note: 'A note & more' }],
  ...o,
});

const book = (chapters: ChapterInput[], o: Partial<BookInput> = {}): BookInput => ({
  title: 'My <export>',
  author: 'Readlater',
  language: 'en',
  identifier: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
  modified: new Date('2026-10-09T12:34:56.789Z'),
  chapters,
  ...o,
});

function fetcher(map: Record<string, Buffer | Error>, calls: string[] = []): ImageFetcher {
  return async (url) => {
    calls.push(url);
    const v = map[url];
    if (!v) return null;
    if (v instanceof Error) throw v;
    return { data: v };
  };
}

async function open(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const text = async (p: string) => {
    const f = zip.file(p);
    if (!f) throw new Error(`missing ${p}`);
    return f.async('string');
  };
  return { zip, text };
}

/** Strict XML parse (throws on any well-formedness error). */
function assertWellFormed(xml: string, name: string) {
  const v = XMLValidator.validate(xml);
  if (v !== true) throw new Error(`${name} is not well-formed: ${JSON.stringify(v)}`);
  const dom = new JSDOM(xml, { contentType: 'application/xhtml+xml' });
  dom.window.close();
}

describe('EPUB container structure', () => {
  it('stores mimetype first, uncompressed, without extra fields', async () => {
    const buf = await buildEpub(book([chapter()]), fetcher({}));
    expect(buf.readUInt32LE(0)).toBe(0x04034b50); // local file header
    expect(buf.readUInt16LE(8)).toBe(0); // compression: stored
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    expect(buf.subarray(30, 30 + nameLen).toString('ascii')).toBe('mimetype');
    expect(extraLen).toBe(0);
    expect(buf.subarray(30 + nameLen, 30 + nameLen + 20).toString('ascii')).toBe('application/epub+zip');
  });

  it('has container.xml, OPF, nav, NCX, CSS and one chapter per item, all well-formed', async () => {
    const buf = await buildEpub(book([chapter(), chapter({ title: 'Second & last', html: '<p>Two</p>', highlights: [] })]), fetcher({}));
    const { zip, text } = await open(buf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(
      ['META-INF/container.xml', 'OEBPS/chap-001.xhtml', 'OEBPS/chap-002.xhtml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/style.css', 'OEBPS/toc.ncx', 'mimetype'].sort(),
    );
    for (const n of names.filter((x) => /\.(xml|opf|xhtml|ncx)$/.test(x))) assertWellFormed(await text(n), n);

    expect(await text('META-INF/container.xml')).toContain('full-path="OEBPS/content.opf"');
    const opf = await text('OEBPS/content.opf');
    expect(opf).toContain('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"');
    expect(opf).toContain('<dc:identifier id="bookid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>');
    expect(opf).toContain('<dc:title>My &lt;export&gt;</dc:title>');
    expect(opf).toContain('<dc:language>en</dc:language>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-09T12:34:56Z</meta>');
    expect(opf).toContain('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    expect(opf).toMatch(/<spine toc="ncx">\s*<itemref idref="chap-001"\/>\s*<itemref idref="chap-002"\/>\s*<\/spine>/);

    const nav = await text('OEBPS/nav.xhtml');
    expect(nav).toContain('<nav epub:type="toc" id="toc">');
    expect(nav).toContain('<a href="chap-002.xhtml">Second &amp; last</a>');
    expect(await text('OEBPS/toc.ncx')).toContain('<content src="chap-001.xhtml"/>');
  });

  it('chapters carry title, byline, source link, content and highlights as XHTML', async () => {
    const buf = await buildEpub(book([chapter()]), fetcher({}));
    const { text } = await open(buf);
    const x = await text('OEBPS/chap-001.xhtml');
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"')).toBe(true);
    expect(x).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
    expect(x).toContain('xml:lang="en"');
    expect(x).toContain('<title>First article</title>');
    expect(x).toContain('<section id="chap-001" epub:type="chapter"><h1>First article</h1>');
    expect(x).toContain('<p class="byline">Ann Writer · Example</p>');
    expect(x).toContain('<a href="https://example.com/a?x=1&amp;y=2">https://example.com/a?x=1&amp;y=2</a>');
    expect(x).toContain('<br />');
    expect(x).toContain('break &amp; more');
    expect(x).toContain('<section class="highlights"><h2>Highlights</h2><blockquote><p>Hello world</p></blockquote><p class="note">A note &amp; more</p></section>');
    // The image could not be fetched, so it is dropped (the caption stays).
    expect(x).not.toContain('<img');
    expect(x).toContain('<figcaption>Cap</figcaption>');
  });

  it('cleans content that is not valid XML', async () => {
    const html =
      '<p id="dup">a\u0001b￿</p><p id="dup">c</p><p id="1bad">d</p><a href="#local">local</a><a href="javascript:x">js</a><a href="mailto:a@b.c">mail</a>' +
      '<p style="color:red" data-ok="1">styled</p><math><mi>x</mi></math><p>lone \uD800 surrogate</p>';
    const buf = await buildEpub(book([chapter({ html, highlights: [] })]), fetcher({}));
    const { text } = await open(buf);
    const x = await text('OEBPS/chap-001.xhtml');
    assertWellFormed(x, 'chapter');
    expect(x).toContain('<p id="dup">ab</p><p>c</p><p>d</p>local');
    expect(x).not.toContain('javascript:');
    expect(x).toContain('<a href="mailto:a@b.c">mail</a>');
    expect(x).toContain('<p data-ok="1">styled</p>');
    expect(x).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>');
    expect(await text('OEBPS/content.opf')).toContain('<item id="chap-001" href="chap-001.xhtml" media-type="application/xhtml+xml" properties="mathml"/>');
    expect(stripInvalidXmlChars('a\u0000\u0008\u000B\uD800b😀')).toBe('ab😀');
  });

  it('a chapter without content says so', async () => {
    const buf = await buildEpub(book([chapter({ html: '', highlights: [] })]), fetcher({}));
    const x = await (await open(buf)).text('OEBPS/chap-001.xhtml');
    expect(x).toContain('<p class="empty">This document has no saved text.</p>');
    expect(x).not.toContain('Highlights');
  });
});

describe('EPUB images', () => {
  it('embeds small images once, drops failing, oversized and non-image ones', async () => {
    const calls: string[] = [];
    const html = [
      '<p><img src="https://img.example.com/a.png" alt="A"></p>',
      '<p><img src="https://img.example.com/a.png"></p>', // same URL again
      '<p><img src="https://img.example.com/b.jpg" width="10" height="10"></p>',
      '<p><img src="https://img.example.com/big.png"></p>',
      '<p><img src="https://img.example.com/fail.png"></p>',
      '<p><img src="https://img.example.com/text.png"></p>',
      '<p><img src="data:image/png;base64,AAAA"></p>',
      '<p><img src="https://img.example.com/missing.png" srcset="x 2x"></p>',
    ].join('');
    const buf = await buildEpub(
      book([chapter({ html, highlights: [] }), chapter({ title: 'Two', html: '<img src="https://img.example.com/a.png">', highlights: [] })]),
      fetcher(
        {
          'https://img.example.com/a.png': PNG,
          'https://img.example.com/b.jpg': JPEG_HEAD,
          'https://img.example.com/big.png': pngOfSize(1024 * 1024 + 1),
          'https://img.example.com/fail.png': new Error('boom'),
          'https://img.example.com/text.png': Buffer.from('<html>not an image</html>'),
        },
        calls,
      ),
    );
    expect(calls.filter((c) => c.endsWith('/a.png'))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('data:'))).toBe(false);
    const { zip, text } = await open(buf);
    expect(zip.file('OEBPS/images/img-001.png')).not.toBeNull();
    expect(zip.file('OEBPS/images/img-002.jpg')).not.toBeNull();
    expect(Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir)).toHaveLength(2);
    const x = await text('OEBPS/chap-001.xhtml');
    expect(x.match(/<img /g)).toHaveLength(3);
    expect(x).toContain('<img src="images/img-001.png" alt="A" />');
    expect(x).toContain('<img src="images/img-002.jpg" alt="" />');
    expect(x).not.toContain('srcset');
    expect(x).not.toContain('width=');
    expect(await text('OEBPS/chap-002.xhtml')).toContain('<img src="images/img-001.png" alt="" />');
    const opf = await text('OEBPS/content.opf');
    expect(opf).toContain('<item id="img-001" href="images/img-001.png" media-type="image/png"/>');
    expect(opf).toContain('<item id="img-002" href="images/img-002.jpg" media-type="image/jpeg"/>');
  });

  it('stops embedding at 30 MB in total', async () => {
    const size = 1_048_000;
    const map: Record<string, Buffer> = {};
    const imgs: string[] = [];
    for (let i = 0; i < 32; i++) {
      const url = `https://img.example.com/${i}.png`;
      map[url] = pngOfSize(size);
      imgs.push(`<p><img src="${url}"></p>`);
    }
    const buf = await buildEpub(book([chapter({ html: imgs.join(''), highlights: [] })]), fetcher(map));
    const { zip } = await open(buf);
    const embedded = Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir);
    expect(embedded).toHaveLength(Math.floor((30 * 1024 * 1024) / size));
  });

  it('sniffs image types from bytes', () => {
    expect(sniffImageType(PNG)).toEqual({ mediaType: 'image/png', ext: 'png' });
    expect(sniffImageType(JPEG_HEAD)).toEqual({ mediaType: 'image/jpeg', ext: 'jpg' });
    expect(sniffImageType(Buffer.from('GIF89a......'))).toEqual({ mediaType: 'image/gif', ext: 'gif' });
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ mediaType: 'image/webp', ext: 'webp' });
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('round trip through the EPUB importer', () => {
  it('extractEpub reads the export back: metadata, chapters, text, highlights and images', async () => {
    const chapters = [
      chapter(),
      chapter({ title: 'Second piece', author: null, siteName: null, url: null, html: '<h2>Sub</h2><p>Second body text.</p>', highlights: [] }),
      chapter({ title: 'Third', html: '<blockquote><p>Quoted</p></blockquote><ul><li>One</li></ul>', highlights: [{ text: 'Quoted', note: '' }] }),
    ];
    const buf = await buildEpub(book(chapters, { title: 'Round trip', author: 'Readlater' }), fetcher({ 'https://img.example.com/a.png': PNG }));
    const uploaded: { name: string; type: string; size: number }[] = [];
    const ex = await extractEpub(buf, {
      uploadImage: async (name, data, type) => {
        uploaded.push({ name, type, size: data.byteLength });
        return `https://storage.example.com/${name}`;
      },
    });
    expect(ex.type).toBe('epub');
    expect(ex.title).toBe('Round trip');
    expect(ex.author).toBe('Readlater');
    const sections = ex.html.match(/<section data-chapter="\d+">/g) ?? [];
    expect(sections).toHaveLength(3);
    expect(ex.html).toContain('<h1>First article</h1>');
    expect(ex.html).toContain('<h1>Second piece</h1>');
    expect(ex.html).toContain('<h1>Third</h1>');
    expect(ex.text).toContain('Hello world');
    expect(ex.text).toContain('Second body text.');
    expect(ex.text).toContain('Highlights');
    expect(ex.text).toContain('A note & more');
    expect(ex.html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(uploaded).toEqual([{ name: '001-img-001.png', type: 'image/png', size: PNG.length }]);
    expect(ex.html).toContain('src="https://storage.example.com/001-img-001.png"');
  });
});

describe('export helpers', () => {
  it('parseItemIds validates and dedupes', () => {
    expect(parseItemIds({ itemIds: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
    expect(parseItemIds({ itemIds: Array.from({ length: MAX_EXPORT_ITEMS }, (_, i) => `i${i}`) })).toHaveLength(MAX_EXPORT_ITEMS);
    for (const bad of [null, {}, { itemIds: [] }, { itemIds: 'a' }, { itemIds: ['a/b'] }, { itemIds: [1] }, { itemIds: [''] }, { itemIds: Array.from({ length: 201 }, (_, i) => `i${i}`) }]) {
      expect(() => parseItemIds(bad)).toThrow(HttpsError);
    }
  });

  it('exportName: title for one document, dated name for several', () => {
    expect(exportName([chapter({ title: 'Why: "Gardens" matter?' })])).toEqual({ title: 'Why: "Gardens" matter?', fileName: 'Why_Gardens_matter_.epub' });
    expect(exportName([chapter({ title: 'Война и мир' })]).fileName).toBe('readlater.epub');
    expect(exportName([chapter(), chapter()], new Date('2026-10-09T10:00:00Z'))).toEqual({
      title: 'Readlater — 2 documents (2026-10-09)',
      fileName: 'readlater-2026-10-09.epub',
    });
  });

  it('ownStoragePath only accepts this bucket and this user', () => {
    const url = (bucket: string, path: string) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=t`;
    expect(ownStoragePath(url('b1', 'users/u1/files/i1/img.png'), 'b1', 'u1')).toBe('users/u1/files/i1/img.png');
    expect(ownStoragePath(`http://127.0.0.1:9199/v0/b/b1/o/${encodeURIComponent('users/u1/x.png')}?alt=media`, 'b1', 'u1')).toBe('users/u1/x.png');
    expect(ownStoragePath(url('b2', 'users/u1/files/i1/img.png'), 'b1', 'u1')).toBeNull();
    expect(ownStoragePath(url('b1', 'users/u2/files/i1/img.png'), 'b1', 'u1')).toBeNull();
    expect(ownStoragePath(url('b1', 'users/u1/../u2/x.png'), 'b1', 'u1')).toBeNull();
    expect(ownStoragePath('https://example.com/a.png', 'b1', 'u1')).toBeNull();
    expect(ownStoragePath('not a url', 'b1', 'u1')).toBeNull();
  });

  it('epubDate drops milliseconds', () => {
    expect(epubDate(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });
});
