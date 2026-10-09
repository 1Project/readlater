/**
 * "Share public link…" dialog (SPEC-2 §6): create a read-only public copy of the document at /s/{token}
 * (optionally with highlights and notes), copy or share the link, refresh the copy, or turn the link off.
 *
 * export default ShareDialog
 * Props: { item: Item; open: boolean; highlightCount: number; onClose(): void }
 */
import { useEffect, useId, useState } from 'react';
import Dialog from '../components/Dialog';
import { toast } from '../components/Toast';
import { createShare, revokeShare } from '../lib/data';
import { publicUrl } from '../lib/firebase';
import type { Item } from '../lib/types';
import { copyText } from './clipboard';

function errorMessage(e: unknown): string {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^Firebase:\s*/, '') : 'Something went wrong';
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export default function ShareDialog({ item, open, highlightCount, onClose }: { item: Item; open: boolean; highlightCount: number; onClose: () => void }) {
  const [withHighlights, setWithHighlights] = useState(highlightCount > 0);
  // The dialog stays mounted with the reader, usually since before the highlights loaded: default the
  // checkbox from the count each time it opens (not when the count changes while it is open).
  useEffect(() => {
    if (open) setWithHighlights(highlightCount > 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local view of the link until the item snapshot catches up with the server.
  const [local, setLocal] = useState<{ token: string; url: string } | { revoked: string } | null>(null);
  const checkId = useId();
  const linkId = useId();

  const serverToken = item.shareToken ?? null;
  let token: string | null = serverToken;
  let url: string | null = serverToken ? `${publicUrl()}/s/${serverToken}` : null;
  if (local && 'token' in local) {
    token = local.token;
    url = local.url;
  } else if (local && 'revoked' in local && local.revoked === serverToken) {
    token = null;
    url = null;
  }

  const create = () => {
    setBusy('create');
    setError(null);
    createShare(item.id, withHighlights && highlightCount > 0)
      .then((r) => {
        // Built from this app's own origin (like the stored-token case above), not the server's PUBLIC_URL,
        // so the link matches the domain the user actually opened.
        setLocal({ token: r.token, url: `${publicUrl()}/s/${r.token}` });
        toast(token ? 'Shared copy updated' : 'Public link created');
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const revoke = () => {
    if (!token) return;
    const t = token;
    setBusy('revoke');
    setError(null);
    revokeShare(t)
      .then(() => {
        setLocal({ revoked: t });
        toast('Public link turned off');
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const copy = () => {
    if (!url) return;
    copyText(url).then(
      () => toast('Link copied'),
      () => toast('Could not copy the link', { error: true }),
    );
  };

  const share = () => {
    if (!url) return;
    navigator.share({ title: item.title || 'Shared from Readlater', url }).catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'AbortError') toast('Could not open the share sheet', { error: true });
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share public link"
      dismissable={busy === null}
      footer={
        <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
          Done
        </button>
      }
    >
      <div className="form-stack share-dialog">
        <p className="muted">
          {url
            ? 'Anyone with this link can read a copy of this document. They cannot see the rest of your library.'
            : 'Create a link to a read-only copy of this document. Anyone with the link can read it, without signing in.'}
        </p>

        {url ? (
          <>
            <label className="field" htmlFor={linkId}>
              <span className="field-label">Link</span>
              <input id={linkId} className="input share-link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="row share-actions">
              <button type="button" className="btn btn-primary" onClick={copy}>
                Copy link
              </button>
              {canShare() ? (
                <button type="button" className="btn" onClick={share}>
                  Share…
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <label className="reader-check" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={withHighlights && highlightCount > 0}
            disabled={highlightCount === 0 || busy !== null}
            onChange={(e) => setWithHighlights(e.target.checked)}
          />
          <span>
            Include my highlights and notes{highlightCount > 0 ? ` (${highlightCount})` : ''}
            {highlightCount === 0 ? <span className="small muted"> — this document has none</span> : null}
          </span>
        </label>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="row share-actions">
          <button type="button" className={url ? 'btn' : 'btn btn-primary'} onClick={create} disabled={busy !== null}>
            {busy === 'create' ? (url ? 'Updating…' : 'Creating…') : url ? 'Update shared copy' : 'Create link'}
          </button>
          {url ? (
            <button type="button" className="btn btn-danger" onClick={revoke} disabled={busy !== null}>
              {busy === 'revoke' ? 'Turning off…' : 'Turn off link'}
            </button>
          ) : null}
        </div>
        {url ? <p className="small muted">The copy does not change when you edit the document. Update it to share your latest highlights.</p> : null}
      </div>
    </Dialog>
  );
}
