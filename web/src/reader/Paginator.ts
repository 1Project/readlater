/**
 * Helpers for the paginated (CSS multi-column) reader layout.
 *
 * Layout: a clip box (overflow hidden, width W, height H) contains the flow element with
 * `column-width: W; column-gap: G; height: H; column-fill: auto`. Page k is shown by
 * `transform: translateX(-k * (W + G))`, so the page stride is W + G.
 *
 * Exports (pure):
 *   pageCountFromOffset(endOffset, stride): number     pages needed when the end marker sits at endOffset
 *   pageOfOffset(offset, stride, pages): number        0-based page containing a horizontal offset
 *   pageToProgress(page, pages): number                page / (pages - 1); 1 for single-page content
 *   progressToPage(progress, pages): number            inverse, rounded and clamped
 *   clampPage(page, pages): number
 * Exports (DOM):
 *   offsetInFlow(el | Range, flow): number              left offset of el's start relative to the flow box
 *   captureAnchor(clip, flow): Range | Element | null   reading position at the top-left of the visible page
 */

export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.max(0, Math.min(Math.max(1, pages) - 1, Math.round(page)));
}

export function pageCountFromOffset(endOffset: number, stride: number): number {
  if (!(stride > 0) || !Number.isFinite(endOffset) || endOffset <= 0) return 1;
  // A marker that lands exactly at the start of a column (tiny rounding error) belongs to that column.
  return Math.max(1, Math.floor(endOffset / stride + 0.01) + 1);
}

export function pageOfOffset(offset: number, stride: number, pages: number): number {
  if (!(stride > 0) || !Number.isFinite(offset)) return 0;
  return clampPage(Math.floor(offset / stride + 0.01), pages);
}

export function pageToProgress(page: number, pages: number): number {
  if (pages <= 1) return 1;
  return Math.max(0, Math.min(1, page / (pages - 1)));
}

export function progressToPage(progress: number, pages: number): number {
  if (pages <= 1 || !Number.isFinite(progress)) return 0;
  return clampPage(Math.max(0, Math.min(1, progress)) * (pages - 1), pages);
}

/** Horizontal offset of the start of `target` inside `flow` (both measured with the current transform). */
export function offsetInFlow(target: Element | Range, flow: Element): number {
  const flowLeft = flow.getBoundingClientRect().left;
  let rect: DOMRect | null = null;
  if (target instanceof Range) {
    const rects = target.getClientRects();
    rect = rects.length ? rects[0] : target.getBoundingClientRect();
    if (rect && rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) {
      const parent = target.startContainer.nodeType === 1 ? (target.startContainer as Element) : target.startContainer.parentElement;
      rect = parent ? firstRect(parent) : null;
    }
  } else {
    rect = firstRect(target);
  }
  return rect ? rect.left - flowLeft : 0;
}

function firstRect(el: Element): DOMRect {
  const rects = el.getClientRects();
  return rects.length ? rects[0] : el.getBoundingClientRect();
}

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

/** A text position (or element) near the top-left of the visible page, used to keep the place on relayout. */
export function captureAnchor(clip: Element, flow: Element): Range | Element | null {
  const r = clip.getBoundingClientRect();
  const doc = clip.ownerDocument as CaretDoc;
  const probes: [number, number][] = [
    [r.left + 4, r.top + 4],
    [r.left + r.width / 2, r.top + 8],
    [r.left + 4, r.top + r.height / 3],
    [r.left + r.width / 2, r.top + r.height / 2],
  ];
  for (const [x, y] of probes) {
    let range: Range | null = null;
    if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(x, y);
    } else if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) {
        range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range && flow.contains(range.startContainer)) return range;
    // Only small elements (e.g. an image) make good anchors; a container's first box may be pages back.
    const el = doc.elementFromPoint?.(x, y);
    if (el && flow.contains(el) && el !== flow && el.getClientRects().length === 1) return el;
  }
  return null;
}
