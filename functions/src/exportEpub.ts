/**
 * Export documents as an EPUB 3 book (docs/SPEC-2.md §6): callable `exportEpub({ itemIds })` → `{ url, name }`.
 *
 * One XHTML chapter per item (title, byline, source link, content, then its highlights as a "Highlights"
 * section), a nav document plus an NCX table of contents for older readers, and images embedded when small
 * (≤ 1 MB each, ≤ 30 MB per book; anything else is dropped). The book is stored at
 * `users/{uid}/exports/{id}.epub` (owner-readable, with a download token); exports older than 7 days are
 * removed on the next export.
 *
 * `buildEpub` is pure apart from the injected image fetcher, so it is unit-tested without Firebase.
 */
import './options';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import JSZip from 'jszip';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Timestamp } from 'firebase-admin/firestore';
import { bucket, db, REGION } from './admin';
import { readContent } from './content';
import { mapLimit } from './extract/html';
import { fetchBuffer } from './http';
import { enforce, HOUR } from './rateLimit';
import { htmlToPlainText } from './searchIndex';
import { orderHighlights, truncateHtml, type ShareHighlight } from './shares';
import { BASE62, escapeHtml, randomString, safeFileName, storageDownloadUrl } from './util';

export const MAX_EXPORT_ITEMS = 200;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGES = 1000;
/** Content HTML per chapter (a whole book saved as one EPUB item can be large). */
const MAX_CHAPTER_HTML_BYTES = 8 * 1024 * 1024;
const EXPORT_TTL_MS = 7 * 24 * HOUR;

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const OPS_NS = 'http://www.idpf.org/2007/ops';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface ChapterInput {
  title: string;
  author: string | null;
  siteName: string | null;
  url: string | null;
  /** Sanitized content HTML (docs/SPEC.md allow-list). */
  html: string;
  highlights: ShareHighlight[];
}

export interface BookInput {
  title: string;
  author: string;
  language: string;
  /** urn:uuid:… */
  identifier: string;
  modified: Date;
  chapters: ChapterInput[];
}

export interface FetchedImage {
  data: Uint8Array;
}

/** Returns the image bytes, or null when it cannot (or should not) be embedded. */
export type ImageFetcher = (url: string) => Promise<FetchedImage | null>;

// ---------------------------------------------------------------------------- helpers

/** Characters that are not allowed anywhere in an XML 1.0 document (control chars, lone surrogates, U+FFFE/F). */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const stripInvalidXmlChars = (s: string): string => s.replace(INVALID_XML_CHARS, '');

const escapeXml = (s: string): string => escapeHtml(stripInvalidXmlChars(s));

/** EPUB core media types we embed, recognised from the bytes (headers and extensions are unreliable). */
export function sniffImageType(data: Uint8Array): { mediaType: string; ext: string } | null {
  const b = data;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return { mediaType: 'image/png', ext: 'png' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mediaType: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP')
    return { mediaType: 'image/webp', ext: 'webp' };
  return null;
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Make parsed content safe to serialise as well-formed, valid-enough XHTML: drop attributes and unwrap
 * elements whose names are not XML names, remove duplicate ids, and unwrap links the book can't follow.
 */
function cleanForXhtml(root: Element, seenIds: Set<string>): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!VALID_NAME.test(el.localName) && el.namespaceURI === XHTML_NS) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      if (!a.namespaceURI && !VALID_NAME.test(a.name)) el.removeAttribute(a.name);
    }
    el.removeAttribute('srcset');
    el.removeAttribute('style');
    const id = el.getAttribute('id');
    if (id !== null) {
      if (!id || seenIds.has(id) || !VALID_NAME.test(id)) el.removeAttribute('id');
      else seenIds.add(id);
    }
    if (el.localName === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) el.replaceWith(...Array.from(el.childNodes));
    }
  }
}

function chapterHeaderHtml(c: ChapterInput): string {
  const byline = [c.author, c.siteName].filter((s): s is string => !!s && !!s.trim()).map(escapeHtml).join(' · ');
  return [
    `<h1>${escapeHtml(c.title)}</h1>`,
    byline ? `<p class="byline">${byline}</p>` : '',
    c.url ? `<p class="source"><a href="${escapeHtml(c.url)}">${escapeHtml(c.url)}</a></p>` : '',
  ].join('');
}

function highlightsHtml(list: ShareHighlight[]): string {
  if (!list.length) return '';
  const items = list
    .map((h) => `<blockquote><p>${escapeHtml(h.text)}</p></blockquote>${h.note.trim() ? `<p class="note">${escapeHtml(h.note.trim())}</p>` : ''}`)
    .join('');
  return `<section class="highlights"><h2>Highlights</h2>${items}</section>`;
}

const STYLE_CSS = `body { margin: 0 4%; line-height: 1.5; }
h1 { font-size: 1.5em; line-height: 1.25; margin: 0 0 0.4em; }
h2 { font-size: 1.2em; } h3 { font-size: 1.1em; }
.byline, .source { margin: 0 0 0.3em; font-size: 0.9em; }
.source a { word-break: break-all; }
.content { margin-top: 1.5em; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; } figcaption { font-size: 0.85em; }
blockquote { margin: 1em 0 1em 1em; padding-left: 0.8em; border-left: 3px solid #000; }
pre { white-space: pre-wrap; font-size: 0.85em; }
table { border-collapse: collapse; } td, th { border: 1px solid #000; padding: 0.2em 0.4em; }
.highlights { margin-top: 2em; border-top: 1px solid #000; padding-top: 0.5em; }
.highlights .note { margin: -0.5em 0 1em 1.8em; font-style: italic; }
.empty { font-style: italic; }
`;

function xhtmlDocument(dom: JSDOM): string {
  const s = new dom.window.XMLSerializer().serializeToString(dom.window.document.documentElement);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n${s}\n`;
}

const pad = (n: number): string => String(n).padStart(3, '0');

/** dcterms:modified wants CCYY-MM-DDThh:mm:ssZ (no milliseconds). */
export const epubDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------- builder

interface ManifestEntry {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

/** Build the EPUB file. Images are fetched through `fetchImage` and dropped when they fail or exceed the limits. */
export async function buildEpub(book: BookInput, fetchImage: ImageFetcher): Promise<Buffer> {
  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed (OCF).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  );

  const manifest: ManifestEntry[] = [
    { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
    { id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' },
    { id: 'css', href: 'style.css', mediaType: 'text/css' },
  ];
  zip.file('OEBPS/style.css', STYLE_CSS);

  // Images shared across chapters, keyed by source URL.
  const images = new Map<string, Promise<string | null>>();
  let imageBytes = 0;
  let imageCount = 0;
  const embed = (src: string): Promise<string | null> => {
    const known = images.get(src);
    if (known) return known;
    const p = (async () => {
      if (imageCount >= MAX_IMAGES || imageBytes >= MAX_TOTAL_IMAGE_BYTES) return null;
      let got: FetchedImage | null = null;
      try {
        got = await fetchImage(src);
      } catch {
        got = null;
      }
      if (!got || !got.data.byteLength || got.data.byteLength > MAX_IMAGE_BYTES) return null;
      const type = sniffImageType(got.data);
      if (!type || imageBytes + got.data.byteLength > MAX_TOTAL_IMAGE_BYTES || imageCount >= MAX_IMAGES) return null;
      imageBytes += got.data.byteLength;
      const n = ++imageCount;
      const href = `images/img-${pad(n)}.${type.ext}`;
      zip.file(`OEBPS/${href}`, got.data);
      manifest.push({ id: `img-${pad(n)}`, href, mediaType: type.mediaType });
      return href;
    })();
    images.set(src, p);
    return p;
  };

  const chapters: { id: string; href: string; title: string }[] = [];
  const vc = new VirtualConsole();
  for (let i = 0; i < book.chapters.length; i++) {
    const c = book.chapters[i];
    const id = `chap-${pad(i + 1)}`;
    const href = `${id}.xhtml`;
    const properties: string[] = [];
    const dom = new JSDOM(
      '<!DOCTYPE html><html><head><meta charset="utf-8"/><title></title><link rel="stylesheet" type="text/css" href="style.css"/></head><body></body></html>',
      { virtualConsole: vc },
    );
    try {
      const doc = dom.window.document;
      const html = doc.documentElement;
      html.setAttribute('lang', book.language);
      html.setAttributeNS(XML_NS, 'xml:lang', book.language);
      html.setAttributeNS(XMLNS_NS, 'xmlns:epub', OPS_NS);
      doc.title = stripInvalidXmlChars(c.title);

      const section = doc.createElement('section');
      section.setAttribute('id', id);
      section.setAttributeNS(OPS_NS, 'epub:type', 'chapter');
      section.innerHTML = stripInvalidXmlChars(chapterHeaderHtml(c));
      const content = doc.createElement('div');
      content.setAttribute('class', 'content');
      const body = c.html.trim() ? truncateHtml(c.html, MAX_CHAPTER_HTML_BYTES).html : '';
      content.innerHTML = body ? stripInvalidXmlChars(body) : '<p class="empty">This document has no saved text.</p>';
      section.appendChild(content);
      const hl = highlightsHtml(c.highlights);
      if (hl) section.insertAdjacentHTML('beforeend', stripInvalidXmlChars(hl));
      doc.body.appendChild(section);

      cleanForXhtml(content, new Set([id]));

      const imgs = Array.from(content.querySelectorAll('img'));
      const hrefs = await mapLimit(imgs, 6, (img) => {
        const src = img.getAttribute('src') ?? '';
        return /^https?:\/\//i.test(src) ? embed(src) : Promise.resolve(null);
      });
      imgs.forEach((img, k) => {
        const local = hrefs[k];
        if (!local) {
          img.remove();
          return;
        }
        img.setAttribute('src', local);
        if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
        for (const a of ['width', 'height', 'loading', 'decoding']) img.removeAttribute(a);
      });

      // OPF item properties for embedded MathML / SVG (EPUB 3 requires them to be declared).
      if (doc.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math').length) properties.push('mathml');
      if (doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'svg').length) properties.push('svg');
      zip.file(`OEBPS/${href}`, xhtmlDocument(dom));
    } finally {
      dom.window.close();
    }
    chapters.push({ id, href, title: c.title });
    manifest.push({ id, href, mediaType: 'application/xhtml+xml', ...(properties.length ? { properties: properties.join(' ') } : {}) });
  }

  zip.file('OEBPS/nav.xhtml', navDocument(book, chapters));
  zip.file('OEBPS/toc.ncx', ncxDocument(book, chapters));
  zip.file('OEBPS/content.opf', opfDocument(book, manifest, chapters));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' });
}

function navDocument(book: BookInput, chapters: { href: string; title: string }[]): string {
  const lang = escapeXml(book.language);
  const items = chapters.map((c) => `      <li><a href="${c.href}">${escapeXml(c.title)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(book.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function ncxDocument(book: BookInput, chapters: { id: string; href: string; title: string }[]): string {
  const points = chapters
    .map(
      (c, i) => `    <navPoint id="np-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${c.href}"/>
    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(book.identifier)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(book.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

function opfDocument(book: BookInput, manifest: ManifestEntry[], chapters: { id: string }[]): string {
  const items = manifest
    .map((m) => `    <item id="${m.id}" href="${m.href}" media-type="${m.mediaType}"${m.properties ? ` properties="${m.properties}"` : ''}/>`)
    .join('\n');
  const spine = chapters.map((c) => `    <itemref idref="${c.id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(book.identifier)}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author)}</dc:creator>
    <dc:language>${escapeXml(book.language)}</dc:language>
    <dc:publisher>Readlater</dc:publisher>
    <dc:date>${epubDate(book.modified)}</dc:date>
    <meta property="dcterms:modified">${epubDate(book.modified)}</meta>
  </metadata>
  <manifest>
${items}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;
}

// ---------------------------------------------------------------------------- Firebase side

export function parseItemIds(data: unknown): string[] {
  const raw = (data as { itemIds?: unknown } | null)?.itemIds;
  if (!Array.isArray(raw) || !raw.length) throw new HttpsError('invalid-argument', 'Choose at least one document');
  const ids = [...new Set(raw)];
  if (ids.length > MAX_EXPORT_ITEMS) throw new HttpsError('invalid-argument', `You can export at most ${MAX_EXPORT_ITEMS} documents at once`);
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > 128 || id.includes('/')) throw new HttpsError('invalid-argument', 'Invalid item id');
  }
  return ids as string[];
}

/** Bucket path of a Storage download URL of this bucket under users/{uid}/, or null for any other URL. */
export function ownStoragePath(url: string, bucketName: string, uid: string): string | null {
  try {
    const u = new URL(url);
    const m = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
    if (!m || decodeURIComponent(m[1]) !== bucketName) return null;
    const path = decodeURIComponent(m[2]);
    return path.startsWith(`users/${uid}/`) && !path.includes('..') ? path : null;
  } catch {
    return null;
  }
}

/** Image fetcher: the user's own Storage objects are read directly, everything else over HTTP (SSRF-guarded). */
export function imageFetcher(uid: string): ImageFetcher {
  const b = bucket();
  return async (url) => {
    const own = ownStoragePath(url, b.name, uid);
    if (own) {
      const file = b.file(own);
      const [meta] = await file.getMetadata();
      if (Number(meta.size ?? 0) > MAX_IMAGE_BYTES) return null;
      const [data] = await file.download();
      return { data };
    }
    const res = await fetchBuffer(url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15_000, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5' });
    return { data: res.body };
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Load the chapters (in the requested order; missing items are skipped). */
async function loadChapters(uid: string, ids: string[]): Promise<ChapterInput[]> {
  const items = db.collection('users').doc(uid).collection('items');
  const snaps = await db.getAll(...ids.map((id) => items.doc(id)));
  const found = snaps.filter((s) => s.exists);
  return mapLimit(found, 8, async (snap) => {
    const html = snap.get('contentChunks') ? await readContent(snap.ref) : '';
    const hs = await db.collection('users').doc(uid).collection('highlights').where('itemId', '==', snap.id).get();
    const list = hs.docs.map((d) => ({
      text: String(d.get('text') ?? ''),
      note: String(d.get('note') ?? ''),
      createdAt: (d.get('createdAt') as Timestamp | undefined)?.toMillis?.() ?? 0,
    }));
    return {
      title: str(snap.get('title')) ?? 'Untitled',
      author: str(snap.get('author')),
      siteName: str(snap.get('siteName')),
      url: str(snap.get('url')),
      html,
      highlights: orderHighlights(list, htmlToPlainText(html), Number.MAX_SAFE_INTEGER),
    };
  });
}

/** File name for the download: the document title for one item, else a dated collection name. */
export function exportName(chapters: ChapterInput[], now = new Date()): { title: string; fileName: string } {
  if (chapters.length === 1) {
    const title = chapters[0].title;
    const base = safeFileName(title.replace(/\s+/g, ' ').trim().slice(0, 80), 'readlater').replace(/_+/g, '_');
    return { title, fileName: `${base}.epub` };
  }
  const day = now.toISOString().slice(0, 10);
  return { title: `Readlater — ${chapters.length} documents (${day})`, fileName: `readlater-${day}.epub` };
}

async function removeOldExports(uid: string): Promise<void> {
  try {
    const [files] = await bucket().getFiles({ prefix: `users/${uid}/exports/` });
    const cutoff = Date.now() - EXPORT_TTL_MS;
    await Promise.all(
      files.filter((f) => Date.parse(String(f.metadata.timeCreated ?? '')) < cutoff).map((f) => f.delete({ ignoreNotFound: true })),
    );
  } catch (e) {
    logger.info('exportEpub: cleanup failed', { error: (e as Error).message });
  }
}

export async function exportEpubForUser(uid: string, ids: string[], fetchImage: ImageFetcher = imageFetcher(uid)): Promise<{ url: string; name: string }> {
  const chapters = await loadChapters(uid, ids);
  if (!chapters.length) throw new HttpsError('not-found', 'None of these documents were found');
  const { title, fileName } = exportName(chapters);
  const authors = [...new Set(chapters.map((c) => c.author).filter((a): a is string => !!a))];
  const buf = await buildEpub(
    {
      title,
      author: chapters.length === 1 && authors.length ? authors[0] : 'Readlater',
      language: 'en',
      identifier: `urn:uuid:${randomUUID()}`,
      modified: new Date(),
      chapters,
    },
    fetchImage,
  );
  await removeOldExports(uid);
  const b = bucket();
  const path = `users/${uid}/exports/${randomString(20, BASE62)}.epub`;
  const token = randomUUID();
  await b.file(path).save(buf, {
    resumable: false,
    contentType: 'application/epub+zip',
    metadata: {
      contentDisposition: `attachment; filename="${fileName}"`,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return { url: storageDownloadUrl(b.name, path, token), name: fileName };
}

export const exportEpub = onCall({ region: REGION, timeoutSeconds: 540, memory: '2GiB' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const ids = parseItemIds(request.data);
  await enforce(`epub:${uid}`, 30, HOUR, 'Too many exports, please try again later');
  return exportEpubForUser(uid, ids);
});
