import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractEpub, extractPdf, extractUrl } from '../src/extract';
import { itemsToLines, linesToBlocks, pdfLinesToHtml, pickPdfTitle, type PdfLine } from '../src/extract/pdf';
import { parseOpf, resolveZipPath } from '../src/extract/epub';
import { makePdf } from './fixtures/extract/makePdf';
import { mockFetch } from './fixtures/extract/mockFetch';

afterEach(() => vi.restoreAllMocks());

const body = (y: number, text: string, size = 11): { text: string; y: number; size: number } => ({ text, y, size });

describe('PDF', () => {
  it('extracts paragraphs, joins hyphenation, adds page markers and drops page numbers', async () => {
    const pdf = makePdf({
      info: { Title: 'Microsoft Word - draft3.docx', Author: 'Jane Roe', CreationDate: 'D:20230412101500Z' },
      pages: [
        [
          body(740, 'On Reading Machines', 24),
          body(700, 'The first paragraph starts here and it runs across several lines of text'),
          body(686, 'so that the extractor has to merge them into a single para-'),
          body(672, 'graph without leaving a hyphen behind in the middle.'),
          body(640, 'A second paragraph follows after a larger vertical gap between'),
          body(626, 'the lines of the page.'),
          body(60, '1'),
        ],
        [
          body(740, 'Methods', 16),
          body(710, 'Text on the second page continues the story for the reader.'),
          body(60, '2'),
        ],
      ],
    });
    const r = await extractPdf(pdf, { url: 'https://files.example.org/papers/reading.pdf' });
    expect(r.type).toBe('pdf');
    expect(r.title).toBe('On Reading Machines');
    expect(r.author).toBe('Jane Roe');
    expect(r.siteName).toBe('files.example.org');
    expect(r.publishedAt?.toISOString()).toBe('2023-04-12T10:15:00.000Z');
    expect(r.file).toEqual({ buffer: pdf, contentType: 'application/pdf', name: 'reading.pdf' });
    expect(r.html).toBe(
      '<h2 data-page="1">Page 1</h2><h3>On Reading Machines</h3>' +
        '<p>The first paragraph starts here and it runs across several lines of text so that the extractor has to merge them into a single paragraph without leaving a hyphen behind in the middle.</p>' +
        '<p>A second paragraph follows after a larger vertical gap between the lines of the page.</p>' +
        '<h2 data-page="2">Page 2</h2><h3>Methods</h3><p>Text on the second page continues the story for the reader.</p>',
    );
    expect(r.wordCount).toBeGreaterThan(50);
    // The excerpt comes from the paragraphs, without page markers or headings.
    expect(r.excerpt).toMatch(/^The first paragraph starts here/);
  });

  it('detects academic papers', async () => {
    const pdf = makePdf({
      info: { Title: 'Attention Is Mostly What You Need' },
      pages: [
        [
          body(740, 'Attention Is Mostly What You Need', 20),
          body(700, 'Abstract'),
          body(686, 'We study attention and find that it is mostly what you need, see arXiv:2401.12345v2.'),
          body(650, '1 Introduction', 14),
          body(620, 'Transformers are everywhere. DOI 10.1234/abcd.5678 is cited.'),
        ],
        [body(740, 'References', 14), body(710, '[1] Vaswani et al. Attention is all you need. 2017.')],
      ],
    });
    const r = await extractPdf(pdf, { name: 'attention.pdf' });
    expect(r.type).toBe('paper');
    expect(r.title).toBe('Attention Is Mostly What You Need');
    expect(r.paper).toMatchObject({ arxivId: '2401.12345v2', doi: '10.1234/abcd.5678' });
    expect(r.paper?.abstract).toMatch(/^We study attention/);
    expect(r.excerpt).toMatch(/^We study attention/);
    expect(r.file?.name).toBe('attention.pdf');
  });

  it('handles PDFs without text and invalid PDFs', async () => {
    const empty = await extractPdf(makePdf({ pages: [[]] }), { name: 'scan.pdf' });
    expect(empty.html).toBe('');
    expect(empty.title).toBe('scan');
    expect(empty.wordCount).toBe(0);
    await expect(extractPdf(Buffer.from('%PDF-1.4 garbage'), {})).rejects.toThrow(/Could not read this PDF/);
  });

  it('groups positioned items into lines', () => {
    const lines = itemsToLines([
      { str: 'Hello', x: 72, y: 700, width: 30, height: 11, fontSize: 11, hasEOL: false },
      { str: 'world', x: 105, y: 700, width: 30, height: 11, fontSize: 11, hasEOL: false },
      { str: '', x: 72, y: 686, width: 0, height: 0, fontSize: 11, hasEOL: true },
      { str: 'Next', x: 72, y: 686, width: 25, height: 11, fontSize: 11, hasEOL: false },
      { str: 'line', x: 72, y: 600, width: 25, height: 11, fontSize: 11, hasEOL: true },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next', 'line']);
  });

  it('splits bullets and keeps headings short', () => {
    const lines: PdfLine[] = [
      { text: 'Intro text that is long enough to be a typical body line here.', x: 72, y: 700, fontSize: 10 },
      { text: '• first bullet', x: 72, y: 688, fontSize: 10 },
      { text: '• second bullet', x: 72, y: 676, fontSize: 10 },
    ];
    expect(linesToBlocks(lines, 10).map((b) => b.text)).toEqual([
      'Intro text that is long enough to be a typical body line here.',
      '• first bullet',
      '• second bullet',
    ]);
  });

  it('removes running headers repeated on most pages', () => {
    const page = (n: number): PdfLine[] => [
      { text: 'Journal of Examples, Vol. 3', x: 72, y: 760, fontSize: 9 },
      { text: `Content of page ${n} with enough words to be a paragraph.`, x: 72, y: 700, fontSize: 10 },
      { text: `${n}`, x: 300, y: 40, fontSize: 9 },
    ];
    const { html } = pdfLinesToHtml([page(1), page(2), page(3), page(4)]);
    expect(html).not.toContain('Journal of Examples');
    expect(html).toContain('<p>Content of page 4 with enough words to be a paragraph.</p>');
  });

  it('recognises numbered section headings in body font', () => {
    const lines: PdfLine[] = [
      { text: 'Some closing sentence of the previous section that runs long.', x: 72, y: 700, fontSize: 10 },
      { text: '2. Transactions', x: 72, y: 670, fontSize: 10 },
      { text: 'We define an electronic coin as a chain of digital signatures here.', x: 72, y: 640, fontSize: 10 },
      { text: '1. the first step is to collect all of the data you can find.', x: 72, y: 610, fontSize: 10 },
    ];
    expect(linesToBlocks(lines, 10).map((b) => b.kind)).toEqual(['p', 'h', 'p', 'p']);
  });

  it('picks titles sensibly', () => {
    expect(pickPdfTitle('Untitled', [], 'file')).toBe('file');
    expect(pickPdfTitle('  A Real Title ', [], 'file')).toBe('A Real Title');
    expect(
      pickPdfTitle('report.docx', [
        { text: 'Big', x: 0, y: 700, fontSize: 20 },
        { text: 'Title Here', x: 0, y: 680, fontSize: 20 },
        { text: 'body text that is longer than the title', x: 0, y: 600, fontSize: 10 },
        { text: 'and more body text on the next line', x: 0, y: 590, fontSize: 10 },
      ], null),
    ).toBe('Big Title Here');
  });
});

// --- EPUB fixtures built in memory ---

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const xhtml = (title: string, bodyHtml: string) =>
  `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><link rel="stylesheet" href="../css/style.css"/></head><body>${bodyHtml}</body></html>`;

async function buildEpub(opts: { epub3?: boolean; drm?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  if (opts.drm) {
    zip.file(
      'META-INF/encryption.xml',
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></enc:EncryptedData></encryption>',
    );
  }
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${opts.epub3 ? '3.0' : '2.0'}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title id="t">The Test Book</dc:title>
    <dc:creator opf:role="aut">Mary Shelley</dc:creator>
    <dc:creator>Percy Shelley</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Example Press</dc:publisher>
    <dc:date>1818-01-01</dc:date>
    <dc:description>&lt;p&gt;A &lt;b&gt;classic&lt;/b&gt; tale of ambition and creation.&lt;/p&gt;</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.png" media-type="image/png"${opts.epub3 ? ' properties="cover-image"' : ''}/>
    <item id="fig" href="images/fig%201.png" media-type="image/png"/>
    <item id="coverpage" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="blank" href="text/blank.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${opts.epub3 ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
    <item id="css" href="css/style.css" media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="coverpage"/>
    <itemref idref="ch1"/>
    <itemref idref="blank"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
      <navPoint id="n1" playOrder="1"><navLabel><text>Letter I</text></navLabel><content src="text/ch1.xhtml"/>
        <navPoint id="n1a" playOrder="2"><navLabel><text>Sub</text></navLabel><content src="text/ch1.xhtml#s"/></navPoint>
      </navPoint>
    </navMap></ncx>`,
  );
  if (opts.epub3) {
    zip.file(
      'OEBPS/nav.xhtml',
      xhtml('Nav', '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Letter the First</a></li><li><a href="text/ch2.xhtml#start">Chapter 1</a></li></ol></nav>'),
    );
  }
  zip.file('OEBPS/css/style.css', 'body { color: red }');
  zip.file('OEBPS/images/cover.png', PNG);
  zip.file('OEBPS/images/fig 1.png', PNG);
  zip.file(
    'OEBPS/text/cover.xhtml',
    xhtml('Cover', '<div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image xlink:href="../images/cover.png" width="10" height="10"/></svg></div>'),
  );
  zip.file(
    'OEBPS/text/ch1.xhtml',
    xhtml(
      'Letter 1',
      '<h1 class="title">Letter I</h1><p>You will rejoice to hear that no disaster has accompanied the commencement of an enterprise.</p>' +
        '<p>See <a href="ch2.xhtml#start">the next chapter</a> or <a href="https://www.gutenberg.org/">Gutenberg</a>.</p>' +
        '<div/><p><img src="../images/fig%201.png" alt="Figure one"/></p><script>alert(1)</script>',
    ),
  );
  zip.file('OEBPS/text/blank.xhtml', xhtml('Blank', '<p> </p>'));
  zip.file(
    'OEBPS/text/ch2.xhtml',
    xhtml('Ch 2', '<h2 id="start">Chapter 1</h2><p onclick="x()">I am by birth a Genevese.</p><h1>Inner heading</h1><p><img src="../images/fig 1.png" alt="Again"/></p>'),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('EPUB', () => {
  it('extracts chapters, metadata, cover and de-duplicated images (EPUB2 + NCX)', async () => {
    const uploads: string[] = [];
    const uploadImage = vi.fn(async (name: string, data: Uint8Array, type: string) => {
      uploads.push(`${name}|${type}|${data.byteLength}`);
      return `https://storage.example/${name}`;
    });
    const r = await extractEpub(await buildEpub(), { uploadImage });
    expect(r.type).toBe('epub');
    expect(r.title).toBe('The Test Book');
    expect(r.author).toBe('Mary Shelley, Percy Shelley');
    expect(r.siteName).toBe('Example Press');
    expect(r.publishedAt?.getUTCFullYear()).toBe(1818);
    expect(r.excerpt).toBe('A classic tale of ambition and creation.');
    expect(r.imageUrl).toBe('https://storage.example/001-cover.png');
    expect(uploads).toEqual([`001-cover.png|image/png|${PNG.byteLength}`, `002-fig_1.png|image/png|${PNG.byteLength}`]);
    expect(r.html).toBe(
      '<section data-chapter="1"><h1>Letter I</h1>' +
        '<p>You will rejoice to hear that no disaster has accompanied the commencement of an enterprise.</p>' +
        '<p>See the next chapter or <a href="https://www.gutenberg.org/">Gutenberg</a>.</p>' +
        '<p><img src="https://storage.example/002-fig_1.png" alt="Figure one"></p></section>' +
        '<section data-chapter="2"><h1>Chapter 1</h1><p>I am by birth a Genevese.</p><h2>Inner heading</h2>' +
        '<p><img src="https://storage.example/002-fig_1.png" alt="Again"></p></section>',
    );
    expect(r.wordCount).toBeGreaterThan(20);
  });

  it('prefers the EPUB3 nav document for chapter titles', async () => {
    const r = await extractEpub(await buildEpub({ epub3: true }), { uploadImage: async (n) => `https://s.example/${n}` });
    expect(r.html).toContain('<section data-chapter="1"><h1>Letter the First</h1><h2>Letter I</h2>');
    expect(r.html).toContain('<section data-chapter="2"><h1>Chapter 1</h1><p>I am by birth');
  });

  it('drops images when uploads fail and rejects DRM/invalid files', async () => {
    const r = await extractEpub(await buildEpub(), { uploadImage: async () => { throw new Error('quota'); } });
    expect(r.imageUrl).toBeNull();
    expect(r.html).not.toContain('<img');
    await expect(extractEpub(await buildEpub({ drm: true }), { uploadImage: async () => '' })).rejects.toThrow(/DRM/);
    await expect(extractEpub(Buffer.from('not a zip'), { uploadImage: async () => '' })).rejects.toThrow(/valid EPUB/);
  });

  it('is detected when fetched from a URL', async () => {
    const epub = await buildEpub();
    mockFetch([['https://books.example/frankenstein.epub', { body: epub, type: 'application/epub+zip' }]]);
    const r = await extractUrl('https://books.example/frankenstein.epub');
    expect(r.type).toBe('epub');
    expect(r.file?.name).toBe('frankenstein.epub');
    expect(r.file?.contentType).toBe('application/epub+zip');
    expect(r.html).not.toContain('<img');
  });

  it('resolves zip paths and parses OPF', () => {
    expect(resolveZipPath('OEBPS/text/ch1.xhtml', '../images/a%20b.png#x')).toBe('OEBPS/images/a b.png');
    expect(resolveZipPath('content.opf', 'text/ch1.xhtml')).toBe('text/ch1.xhtml');
    const { spine, meta } = parseOpf(
      '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="missing"/></spine></package>',
      'OPS/content.opf',
    );
    expect(meta.title).toBe('T');
    expect(spine.map((s) => s.href)).toEqual(['OPS/a.xhtml']);
  });
});
