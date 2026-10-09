/** Settings › Link a device: one-time sign-in code (createLoginCode) shown big + as a QR code, with a live countdown. */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { createLoginCode } from '../../lib/data';
import { publicUrl } from '../../lib/firebase';
import { usePrefs } from '../../lib/prefs';
import { errorMessage, Section } from './ui';

interface Code {
  code: string;
  expiresAt: number;
  qr: string | null;
}

function groupCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function LinkDeviceSection() {
  const prefs = usePrefs();
  const [code, setCode] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const remaining = code ? Math.max(0, code.expiresAt - now) : 0;
  const expired = !!code && remaining <= 0;
  const eink = prefs.theme === 'eink';

  useEffect(() => {
    if (!code || expired) return;
    // E-ink screens flash on every repaint: tick every 15 s and show minutes only.
    const t = window.setInterval(() => setNow(Date.now()), eink ? 15_000 : 1000);
    return () => window.clearInterval(t);
  }, [code, expired, eink]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createLoginCode();
      const link = `${publicUrl()}/link?code=${encodeURIComponent(res.code)}`;
      let qr: string | null = null;
      try {
        qr = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 264, color: { dark: '#000000', light: '#ffffff' } });
      } catch (e) {
        console.error('QR code failed', e);
      }
      setNow(Date.now());
      setCode({ code: res.code, expiresAt: res.expiresAt, qr });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1000);
  const countdown = eink ? `${Math.max(1, Math.ceil(remaining / 60_000))} min` : `${mins}:${String(secs).padStart(2, '0')}`;

  return (
    <Section id="link" title="Link a device" intro="Sign in on a phone, tablet or e-reader without typing your password.">
      <ol className="set-steps">
        <li>Tap “Generate code” below.</li>
        <li>
          On the other device open Readlater → <strong>Sign in</strong> → <strong>Enter code</strong>, or scan the QR code with its camera.
        </li>
      </ol>
      {code && !expired ? (
        <div className="set-code-box">
          <p className="set-code" aria-label={`Code ${code.code.split('').join(' ')}`}>
            {groupCode(code.code)}
          </p>
          <p className="small" role="timer" aria-live="off">
            Expires in {countdown} · works once
          </p>
          {code.qr ? <img className="set-qr" src={code.qr} width={264} height={264} alt="QR code that signs in the other device" /> : null}
        </div>
      ) : code && expired ? (
        <p className="set-expired">That code has expired.</p>
      ) : null}
      {error ? <p className="error-text small">{error}</p> : null}
      <button type="button" className={`btn${code && !expired ? '' : ' btn-primary'}`} onClick={() => void generate()} disabled={busy}>
        {busy ? 'Generating…' : code ? 'Generate a new code' : 'Generate code'}
      </button>
    </Section>
  );
}
