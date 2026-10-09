/**
 * Floating "Highlight" / "Highlight + note" bar shown while text inside the article is selected.
 * Near the selection with a fine pointer; fixed at the bottom on touch screens so it does not fight
 * the native selection menu.
 *
 * export default SelectionBar
 * Props: {
 *   getRoot: () => HTMLElement | null           the content root; selections outside it are ignored
 *   onHighlight: (range: Range, withNote: boolean) => void
 * }
 */
import { useEffect, useRef, useState } from 'react';
import { Highlight, Note } from '../components/Icons';

export interface SelectionBarProps {
  getRoot: () => HTMLElement | null;
  onHighlight: (range: Range, withNote: boolean) => void;
}

interface BarState {
  top?: number;
  left?: number;
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

const BAR_W = 300;

export default function SelectionBar({ getRoot, onHighlight }: SelectionBarProps) {
  const [state, setState] = useState<BarState | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const hideTimer = useRef(0);
  const getRootRef = useRef(getRoot);
  getRootRef.current = getRoot;

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
        const width = Math.min(BAR_W, window.innerWidth - 16);
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2));
        const top = r.top > 72 ? r.top - 56 : Math.min(window.innerHeight - 56, r.bottom + 10);
        setState({ top, left });
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

  const positioned = state.top != null;
  return (
    <div
      className={`selection-bar${positioned ? ' selection-bar-float' : ' selection-bar-bottom'}`}
      style={positioned ? { top: state.top, left: state.left } : undefined}
      role="toolbar"
      aria-label="Selection"
      // Keep the selection when pressing the buttons with a mouse.
      onPointerDown={(e) => {
        window.clearTimeout(hideTimer.current);
        if (e.pointerType === 'mouse') e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="btn" onClick={() => act(false)}>
        <Highlight /> Highlight
      </button>
      <button type="button" className="btn" onClick={() => act(true)}>
        <Note /> Highlight + note
      </button>
    </div>
  );
}
