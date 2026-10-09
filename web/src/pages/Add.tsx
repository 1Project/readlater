/**
 * Share-target / bookmarklet landing: `/add?url=&title=&text=&source=`.
 *
 * A link shared through the app's own share handler (native.ts, takeTrustedShare) is saved at once. Any other
 * arrival (the PWA share target, the "Open in Readlater" bookmarklet, a link on some page) asks first, so a
 * web page cannot add things to the library by sending a signed-in visitor here. After saving it confirms
 * "Saved" with Read now, Add tags and Done (in the Android app, Done returns to the app the link came from).
 * `source=bookmarklet` is recorded on new items; anything else records the default (web / app). Without a
 * usable link it shows the add form pre-filled with the shared text.
 * (Signed-out visitors are sent to /login?next=/add… by the App auth gate, so this always runs signed in.)
 */
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import AddDialog from '../components/AddDialog';
import EditItemDialog from '../components/EditItemDialog';
import { addUrl, extractUrl, useItem } from '../lib/data';
import { finishShare, takeTrustedShare } from '../native';
import './pages.css';

type Phase = 'confirm' | 'saving' | 'saved' | 'error';

export default function Add() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const rawUrl = params.get('url') ?? '';
  const text = params.get('text') ?? '';
  const title = params.get('title') ?? '';
  const source = params.get('source') === 'bookmarklet' ? 'bookmarklet' : undefined;
  const target = extractUrl(rawUrl) ?? extractUrl(text) ?? extractUrl(title);
  // A shared title is used as a placeholder until the server extracts the real one.
  const sharedTitle = title.trim() && !extractUrl(title.trim()) ? title.trim().slice(0, 300) : undefined;

  const [trusted] = useState(() => !!target && takeTrustedShare(target));
  const [phase, setPhase] = useState<Phase>(trusted ? 'saving' : 'confirm');
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(!target);
  const [tagsOpen, setTagsOpen] = useState(false);
  const started = useRef<string | null>(null);
  const saved = useItem(savedId ?? undefined);

  function save() {
    if (!target || started.current === target) return;
    started.current = target;
    setPhase('saving');
    addUrl(target, { title: sharedTitle, source })
      .then((id) => {
        setSavedId(id);
        setPhase('saved');
      })
      .catch((e: unknown) => {
        setError((e as Error)?.message || 'Could not save the link.');
        setPhase('error');
        setFormOpen(true);
      });
  }

  useEffect(() => {
    if (trusted) save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = () => finishShare((path) => void navigate(path, { replace: true }));
  const prefill = target ?? [title, text, rawUrl].map((s) => s.trim()).filter(Boolean).join(' ');
  const shownTitle = (saved?.title || sharedTitle || '').trim();

  let body;
  if (!target || phase === 'error') {
    body = (
      <>
        <p className="auth-status">{error ? `Could not save: ${error}` : 'No link found in what was shared.'}</p>
        {!error && prefill ? <blockquote className="add-shared">{prefill}</blockquote> : null}
        <button type="button" className="btn btn-primary auth-wide" onClick={() => setFormOpen(true)}>
          Add a link or file
        </button>
        <RouterLink className="btn auth-wide" to="/" replace>
          Back to library
        </RouterLink>
      </>
    );
  } else if (phase === 'confirm') {
    body = (
      <>
        <h1 className="add-heading">Save to Readlater?</h1>
        {sharedTitle ? <p className="add-title">{sharedTitle}</p> : null}
        <p className="add-target small">{target}</p>
        <button type="button" className="btn btn-primary auth-wide" onClick={save}>
          Save
        </button>
        <RouterLink className="btn auth-wide" to="/" replace>
          Cancel
        </RouterLink>
      </>
    );
  } else if (phase === 'saving') {
    body = (
      <p className="auth-status" aria-live="polite">
        Saving <span className="add-target">{target}</span>…
      </p>
    );
  } else {
    body = (
      <>
        <h1 className="add-heading" aria-live="polite">
          Saved ✓
        </h1>
        {shownTitle ? <p className="add-title">{shownTitle}</p> : null}
        <p className="add-target small">{target}</p>
        <button type="button" className="btn btn-primary auth-wide" onClick={() => savedId && void navigate(`/item/${encodeURIComponent(savedId)}`, { replace: true })}>
          Read now
        </button>
        <button type="button" className="btn auth-wide" onClick={() => setTagsOpen(true)} disabled={!saved}>
          Add tags
        </button>
        <button type="button" className="btn auth-wide" onClick={done}>
          Done
        </button>
      </>
    );
  }

  return (
    <main className="page auth-page add-page">
      {body}
      <AddDialog
        open={formOpen && (!target || phase === 'error')}
        initialUrl={prefill}
        onClose={() => setFormOpen(false)}
        onSaved={(id) => void navigate(`/item/${encodeURIComponent(id)}`, { replace: true })}
      />
      {saved && tagsOpen ? <EditItemDialog item={saved} open onClose={() => setTagsOpen(false)} /> : null}
    </main>
  );
}
