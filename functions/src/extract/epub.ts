/** EPUB extraction: container.xml → OPF → spine; chapters sanitized, images uploaded via `uploadImage`. */
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { posix } from 'node:path';
import { collapseWs, escapeHtml, mapLimit, parseXhtml, titleFromFileName, toDate } from './html';
import { sanitizeHtml } from './sanitize';
import { finalize, htmlToText } from './text';
import type { Extracted, UploadImage } from './types';

const MAX_TOTAL_HTML = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 500;
const MAX_UNCOMPRESSED = 400 * 1024 * 1024;

const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp',
};

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ['item', 'itemref', 'meta', 'creator', 'title', 'navPoint', 'rootfile', 'EncryptedData', 'date', 'language', 'publisher'].includes(name),
});

type Obj = Record<string, unknown>;

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return collapseWs(String(v));
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return textOf((v as Obj)['#text']);
  return '';
}

function arr<T = Obj>(v: unknown): T[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

interface ManifestItem {
  id: string;
  href: string; // resolved zip path
  mediaType: string;
  properties: string;
}

export interface EpubMeta {
  title: string | null;
  creators: string[];
  language: string | null;
  publisher: string | null;
  date: string | null;
  description: string | null;
  coverPath: string | null;
}

/** Resolve an href relative to a file inside the zip (no fragment/query). */
export function resolveZipPath(fromFile: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  if (decoded.startsWith('/')) return posix.normalize(decoded.slice(1));
  return posix.normalize(posix.join(posix.dirname(fromFile), decoded)).replace(/^(\.\/)+/, '');
}

class Zip {
  private lower = new Map<string, string>();
  constructor(public zip: JSZip) {
    for (const name of Object.keys(zip.files)) this.lower.set(name.toLowerCase(), name);
  }
  file(path: string): JSZip.JSZipObject | null {
    return this.zip.file(path) ?? (this.lower.has(path.toLowerCase()) ? this.zip.file(this.lower.get(path.toLowerCase())!) : null);
  }
  async text(path: string): Promise<string | null> {
    const f = this.file(path);
    if (!f) return null;
    const buf = await f.async('uint8array');
    return decodeXml(buf);
  }
}

function decodeXml(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const head = new TextDecoder('latin1').decode(buf.subarray(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(enc && enc !== 'utf-8' ? enc : 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Parse OPF package metadata, manifest and spine. Pure. */
export function parseOpf(opfXml: string, opfPath: string) {
  const doc = xml.parse(opfXml) as Obj;
  const pkg = (doc.package ?? {}) as Obj;
  const md = (pkg.metadata ?? {}) as Obj;
  const manifest = new Map<string, ManifestItem>();
  for (const it of arr<Obj>((pkg.manifest as Obj | undefined)?.item)) {
    const id = String(it['@_id'] ?? '');
    const href = String(it['@_href'] ?? '');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: resolveZipPath(opfPath, href),
      mediaType: String(it['@_media-type'] ?? ''),
      properties: String(it['@_properties'] ?? ''),
    });
  }
  const spineEl = (pkg.spine ?? {}) as Obj;
  const spine = arr<Obj>(spineEl.itemref)
    .map((r) => manifest.get(String(r['@_idref'] ?? '')))
    .filter((x): x is ManifestItem => !!x);
  const tocId = String(spineEl['@_toc'] ?? '');
  const ncx = manifest.get(tocId) ?? [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml') ?? null;
  const nav = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes('nav')) ?? null;

  let coverPath: string | null = null;
  const coverItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes('cover-image'));
  if (coverItem) coverPath = coverItem.href;
  if (!coverPath) {
    const metaCover = arr<Obj>(md.meta).find((m) => String(m['@_name'] ?? '').toLowerCase() === 'cover');
    const ref = metaCover ? String(metaCover['@_content'] ?? '') : '';
    const item = manifest.get(ref) ?? [...manifest.values()].find((m) => m.href.endsWith(ref) && ref);
    if (item && item.mediaType.startsWith('image/')) coverPath = item.href;
  }
  if (!coverPath) {
    const guess = [...manifest.values()].find((m) => m.mediaType.startsWith('image/') && /cover/i.test(m.id + m.href));
    if (guess) coverPath = guess.href;
  }

  const creators = arr(md.creator).map(textOf).filter(Boolean);
  const meta: EpubMeta = {
    title: arr(md.title).map(textOf).find(Boolean) ?? null,
    creators,
    language: arr(md.language).map(textOf).find(Boolean) ?? null,
    publisher: arr(md.publisher).map(textOf).find(Boolean) ?? null,
    date: arr(md.date).map(textOf).find(Boolean) ?? null,
    description: textOf(md.description) || null,
    coverPath,
  };
  return { meta, manifest, spine, ncx, nav };
}

/** NCX navMap → {zip path → title} (first entry per file wins). Pure. */
export function parseNcx(ncxXml: string, ncxPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const doc = xml.parse(ncxXml) as Obj;
  const walk = (points: unknown) => {
    for (const p of arr<Obj>(points)) {
      const label = textOf(((p.navLabel ?? {}) as Obj).text);
      const src = String(((p.content ?? {}) as Obj)['@_src'] ?? '');
      if (src && label) {
        const path = resolveZipPath(ncxPath, src);
        if (!out.has(path)) out.set(path, label);
      }
      walk(p.navPoint);
    }
  };
  walk(((doc.ncx ?? {}) as Obj).navMap && (((doc.ncx as Obj).navMap as Obj).navPoint));
  return out;
}

/** EPUB3 nav document → {zip path → title}. */
export function parseNavDoc(navXhtml: string, navPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const dom = parseXhtml(navXhtml);
  try {
    const doc = dom.window.document;
    const navs = Array.from(doc.querySelectorAll('nav'));
    const toc = navs.find((n) => (n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '').includes('toc')) ?? navs[0];
    if (!toc) return out;
    for (const a of Array.from(toc.querySelectorAll('a[href]'))) {
      const label = collapseWs(a.textContent);
      const path = resolveZipPath(navPath, a.getAttribute('href') ?? '');
      if (label && !out.has(path)) out.set(path, label);
    }
  } finally {
    dom.window.close();
  }
  return out;
}

function safeName(path: string, n: number): string {
  const base = posix.basename(path).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'image';
  return `${String(n).padStart(3, '0')}-${base}`;
}

function normTitle(s: string): string {
  return collapseWs(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function renameElement(el: Element, tag: string): void {
  const doc = el.ownerDocument;
  const repl = doc.createElementNS(el.namespaceURI ?? 'http://www.w3.org/1999/xhtml', tag);
  while (el.firstChild) repl.appendChild(el.firstChild);
  el.replaceWith(repl);
}

/** Extract an EPUB buffer into chapter sections; images go through `opts.uploadImage`. */
export async function extractEpub(buf: Buffer, opts: { uploadImage: UploadImage; name?: string }): Promise<Extracted> {
  let jszip: JSZip;
  try {
    jszip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error("This file isn't a valid EPUB (could not open the archive)");
  }
  const zip = new Zip(jszip);

  // Zip-bomb guard (uncompressed sizes from the central directory).
  let total = 0;
  for (const f of Object.values(jszip.files)) {
    total += ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  }
  if (total > MAX_UNCOMPRESSED) throw new Error('This EPUB is too large to import');

  // DRM check: encrypted resources other than obfuscated fonts.
  const enc = await zip.text('META-INF/encryption.xml');
  if (enc) {
    const encDoc = xml.parse(enc) as Obj;
    const data = arr<Obj>((encDoc.encryption as Obj | undefined)?.EncryptedData);
    const drm = data.some((d) => !FONT_OBFUSCATION.has(String(((d.EncryptionMethod ?? {}) as Obj)['@_Algorithm'] ?? '')));
    if (drm) throw new Error('This EPUB is DRM-protected and cannot be imported');
  }
  if (zip.file('META-INF/rights.xml')) throw new Error('This EPUB is DRM-protected and cannot be imported');

  let opfPath: string | null = null;
  const container = await zip.text('META-INF/container.xml');
  if (container) {
    const c = xml.parse(container) as Obj;
    const rootfiles = arr<Obj>(((c.container as Obj | undefined)?.rootfiles as Obj | undefined)?.rootfile);
    const rf = rootfiles.find((r) => String(r['@_media-type'] ?? '').includes('oebps-package')) ?? rootfiles[0];
    if (rf?.['@_full-path']) opfPath = String(rf['@_full-path']);
  }
  if (!opfPath || !zip.file(opfPath)) opfPath = Object.keys(jszip.files).find((n) => n.toLowerCase().endsWith('.opf')) ?? null;
  if (!opfPath) throw new Error("This file isn't a valid EPUB (no package document)");
  const opfXml = await zip.text(opfPath);
  if (!opfXml) throw new Error("This file isn't a valid EPUB (no package document)");

  const { meta, manifest, spine, ncx, nav } = parseOpf(opfXml, opfPath);
  if (!spine.length) throw new Error('This EPUB has no readable chapters');

  const tocTitles = new Map<string, string>();
  if (nav) {
    const navXml = await zip.text(nav.href);
    if (navXml) for (const [k, v] of parseNavDoc(navXml, nav.href)) tocTitles.set(k, v);
  }
  if (ncx) {
    const ncxXml = await zip.text(ncx.href);
    if (ncxXml) for (const [k, v] of parseNcx(ncxXml, ncx.href)) if (!tocTitles.has(k)) tocTitles.set(k, v);
  }

  // Image upload with de-duplication by zip path.
  const uploaded = new Map<string, Promise<string | null>>();
  let imageCount = 0;
  const uploadPath = (path: string): Promise<string | null> => {
    const existing = uploaded.get(path);
    if (existing) return existing;
    const p = (async () => {
      const f = zip.file(path);
      if (!f || imageCount >= MAX_IMAGES) return null;
      imageCount++;
      const data = await f.async('uint8array');
      if (data.byteLength > MAX_IMAGE_BYTES) return null;
      const ext = posix.extname(path).slice(1).toLowerCase();
      const item = [...manifest.values()].find((m) => m.href === path);
      const type = item?.mediaType?.startsWith('image/') ? item.mediaType : IMAGE_TYPES[ext] ?? 'application/octet-stream';
      if (!type.startsWith('image/')) return null;
      try {
        const url = await opts.uploadImage(safeName(path, imageCount), data, type);
        return url || null;
      } catch {
        return null;
      }
    })();
    uploaded.set(path, p);
    return p;
  };

  const coverUrl = meta.coverPath ? await uploadPath(meta.coverPath) : null;

  const sections: string[] = [];
  let size = 0;
  let chapterNo = 0;
  for (const item of spine) {
    if (size > MAX_TOTAL_HTML) break;
    if (!/x?html|xml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    const src = await zip.text(item.href);
    if (!src) continue;
    const dom = parseXhtml(src);
    try {
      const doc = dom.window.document;
      const body = doc.body ?? doc.querySelector('body');
      if (!body) continue;
      body.querySelectorAll('script, style, link, meta, iframe, object, embed, form').forEach((el) => el.remove());

      // SVG-wrapped images (common for covers) → plain <img>.
      for (const svg of Array.from(body.querySelectorAll('svg'))) {
        const image = svg.querySelector('image');
        const href = image?.getAttribute('xlink:href') ?? image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? image?.getAttribute('href');
        if (href) {
          const img = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
          img.setAttribute('src', href);
          img.setAttribute('alt', '');
          svg.replaceWith(img);
        } else svg.remove();
      }

      const imgs = Array.from(body.querySelectorAll('img'));
      const paths = imgs.map((img) => {
        const s = img.getAttribute('src') ?? '';
        return /^[a-z]+:/i.test(s) ? null : resolveZipPath(item.href, s);
      });
      const onlyCover = imgs.length > 0 && paths.every((p) => p && p === meta.coverPath);
      const urls = await mapLimit(paths, 4, (p) => (p ? uploadPath(p) : Promise.resolve(null)));
      imgs.forEach((img, i) => {
        if (urls[i]) img.setAttribute('src', urls[i]!);
        else img.remove();
      });

      // Internal links can't be followed inside the reader: unwrap them.
      for (const a of Array.from(body.querySelectorAll('a'))) {
        const href = a.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:)/i.test(href)) a.replaceWith(...Array.from(a.childNodes));
      }

      const text = collapseWs(body.textContent);
      if (!text && (!body.querySelector('img') || onlyCover)) continue;

      // Chapter title: TOC entry, else first heading, else "Chapter N".
      const headings = Array.from(body.querySelectorAll('h1, h2, h3'));
      let title = tocTitles.get(item.href) ?? null;
      const firstHeading = headings[0] ?? null;
      if (!title && firstHeading && collapseWs(firstHeading.textContent)) title = collapseWs(firstHeading.textContent);
      if (firstHeading && title && normTitle(firstHeading.textContent ?? '') === normTitle(title)) firstHeading.remove();
      for (const h1 of Array.from(body.querySelectorAll('h1'))) renameElement(h1, 'h2');
      chapterNo++;
      if (!title) title = `Chapter ${chapterNo}`;

      const clean = sanitizeHtml(body.innerHTML);
      if (!clean && !text) {
        chapterNo--;
        continue;
      }
      const section = `<section data-chapter="${chapterNo}"><h1>${escapeHtml(title)}</h1>${clean}</section>`;
      size += section.length;
      sections.push(section);
    } finally {
      dom.window.close();
    }
  }

  if (!sections.length) throw new Error('This EPUB has no readable text');
  const html = sections.join('');
  const text = htmlToText(html);
  return finalize({
    type: 'epub',
    html,
    text,
    title: meta.title ?? titleFromFileName(opts.name) ?? 'Untitled book',
    author: meta.creators.length ? meta.creators.slice(0, 4).join(', ') : null,
    siteName: meta.publisher,
    description: meta.description ? htmlToText(meta.description) : null,
    imageUrl: coverUrl,
    publishedAt: toDate(meta.date),
  });
}
