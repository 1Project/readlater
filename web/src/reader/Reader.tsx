/**
 * Reader page (`/item/:id`).
 *
 * export default Reader
 *
 * Loads the item (useItem) and its content (loadContent), sanitises it again client-side, and shows
 * it in scroll or pages mode (ArticleView) with highlights, or the original PDF (PdfView). Saves
 * reading progress (debounced 2 s) and sets lastOpenedAt on open. Sets window.__readerActive while
 * mounted so native volume keys turn pages (window `hwpage` events).
 *
 * Keys: e archive · s favorite · h highlight selection · t text settings · Esc back;
 * pages mode: ←/→/PageUp/PageDown/Space/Shift+Space.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import EditItemDialog from '../components/EditItemDialog';
import { Back } from '../components/Icons';
import { isTypingTarget } from '../components/ItemList';
import { deleteWithConfirm, openOriginal, retryFetch, saveToLibrary, toggleArchive, toggleFavorite, toggleSeen } from '../components/itemActions';
import Spinner from '../components/Spinner';
import { toast } from '../components/Toast';
import { addHighlight, loadContent, markOpened, updateItemLater, useCategories, useHighlights, useItem } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import type { Highlight, Item } from '../lib/types';
import ArticleHeader, { openLinkNatively } from './ArticleHeader';
import ArticleView, { type ArticleHandle } from './ArticleView';
import { getSelectionQuote, type Anchorable, type Quote } from './highlights';
import { ContentsPanel, HighlightDialog, HighlightsPanel, NewNoteDialog, type Chapter } from './panels';
import ReaderToolbar, { type ReaderActions } from './ReaderToolbar';
import { hasChapters, sanitizeContent } from './sanitize';
import SelectionBar, { selectionRangeIn } from './SelectionBar';
import TypographyPanel from './TypographyPanel';
import './reader.css';

const PdfView = lazy(() => import('./PdfView'));

const PDF_VIEW_KEY = 'rl.reader.pdfView';
const SAVE_DELAY = 2000;

type PdfChoice = 'text' | 'original';

function readPdfChoice(): PdfChoice | null {
  try {
    const v = localStorage.getItem(PDF_VIEW_KEY);
    return v === 'text' || v === 'original' ? v : null;
  } catch {
    return null;
  }
}

function writePdfChoice(v: PdfChoice): void {
  try {
    localStorage.setItem(PDF_VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}

function setReaderActive(v: boolean): void {
  (window as unknown as { __readerActive?: boolean }).__readerActive = v;
}

function anyOverlayOpen(): boolean {
  return !!document.querySelector('.dialog-backdrop, .menu-list');
}

function useGoBack(fallback: string) {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) void navigate(-1);
    else void navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}

export default function Reader() {
  const { id } = useParams();
  const item = useItem(id);

  useEffect(() => {
    setReaderActive(true);
    return () => setReaderActive(false);
  }, []);

  if (item === undefined) {
    return (
      <div className="reader reader-scroll">
        <div className="reader-page">
          <Spinner label="Opening…" />
        </div>
      </div>
    );
  }
  if (item === null) return <MissingItem />;
  return <ReaderInner key={item.id} item={item} />;
}

function MissingItem() {
  const goBack = useGoBack('/');
  useEffect(() => {
    document.title = 'Not found · Readlater';
  }, []);
  return (
    <div className="reader reader-scroll">
      <header className="reader-toolbar">
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Back" onClick={goBack}>
          <Back />
        </button>
      </header>
      <div className="reader-page reader-state">
        <p>This item doesn’t exist anymore. It may have been deleted on another device.</p>
        <div className="row">
          <button type="button" className="btn" onClick={goBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

const NOUN: Record<Item['type'], string> = {
  article: 'article',
  tweet: 'post',
  paper: 'paper',
  pdf: 'document',
  epub: 'book',
  video: 'page',
  other: 'document',
};

function byCreated(a: Highlight, b: Highlight): number {
  const ta = a.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
  const tb = b.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
  return ta - tb;
}

function ReaderInner({ item }: { item: Item }) {
  const prefs = usePrefs();
  const categories = useCategories();
  const allHighlights = useHighlights();
  const goBackRaw = useGoBack(item.location === 'feed' ? '/feed' : '/');
  const articleRef = useRef<ArticleHandle>(null);
  const itemRef = useRef(item);
  itemRef.current = item;

  const [chromeVisible, setChromeVisible] = useState(true);
  const [typoOpen, setTypoOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [hlPanelOpen, setHlPanelOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [editHid, setEditHid] = useState<string | null>(null);
  const [pendingQuote, setPendingQuote] = useState<Quote | null>(null);
  const [hlState, setHlState] = useState<{ applied: string[]; missing: string[] }>({ applied: [], missing: [] });
  const [pdfChoice, setPdfChoice] = useState<PdfChoice | null>(readPdfChoice);
  const [reload, setReload] = useState(0);

  // ------------------------------------------------------------------ open / title

  useEffect(() => {
    markOpened(item.id).catch((e: unknown) => console.warn('markOpened failed', e));
  }, [item.id]);

  useEffect(() => {
    document.title = `${item.title || 'Untitled'} · Readlater`;
  }, [item.title]);

  // ------------------------------------------------------------------ progress

  const progressRef = useRef(item.progress);
  const pendingProgress = useRef<number | null>(null);
  const saveTimer = useRef(0);
  const deleted = useRef(false);

  const flushProgress = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const p = pendingProgress.current;
    pendingProgress.current = null;
    if (p == null || deleted.current) return;
    if (Math.abs(p - itemRef.current.progress) < 0.002) return;
    updateItemLater(itemRef.current.id, { progress: Math.round(p * 10000) / 10000 });
  }, []);

  const onProgress = useCallback(
    (p: number) => {
      progressRef.current = p;
      pendingProgress.current = p;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushProgress, SAVE_DELAY);
    },
    [flushProgress],
  );

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flushProgress);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flushProgress);
      flushProgress();
    };
  }, [flushProgress]);

  const goBack = useCallback(() => {
    flushProgress();
    goBackRaw();
  }, [flushProgress, goBackRaw]);

  // ------------------------------------------------------------------ content

  const contentKey = item.contentChunks > 0 ? `${item.id}:${item.contentChunks}:${item.fetchStatus === 'done' ? 'd' : 'x'}:${reload}` : null;
  const [content, setContent] = useState<{ html: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!contentKey) return;
    let cancelled = false;
    loadContent(itemRef.current)
      .then((html) => !cancelled && setContent({ html, error: null }))
      .catch((e: unknown) => !cancelled && setContent((prev) => (prev?.html ? prev : { html: null, error: (e as Error)?.message || 'Could not load the text' })));
    return () => {
      cancelled = true;
    };
  }, [contentKey]);

  const rawHtml = contentKey ? (content?.html ?? null) : null;
  const html = useMemo(() => (rawHtml ? sanitizeContent(rawHtml) : ''), [rawHtml]);
  const textEmpty = useMemo(() => !/\S/.test(html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')) && !/<img\b/i.test(html), [html]);
  const chaptered = useMemo(() => hasChapters(html), [html]);
  const contentLoading = !!contentKey && content === null;
  const hasText = !!contentKey && !!rawHtml && !textEmpty;

  // ------------------------------------------------------------------ PDF original

  const isPdfFile = !!item.file && (item.file.contentType === 'application/pdf' || /\.pdf$/i.test(item.file.name));
  const canOriginal = isPdfFile && item.fetchStatus !== 'uploading';
  const noTextYet = !hasText && !contentLoading;
  const showOriginal = canOriginal && (pdfChoice === 'original' || noTextYet);
  const choosePdf = (v: PdfChoice) => {
    setPdfChoice(v);
    writePdfChoice(v);
  };

  // ------------------------------------------------------------------ highlights

  const itemHighlights = useMemo(() => (allHighlights ?? []).filter((h) => h.itemId === item.id).sort(byCreated), [allHighlights, item.id]);
  const anchorables = useMemo<Anchorable[]>(
    () => itemHighlights.map((h) => ({ id: h.id, text: h.text, prefix: h.prefix, suffix: h.suffix, note: h.note })),
    [itemHighlights],
  );
  const orderedHighlights = useMemo(() => {
    const byId = new Map(itemHighlights.map((h) => [h.id, h]));
    const out: Highlight[] = [];
    for (const id of hlState.applied) {
      const h = byId.get(id);
      if (h) {
        out.push(h);
        byId.delete(id);
      }
    }
    return [...out, ...byId.values()];
  }, [itemHighlights, hlState]);
  const missing = useMemo(() => {
    const placed = new Set(hlState.applied);
    return new Set(itemHighlights.filter((h) => !placed.has(h.id)).map((h) => h.id));
  }, [itemHighlights, hlState]);
  const editingHighlight = editHid ? (itemHighlights.find((h) => h.id === editHid) ?? null) : null;

  const saveHighlight = useCallback(
    (q: Quote, note: string) => {
      addHighlight({ itemId: itemRef.current.id, text: q.text, prefix: q.prefix, suffix: q.suffix, note }).catch((e: unknown) =>
        toast(`Could not save the highlight: ${(e as Error)?.message ?? 'unknown error'}`, { error: true }),
      );
    },
    [],
  );

  const highlightRange = useCallback(
    (range: Range, withNote: boolean) => {
      const root = articleRef.current?.root();
      const q = root ? getSelectionQuote(root, range) : null;
      if (!q) {
        toast('Select some text in the article to highlight it');
        return;
      }
      window.getSelection()?.removeAllRanges();
      const quote = { text: q.text, prefix: q.prefix, suffix: q.suffix };
      if (withNote) setPendingQuote(quote);
      else saveHighlight(quote, '');
    },
    [saveHighlight],
  );

  const jumpTo = (find: () => Element | null | undefined, align: 'start' | 'center') => {
    // Let the closing dialog restore page scrolling first.
    window.setTimeout(() => {
      const el = find();
      if (el) articleRef.current?.goTo(el, align);
    }, 30);
  };

  const openContents = () => {
    const root = articleRef.current?.root();
    const list: Chapter[] = [];
    root?.querySelectorAll('section[data-chapter]').forEach((el, i) => {
      const h = el.querySelector('h1, h2, h3');
      list.push({ el, title: h?.textContent?.trim() || `Chapter ${i + 1}` });
    });
    setChapters(list);
    setContentsOpen(true);
  };

  // ------------------------------------------------------------------ actions

  const actions: ReaderActions = {
    back: goBack,
    archive: () => {
      const it = itemRef.current;
      const leaving = it.status !== 'archived';
      flushProgress();
      toggleArchive(it);
      if (leaving) goBackRaw();
    },
    favorite: () => toggleFavorite(itemRef.current),
    edit: () => setEditOpen(true),
    typography: () => setTypoOpen((o) => !o),
    highlights: () => setHlPanelOpen(true),
    contents: openContents,
    openOriginal: () => openOriginal(itemRef.current),
    copyLink: () => {
      const url = itemRef.current.url;
      if (!url) return;
      if (!navigator.clipboard?.writeText) {
        toast('Copying is not available here', { error: true });
        return;
      }
      navigator.clipboard.writeText(url).then(
        () => toast('Link copied'),
        () => toast('Could not copy the link', { error: true }),
      );
    },
    refetch: () => {
      retryFetch(itemRef.current);
      toast('Fetching again…');
    },
    remove: () => {
      void deleteWithConfirm(itemRef.current).then((ok) => {
        if (ok) {
          deleted.current = true;
          goBackRaw();
        }
      });
    },
    saveToLibrary: () => saveToLibrary(itemRef.current),
    toggleSeen: () => toggleSeen(itemRef.current),
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // ------------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || anyOverlayOpen()) return;
      const a = actionsRef.current;
      switch (e.key) {
        case 'e':
          a.archive();
          break;
        case 's':
          a.favorite();
          break;
        case 't':
          a.typography();
          break;
        case 'h': {
          const range = selectionRangeIn(articleRef.current?.root() ?? null);
          if (range) highlightRange(range, false);
          else toast('Select some text in the article to highlight it');
          break;
        }
        case 'Escape':
          a.back();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [highlightRange]);

  // ------------------------------------------------------------------ layout

  const articleShown = !showOriginal && hasText;
  const paged = articleShown && prefs.readerMode === 'paginate';

  useEffect(() => {
    const cls = 'reader-pages-active';
    document.documentElement.classList.toggle(cls, paged);
    return () => document.documentElement.classList.remove(cls);
  }, [paged]);

  const style = {
    '--reader-font': `var(--font-${prefs.fontFamily})`,
    '--reader-size': `${prefs.fontSize}px`,
    '--reader-lh': String(prefs.lineHeight),
    '--reader-width': `${prefs.width}ch`,
    '--reader-align': prefs.justify ? 'justify' : 'left',
  } as CSSProperties;
  const layoutKey = `${prefs.fontFamily}|${prefs.fontSize}|${prefs.lineHeight}|${prefs.width}|${prefs.justify}|${prefs.theme}`;

  const header = (extra?: ReactNode) => (
    <ArticleHeader item={item} categories={categories} onEdit={() => setEditOpen(true)}>
      {extra}
    </ArticleHeader>
  );

  const pdfToggle = canOriginal ? (
    <div className="segmented reader-view-toggle" role="group" aria-label="View">
      <button type="button" className="btn" aria-pressed={true}>
        Text
      </button>
      <button type="button" className="btn" aria-pressed={false} onClick={() => choosePdf('original')}>
        Original
      </button>
    </div>
  ) : null;

  const originalLink = item.url ? (
    <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer" onClick={openLinkNatively}>
      Open original
    </a>
  ) : null;

  const statusBanner =
    item.fetchStatus === 'pending' || item.fetchStatus === 'processing' ? (
      <p className="reader-banner">
        <Spinner inline label="Fetching a fresh copy…" />
      </p>
    ) : item.fetchStatus === 'error' ? (
      <p className="reader-banner">
        <span className="error-text">{item.fetchError || 'Fetching failed.'}</span>{' '}
        <button type="button" className="btn btn-small" onClick={() => retryFetch(item)}>
          Retry
        </button>
      </p>
    ) : null;

  const feed = item.location === 'feed';
  const archived = item.status === 'archived';
  const footer = (
    <footer className="article-footer">
      <p className="muted small">End of {NOUN[item.type]}</p>
      <div className="row article-footer-actions">
        <button type="button" className="btn" onClick={actions.archive}>
          {feed ? (archived ? 'Mark as new' : 'Mark seen') : archived ? 'Unarchive' : 'Archive'}
        </button>
        {feed ? (
          <button type="button" className="btn" onClick={actions.saveToLibrary}>
            Save to library
          </button>
        ) : null}
      </div>
    </footer>
  );

  let body: ReactNode;
  if (showOriginal) {
    body = (
      <div className="reader-page reader-page-wide">
        <Suspense fallback={<Spinner label="Opening PDF…" />}>
          <PdfView
            item={item}
            initialProgress={progressRef.current}
            onProgress={onProgress}
            onShowText={hasText ? () => choosePdf('text') : undefined}
          />
        </Suspense>
      </div>
    );
  } else if (contentLoading) {
    body = (
      <div className="reader-page">
        <Spinner label="Loading text…" />
      </div>
    );
  } else if (contentKey && content?.error && !rawHtml) {
    body = (
      <div className="reader-page reader-state">
        {header()}
        <p className="error-text">Could not load the text: {content.error}</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setReload((r) => r + 1)}>
            Retry
          </button>
          {originalLink}
        </div>
      </div>
    );
  } else if (hasText) {
    body = (
      <ArticleView
        ref={articleRef}
        html={html}
        header={header(
          <>
            {statusBanner}
            {pdfToggle}
          </>,
        )}
        footer={footer}
        mode={prefs.readerMode}
        layoutKey={layoutKey}
        highlights={anchorables}
        initialProgress={progressRef.current}
        hideImages={!prefs.showImages}
        onProgress={onProgress}
        onToggleChrome={() => setChromeVisible((v) => !v)}
        onPageTurn={() => setChromeVisible(false)}
        onHighlightTap={setEditHid}
        onHighlightsApplied={setHlState}
      />
    );
  } else if (item.fetchStatus === 'uploading' || item.fetchStatus === 'pending' || item.fetchStatus === 'processing') {
    body = (
      <div className="reader-page reader-state">
        {header()}
        <p>
          <Spinner inline label={item.fetchStatus === 'uploading' ? 'Uploading the file…' : `Fetching the ${item.type === 'tweet' ? 'post' : 'article'}…`} />
        </p>
        <p className="muted small">This usually takes a few seconds. The page updates by itself.</p>
        <div className="row">{originalLink}</div>
      </div>
    );
  } else if (item.fetchStatus === 'error') {
    body = (
      <div className="reader-page reader-state">
        {header()}
        <p className="error-text">{item.fetchError || 'Could not fetch this item.'}</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => retryFetch(item)}>
            Retry
          </button>
          {originalLink}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="reader-page reader-state">
        {header()}
        <p>No readable text was found for this {NOUN[item.type]}.</p>
        <div className="row">
          {originalLink}
          {item.url || item.file ? (
            <button type="button" className="btn" onClick={() => retryFetch(item)}>
              Fetch again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`reader ${paged ? 'reader-pages' : 'reader-scroll'}`} style={style}>
      <ReaderToolbar
        item={item}
        overlay={paged}
        hidden={paged && !chromeVisible}
        highlightCount={itemHighlights.length}
        hasContents={articleShown && chaptered}
        typographyOpen={typoOpen}
        actions={actions}
      />
      {paged && !chromeVisible ? (
        <div className="running-head" aria-hidden="true">
          <span className="truncate">{item.title}</span>
        </div>
      ) : null}
      <main className="reader-main">{body}</main>

      {articleShown ? <SelectionBar getRoot={() => articleRef.current?.root() ?? null} onHighlight={highlightRange} /> : null}
      <TypographyPanel open={typoOpen} onClose={() => setTypoOpen(false)} />
      <EditItemDialog item={item} open={editOpen} onClose={() => setEditOpen(false)} />
      <HighlightsPanel
        open={hlPanelOpen}
        onClose={() => setHlPanelOpen(false)}
        highlights={orderedHighlights}
        missing={missing}
        onJump={(hid) => {
          setHlPanelOpen(false);
          jumpTo(() => articleRef.current?.root()?.querySelector(`mark[data-hid="${CSS.escape(hid)}"]`), 'center');
        }}
        onEdit={(hid) => {
          setHlPanelOpen(false);
          setEditHid(hid);
        }}
      />
      <ContentsPanel
        open={contentsOpen}
        onClose={() => setContentsOpen(false)}
        chapters={chapters}
        onJump={(i) => {
          setContentsOpen(false);
          const el = chapters[i]?.el;
          jumpTo(() => (el && el.isConnected ? el : null), 'start');
        }}
      />
      <HighlightDialog highlight={editingHighlight} onClose={() => setEditHid(null)} />
      <NewNoteDialog
        quote={pendingQuote?.text ?? null}
        onClose={() => setPendingQuote(null)}
        onSave={(note) => {
          if (pendingQuote) saveHighlight(pendingQuote, note);
          setPendingQuote(null);
        }}
      />
    </div>
  );
}
