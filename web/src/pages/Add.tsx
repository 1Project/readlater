/**
 * Share-target / bookmarklet landing: `/add?url=&title=&text=`. Saves the first link found and opens it
 * in the reader. Without a usable link it shows the add form pre-filled with the shared text.
 * (Signed-out visitors are sent to /login?next=/add… by the App auth gate, so this always runs signed in.)
 */
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import AddDialog from '../components/AddDialog';
import { useToast } from '../components/Toast';
import { addUrl, extractUrl } from '../lib/data';
import './pages.css';

export default function Add() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const rawUrl = params.get('url') ?? '';
  const text = params.get('text') ?? '';
  const title = params.get('title') ?? '';
  const target = extractUrl(rawUrl) ?? extractUrl(text) ?? extractUrl(title);
  // A shared title is used as a placeholder until the server extracts the real one.
  const sharedTitle = title.trim() && !extractUrl(title.trim()) ? title.trim().slice(0, 300) : undefined;

  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(!target);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!target || started.current === target) return;
    started.current = target;
    addUrl(target, { title: sharedTitle })
      .then((id) => {
        toast('Saved to Library', { action: { label: 'Back to library', onClick: () => void navigate('/') } });
        void navigate(`/item/${encodeURIComponent(id)}`, { replace: true });
      })
      .catch((e: unknown) => {
        setError((e as Error)?.message || 'Could not save the link.');
        setFormOpen(true);
      });
  }, [target, sharedTitle, navigate, toast]);

  const prefill = target ?? [title, text, rawUrl].map((s) => s.trim()).filter(Boolean).join(' ');

  return (
    <main className="page auth-page add-page">
      {target && !error ? (
        <p className="auth-status" aria-live="polite">
          Saving <span className="add-target">{target}</span>…
        </p>
      ) : (
        <>
          <p className="auth-status">{error ? `Could not save: ${error}` : 'No link found in what was shared.'}</p>
          {!error && prefill ? <blockquote className="add-shared">{prefill}</blockquote> : null}
          <button type="button" className="btn btn-primary auth-wide" onClick={() => setFormOpen(true)}>
            Add a link or file
          </button>
        </>
      )}
      <RouterLink className="btn auth-wide" to="/" replace>
        Back to library
      </RouterLink>
      <AddDialog
        open={formOpen}
        initialUrl={prefill}
        onClose={() => setFormOpen(false)}
        onSaved={(id) => void navigate(`/item/${encodeURIComponent(id)}`, { replace: true })}
      />
    </main>
  );
}
