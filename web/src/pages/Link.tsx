/**
 * Target of the "link a device" QR code: asks before redeeming `?code=` (a link from someone else must not
 * quietly sign this device into their account), then goes to the library.
 */
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import { normalizeCode, redeemLoginCode, useUser } from '../lib/data';
import { authErrorMessage, formatCode } from './Login';
import './pages.css';

type State = { kind: 'working' } | { kind: 'done' } | { kind: 'error'; message: string };

export default function Link() {
  const user = useUser();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = normalizeCode(params.get('code') ?? '');
  const [state, setState] = useState<State | null>(null);
  const started = useRef(false);

  function redeem() {
    // Never replace an existing session.
    if (user !== null || started.current || code.length !== 8) return;
    started.current = true;
    setState({ kind: 'working' });
    redeemLoginCode(code)
      .then(() => setState({ kind: 'done' }))
      .catch((e: unknown) => setState({ kind: 'error', message: authErrorMessage(e) ?? 'Could not sign in.' }));
  }

  useEffect(() => {
    if (state?.kind !== 'done') return;
    const t = window.setTimeout(() => void navigate('/', { replace: true }), 1200);
    return () => window.clearTimeout(t);
  }, [state, navigate]);

  let body;
  if (state?.kind === 'done') {
    body = (
      <>
        <p className="auth-status">Signed in{user?.email ? ` as ${user.email}` : ''}. Opening your library…</p>
        <RouterLink className="btn btn-primary auth-wide" to="/" replace>
          Continue
        </RouterLink>
      </>
    );
  } else if (user) {
    body = (
      <>
        <p className="auth-status">This device is already signed in{user.email ? ` as ${user.email}` : ''}.</p>
        <RouterLink className="btn btn-primary auth-wide" to="/" replace>
          Continue to library
        </RouterLink>
      </>
    );
  } else if (code.length !== 8) {
    body = (
      <>
        <p className="auth-status">This link does not contain a valid sign-in code.</p>
        <RouterLink className="btn btn-primary auth-wide" to="/login" replace>
          Go to sign in
        </RouterLink>
      </>
    );
  } else if (state?.kind === 'error') {
    body = (
      <>
        <p className="auth-status error-text" role="alert">
          {state.message}
        </p>
        <p className="small muted">Codes are valid for 10 minutes and work once. Create a new one in Settings → Link a device on your other device.</p>
        <RouterLink className="btn btn-primary auth-wide" to="/login" replace>
          Sign in another way
        </RouterLink>
      </>
    );
  } else if (state?.kind === 'working') {
    body = (
      <p className="auth-status" aria-live="polite">
        Signing in with code <span className="code-display-inline">{formatCode(code)}</span>…
      </p>
    );
  } else if (user === undefined) {
    body = null;
  } else {
    body = (
      <>
        <p className="auth-status">
          Sign in on this device with code <span className="code-display-inline">{formatCode(code)}</span>?
        </p>
        <button type="button" className="btn btn-primary auth-wide" onClick={redeem}>
          Sign in
        </button>
        <p className="small muted">Only continue if you created this code yourself, in Settings → Link a device on your other device.</p>
      </>
    );
  }

  return (
    <main className="page auth-page">
      <h1 className="auth-brand">Readlater</h1>
      {body}
    </main>
  );
}
