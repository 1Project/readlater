/** PDF text extraction with unpdf: positioned text items → lines → paragraphs, with page markers. */
import { escapeHtml, collapseWs, fileNameFromUrl, titleFromFileName, toDate } from './html';
import { finalize } from './text';
import type { Extracted, PaperMeta } from './types';

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL: boolean;
}

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

const MAX_HTML_CHARS = 25 * 1024 * 1024;

/** Group positioned text items of one page into lines. */
export function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let cur: (PdfLine & { endX: number; sizes: number[] }) | null = null;
  const flush = () => {
    if (cur) {
      const text = collapseWs(cur.text);
      if (text) {
        const sizes = cur.sizes.sort((a, b) => a - b);
        lines.push({ text, x: cur.x, y: cur.y, fontSize: sizes[Math.floor(sizes.length / 2)] });
      }
    }
    cur = null;
  };
  for (const it of items) {
    const size = Math.abs(it.fontSize || it.height || 10);
    if (!it.str) {
      if (it.hasEOL) flush();
      continue;
    }
    if (cur && Math.abs(it.y - cur.y) > Math.max(2, 0.45 * size)) flush();
    if (!cur) {
      cur = { text: it.str, x: it.x, y: it.y, fontSize: size, endX: it.x + it.width, sizes: [] };
    } else {
      const gap = it.x - cur.endX;
      const needsSpace = gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? ' ' : '') + it.str;
      cur.endX = it.x + it.width;
    }
    if (it.str.trim()) for (let i = 0; i < Math.min(it.str.length, 50); i++) cur.sizes.push(size);
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

const PAGE_NUM = /^(page\s+)?[-–—]?\s*\d{1,4}\s*[-–—]?(\s*(\/|of)\s*\d{1,4})?$|^[ivxlcdm]{1,6}$/i;
/** Standalone section headings in body font: "2. Transactions", "3.1 Setup", "IV. RESULTS", "References". */
const SECTION_HEADING =
  /^((\d{1,2}(\.\d{1,2})*\.?|[IVX]{1,5}\.)\s+\p{Lu}[^.!?:;,]*|(abstract|introduction|references|bibliography|acknowledge?ments?|conclusions?|appendix( [A-Z])?|ABSTRACT|INTRODUCTION|REFERENCES|BIBLIOGRAPHY|ACKNOWLEDGE?MENTS?|CONCLUSIONS?)|(Abstract|Introduction|References|Bibliography|Acknowledge?ments?|Conclusions?|Appendix( [A-Z])?))$/u;
const BULLET = /^([•◦▪▫‣⁃●○■□–—-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function joinLines(a: string, b: string): string {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  if (/[­]$/.test(a)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

interface Block {
  kind: 'p' | 'h';
  text: string;
}

/** Plain text of the paragraphs (all blocks when there are none), for the excerpt. */
export function pdfExcerptText(blocks: Block[][]): string {
  const all = blocks.flat();
  const paras = all.filter((b) => b.kind === 'p');
  return (paras.length ? paras : all).map((b) => b.text).join(' ');
}

/** Remove running headers/footers and page numbers (first/last two lines of pages). */
function stripRunningLines(pages: PdfLine[][]): PdfLine[][] {
  const key = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edge = new Set(edgeLines(lines).map((l) => key(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const repeated = (k: string) => pages.length >= 4 && (counts.get(k) ?? 0) >= Math.max(3, pages.length * 0.5);
  return pages.map((lines) => {
    const edges = new Set(edgeLines(lines));
    return lines.filter((l) => {
      if (!edges.has(l)) return true;
      if (PAGE_NUM.test(l.text)) return false;
      return !repeated(key(l.text));
    });
  });
}

/** First/last line of a page (two of each on longer pages): where running headers and page numbers live. */
function edgeLines(lines: PdfLine[]): PdfLine[] {
  if (lines.length <= 2) return lines;
  const n = lines.length >= 8 ? 2 : 1;
  return [...lines.slice(0, n), ...lines.slice(-n)];
}

/** Body font size: the most common size weighted by characters. */
function bodyFontSize(pages: PdfLine[][]): number {
  const w = new Map<number, number>();
  for (const lines of pages) for (const l of lines) {
    const k = Math.round(l.fontSize * 2) / 2;
    w.set(k, (w.get(k) ?? 0) + l.text.length);
  }
  let best = 0;
  let bestW = -1;
  for (const [k, v] of w) if (v > bestW) [best, bestW] = [k, v];
  return best || 10;
}

/** Turn lines of one page into paragraphs and headings. */
export function linesToBlocks(lines: PdfLine[], bodySize: number): Block[] {
  const blocks: Block[] = [];
  if (!lines.length) return blocks;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0 && g < lines[i].fontSize * 3) gaps.push(g);
  }
  const typicalGap = median(gaps) || bodySize * 1.2;
  const maxLen = Math.max(...lines.map((l) => l.text.length));
  const isHeadingSize = (s: number) => s >= bodySize * 1.18;

  let cur: { kind: 'p' | 'h'; text: string; size: number; lines: number } | null = null;
  let prev: PdfLine | null = null;
  const push = () => {
    if (cur && cur.text.trim()) {
      const numberedHeading =
        cur.kind === 'p' && cur.lines === 1 && cur.text.length <= 80 && cur.text.split(/\s+/).length <= 8 && SECTION_HEADING.test(cur.text);
      blocks.push({ kind: (cur.kind === 'h' && cur.text.length <= 200) || numberedHeading ? 'h' : 'p', text: cur.text });
    }
    cur = null;
  };
  for (const l of lines) {
    const kind: 'p' | 'h' = isHeadingSize(l.fontSize) && l.text.length < 160 ? 'h' : 'p';
    let brk = !cur || !prev;
    if (cur && prev) {
      const gap = prev.y - l.y;
      if (gap < -typicalGap * 0.5 || gap > typicalGap * 1.45 + 0.5) brk = true; // big gap or column jump
      else if (Math.abs(l.fontSize - prev.fontSize) > Math.max(0.6, bodySize * 0.08)) brk = true;
      else if (kind !== cur.kind) brk = true;
      else if (BULLET.test(l.text)) brk = true;
      else if (kind === 'p' && /[.!?:;"”’)]$/.test(prev.text) && prev.text.length < maxLen * 0.7) brk = true;
      else if (kind === 'h' && cur.lines >= 3) brk = true;
    }
    if (brk) {
      push();
      cur = { kind, text: l.text, size: l.fontSize, lines: 1 };
    } else if (cur) {
      cur.text = joinLines(cur.text, l.text);
      cur.lines++;
    }
    prev = l;
  }
  push();
  return blocks;
}

/** Build the content HTML (with page markers) from per-page lines. Pure. */
export function pdfLinesToHtml(pages: PdfLine[][]): { html: string; blocks: Block[][] } {
  const cleaned = stripRunningLines(pages);
  const bodySize = bodyFontSize(cleaned);
  const all: Block[][] = [];
  const parts: string[] = [];
  let size = 0;
  cleaned.forEach((lines, i) => {
    const blocks = linesToBlocks(lines, bodySize);
    all.push(blocks);
    if (size > MAX_HTML_CHARS) return;
    const pageHtml =
      `<h2 data-page="${i + 1}">Page ${i + 1}</h2>` +
      blocks.map((b) => (b.kind === 'h' ? `<h3>${escapeHtml(b.text)}</h3>` : `<p>${escapeHtml(b.text)}</p>`)).join('');
    size += pageHtml.length;
    parts.push(pageHtml);
  });
  return { html: parts.join(''), blocks: all };
}

const BAD_TITLE = /^(untitled|unknown|document\d*|microsoft (word|powerpoint)\b.*|.*\.(docx?|pdf|tex|dvi|indd|pptx?|rtf|odt|qxd))$/i;

/** Pick a title: PDF metadata unless junk, else the largest-font text at the top of page 1. */
export function pickPdfTitle(infoTitle: unknown, firstPage: PdfLine[], fallback: string | null, bodySize?: number): string | null {
  const meta = typeof infoTitle === 'string' ? collapseWs(infoTitle) : '';
  if (meta && meta.length >= 3 && !BAD_TITLE.test(meta)) return meta;
  const top = firstPage.slice(0, 25).filter((l) => l.text.length >= 3 && !PAGE_NUM.test(l.text));
  if (top.length) {
    const maxSize = Math.max(...top.map((l) => l.fontSize));
    const body = bodySize ?? bodyFontSize([firstPage]);
    if (maxSize > body * 1.15) {
      const start = top.findIndex((l) => l.fontSize === maxSize);
      const parts: string[] = [];
      for (let i = start; i < top.length && top[i].fontSize === maxSize && parts.length < 4; i++) parts.push(top[i].text);
      const t = collapseWs(parts.join(' '));
      if (t.length <= 250) return t;
    }
    const first = top[0].text;
    if (first.length <= 200) return first;
  }
  return fallback;
}

/** Academic paper heuristics: abstract + references section. */
export function detectPaper(blocks: Block[][]): PaperMeta | null {
  const flat = blocks.flat();
  const early = blocks.slice(0, 3).flat();
  const earlyText = early.map((b) => b.text).join('\n');
  const hasAbstract = /\babstract\b/i.test(earlyText);
  const hasRefs = flat.some((b) => /^(\d+\.?\s*)?(references|bibliography|works cited)\b/i.test(b.text));
  if (!hasAbstract || !hasRefs) return null;
  const paper: PaperMeta = {};
  const idx = early.findIndex((b) => /^\s*abstract\b/i.test(b.text));
  if (idx >= 0) {
    let abs = early[idx].text.replace(/^\s*abstract[\s.:—–-]*/i, '');
    if (abs.length < 80 && early[idx + 1]) abs = `${abs} ${early[idx + 1].text}`.trim();
    if (abs) paper.abstract = abs.length > 3000 ? `${abs.slice(0, 2999)}…` : abs;
  }
  const all = flat.map((b) => b.text).join('\n');
  const doi = /\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)])/.exec(all);
  if (doi) paper.doi = doi[1];
  const arx = /arXiv:\s*(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)/.exec(all);
  if (arx) paper.arxivId = arx[1];
  return paper;
}

function friendlyPdfError(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  const name = (e as Error)?.name ?? '';
  if (name === 'PasswordException' || /password/i.test(msg)) return new Error('This PDF is password-protected');
  return new Error('Could not read this PDF (it may be damaged)');
}

/** Extract text and metadata from a PDF buffer. Returns the original as `file` for storage. */
export async function extractPdf(buf: Buffer, opts: { url?: string; name?: string } = {}): Promise<Extracted> {
  const { getDocumentProxy, extractTextItems, getMeta } = await import('unpdf');
  let pages: PdfLine[][] = [];
  let info: Record<string, unknown> = {};
  try {
    // pdf.js may transfer/detach the buffer it is given, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    try {
      try {
        info = (await getMeta(pdf, { parseDates: true })).info ?? {};
      } catch {
        info = {};
      }
      const { items } = await extractTextItems(pdf);
      pages = items.map((pageItems) => itemsToLines(pageItems as PdfTextItem[]));
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  } catch (e) {
    throw friendlyPdfError(e);
  }

  const name = opts.name || fileNameFromUrl(opts.url) || 'document.pdf';
  const fileName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  const { html, blocks } = pdfLinesToHtml(pages);
  const hasText = blocks.some((b) => b.length);
  const paper = hasText ? detectPaper(blocks) : null;
  const title = pickPdfTitle(info.Title, pages[0] ?? [], titleFromFileName(name), bodyFontSize(pages));
  const author = typeof info.Author === 'string' && collapseWs(info.Author) ? collapseWs(info.Author) : null;
  let siteName: string | null = null;
  if (opts.url) {
    try {
      siteName = new URL(opts.url).hostname.replace(/^www\./, '');
    } catch {
      siteName = null;
    }
  }
  return finalize({
    type: paper ? 'paper' : 'pdf',
    html: hasText ? html : '',
    title,
    author,
    siteName,
    description: paper?.abstract ?? null,
    // From the paragraphs, so the "Page N" markers and headings of the HTML do not end up in the excerpt.
    excerpt: paper?.abstract || !hasText ? undefined : pdfExcerptText(blocks),
    publishedAt: toDate(info.CreationDate ?? info.ModDate ?? null),
    canonicalUrl: opts.url ?? null,
    paper: paper && opts.url ? { ...paper, pdfUrl: opts.url } : paper,
    file: { buffer: buf, contentType: 'application/pdf', name: fileName },
  });
}
