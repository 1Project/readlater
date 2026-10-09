/**
 * Text-quote anchoring for highlights (pure DOM functions, no React / Firebase).
 *
 * The "text model" of a content root is the concatenation of its text nodes with whitespace runs
 * collapsed to a single space, leading/trailing whitespace dropped, and a single synthetic space at
 * block boundaries (p, li, h1…, br, img…). The same model is used to create a quote from a selection
 * and to re-anchor it on render, so they always agree.
 *
 * Exports:
 *   type Quote = { text: string; prefix: string; suffix: string }
 *   type Anchorable = { id: string; text: string; prefix: string; suffix: string; note?: string }
 *   QUOTE_CONTEXT = 32                                   chars of prefix / suffix stored with a quote
 *   collapseWhitespace(s): string                        runs of whitespace → one space (no trim)
 *   buildTextIndex(root): TextIndex                      text model + mapping back to DOM text nodes
 *   getSelectionQuote(root, range): Quote | null         quote for the part of `range` inside `root`
 *   findQuote(rootText, quote): {start, end} | null      offsets in rootText (whitespace-insensitive);
 *                                                        prefix/suffix disambiguate repeated text,
 *                                                        else the first exact match wins
 *   applyHighlights(root, highlights): { applied: string[]; missing: string[] }
 *                                                        wraps matches in <mark class="hl" data-hid>
 *                                                        (applied = ids in document order)
 *   clearHighlights(root): void                          removes marks added by applyHighlights
 */

export interface Quote {
  text: string;
  prefix: string;
  suffix: string;
}

export interface Anchorable extends Quote {
  id: string;
  note?: string;
}

export const QUOTE_CONTEXT = 32;

export interface TextIndex {
  /** Normalised text. */
  text: string;
  /** DOM text nodes in document order. */
  nodes: Text[];
  /** Per normalised char: index into `nodes`. */
  node: number[];
  /** Per normalised char: offset of the char inside its text node. */
  offset: number[];
  /** Per normalised char: true for synthetic block-boundary spaces (zero width in the DOM). */
  virtual: boolean[];
}

/** Elements whose start and end separate words (a synthetic space is inserted). */
const BREAKING = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'IMG', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'MATH', 'VIDEO', 'AUDIO',
]);

/** Elements that cannot hold an inline <mark> between their children. */
const CONTAINERS = new Set([
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL', 'DL', 'SECTION', 'ARTICLE', 'ASIDE', 'DIV', 'BLOCKQUOTE',
  'FIGURE', 'DETAILS', 'BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
]);

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

const MARK_SELECTOR = 'mark.hl[data-hid]';

function isWs(code: number): boolean {
  // Same set as /\s/ for the characters that matter in prose.
  return (
    code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

export function buildTextIndex(root: Node): TextIndex {
  const out: string[] = [];
  const nodes: Text[] = [];
  const node: number[] = [];
  const offset: number[] = [];
  const virtual: boolean[] = [];
  let pendingWs: { n: number; o: number } | null = null;
  let pendingBreak = false;
  let lastIsSpace = true; // nothing emitted yet → suppress leading spaces

  const visitText = (t: Text) => {
    const data = t.data;
    if (!data) return;
    const n = nodes.length;
    nodes.push(t);
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (isWs(code)) {
        if (!pendingWs) pendingWs = { n, o: i };
        continue;
      }
      if ((pendingWs || pendingBreak) && !lastIsSpace) {
        out.push(' ');
        if (pendingWs) {
          node.push(pendingWs.n);
          offset.push(pendingWs.o);
          virtual.push(false);
        } else {
          node.push(n);
          offset.push(i);
          virtual.push(true);
        }
      }
      pendingWs = null;
      pendingBreak = false;
      out.push(data[i]);
      node.push(n);
      offset.push(i);
      virtual.push(false);
      lastIsSpace = false;
    }
  };

  const visit = (el: Node) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        visitText(c as Text);
      } else if (c.nodeType === 1) {
        const tag = (c as Element).tagName.toUpperCase();
        if (SKIP.has(tag)) continue;
        const breaking = BREAKING.has(tag);
        if (breaking) pendingBreak = true;
        visit(c);
        if (breaking) pendingBreak = true;
      }
    }
  };
  if (root.nodeType === 3) visitText(root as Text);
  else visit(root);

  return { text: out.join(''), nodes, node, offset, virtual };
}

/** First index in [0, n) for which pred is true (pred must be monotonic false…true); n when none. */
function lowerBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function comparePoint(range: Range, node: Node, offset: number): number {
  try {
    return range.comparePoint(node, offset);
  } catch {
    return -2;
  }
}

/**
 * The quote (text + context) for the part of `range` that lies inside `root`, in the normalised text
 * model. Returns null when the range covers no text inside root.
 */
export function getSelectionQuote(root: Node, range: Range): (Quote & { start: number; end: number }) | null {
  const idx = buildTextIndex(root);
  const n = idx.text.length;
  if (!n || range.collapsed) return null;
  const startPt = (i: number) => comparePoint(range, idx.nodes[idx.node[i]], idx.offset[i]);
  const endPt = (i: number) => comparePoint(range, idx.nodes[idx.node[i]], idx.virtual[i] ? idx.offset[i] : idx.offset[i] + 1);
  // first char that starts at or after the range start
  let s = lowerBound(n, (i) => {
    const c = startPt(i);
    return c === 0 || c === 1;
  });
  // first char that ends after the range end
  let e = lowerBound(n, (i) => endPt(i) === 1);
  const t = idx.text;
  while (s < e && t[s] === ' ') s++;
  while (e > s && t[e - 1] === ' ') e--;
  if (s >= e) return null;
  return {
    text: t.slice(s, e),
    prefix: t.slice(Math.max(0, s - QUOTE_CONTEXT), s),
    suffix: t.slice(e, e + QUOTE_CONTEXT),
    start: s,
    end: e,
  };
}

function commonSuffixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const MAX_CANDIDATES = 5000;

/** findQuote on text that is already in the normalised model (no internal whitespace runs). */
function findNormalized(text: string, quote: Quote): { start: number; end: number } | null {
  const q = collapseWhitespace(quote.text).trim();
  if (!q) return null;
  const prefix = collapseWhitespace(quote.prefix ?? '');
  const suffix = collapseWhitespace(quote.suffix ?? '');
  let best = -1;
  let bestScore = -1;
  let count = 0;
  for (let p = text.indexOf(q); p !== -1 && count < MAX_CANDIDATES; p = text.indexOf(q, p + 1), count++) {
    const before = text.slice(Math.max(0, p - prefix.length), p);
    const after = text.slice(p + q.length, p + q.length + suffix.length);
    const score = commonSuffixLength(prefix, before) + commonPrefixLength(suffix, after);
    if (score > bestScore) {
      best = p;
      bestScore = score;
      if (score === prefix.length + suffix.length) break; // perfect context match
    }
  }
  return best < 0 ? null : { start: best, end: best + q.length };
}

/**
 * Locate a quote in `rootText`. Matching ignores differences in whitespace (runs, newlines, NBSP).
 * Returns offsets into `rootText` (end exclusive), or null when the text does not occur.
 */
export function findQuote(rootText: string, quote: Quote): { start: number; end: number } | null {
  // Collapse whitespace while remembering where each normalised char came from.
  const map: number[] = [];
  const chars: string[] = [];
  let inWs = false;
  for (let i = 0; i < rootText.length; i++) {
    if (isWs(rootText.charCodeAt(i))) {
      if (!inWs) {
        chars.push(' ');
        map.push(i);
      }
      inWs = true;
    } else {
      chars.push(rootText[i]);
      map.push(i);
      inWs = false;
    }
  }
  const r = findNormalized(chars.join(''), quote);
  if (!r) return null;
  return { start: map[r.start], end: map[r.end - 1] + 1 };
}

/** Remove marks added by applyHighlights, restoring the original text nodes. */
export function clearHighlights(root: Element | DocumentFragment): void {
  const marks = root.querySelectorAll(MARK_SELECTOR);
  if (!marks.length) return;
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  root.normalize();
}

interface Segment {
  from: number;
  to: number;
  order: number; // index in the highlights array; later wins on overlap
}

/**
 * Wrap every highlight's text in <mark class="hl" data-hid="…"> (several marks when the quote spans
 * elements). Marks get the extra class `has-note` when the highlight has a note. Existing marks from a
 * previous call are removed first. Text inside <math> is never wrapped.
 */
export function applyHighlights(root: Element, highlights: Anchorable[]): { applied: string[]; missing: string[] } {
  clearHighlights(root);
  const idx = buildTextIndex(root);
  const missing: string[] = [];
  const found: { id: string; start: number }[] = [];
  const perNode = new Map<number, Segment[]>();

  highlights.forEach((h, order) => {
    const r = findNormalized(idx.text, h);
    if (!r) {
      missing.push(h.id);
      return;
    }
    found.push({ id: h.id, start: r.start });
    let curNode = -1;
    let from = 0;
    let to = 0;
    const flush = () => {
      if (curNode < 0) return;
      const list = perNode.get(curNode) ?? [];
      list.push({ from, to, order });
      perNode.set(curNode, list);
    };
    for (let k = r.start; k < r.end; k++) {
      if (idx.virtual[k]) continue;
      const n = idx.node[k];
      const o = idx.offset[k];
      if (n !== curNode) {
        flush();
        curNode = n;
        from = o;
      }
      to = o + 1;
    }
    flush();
  });

  const doc = root.ownerDocument;
  for (const [n, segs] of perNode) {
    const textNode = idx.nodes[n];
    const parent = textNode.parentNode as Element | null;
    if (!parent || (parent as Element).closest?.('math')) continue;
    const data = textNode.data;
    const wsOnlyNode = !/\S/.test(data);
    if (wsOnlyNode && CONTAINERS.has(parent.tagName?.toUpperCase())) continue;
    const cuts = new Set<number>([0, data.length]);
    segs.forEach((s) => {
      cuts.add(s.from);
      cuts.add(s.to);
    });
    const points = [...cuts].sort((a, b) => a - b);
    const frag = doc.createDocumentFragment();
    let prev: { order: number; mark: HTMLElement } | null = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a === b) continue;
      const piece = data.slice(a, b);
      let owner: Segment | null = null;
      for (const s of segs) if (s.from <= a && s.to >= b && (!owner || s.order > owner.order)) owner = s;
      if (!owner) {
        frag.appendChild(doc.createTextNode(piece));
        prev = null;
        continue;
      }
      if (prev && prev.order === owner.order) {
        (prev.mark.firstChild as Text).appendData(piece);
        continue;
      }
      const h = highlights[owner.order];
      const mark = doc.createElement('mark');
      mark.className = h.note && h.note.trim() ? 'hl has-note' : 'hl';
      mark.setAttribute('data-hid', h.id);
      mark.appendChild(doc.createTextNode(piece));
      frag.appendChild(mark);
      prev = { order: owner.order, mark };
    }
    parent.replaceChild(frag, textNode);
  }

  found.sort((a, b) => a.start - b.start);
  return { applied: found.map((f) => f.id), missing };
}
