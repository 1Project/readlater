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
 * SPEC-2: Listen (text-to-speech player, ListenBar), AI summary / questions (AiPanel, when
 * useConfig().ai), public share link (ShareDialog), EPUB download, highlight colours, "Copy as
 * Markdown" in the highlights panel, and an end-of-document footer with Archive and "Next unread →".
 * With the autoArchive preference, a library item is archived once per open when the reader reaches
 * its end (scroll mode: within 200 px of the bottom; pages mode / PDF: the last page), with Undo.
 *
 * `?hl=<highlightId>` (links from Highlights and Daily review) opens the document at that highlight.
 * Scroll mode shows the reading progress in the toolbar ("35% · 34 min left" and a thin static line).
 * A newer position saved on another device that arrives before the reader moved is adopted.
 *
 * Keys: e archive · s favorite · h highlight selection · t text settings · Esc back;
 * pages mode: ←/→/PageUp/PageDown/Space/Shift+Space, Home/End.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import EditItemDialog from '../components/EditItemDialog';
import { Back } from '../components/Icons';
import { isTypingTarget } from '../components/ItemList';
import { deleteWithConfirm, isStalled, openOriginal, retryFetch, saveToLibrary, toggleArchive, toggleFavorite, toggleSeen } from '../components/itemActions';
import Spinner from '../components/Spinner';
import { dismissToast, toast } from '../components/Toast';
import { useConfig } from '../lib/config';
import { addHighlight, exportEpub, loadContent, markOpened, updateItem, updateItemLater, useCategories, useHighlights, useItem, useItems } from '../lib/data';
import { fontStack, usePrefs } from '../lib/prefs';
import type { Highlight, HighlightColor, Item } from '../lib/types';
import { isNative, openExternal } from '../native';
import AiPanel, { type AiTab } from './AiPanel';
import ArticleHeader, { openLinkNatively } from './ArticleHeader';
import ArticleView, { type ArticleHandle } from './ArticleView';
import { copyText } from './clipboard';
import { readLastColor, writeLastColor } from './HighlightColors';
import { getSelectionQuote, type Anchorable, type Quote } from './highlights';
import ListenBar, { ttsAvailable, type ListenHandle } from './ListenBar';
import { documentMarkdown } from './markdown';
import { nextUnread } from './nextUnread';
import { ContentsPanel, HighlightDialog, HighlightsPanel, NewNoteDialog, type Chapter } from './panels';
import ReaderToolbar, { type ReaderActions } from './ReaderToolbar';
import { hasChapters, sanitizeContent } from './sanitize';
import SelectionBar, { selectionRangeIn } from './SelectionBar';
import ShareDialog from './ShareDialog';
import TypographyPanel from './TypographyPanel';
import './reader.css';

const PdfView = lazy(() => import('./PdfView'));

const PDF_VIEW_KEY = 'rl.reader.pdfView';
const SAVE_DELAY = 2000;
/** Scroll mode: the end is reached within this distance of the bottom. */
const END_SLACK = 200;

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

/** Toolbar buttons are 48 px in the e-ink theme; below this width Listen moves into the More menu. */
const NARROW_QUERY = '(max-width: 399px)';

function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(NARROW_QUERY);
      mq?.addEventListener?.('change', cb);
      return () => mq?.removeEventListener?.('change', cb);
    },
    () => !!window.matchMedia?.(NARROW_QUERY).matches,
  );
}

function errorMessage(e: unknown): string {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^Firebase:\s*/, '') : 'unknown error';
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

/** Reading progress for the toolbar, outside React state so scrolling does not re-render the whole reader. */
export interface ProgressStore {
  get(): number;
  set(p: number): void;
  subscribe(cb: () => void): () => void;
}

function createProgressStore(initial: number): ProgressStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (p) => {
      if (p === value) return;
      value = p;
      listeners.forEach((l) => l());
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function byCreated(a: Highlight, b: Highlight): number {
  const ta = a.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
  const tb = b.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
  return ta - tb;
}

function ReaderInner({ item }: { item: Item }) {
  const prefs = usePrefs();
  const config = useConfig();
  const categories = useCategories();
  const allHighlights = useHighlights();
  const allItems = useItems();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const goBackRaw = useGoBack(item.location === 'feed' ? '/feed' : '/');
  const articleRef = useRef<ArticleHandle>(null);
  const listenRef = useRef<ListenHandle>(null);
  const itemRef = useRef(item);
  itemRef.current = item;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

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
  const [listening, setListening] = useState(false);
  const [aiTab, setAiTab] = useState<AiTab | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [hlColor, setHlColor] = useState<HighlightColor>(readLastColor);

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
  /** The reader scrolled / turned a page since it opened (saved positions from elsewhere no longer apply). */
  const userMoved = useRef(false);
  const [progressStore] = useState(() => createProgressStore(item.progress));

  // Snapshots can bring a newer position (another device) after the cached one we opened with: until the
  // user moves, follow it — before the text is shown it becomes the initial position, afterwards a jump.
  useEffect(() => {
    if (userMoved.current || pendingProgress.current !== null) return;
    if (Math.abs(item.progress - progressRef.current) < 0.002) return;
    progressRef.current = item.progress;
    progressStore.set(item.progress);
    articleRef.current?.adoptProgress(item.progress);
  }, [item.progress, progressStore]);

  const flushProgress = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const p = pendingProgress.current;
    pendingProgress.current = null;
    if (p == null || deleted.current) return;
    if (Math.abs(p - itemRef.current.progress) < 0.002) return;
    updateItemLater(itemRef.current.id, { progress: Math.round(p * 10000) / 10000 });
  }, []);

  // Auto-archive at the end (once per open; only user-driven progress — scrolling, page turns, Listen).
  const autoArchived = useRef(false);
  const scrollEndMode = useRef(false);
  const maybeAutoArchive = useCallback((p: number) => {
    const it = itemRef.current;
    if (autoArchived.current || deleted.current || prefsRef.current.autoArchive !== true) return;
    if (it.location !== 'library' || it.status !== 'unread') return;
    const atEnd = scrollEndMode.current
      ? document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= END_SLACK
      : p >= 0.999;
    if (!atEnd) return;
    autoArchived.current = true;
    updateItem(it.id, { status: 'archived' }).catch((e: unknown) => toast(`Could not archive: ${errorMessage(e)}`, { error: true }));
    toast('Archived — you reached the end', {
      duration: 6000,
      action: {
        label: 'Undo',
        onClick: () => {
          updateItem(it.id, { status: 'unread' }).catch((e: unknown) => toast(`Could not undo: ${errorMessage(e)}`, { error: true }));
        },
      },
    });
  }, []);

  const onProgress = useCallback(
    (p: number) => {
      userMoved.current = true;
      progressRef.current = p;
      progressStore.set(p);
      pendingProgress.current = p;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushProgress, SAVE_DELAY);
      maybeAutoArchive(p);
    },
    [flushProgress, maybeAutoArchive, progressStore],
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
    () => itemHighlights.map((h) => ({ id: h.id, text: h.text, prefix: h.prefix, suffix: h.suffix, note: h.note, color: h.color ?? 'yellow' })),
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

  const hlColorRef = useRef(hlColor);
  hlColorRef.current = hlColor;
  const chooseColor = useCallback((c: HighlightColor) => {
    setHlColor(c);
    writeLastColor(c);
  }, []);

  const saveHighlight = useCallback((q: Quote, note: string, color: HighlightColor = hlColorRef.current) => {
    addHighlight({ itemId: itemRef.current.id, text: q.text, prefix: q.prefix, suffix: q.suffix, note, color }).catch((e: unknown) =>
      toast(`Could not save the highlight: ${(e as Error)?.message ?? 'unknown error'}`, { error: true }),
    );
  }, []);

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

  // `?hl=<id>`: open at that highlight once it is placed in the text.
  const [params] = useSearchParams();
  const hlTarget = params.get('hl');
  const hlJumped = useRef(false);
  useEffect(() => {
    if (!hlTarget || hlJumped.current || !hlState.applied.includes(hlTarget)) return;
    hlJumped.current = true;
    jumpTo(() => articleRef.current?.root()?.querySelector(`mark[data-hid="${CSS.escape(hlTarget)}"]`), 'center');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlState, hlTarget]);

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
      copyText(url).then(
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
    listen: () => listenRef.current?.toggle(),
    summarize: () => setAiTab('summary'),
    ask: () => setAiTab('ask'),
    share: () => setShareOpen(true),
    downloadEpub: () => {
      toast('Preparing the EPUB…', { duration: 120_000 });
      exportEpub([itemRef.current.id])
        .then(({ url, name }) => {
          dismissToast();
          if (isNative()) {
            void openExternal(url);
            return;
          }
          // The file is served as an attachment, so following the link downloads it and the page stays.
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast(`Downloading ${name}`);
        })
        .catch((e: unknown) => toast(`Could not create the EPUB: ${errorMessage(e)}`, { error: true }));
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const copyMarkdown = () => {
    const it = itemRef.current;
    const md = documentMarkdown(
      {
        title: it.title,
        url: it.url,
        author: it.author,
        siteName: it.siteName,
        tags: it.tags,
        savedAt: it.createdAt?.toDate?.() ?? null,
        publishedAt: it.publishedAt?.toDate?.() ?? null,
      },
      orderedHighlights,
    );
    copyText(md).then(
      () => toast('Highlights copied as Markdown'),
      () => toast('Could not copy', { error: true }),
    );
  };

  const next = useMemo(() => (allItems ? nextUnread(allItems, item) : null), [allItems, item]);
  const goNext = () => {
    if (!next) return;
    flushProgress();
    void navigate(`/item/${encodeURIComponent(next.id)}`, { replace: true });
  };

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
  scrollEndMode.current = articleShown && !paged;
  const canListen = articleShown && ttsAvailable();

  useEffect(() => {
    const cls = 'reader-pages-active';
    document.documentElement.classList.toggle(cls, paged);
    return () => document.documentElement.classList.remove(cls);
  }, [paged]);

  const style = {
    '--reader-font': fontStack(prefs.fontFamily),
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
    isStalled(item) ? (
      <p className="reader-banner">
        <span>Fetching a fresh copy is taking unusually long.</span>{' '}
        <button type="button" className="btn btn-small" onClick={() => retryFetch(item)}>
          Retry
        </button>
      </p>
    ) : item.fetchStatus === 'pending' || item.fetchStatus === 'processing' ? (
      <p className="reader-banner">
        <Spinner inline label="Fetching a fresh copy…" />
      </p>
    ) : item.fetchStatus === 'error' && item.retryAt ? (
      <p className="reader-banner muted">A fresh copy is fetched automatically soon.</p>
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
        {next ? (
          <button type="button" className="btn article-next" onClick={goNext} title={next.title}>
            Next unread →
          </button>
        ) : null}
      </div>
      {next ? <p className="small muted truncate article-next-title">{next.title || 'Untitled'}</p> : null}
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
  } else if ((item.fetchStatus === 'uploading' || item.fetchStatus === 'pending' || item.fetchStatus === 'processing') && !isStalled(item)) {
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
  } else if (item.fetchStatus === 'error' || isStalled(item)) {
    body = (
      <div className="reader-page reader-state">
        {header()}
        <p className={item.retryAt ? 'muted' : 'error-text'}>
          {isStalled(item) ? 'Fetching this item is taking unusually long.' : item.fetchError || 'Could not fetch this item.'}
        </p>
        <div className="row">
          {item.retryAt ? null : (
            <button type="button" className="btn btn-primary" onClick={() => retryFetch(item)}>
              Retry
            </button>
          )}
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
        canListen={canListen}
        listening={listening}
        listenInMenu={narrow && prefs.theme === 'eink'}
        ai={config.ai}
        actions={actions}
        progress={articleShown && !paged ? progressStore : null}
      />
      {paged && !chromeVisible ? (
        <div className="running-head" aria-hidden="true">
          <span className="truncate">{item.title}</span>
        </div>
      ) : null}
      <main className="reader-main">{body}</main>

      {articleShown ? (
        <SelectionBar getRoot={() => articleRef.current?.root() ?? null} onHighlight={highlightRange} color={hlColor} onColor={chooseColor} />
      ) : null}
      {articleShown ? (
        <ListenBar
          ref={listenRef}
          getRoot={() => articleRef.current?.root() ?? null}
          contentKey={html}
          paged={paged}
          goTo={(el, align) => articleRef.current?.goTo(el, align)}
          onOpenChange={setListening}
        />
      ) : null}
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
        onCopyMarkdown={copyMarkdown}
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
        color={hlColor}
        onClose={() => setPendingQuote(null)}
        onSave={(note, color) => {
          if (color !== hlColor) chooseColor(color);
          if (pendingQuote) saveHighlight(pendingQuote, note, color);
          setPendingQuote(null);
        }}
      />
      {config.ai ? <AiPanel item={item} tab={aiTab} onTab={setAiTab} onClose={() => setAiTab(null)} /> : null}
      <ShareDialog item={item} open={shareOpen} highlightCount={itemHighlights.length} onClose={() => setShareOpen(false)} />
    </div>
  );
}
