/**
 * Renders sanitized item HTML with highlights, in scroll mode (window scroll) or pages mode
 * (CSS multi-column pagination, see Paginator.ts).
 *
 * export default ArticleView
 * Props (ArticleViewProps): see interface below.
 * Imperative handle (ArticleHandle) via `ref`: root(), goTo(el), turn(dir), progress(), adoptProgress(p).
 *
 * Pages mode input: tap left 30% = previous, right 30% = next, middle = onToggleChrome; keys
 * ←/→/PageUp/PageDown/Space/Shift+Space, Home/End (first / last page); the page indicator ("3 / 67") is a
 * button that opens "Go to page" (number, Start, End); window `hwpage` CustomEvent {detail:{dir}} (both
 * modes; in scroll mode it scrolls by about one screen). Taps are ignored while text is selected so
 * long-press selection for highlighting keeps working.
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import Dialog from '../components/Dialog';
import { isTypingTarget } from '../components/ItemList';
import type { ReaderMode } from '../lib/prefs';
import { isNative, openExternal } from '../native';
import { applyHighlights, type Anchorable } from './highlights';
import { captureAnchor, clampPage, offsetInFlow, pageCountFromOffset, pageOfOffset, pageToProgress, progressToPage } from './Paginator';

export interface ArticleHandle {
  /** The element holding the content HTML (highlights live here). */
  root(): HTMLElement | null;
  /** Bring an element inside the article into view (scroll or turn to its page). */
  goTo(target: Element, align?: 'start' | 'center'): void;
  /** Next / previous page (pages mode) or screen (scroll mode). */
  turn(dir: 1 | -1): void;
  /** Current reading progress 0..1. */
  progress(): number;
  /**
   * A newer saved position arrived (e.g. from another device) before the reader moved: go there. Ignored
   * once the user has scrolled or turned a page.
   */
  adoptProgress(p: number): void;
}

export interface ArticleViewProps {
  html: string;
  header: ReactNode;
  footer?: ReactNode;
  mode: ReaderMode;
  /** Changes whenever typography changes, to re-measure pages. */
  layoutKey: string;
  highlights: Anchorable[];
  initialProgress: number;
  hideImages: boolean;
  /** User-driven progress changes (scrolling, page turns). */
  onProgress: (p: number) => void;
  /** Middle tap in pages mode. */
  onToggleChrome: () => void;
  /** Called after a page turn (pages mode). */
  onPageTurn?: () => void;
  onHighlightTap: (id: string) => void;
  onHighlightsApplied?: (r: { applied: string[]; missing: string[] }) => void;
  ref?: Ref<ArticleHandle>;
}

const GAP = 48;
const RESTORE_MS = 4000;

function dialogOpen(): boolean {
  return !!document.querySelector('.dialog-backdrop, .menu-list');
}

export default function ArticleView(props: ArticleViewProps) {
  const { html, header, footer, mode, layoutKey, highlights, initialProgress, hideImages, ref } = props;
  const clipRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [jump, setJump] = useState<string | null>(null);

  // Latest props for event handlers bound once.
  const cb = useRef(props);
  cb.current = props;

  const st = useRef({
    mode,
    page: 0,
    pages: 1,
    stride: 0,
    progress: initialProgress,
    /** While set, layout changes re-apply this progress (initial restore, mode switch). */
    restore: (initialProgress > 0 ? { progress: initialProgress, until: Date.now() + RESTORE_MS } : null) as { progress: number; until: number } | null,
    rendered: null as string | null,
    raf: 0,
    selAtDown: false,
    /** Reading position captured whenever a page is shown; used to keep the place on relayout. */
    anchor: null as Range | Element | null,
    /** Next layout keeps the page index (highlight-only changes: the anchor's text node may be gone). */
    keepPage: false,
    /** The user scrolled, turned a page or jumped: positions from elsewhere no longer apply. */
    moved: false,
  });

  const restoreActive = () => {
    const r = st.current.restore;
    if (r && Date.now() > r.until) st.current.restore = null;
    return st.current.restore;
  };

  const report = (p: number) => {
    st.current.progress = p;
    st.current.moved = true;
    cb.current.onProgress(p);
  };

  // ------------------------------------------------------------------ pages layout

  const showPage = useCallback((p: number) => {
    const s = st.current;
    s.page = p;
    const flow = flowRef.current;
    const clip = clipRef.current;
    if (flow) flow.style.transform = `translate3d(${-p * s.stride}px, 0, 0)`;
    // Capture now: by the time a resize is observed the browser has already re-flowed the columns.
    s.anchor = flow && clip ? captureAnchor(clip, flow) : null;
    setPage(p);
  }, []);

  const layout = useCallback(() => {
    const s = st.current;
    if (s.mode !== 'paginate') return;
    const clip = clipRef.current;
    const flow = flowRef.current;
    const end = endRef.current;
    if (!clip || !flow || !end) return;
    const W = clip.clientWidth;
    const H = clip.clientHeight;
    if (!W || !H) return;
    const restore = restoreActive();
    const keepPage = s.keepPage;
    s.keepPage = false;
    const anchor =
      !restore && !keepPage && s.stride && s.anchor && (!(s.anchor instanceof Element) || s.anchor.isConnected) ? s.anchor : null;
    clip.scrollLeft = 0;
    flow.style.height = `${H}px`;
    flow.style.columnWidth = `${W}px`;
    flow.style.columnGap = `${GAP}px`;
    flow.style.setProperty('--page-h', `${H}px`);
    const stride = W + GAP;
    s.stride = stride;
    const count = pageCountFromOffset(offsetInFlow(end, flow), stride);
    s.pages = count;
    setPages(count);
    let p: number;
    if (restore) p = progressToPage(restore.progress, count);
    else if (anchor) p = pageOfOffset(offsetInFlow(anchor, flow), stride, count);
    else p = clampPage(s.page, count);
    showPage(p);
  }, [showPage]);

  const scheduleLayout = useCallback(() => {
    cancelAnimationFrame(st.current.raf);
    st.current.raf = requestAnimationFrame(() => {
      if (st.current.mode === 'paginate') layout();
      else restoreScroll();
    });
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ scroll mode

  const scrollable = () => document.documentElement.scrollHeight - window.innerHeight;

  const restoreScroll = () => {
    const r = restoreActive();
    if (!r || st.current.mode !== 'scroll') return;
    const max = scrollable();
    if (max > 0) window.scrollTo(0, Math.round(r.progress * max));
  };

  // ------------------------------------------------------------------ content + highlights

  const hlKey = highlights
    .map((h) => `${h.id}\u0001${h.text}\u0001${h.prefix}\u0001${h.suffix}\u0001${h.note?.trim() ? 1 : 0}\u0001${h.color ?? ''}`)
    .join('\u0002');

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (st.current.rendered !== html) {
      root.innerHTML = html;
      st.current.rendered = html;
    } else if (st.current.mode === mode) {
      st.current.keepPage = true;
    }
    if (mode === 'paginate') {
      // Lazy images would load (and change the page count) only when their page is shown.
      root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
    }
    const res = applyHighlights(root, cb.current.highlights);
    cb.current.onHighlightsApplied?.(res);
    scheduleLayout();
  }, [html, hlKey, mode, scheduleLayout]);

  // Mode switches: carry the reading position over.
  useLayoutEffect(() => {
    const s = st.current;
    if (s.mode === mode) return;
    s.mode = mode;
    s.restore = { progress: s.progress, until: Date.now() + RESTORE_MS };
    const flow = flowRef.current;
    if (mode === 'scroll' && flow) {
      flow.style.removeProperty('height');
      flow.style.removeProperty('column-width');
      flow.style.removeProperty('column-gap');
      flow.style.removeProperty('transform');
      flow.style.removeProperty('--page-h');
      s.stride = 0;
    } else {
      window.scrollTo(0, 0);
    }
    scheduleLayout();
  }, [mode, scheduleLayout]);

  // Typography / image visibility changes.
  useLayoutEffect(() => {
    if (st.current.mode === 'scroll') {
      if (!st.current.restore && st.current.progress > 0) st.current.restore = { progress: st.current.progress, until: Date.now() + 600 };
      restoreScroll();
    } else layout();
  }, [layoutKey, hideImages, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-measure on resize, image loads, fonts and <details> toggles.
  useEffect(() => {
    const clip = clipRef.current;
    const root = rootRef.current;
    if (!clip || !root) return;
    const ro = new ResizeObserver(() => scheduleLayout());
    ro.observe(clip);
    const onLoad = (e: Event) => {
      if ((e.target as Element)?.tagName === 'IMG') scheduleLayout();
    };
    root.addEventListener('load', onLoad, true);
    root.addEventListener('error', onLoad, true);
    root.addEventListener('toggle', scheduleLayout, true);
    let alive = true;
    document.fonts?.ready.then(() => alive && scheduleLayout()).catch(() => {});
    const stopRestore = () => {
      st.current.restore = null;
    };
    const stopTimer = window.setTimeout(stopRestore, RESTORE_MS + 50);
    window.addEventListener('wheel', stopRestore, { passive: true });
    window.addEventListener('touchstart', stopRestore, { passive: true });
    window.addEventListener('keydown', stopRestore);
    window.addEventListener('pointerdown', stopRestore);
    return () => {
      alive = false;
      ro.disconnect();
      root.removeEventListener('load', onLoad, true);
      root.removeEventListener('error', onLoad, true);
      root.removeEventListener('toggle', scheduleLayout, true);
      window.clearTimeout(stopTimer);
      window.removeEventListener('wheel', stopRestore);
      window.removeEventListener('touchstart', stopRestore);
      window.removeEventListener('keydown', stopRestore);
      window.removeEventListener('pointerdown', stopRestore);
      cancelAnimationFrame(st.current.raf);
    };
  }, [scheduleLayout]);

  // Scroll progress.
  useEffect(() => {
    if (mode !== 'scroll') return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (restoreActive()) return;
        const max = scrollable();
        if (max <= 0) return;
        const p = Math.max(0, Math.min(1, window.scrollY / max));
        if (Math.abs(p - st.current.progress) > 0.0005) report(p);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ navigation

  const turn = useCallback(
    (dir: 1 | -1) => {
      const s = st.current;
      s.restore = null;
      if (s.mode !== 'paginate') {
        const bar = document.querySelector('.reader-toolbar') as HTMLElement | null;
        const step = Math.max(100, window.innerHeight - (bar?.offsetHeight ?? 0) - 40);
        window.scrollBy(0, dir * step);
        return;
      }
      const next = clampPage(s.page + dir, s.pages);
      if (next === s.page) return;
      showPage(next);
      report(pageToProgress(next, s.pages));
      cb.current.onPageTurn?.();
    },
    [showPage], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const goTo = useCallback(
    (target: Element, align: 'start' | 'center' = 'center') => {
      const s = st.current;
      s.restore = null;
      if (s.mode !== 'paginate') {
        target.scrollIntoView({ block: align });
        return;
      }
      const flow = flowRef.current;
      if (!flow || !s.stride) return;
      const p = pageOfOffset(offsetInFlow(target, flow), s.stride, s.pages);
      showPage(p);
      report(pageToProgress(p, s.pages));
    },
    [showPage], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Show page `p` (0-based, clamped) — Home / End / "Go to page". */
  const goToPage = useCallback(
    (p: number) => {
      const s = st.current;
      if (s.mode !== 'paginate') return;
      s.restore = null;
      const next = clampPage(p, s.pages);
      if (next === s.page) return;
      showPage(next);
      report(pageToProgress(next, s.pages));
      cb.current.onPageTurn?.();
    },
    [showPage], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const adoptProgress = useCallback(
    (p: number) => {
      const s = st.current;
      if (s.moved || !(p >= 0 && p <= 1)) return;
      s.progress = p;
      s.restore = { progress: p, until: Date.now() + RESTORE_MS };
      scheduleLayout();
    },
    [scheduleLayout],
  );

  useImperativeHandle(ref, () => ({ root: () => rootRef.current, goTo, turn, progress: () => st.current.progress, adoptProgress }), [goTo, turn, adoptProgress]);

  // Keys (pages mode) and hardware page buttons (both modes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (st.current.mode !== 'paginate' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || dialogOpen()) return;
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        goToPage(e.key === 'Home' ? 0 : st.current.pages - 1);
        return;
      }
      let dir: 1 | -1 | 0 = 0;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) dir = 1;
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) dir = -1;
      if (!dir) return;
      if (e.target instanceof HTMLButtonElement && e.key === ' ') return; // Space activates a focused button
      e.preventDefault();
      turn(dir);
    };
    const onHw = (e: Event) => {
      if (dialogOpen()) return;
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir;
      if (dir === 1 || dir === -1) turn(dir);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('hwpage', onHw);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hwpage', onHw);
    };
  }, [turn, goToPage]);

  // ------------------------------------------------------------------ taps

  const onPointerDown = () => {
    const sel = window.getSelection();
    st.current.selAtDown = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const t = e.target as Element;
    // Clicks inside the "Go to page" dialog (a portal) bubble here through React, but are not taps on the page.
    if (!e.currentTarget.contains(t)) return;
    const sel = window.getSelection();
    const hasSel = (!!sel && !sel.isCollapsed && sel.toString().trim().length > 0) || st.current.selAtDown;
    st.current.selAtDown = false;
    const link = t.closest?.('a[href]') as HTMLAnchorElement | null;
    if (link) {
      if (isNative() && /^https?:/i.test(link.href)) {
        e.preventDefault();
        void openExternal(link.href);
      }
      return;
    }
    const mark = t.closest?.('mark.hl[data-hid]');
    if (mark && !hasSel && rootRef.current?.contains(mark)) {
      cb.current.onHighlightTap(mark.getAttribute('data-hid')!);
      return;
    }
    if (st.current.mode !== 'paginate' || hasSel) return;
    if (t.closest?.('button, input, select, textarea, label, summary, [role="button"]')) return;
    const w = window.innerWidth;
    if (e.clientX < w * 0.3) turn(-1);
    else if (e.clientX > w * 0.7) turn(1);
    else cb.current.onToggleChrome();
  };

  const paged = mode === 'paginate';
  return (
    <div className={`article${paged ? ' article-pages' : ' article-scroll'}${hideImages ? ' hide-images' : ''}`} onPointerDown={onPointerDown} onClick={onClick}>
      <div className="article-clip" ref={clipRef} onScroll={(e) => (e.currentTarget.scrollLeft = 0)}>
        <div className="article-flow" ref={flowRef}>
          {header}
          <div className="reader-content" ref={rootRef} />
          {footer}
          <div className="article-end" ref={endRef} aria-hidden="true" />
        </div>
      </div>
      {paged ? (
        <div className="page-indicator">
          <button
            type="button"
            className="page-indicator-button"
            aria-label={`Page ${page + 1} of ${pages}. Go to page…`}
            title="Go to page"
            onClick={() => setJump(String(page + 1))}
          >
            {page + 1} / {pages}
          </button>
        </div>
      ) : null}
      <Dialog
        open={jump !== null}
        onClose={() => setJump(null)}
        title="Go to page"
        className="page-jump-dialog"
        onSubmit={() => {
          const n = Number(jump);
          if (Number.isFinite(n) && n >= 1) goToPage(Math.round(n) - 1);
          setJump(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                goToPage(0);
                setJump(null);
              }}
            >
              Start
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                goToPage(pages - 1);
                setJump(null);
              }}
            >
              End
            </button>
            <button type="submit" className="btn btn-primary">
              Go
            </button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">Page (1–{pages})</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={pages}
            value={jump ?? ''}
            onChange={(e) => setJump(e.target.value)}
            data-autofocus=""
          />
        </label>
      </Dialog>
    </div>
  );
}
