/** Small generated documents for the upload tests: a two-page PDF (hand-written) and a two-chapter EPUB (jszip). */
import JSZip from 'jszip';

export const PDF_TITLE = 'Readlater Sample Report';
/** Words that appear only in the PDF body (used by the search test). */
export const PDF_BODY_WORD = 'zebrafish';
export const EPUB_TITLE = 'The Lighthouse Keeper';
export const EPUB_CHAPTERS = ['The Storm', 'Morning Light'];

function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * A valid two-page PDF 1.4 with Helvetica text, an /Info title and a correct xref table. Kept as plain
 * ASCII so the byte offsets equal string offsets.
 */
export function makePdf(): Buffer {
  const pages = [
    [PDF_TITLE, 'This report checks that uploaded PDF files are processed end to end.', `The ${PDF_BODY_WORD} study measured how fast fins regrow.`],
    ['Second page', 'Results were consistent across all tanks.', 'The original page view renders this text with pdf.js.'],
  ];
  const objects: string[] = [];
  // 1: catalog, 2: pages, 3: font, then per page: page object + content stream; last: info.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((lines, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const ops = lines
      .map((line, j) => (j === 0 ? `/F1 20 Tf 72 720 Td ${pdfString(line)} Tj` : `/F1 12 Tf 0 ${j === 1 ? -36 : -18} Td ${pdfString(line)} Tj`))
      .join('\n');
    const stream = `BT\n${ops}\nET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const infoId = objects.length;
  objects[infoId] = `<< /Title ${pdfString(PDF_TITLE)} /Producer (Readlater e2e) >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function chapterXhtml(title: string, paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>
<h1>${title}</h1>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
</body>
</html>`;
}

/** A minimal EPUB 3 (with an EPUB 2 NCX for older readers): two chapters, nav document, metadata. */
export async function makeEpub(): Promise<Buffer> {
  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5f0c2a4e-8d2b-4c55-9a51-readlater-e2e</dc:identifier>
    <dc:title>${EPUB_TITLE}</dc:title>
    <dc:creator>Ada Example</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><ol>
  <li><a href="chapter1.xhtml">${EPUB_CHAPTERS[0]}</a></li>
  <li><a href="chapter2.xhtml">${EPUB_CHAPTERS[1]}</a></li>
</ol></nav>
</body>
</html>`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:5f0c2a4e-8d2b-4c55-9a51-readlater-e2e"/></head>
  <docTitle><text>${EPUB_TITLE}</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>${EPUB_CHAPTERS[0]}</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>${EPUB_CHAPTERS[1]}</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`,
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    chapterXhtml(EPUB_CHAPTERS[0], [
      'The wind rose at dusk and the keeper climbed the stairs to light the lamp.',
      'Waves broke over the rocks all night, and the beam swept the dark water.',
    ]),
  );
  zip.file(
    'OEBPS/chapter2.xhtml',
    chapterXhtml(EPUB_CHAPTERS[1], [
      'By morning the sea was calm and silver under a pale sky.',
      'The keeper wrote the night in the log book and went to sleep.',
    ]),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}
