/**
 * Original-PDF viewer (pdf.js canvas, one page at a time, fit to width, devicePixelRatio aware).
 *
 * export default PdfView
 * Props (PdfViewProps):
 *   item: Item                        must have item.file (a PDF in Storage); loaded via fileUrl(item)
 *   initialProgress: number           0..1, restored as page = round(progress * numPages)
 *   onProgress: (p: number) => void   page / numPages after each user page change
 *   onShowText?: () => void           when given, a "Text / Original" toggle is shown
 *
 * Navigation: prev/next buttons (top and bottom), tap left 30% / right 30% of the page, ←/→/PageUp/
 * PageDown keys, window `hwpage` events, page number field. Zoom − / + (fit width = 100%).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
// The legacy build polyfills recent JS built-ins (e.g. Map#getOrInsertComputed) that older Android
// WebViews — such as those on e-ink readers — and older Safari versions lack.
import { getDocument, GlobalWorkerOptions, RenderingCancelledException, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Download } from '../components/Icons';
import Spinner from '../components/Spinner';
import { isTypingTarget } from '../components/ItemList';
import { fileUrl } from '../lib/data';
import type { Item } from '../lib/types';
import { isNative, openExternal } from '../native';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfViewProps {
  item: Item;
  initialProgress: number;
  onProgress: (p: number) => void;
  onShowText?: () => void;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
/** Keep canvases under ~16 MP; larger ones fail silently on many mobile browsers. */
const MAX_PIXELS = 16_000_000;

export default function PdfView({ item, initialProgress, onProgress, onShowText }: PdfViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [pageInput, setPageInput] = useState('1');
  const [attempt, setAttempt] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const numPages = doc?.numPages ?? 0;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const initialRef = useRef(initialProgress);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setDoc(null);
    fileUrl(item)
      .then((u) => {
        if (cancelled) return;
        if (!u) throw new Error('This item has no stored file');
        setUrl(u);
        task = getDocument({ url: u });
        return task.promise.then((d) => {
          if (cancelled) return;
          const n = d.numPages;
          const p = initialRef.current > 0 ? Math.min(n, Math.max(1, Math.round(initialRef.current * n))) : 1;
          setPage(p);
          setPageInput(String(p));
          setDoc(d);
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error)?.message || 'Could not open the PDF');
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [item.id, item.file?.path, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the available width.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  // Render the current page.
  useEffect(() => {
    if (!doc || !width || !canvasRef.current) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    setRendering(true);
    doc
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const cssScale = (width / base.width) * zoom;
        let dpr = window.devicePixelRatio || 1;
        const cssW = base.width * cssScale;
        const cssH = base.height * cssScale;
        if (cssW * cssH * dpr * dpr > MAX_PIXELS) dpr = Math.max(0.5, Math.sqrt(MAX_PIXELS / (cssW * cssH)));
        const viewport = p.getViewport({ scale: cssScale * dpr });
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(cssW)}px`;
        canvas.style.height = `${Math.floor(cssH)}px`;
        task = p.render({ canvas, viewport });
        return task.promise;
      })
      .then(() => {
        if (!cancelled) setRendering(false);
      })
      .catch((e: unknown) => {
        if (cancelled || e instanceof RenderingCancelledException) return;
        setRendering(false);
        setError((e as Error)?.message || 'Could not render the page');
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, width]);

  const go = useCallback(
    (p: number) => {
      if (!numPages) return;
      const next = Math.min(numPages, Math.max(1, p));
      setPageInput(String(next));
      if (next === page) return;
      setPage(next);
      onProgressRef.current(next / numPages);
      const top = viewRef.current?.getBoundingClientRect().top ?? 0;
      if (top < 0) viewRef.current?.scrollIntoView({ block: 'start' });
    },
    [numPages, page],
  );

  // Keys and hardware page buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('.dialog-backdrop, .menu-list')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        go(page + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(page - 1);
      }
    };
    const onHw = (e: Event) => {
      if (document.querySelector('.dialog-backdrop')) return;
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir;
      if (dir === 1 || dir === -1) go(page + dir);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('hwpage', onHw);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hwpage', onHw);
    };
  }, [go, page]);

  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < r.width * 0.3) go(page - 1);
    else if (x > r.width * 0.7) go(page + 1);
  };

  const submitPage = (e: FormEvent) => {
    e.preventDefault();
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) go(n);
    else setPageInput(String(page));
  };

  const zoomIdx = ZOOMS.indexOf(zoom);
  const download = (e: MouseEvent<HTMLAnchorElement>) => {
    if (url && isNative()) {
      e.preventDefault();
      void openExternal(url);
    }
  };

  const toggle = onShowText ? (
    <div className="segmented" role="group" aria-label="View">
      <button type="button" className="btn" aria-pressed={false} onClick={onShowText}>
        Text
      </button>
      <button type="button" className="btn" aria-pressed={true}>
        Original
      </button>
    </div>
  ) : null;

  const nav = (where: 'top' | 'bottom') => (
    <div className="pdf-nav">
      <button type="button" className="btn btn-icon" aria-label="Previous page" disabled={page <= 1 || !numPages} onClick={() => go(page - 1)}>
        <ChevronLeft />
      </button>
      {where === 'top' ? (
        <form className="pdf-page-form" onSubmit={submitPage}>
          <input
            className="input pdf-page-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={numPages || 1}
            value={pageInput}
            aria-label="Page number"
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={submitPage}
          />
          <span className="muted">/ {numPages || '…'}</span>
        </form>
      ) : (
        <span className="pdf-page-label">
          {page} / {numPages || '…'}
        </span>
      )}
      <button type="button" className="btn btn-icon" aria-label="Next page" disabled={page >= numPages || !numPages} onClick={() => go(page + 1)}>
        <ChevronRight />
      </button>
    </div>
  );

  return (
    <div className="pdf-view" ref={viewRef}>
      <div className="pdf-controls">
        {toggle}
        {url ? (
          <a
            className="btn"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            download={item.file?.name}
            onClick={download}
            title="Download / open in another app"
          >
            <Download /> Download
          </a>
        ) : null}
        {nav('top')}
        <div className="pdf-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-icon" aria-label="Zoom out" disabled={zoomIdx <= 0} onClick={() => setZoom(ZOOMS[Math.max(0, zoomIdx - 1)])}>
            −
          </button>
          <button type="button" className="btn pdf-zoom-value" aria-label="Fit width" title="Fit width" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Zoom in"
            disabled={zoomIdx >= ZOOMS.length - 1}
            onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIdx + 1)])}
          >
            +
          </button>
        </div>
      </div>

      {error ? (
        <div className="reader-state">
          <p className="error-text">Could not show the PDF: {error}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
            {onShowText ? (
              <button type="button" className="btn" onClick={onShowText}>
                Show text
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={`pdf-stage${zoom > 1 ? ' pdf-stage-zoomed' : ''}`} ref={stageRef} onClick={onStageClick}>
          {!doc ? <Spinner label="Opening PDF…" /> : null}
          <canvas ref={canvasRef} className="pdf-canvas" hidden={!doc} aria-label={doc ? `Page ${page} of ${numPages}` : undefined} />
          {doc && rendering ? <span className="pdf-rendering small muted">Rendering…</span> : null}
        </div>
      )}
      {doc && !error ? <div className="pdf-bottom">{nav('bottom')}</div> : null}
    </div>
  );
}
