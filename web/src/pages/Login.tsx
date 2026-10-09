/** Sign-in: Google, or a one-time code created on another signed-in device. Redirects to `?next=` once signed in. */
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { normalizeCode, redeemLoginCode, signInWithGoogle, useUser } from '../lib/data';
import { isNative, nativeGoogleSignIn } from '../native';
import './pages.css';

/** Only same-app paths are allowed as redirect targets. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login')) return '/';
  return raw;
}

/** Human-readable message for auth / callable errors. Returns null for user cancellations. */
export function authErrorMessage(e: unknown): string | null {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return null;
  if (code === 'auth/network-request-failed' || code === 'functions/unavailable' || (typeof navigator !== 'undefined' && navigator.onLine === false))
    return 'No connection. Check your internet and try again.';
  if (code === 'functions/resource-exhausted') return 'Too many attempts. Wait a minute and try again.';
  if (code === 'functions/not-found' || code === 'functions/invalid-argument' || code === 'functions/permission-denied' || code === 'functions/failed-precondition')
    return (e as Error).message || 'That code is invalid or has expired.';
  return (e as Error)?.message || 'Something went wrong. Please try again.';
}

/** Format a code for display as XXXX-XXXX. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export default function Login() {
  const user = useUser();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'google' | 'code' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeWaiting, setNativeWaiting] = useState(false);
  const native = isNative();

  if (user) return <Navigate to={next} replace />;

  async function google() {
    setError(null);
    setBusy('google');
    try {
      if (native) {
        await nativeGoogleSignIn();
        setNativeWaiting(true);
      } else {
        await signInWithGoogle();
      }
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function redeem() {
    const c = normalizeCode(code);
    if (c.length !== 8) {
      setError('Enter all 8 characters of the code.');
      return;
    }
    setError(null);
    setBusy('code');
    try {
      // Stay busy: the auth listener flips useUser() and the <Navigate> above takes over.
      await redeemLoginCode(c);
    } catch (e) {
      setError(authErrorMessage(e));
      setBusy(null);
    }
  }

  const ready = normalizeCode(code).length === 8;

  return (
    <main className="page auth-page">
      <h1 className="auth-brand">Readlater</h1>
      <p className="auth-pitch muted">Save articles, posts, papers and books. Read them later, anywhere — even on e-ink.</p>

      <button type="button" className="btn btn-primary auth-wide" onClick={() => void google()} disabled={busy !== null}>
        {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
      </button>
      {nativeWaiting ? <p className="small muted auth-note">Finish signing in in your browser; you will be brought back here automatically.</p> : null}

      <div className="auth-divider" role="separator">
        <span>or</span>
      </div>

      <form
        className="auth-code-form"
        onSubmit={(e) => {
          e.preventDefault();
          void redeem();
        }}
      >
        <label htmlFor="login-code" className="field-label">
          Have a code from another device?
        </label>
        <input
          id="login-code"
          className="input code-input"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-\s]/g, '').slice(0, 9));
            setError(null);
          }}
          placeholder="XXXX-XXXX"
          maxLength={9}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          disabled={busy !== null}
        />
        <button type="submit" className="btn auth-wide" disabled={busy !== null || !ready}>
          {busy === 'code' ? 'Signing in…' : 'Sign in with code'}
        </button>
        <p className="small muted">On a signed-in device open Settings → Link a device.</p>
      </form>

      {error ? (
        <p className="error-text auth-error" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}
