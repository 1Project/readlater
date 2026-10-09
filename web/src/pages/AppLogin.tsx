/**
 * Native-app sign-in hand-off, opened in the system browser as `/app-login?return=readlater://login&challenge=…`.
 * Signs in with Google; after the user confirms ("Sign in to the app as …"), creates a one-time login code
 * bound to the app's PKCE challenge and redirects to `return?code=…`. Only the app that started the sign-in
 * holds the verifier, so a code caught by another app registered for `readlater://` is useless, and a page
 * that sends a signed-in visitor here gets nothing without that click.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createLoginCode, signInWithGoogle, signOut, useUser } from '../lib/data';
import { authErrorMessage, formatCode } from './Login';
import './pages.css';

export function returnTarget(raw: string | null): string | null {
  return raw && raw.startsWith('readlater://') ? raw : null;
}

/** A PKCE S256 challenge (base64url SHA-256, 43 characters). */
export function challengeParam(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

export default function AppLogin() {
  const user = useUser();
  const [params] = useSearchParams();
  const challenge = challengeParam(params.get('challenge'));
  const ret = challenge ? returnTarget(params.get('return')) : null;
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = code && ret ? `${ret}${ret.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : null;

  const makeCode = useCallback(async () => {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const res = await createLoginCode(challenge);
      setCode(res.code);
    } catch (e) {
      setError(authErrorMessage(e) ?? 'Could not create a sign-in code.');
    } finally {
      setBusy(false);
    }
  }, [challenge]);

  useEffect(() => {
    if (target) window.location.href = target;
  }, [target]);

  async function google() {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    setCode(null);
    await signOut();
  }

  const who = user ? (user.email ?? user.displayName ?? 'you') : '';

  let body;
  if (!ret) {
    body = (
      <p className="auth-status error-text">
        This sign-in link is not valid. Start signing in again from the Readlater app (update the app if this keeps happening).
      </p>
    );
  } else if (!user) {
    body = (
      <>
        <p className="auth-status">Sign in to continue to the Readlater app.</p>
        <button type="button" className="btn btn-primary auth-wide" onClick={() => void google()} disabled={busy}>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </button>
      </>
    );
  } else if (code && target) {
    body = (
      <>
        <p className="auth-status">Returning to the app…</p>
        <a className="btn btn-primary auth-wide" href={target}>
          Open Readlater
        </a>
        <p className="small muted">If the app does not open, open it and enter this code:</p>
        <p className="code-display" aria-label={`Code ${code.split('').join(' ')}`}>
          {formatCode(code)}
        </p>
        <p className="small muted">The code works once and expires in 10 minutes.</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="auth-status" aria-live="polite">
          {busy ? 'Preparing sign-in…' : 'The Readlater app asks to sign in with this account.'}
        </p>
        <button type="button" className="btn btn-primary auth-wide" onClick={() => void makeCode()} disabled={busy}>
          Sign in to the app as {who}
        </button>
        <p className="small muted">Only continue if you just tapped “Continue with Google” in the Readlater app.</p>
      </>
    );
  }

  return (
    <main className="page auth-page">
      <h1 className="auth-brand">Readlater</h1>
      {body}
      {error ? (
        <p className="error-text auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {user && ret ? (
        <p className="small muted auth-note">
          Signed in as {who}.{' '}
          <button type="button" className="link-button" onClick={() => void switchAccount()}>
            Use another account
          </button>
        </p>
      ) : null}
    </main>
  );
}
