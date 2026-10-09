/**
 * Native-app sign-in hand-off, opened in the system browser as `/app-login?return=readlater://login`.
 * Signs in with Google, creates a one-time login code and redirects to `return?code=…`; the app redeems it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createLoginCode, signInWithGoogle, signOut, useUser } from '../lib/data';
import { authErrorMessage, formatCode } from './Login';
import './pages.css';

export function returnTarget(raw: string | null): string | null {
  return raw && raw.startsWith('readlater://') ? raw : null;
}

export default function AppLogin() {
  const user = useUser();
  const [params] = useSearchParams();
  const ret = returnTarget(params.get('return'));
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requested = useRef<string | null>(null);

  const target = code && ret ? `${ret}${ret.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` : null;

  const makeCode = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await createLoginCode();
      setCode(res.code);
    } catch (e) {
      setError(authErrorMessage(e) ?? 'Could not create a sign-in code.');
    } finally {
      setBusy(false);
    }
  }, []);

  // Once signed in, create a code (once per signed-in user).
  useEffect(() => {
    if (!user || !ret || requested.current === user.uid) return;
    requested.current = user.uid;
    void makeCode();
  }, [user, ret, makeCode]);

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
    requested.current = null;
    await signOut();
  }

  let body;
  if (!ret) {
    body = <p className="auth-status error-text">This sign-in link is not valid. Start signing in again from the Readlater app.</p>;
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
          {busy ? 'Preparing sign-in…' : error ? '' : 'Signed in.'}
        </p>
        {error && !busy ? (
          <button type="button" className="btn btn-primary auth-wide" onClick={() => void makeCode()}>
            Try again
          </button>
        ) : null}
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
          Signed in as {user.email ?? user.displayName ?? 'you'}.{' '}
          <button type="button" className="link-button" onClick={() => void switchAccount()}>
            Use another account
          </button>
        </p>
      ) : null}
    </main>
  );
}
