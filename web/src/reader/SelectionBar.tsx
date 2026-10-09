/**
 * Floating "Highlight" / "Highlight + note" bar shown while text inside the article is selected, with
 * the colour for new highlights. Near the selection with a fine pointer; fixed at the bottom on touch
 * screens so it does not fight the native selection menu.
 *
 * export default SelectionBar
 * Props: {
 *   getRoot: () => HTMLElement | null           the content root; selections outside it are ignored
 *   onHighlight: (range: Range, withNote: boolean) => void
 *   color: HighlightColor; onColor: (c) => void  colour picker state (the reader remembers the last one)
 * }
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Highlight, Note } from '../components/Icons';
import type { HighlightColor } from '../lib/types';
import { ColorPicker } from './HighlightColors';

export interface SelectionBarProps {
  getRoot: () => HTMLElement | null;
  onHighlight: (range: Range, withNote: boolean) => void;
  color: HighlightColor;
  onColor: (c: HighlightColor) => void;
}

interface BarState {
  /** Selection rectangle (fine pointer); the bar is placed above it, or below when there is no room. */
  rect?: { top: number; bottom: number; centerX: number };
}

function coarse(): boolean {
  return !!window.matchMedia?.('(pointer: coarse)').matches;
}

/** The current selection's range when it is non-empty and touches the root. */
export function selectionRangeIn(root: HTMLElement | null): Range | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.toString().trim()) return null;
  if (!range.intersectsNode(root)) return null;
  return range;
}

const MARGIN = 8;

export default function SelectionBar({ getRoot, onHighlight, color, onColor }: SelectionBarProps) {
  const [state, setState] = useState<BarState | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const hideTimer = useRef(0);
  const getRootRef = useRef(getRoot);
  getRootRef.current = getRoot;
  const barRef = useRef<HTMLDivElement>(null);

  // Place the floating bar from its real size (it wraps to two rows on narrow screens).
  useLayoutEffect(() => {
    const el = barRef.current;
    const r = state?.rect;
    if (!el || !r) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, r.centerX - w / 2));
    const top = r.top - h - MARGIN >= 64 ? r.top - h - MARGIN : Math.max(MARGIN, Math.min(window.innerHeight - h - MARGIN, r.bottom + 10));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [state]);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const range = selectionRangeIn(getRootRef.current());
        if (!range) {
          // Delay hiding so a tap on the bar (which may clear the selection first) still lands.
          window.clearTimeout(hideTimer.current);
          hideTimer.current = window.setTimeout(() => {
            if (!selectionRangeIn(getRootRef.current())) {
              rangeRef.current = null;
              setState(null);
            }
          }, 400);
          return;
        }
        window.clearTimeout(hideTimer.current);
        rangeRef.current = range.cloneRange();
        if (coarse()) {
          setState({});
          return;
        }
        const r = range.getBoundingClientRect();
        setState({ rect: { top: r.top, bottom: r.bottom, centerX: r.left + r.width / 2 } });
      });
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(hideTimer.current);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (!state) return null;

  const act = (withNote: boolean) => {
    const range = selectionRangeIn(getRootRef.current()) ?? rangeRef.current;
    rangeRef.current = null;
    setState(null);
    if (range) onHighlight(range, withNote);
  };

  // A tap on a colour can clear the selection on touch screens: put it back so the bar stays usable.
  const pickColor = (c: HighlightColor) => {
    onColor(c);
    window.clearTimeout(hideTimer.current);
    const saved = rangeRef.current;
    if (saved && !selectionRangeIn(getRootRef.current())) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved);
    }
  };

  const positioned = !!state.rect;
  return (
    <div
      ref={barRef}
      className={`selection-bar${positioned ? ' selection-bar-float' : ' selection-bar-bottom'}`}
      role="toolbar"
      aria-label="Selection"
      // Keep the selection when pressing the buttons with a mouse.
      onPointerDown={(e) => {
        window.clearTimeout(hideTimer.current);
        if (e.pointerType === 'mouse') e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <ColorPicker value={color} onChange={pickColor} />
      <button type="button" className="btn" onClick={() => act(false)}>
        <Highlight /> Highlight
      </button>
      <button type="button" className="btn" onClick={() => act(true)}>
        <Note /> Highlight + note
      </button>
    </div>
  );
}
