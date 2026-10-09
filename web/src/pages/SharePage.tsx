/**
 * Public share page (`/s/:token`, no sign-in): a read-only copy of a document from top-level
 * `shares/{token}` { title, author, siteName, url, html, highlights: [{ text, note }], createdAt }
 * (public `get` in the Firestore rules), rendered with the reader's sanitiser and typography in scroll
 * mode: title, byline, link to the original, the text with the shared highlights marked, the list of
 * highlights with notes, and "Saved with Readlater". Shows a not-found state for unknown or revoked links.
 *
 * export default SharePage
 *
 * Reads Firestore directly through getServices().db (the one exception to "all data access via
 * lib/data.ts": the page is public and has nothing to do with the signed-in user's data).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { useParams } from 'react-router';
import { External } from '../components/Icons';
import Spinner from '../components/Spinner';
import { getServices } from '../lib/firebase';
import { formatDate, hostname } from '../lib/format';
import { fontStack, usePrefs } from '../lib/prefs';
import { openLinkNatively } from '../reader/ArticleHeader';
import ArticleView from '../reader/ArticleView';
import type { Anchorable } from '../reader/highlights';
import { sanitizeContent } from '../reader/sanitize';
import '../reader/reader.css';
import './SharePage.css';

export interface SharedDoc {
  title: string;
  author: string | null;
  siteName: string | null;
  url: string | null;
  html: string;
  highlights: { text: string; note: string }[];
  createdAt: Date | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The shared snapshot, or null when the link does not exist (any more). */
async function fetchShare(token: string): Promise<SharedDoc | null> {
  if (!TOKEN_RE.test(token)) return null;
  let snap;
  try {
    snap = await getDoc(doc(getServices().db, 'shares', token));
  } catch (e) {
    if ((e as { code?: string })?.code === 'permission-denied') return null;
    throw e;
  }
  if (!snap.exists()) return null;
  const x = snap.data() as Record<string, unknown>;
  const url = str(x.url);
  const created = x.createdAt as { toDate?: () => Date } | null | undefined;
  return {
    title: str(x.title) ?? (url ? hostname(url) : 'Untitled'),
    author: str(x.author),
    siteName: str(x.siteName),
    url: url && /^https?:\/\//i.test(url) ? url : null,
    html: typeof x.html === 'string' ? x.html : '',
    highlights: Array.isArray(x.highlights)
      ? (x.highlights as unknown[])
          .map((h) => {
            const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
            return { text: typeof o.text === 'string' ? o.text.trim() : '', note: typeof o.note === 'string' ? o.note.trim() : '' };
          })
          .filter((h) => h.text)
      : [],
    createdAt: typeof created?.toDate === 'function' ? created.toDate() : null,
  };
}

type State = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ok'; share: SharedDoc };

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

const noop = () => {};

export default function SharePage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useNoIndex();

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchShare(token)
      .then((share) => !cancelled && setState(share ? { status: 'ok', share } : { status: 'missing' }))
      .catch((e: unknown) => !cancelled && setState({ status: 'error', message: (e as Error)?.message || 'Could not load this page' }));
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  useEffect(() => {
    document.title = state.status === 'ok' ? `${state.share.title} · Readlater` : state.status === 'missing' ? 'Not found · Readlater' : 'Readlater';
  }, [state]);

  if (state.status === 'ok') return <SharedView share={state.share} />;

  return (
    <div className="share-page reader reader-scroll">
      <div className="reader-page reader-state share-state">
        {state.status === 'loading' ? (
          <Spinner label="Opening…" />
        ) : state.status === 'missing' ? (
          <>
            <h1>Link not found</h1>
            <p>This shared link doesn’t exist or was turned off by its owner.</p>
          </>
        ) : (
          <>
            <h1>Could not open this page</h1>
            <p className="error-text">{state.message}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </div>
          </>
        )}
        <p className="share-credit small muted">Readlater</p>
      </div>
    </div>
  );
}

function SharedView({ share }: { share: SharedDoc }) {
  const prefs = usePrefs();
  const html = useMemo(() => sanitizeContent(share.html), [share.html]);
  const anchorables = useMemo<Anchorable[]>(
    () => share.highlights.map((h, i) => ({ id: `s${i}`, text: h.text, prefix: '', suffix: '', note: h.note })),
    [share.highlights],
  );

  const style = {
    '--reader-font': fontStack(prefs.fontFamily),
    '--reader-size': `${prefs.fontSize}px`,
    '--reader-lh': String(prefs.lineHeight),
    '--reader-width': `${prefs.width}ch`,
    '--reader-align': prefs.justify ? 'justify' : 'left',
  } as CSSProperties;
  const layoutKey = `${prefs.fontFamily}|${prefs.fontSize}|${prefs.lineHeight}|${prefs.width}|${prefs.justify}|${prefs.theme}`;

  const site = share.siteName || hostname(share.url);
  const byline = [share.author, site].filter(Boolean).join(' · ');
  const shared = share.createdAt ? formatDate(share.createdAt) : '';

  const header = (
    <header className="article-header">
      <h1 className="article-title">{share.title}</h1>
      {byline ? <p className="article-byline">{byline}</p> : null}
      {share.url ? (
        <div className="article-links">
          <a className="article-link" href={share.url} target="_blank" rel="noopener noreferrer" onClick={openLinkNatively}>
            Read the original{site ? ` on ${site}` : ''} <External size={14} />
          </a>
        </div>
      ) : null}
    </header>
  );

  const footer = (
    <footer className="article-footer share-footer">
      {share.highlights.length ? (
        <section className="share-highlights" aria-labelledby="share-hl-title">
          <h2 id="share-hl-title" className="share-hl-title">
            Highlights ({share.highlights.length})
          </h2>
          <ol className="share-hl-list">
            {share.highlights.map((h, i) => (
              <li key={i} id={`share-hl-s${i}`} className="share-hl" tabIndex={-1}>
                <blockquote className="share-hl-quote">{h.text}</blockquote>
                {h.note ? <p className="share-hl-note">{h.note}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <p className="share-credit small muted">
        Saved with <a href="/">Readlater</a>
        {shared ? ` · shared ${shared}` : ''}
      </p>
    </footer>
  );

  if (!html.trim()) {
    return (
      <div className="share-page reader reader-scroll" style={style}>
        <div className="reader-page reader-state">
          {header}
          <p className="muted">The shared copy has no text.</p>
          {footer}
        </div>
      </div>
    );
  }

  return (
    <div className="share-page reader reader-scroll" style={style}>
      <main className="reader-main">
        <ArticleView
          html={html}
          header={header}
          footer={footer}
          mode="scroll"
          layoutKey={layoutKey}
          highlights={anchorables}
          initialProgress={0}
          hideImages={!prefs.showImages}
          onProgress={noop}
          onToggleChrome={noop}
          onHighlightTap={(id) => {
            const el = document.getElementById(`share-hl-${id}`);
            el?.scrollIntoView({ block: 'center' });
            el?.focus({ preventScroll: true });
          }}
        />
      </main>
    </div>
  );
}
