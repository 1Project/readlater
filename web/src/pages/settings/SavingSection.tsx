/** Settings › Saving from anywhere: API keys, bookmarklet, iOS Shortcut, curl and Android instructions. */
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Trash } from '../../components/Icons';
import Spinner from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/useConfirm';
import { createApiKey, revokeApiKey, useApiKeys } from '../../lib/data';
import { publicUrl } from '../../lib/firebase';
import { formatDate, relativeTime } from '../../lib/format';
import type { ApiKeyInfo } from '../../lib/types';
import { copyText } from './download';
import { errorMessage, Section } from './ui';

function bookmarkletCode(base: string): string {
  return (
    `javascript:(function(){var u=${JSON.stringify(`${base}/add?url=`)}+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);` +
    `var w=window.open(u,'_blank');if(!w)location.href=u;})();`
  );
}

function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() => void copyText(text).then((ok) => toast(ok ? `${what} copied` : 'Could not copy — select the text and copy it by hand', { error: !ok }))}
    >
      {label}
    </button>
  );
}

function Bookmarklet({ base }: { base: string }) {
  const toast = useToast();
  const ref = useRef<HTMLAnchorElement>(null);
  const code = useMemo(() => bookmarkletCode(base), [base]);
  // React blocks javascript: URLs in JSX, so set the attribute directly.
  useEffect(() => {
    ref.current?.setAttribute('href', code);
  }, [code]);
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    toast('Drag this button to your bookmarks bar, then click it on any page you want to save.');
  };
  return (
    <div className="set-sub">
      <h3 className="set-sub-title">Bookmarklet</h3>
      <p className="small">Drag this button to your browser’s bookmarks bar. Click it on any page to save that page (you need to be signed in here).</p>
      <div className="row">
        <a ref={ref} className="btn btn-primary set-bookmarklet" draggable onClick={onClick} title="Drag to your bookmarks bar">
          Save to Readlater
        </a>
        <CopyButton text={code} label="Copy code" what="Bookmarklet code" />
      </div>
      <p className="small muted">On a phone: copy the code, bookmark any page, then edit that bookmark and paste the code as its address.</p>
    </div>
  );
}

function ApiKeys({ onCreated }: { onCreated: (key: string) => void }) {
  const keys = useApiKeys();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim() || 'API key';
    setBusy(true);
    try {
      const res = await createApiKey(n.slice(0, 60));
      setCreated({ name: n, key: res.key });
      onCreated(res.key);
      setName('');
    } catch (err) {
      toast(`Could not create key: ${errorMessage(err)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKeyInfo) {
    const ok = await confirm(`Anything using “${k.name}” (${k.prefix}…) will stop saving.`, { title: 'Revoke key', confirmLabel: 'Revoke', danger: true });
    if (!ok) return;
    try {
      await revokeApiKey(k.id);
      toast('Key revoked');
    } catch (err) {
      toast(`Could not revoke: ${errorMessage(err)}`, { error: true });
    }
  }

  return (
    <div className="set-sub">
      <h3 className="set-sub-title">API keys</h3>
      <p className="small">Keys let shortcuts, scripts and other apps save links to your account. Create one per device or tool so you can revoke it separately.</p>
      {created ? (
        <div className="set-key-box" role="status">
          <p className="small">
            <strong>{created.name}</strong> — copy this key now. It will not be shown again.
          </p>
          <code className="set-key">{created.key}</code>
          <div className="row">
            <CopyButton text={created.key} label="Copy key" what="Key" />
            <button type="button" className="btn btn-small" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
      <form className="set-inline-form" onSubmit={(e) => void create(e)}>
        <input className="input" placeholder="Name, e.g. iPhone Shortcut" aria-label="Key name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>
      {keys === undefined ? (
        <Spinner />
      ) : keys.length ? (
        <ul className="set-list">
          {keys.map((k) => (
            <li key={k.id} className="set-list-row">
              <div className="set-list-main">
                <span className="set-list-name">{k.name}</span>
                <span className="small muted">
                  <code>{k.prefix}…</code> · created {formatDate(k.createdAt)} · {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}
                </span>
              </div>
              <div className="set-list-actions">
                <button type="button" className="btn btn-small btn-danger" onClick={() => void revoke(k)}>
                  <Trash size={18} /> Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No keys yet.</p>
      )}
    </div>
  );
}

export function SavingSection() {
  const base = publicUrl();
  const [key, setKey] = useState<string | null>(null);
  const shownKey = key ?? 'YOUR_API_KEY';
  const curl = `curl -X POST "${base}/api/save" \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"url": "https://example.com/article"}'`;
  const getUrl = `${base}/api/save?key=${shownKey}&url=https%3A%2F%2Fexample.com%2Farticle`;

  return (
    <Section id="saving" title="Saving from anywhere" intro="Save links from your browser, phone share sheet, scripts and automations.">
      <Bookmarklet base={base} />

      <div className="set-sub">
        <h3 className="set-sub-title">Android</h3>
        <p className="small">
          Install the Readlater app, or add this site to your home screen (browser menu → <em>Install app</em> or <em>Add to Home screen</em>). Then use{' '}
          <strong>Share → Readlater</strong> in any app. PDFs and EPUBs can be shared too.
        </p>
      </div>

      <ApiKeys onCreated={setKey} />

      <div className="set-sub">
        <h3 className="set-sub-title">iPhone &amp; iPad (Shortcut)</h3>
        <ol className="set-steps small">
          <li>Create an API key above and copy it.</li>
          <li>
            Open the <strong>Shortcuts</strong> app, tap <strong>+</strong> and name the shortcut “Save to Readlater”.
          </li>
          <li>
            Tap the <strong>ⓘ</strong> button, turn on <strong>Show in Share Sheet</strong> and let it receive <strong>URLs</strong> and <strong>Safari web pages</strong>.
          </li>
          <li>
            Add the action <strong>Get Contents of URL</strong>:
            <ul>
              <li>
                URL: <code className="set-wrap">{base}/api/save</code>
              </li>
              <li>
                Method: <strong>POST</strong>
              </li>
              <li>
                Headers: <code>Authorization</code> = <code className="set-wrap">Bearer {shownKey}</code>
              </li>
              <li>
                Request Body: <strong>JSON</strong>, add a Text field <code>url</code> = <strong>Shortcut Input</strong>
              </li>
            </ul>
          </li>
          <li>
            Optionally add <strong>Show Notification</strong> “Saved”. Now use <strong>Share → Save to Readlater</strong> from Safari or any app.
          </li>
        </ol>
      </div>

      <div className="set-sub">
        <h3 className="set-sub-title">From the command line or other tools</h3>
        <pre className="set-pre">
          <code>{curl}</code>
        </pre>
        <div className="row">
          <CopyButton text={curl} label="Copy command" what="Command" />
        </div>
        <p className="small muted">
          The body may also include <code>title</code>, <code>tags</code> (list) and <code>category</code>. For tools that can only open a link:
        </p>
        <pre className="set-pre">
          <code>{getUrl}</code>
        </pre>
      </div>
    </Section>
  );
}
