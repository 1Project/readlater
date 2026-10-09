/**
 * App shell: providers, auth gate, routes, top bar and global shortcuts.
 *
 * Global keys (ignored while typing, with modifiers, while a dialog/menu is open, and in the reader):
 *   /  search      a  add      g l / g f / g s / g h / g p   go to Library / Feed / Search / Highlights / Settings (preferences)
 * Pasting a link anywhere outside a text field, or dropping a PDF/EPUB/link onto the page, opens the add dialog.
 *
 * Other modules can open the add dialog with `window.dispatchEvent(new CustomEvent('readlater:add'))`
 * (optional `detail: { url?: string }`).
 */
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Link as RouterLink, Routes, useLocation, useNavigate } from 'react-router';
import { getRedirectResult } from 'firebase/auth';
import AddDialog from './components/AddDialog';
import { Highlight, Inbox, Plus, Rss, Search as SearchIcon, Settings as SettingsIcon } from './components/Icons';
import { isTypingTarget } from './components/ItemList';
import Spinner from './components/Spinner';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/useConfirm';
import { getServices } from './lib/firebase';
import { extractUrl, prefetchContent, useItems, useUser } from './lib/data';
import { initNative, isNative } from './native';
import Add from './pages/Add';
import AppLogin from './pages/AppLogin';
import Feed from './pages/Feed';
import Library from './pages/Library';
import Link from './pages/Link';
import Login from './pages/Login';
import './pages/pages.css';

const Reader = lazy(() => import('./reader/Reader'));
const Settings = lazy(() => import('./pages/Settings'));
const Feeds = lazy(() => import('./pages/Feeds'));
const Highlights = lazy(() => import('./pages/Highlights'));
const Search = lazy(() => import('./pages/Search'));

const ADD_EVENT = 'readlater:add';

const PUBLIC_ROUTES = ['/login', '/link', '/app-login'];

const NAV = [
  { to: '/', label: 'Library', icon: Inbox, end: true },
  { to: '/feed', label: 'Feed', icon: Rss, end: false },
  { to: '/search', label: 'Search', icon: SearchIcon, end: false },
  { to: '/highlights', label: 'Highlights', icon: Highlight, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Library'],
  [/^\/feed$/, 'Feed'],
  [/^\/feeds$/, 'Feeds'],
  [/^\/search$/, 'Search'],
  [/^\/highlights$/, 'Highlights'],
  [/^\/settings$/, 'Settings'],
  [/^\/login$/, 'Sign in'],
  [/^\/link$/, 'Link device'],
  [/^\/app-login$/, 'Sign in'],
  [/^\/add$/, 'Save'],
];

function isReaderPath(pathname: string): boolean {
  return pathname.startsWith('/item/');
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell() {
  const user = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Native integration (share intents, deep links, volume keys) and the Google redirect result — once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    try {
      initNative((path: string) => void navigateRef.current(path));
    } catch (e) {
      console.error('initNative failed', e);
    }
    // The apps sign in through the system browser (nativeGoogleSignIn), never by redirect.
    if (!isNative()) getRedirectResult(getServices().auth).catch((e: unknown) => console.warn('Google redirect sign-in failed', e));
  }, []);

  const reader = isReaderPath(location.pathname);
  useEffect(() => {
    if (reader) return; // the reader sets its own title
    const name = TITLES.find(([re]) => re.test(location.pathname))?.[1];
    document.title = name ? `${name} · Readlater` : 'Readlater';
  }, [location.pathname, reader]);

  if (user === undefined) {
    return <p className="app-loading">Loading…</p>;
  }

  const isPublic = PUBLIC_ROUTES.includes(location.pathname);
  if (user === null && !isPublic) {
    const next = location.pathname + location.search;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }

  const signedIn = user !== null;
  const showBar = signedIn && !reader && location.pathname !== '/app-login';

  return (
    <>
      {signedIn ? <SignedInExtras showBar={showBar} reader={reader} /> : null}
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/feed" element={<Feed />} />
            <Route path="/feeds" element={<Feeds />} />
            <Route path="/search" element={<Search />} />
            <Route path="/highlights" element={<Highlights />} />
            <Route path="/item/:id" element={<Reader />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/login" element={<Login />} />
            <Route path="/link" element={<Link />} />
            <Route path="/app-login" element={<AppLogin />} />
            <Route path="/add" element={<Add />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

/** Top bar, add dialog, global shortcuts and offline prefetch — only for signed-in users. */
function SignedInExtras({ showBar, reader }: { showBar: boolean; reader: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [add, setAdd] = useState<{ open: boolean; url?: string; file?: File | null }>({ open: false });
  const openAdd = useCallback((url?: string, file?: File | null) => setAdd({ open: true, url, file }), []);

  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ url?: string } | undefined>).detail;
      openAdd(detail?.url);
    };
    window.addEventListener(ADD_EVENT, onAdd);
    return () => window.removeEventListener(ADD_EVENT, onAdd);
  }, [openAdd]);

  // Keyboard shortcuts, paste-to-add and drop-to-add (not in the reader, which has its own).
  const state = useRef({ addOpen: add.open, pathname: location.pathname });
  state.current = { addOpen: add.open, pathname: location.pathname };
  useEffect(() => {
    if (reader) return;
    const blocked = () => state.current.addOpen || !!document.querySelector('.dialog-backdrop, .menu-list');
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || blocked()) return;
      if (gAt && Date.now() - gAt < 1500) {
        gAt = 0;
        const dest = ({ l: '/', f: '/feed', s: '/search', h: '/highlights', p: '/settings' } as Record<string, string>)[e.key];
        if (dest) {
          e.preventDefault();
          void navigate(dest);
        }
        return;
      }
      gAt = 0;
      if (e.key === '/') {
        e.preventDefault();
        if (state.current.pathname === '/search') document.getElementById('search-input')?.focus();
        else void navigate('/search');
      } else if (e.key === 'a') {
        e.preventDefault();
        openAdd();
      } else if (e.key === 'g') {
        gAt = Date.now();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || blocked()) return;
      const url = extractUrl(e.clipboardData?.getData('text/plain'));
      if (!url) return;
      e.preventDefault();
      openAdd(url);
    };
    const accepts = (e: DragEvent) => {
      const types = [...(e.dataTransfer?.types ?? [])];
      return types.includes('Files') || types.includes('text/uri-list');
    };
    const onOver = (e: DragEvent) => {
      if (blocked() || !accepts(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (blocked() || !accepts(e) || !e.dataTransfer) return;
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) {
        openAdd(undefined, file);
        return;
      }
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      openAdd(extractUrl(text.split(/\r?\n/).find((l) => l && !l.startsWith('#')) ?? '') ?? undefined);
    };
    // Capture phase: runs before list shortcuts (e.g. the 's' of 'g s' must not toggle a favorite).
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [reader, navigate, openAdd]);

  return (
    <>
      {showBar ? <TopBar onAdd={() => openAdd()} /> : null}
      <AddDialog open={add.open} initialUrl={add.url} initialFile={add.file ?? null} onClose={() => setAdd({ open: false })} />
      <Prefetcher />
    </>
  );
}

function TopBar({ onAdd }: { onAdd: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <NavLink to="/" className="topbar-brand" end>
          Readlater
        </NavLink>
        <nav className="topbar-nav" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `topbar-link${isActive ? ' active' : ''}`}>
              <Icon className="topbar-icon" />
              <span className="topbar-label">{label}</span>
            </NavLink>
          ))}
          <button type="button" className="topbar-link topbar-add-compact" onClick={onAdd} aria-label="Add">
            <Plus className="topbar-icon" />
            <span className="topbar-label">Add</span>
          </button>
        </nav>
        <button type="button" className="btn btn-primary topbar-add" onClick={onAdd}>
          + Add
        </button>
      </div>
    </header>
  );
}

let prefetchState: 'idle' | 'done' = 'idle';
const PREFETCH_KEY = 'rl.prefetched';

/** Warms the offline cache with unread content once per session, once the item list has settled. */
function Prefetcher() {
  const items = useItems();
  const user = useUser();
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    if (!items || !user || prefetchState === 'done') return;
    try {
      if (sessionStorage.getItem(PREFETCH_KEY) === user.uid) {
        prefetchState = 'done';
        return;
      }
    } catch {
      /* storage unavailable */
    }
    // Restarted on every change of the list, so it runs once the initial sync has settled.
    const t = window.setTimeout(() => {
      if (prefetchState === 'done' || !latest.current) return;
      prefetchState = 'done';
      try {
        sessionStorage.setItem(PREFETCH_KEY, user.uid);
      } catch {
        /* ignore */
      }
      void prefetchContent(latest.current);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [items, user]);
  return null;
}

function NotFound() {
  return (
    <main className="page">
      <div className="empty">
        <p className="empty-title">Page not found</p>
        <p>
          <RouterLink className="btn" to="/">
            Go to Library
          </RouterLink>
        </p>
      </div>
    </main>
  );
}

class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
    return (
      <main className="page">
        <div className="empty">
          <p className="empty-title">{chunk ? 'This page is not available offline yet.' : 'Something went wrong.'}</p>
          <p className="small">{chunk ? 'Connect to the internet and try again.' : error.message}</p>
          <div className="row page-center-row">
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
            <a className="btn" href="/">
              Library
            </a>
          </div>
        </div>
      </main>
    );
  }
}
