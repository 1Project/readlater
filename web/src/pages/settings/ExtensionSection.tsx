/**
 * Settings › Browser extension (#extension — the extension's options page links here to get a key) and
 * Settings › Bookmarklets (#bookmarklets): "Save to Readlater" (API key, small popup window on /api/save) and
 * "Open in Readlater" (/add in the signed-in web app).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useToast } from '../../components/Toast';
import { createApiKey } from '../../lib/data';
import { REPO_URL } from '../../lib/config';
import { publicUrl } from '../../lib/firebase';
import { javascriptUrl, openBookmarkletCode, saveBookmarkletCode } from './bookmarklets';
import { CopyButton, errorMessage, Section } from './ui';

export function ExtensionSection() {
  const base = publicUrl();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    try {
      const res = await createApiKey('Browser extension');
      setKey(res.key);
    } catch (e) {
      toast(`Could not create key: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="extension"
      title="Browser extension"
      intro="Save the page you are on with one click or Alt+Shift+S — including pages behind a login or paywall, saved as you see them. For Chrome, Edge and Firefox."
    >
      <div className="set-sub">
        <h3 className="set-sub-title">1. Install</h3>
        <ol className="set-steps small">
          <li>
            Download the <a href={`${REPO_URL}/tree/main/extension`} target="_blank" rel="noopener noreferrer">extension folder</a> from the source
            repository, or the ready-made store packages (<code>readlater-extension.zip</code> for Chrome and Edge,{' '}
            <code>readlater-extension-firefox.zip</code> for Firefox) from the artifacts of the latest{' '}
            <a href={`${REPO_URL}/actions`} target="_blank" rel="noopener noreferrer">GitHub Actions</a> run.
          </li>
          <li>
            <strong>Chrome / Edge:</strong> open <code>chrome://extensions</code> (or <code>edge://extensions</code>), turn on{' '}
            <strong>Developer mode</strong>, choose <strong>Load unpacked</strong> and select the <code>extension</code> folder (unzip the package
            first).
          </li>
          <li>
            <strong>Firefox:</strong> open <code>about:debugging#/runtime/this-firefox</code> and choose <strong>Load Temporary Add-on…</strong>{' '}
            with <code>manifest.json</code>, or install the signed add-on from addons.mozilla.org if you published one.
          </li>
        </ol>
      </div>
      <div className="set-sub">
        <h3 className="set-sub-title">2. Connect it to your account</h3>
        <p className="small">
          Create a key, then paste the server address and the key into the extension’s options page (right-click its icon → <em>Options</em>).
        </p>
        {key ? (
          <div className="set-key-box" role="status">
            <p className="small">
              <strong>Browser extension</strong> — copy the key now. It will not be shown again.
            </p>
            <span className="set-label">Server URL</span>
            <code className="set-key">{base}</code>
            <span className="set-label">API key</span>
            <code className="set-key">{key}</code>
            <div className="row">
              <CopyButton text={base} label="Copy URL" what="Server URL" />
              <CopyButton text={key} label="Copy key" what="Key" />
              <button type="button" className="btn btn-small" onClick={() => setKey(null)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
              {busy ? 'Creating…' : 'Create key for extension'}
            </button>
          </div>
        )}
        <p className="small muted">You can revoke the key any time under API keys in the Saving section.</p>
      </div>
    </Section>
  );
}

/** A draggable `javascript:` link. React refuses javascript: URLs in JSX, so the attribute is set directly. */
function BookmarkletLink({ href, children }: { href: string; children: string }) {
  const toast = useToast();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute('href', href);
  }, [href]);
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    toast('Drag this button to your bookmarks bar, then click it on any page you want to save.');
  };
  return (
    <a ref={ref} className="btn btn-primary set-bookmarklet" draggable onClick={onClick} title="Drag to your bookmarks bar">
      {children}
    </a>
  );
}

export function BookmarkletsSection() {
  const base = publicUrl();
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveHref = useMemo(() => (key ? javascriptUrl(saveBookmarkletCode(base, key)) : ''), [base, key]);
  const openHref = useMemo(() => javascriptUrl(openBookmarkletCode(base)), [base]);

  async function generate() {
    setBusy(true);
    try {
      // Save-only: the bookmarklet runs inside the pages it is clicked on, which can read its key.
      const res = await createApiKey('Bookmarklet', 'save');
      setKey(res.key);
    } catch (e) {
      toast(`Could not create key: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="bookmarklets" title="Bookmarklets" intro="No extension needed: drag a button to your bookmarks bar and click it on any page.">
      <div className="set-sub">
        <h3 className="set-sub-title">Save to Readlater</h3>
        <p className="small">
          Saves the page in a small window that closes by itself — you stay where you are, and it works on any site. It uses its own API key, so
          it works even when you are not signed in here.
        </p>
        {key ? (
          <>
            <div className="row">
              <BookmarkletLink href={saveHref}>Save to Readlater</BookmarkletLink>
              <CopyButton text={saveHref} label="Copy code" what="Bookmarklet code" />
            </div>
            <p className="small muted">
              It contains a key named “Bookmarklet” that can save to your library but not read it. Revoke the key under API keys to disable it.
            </p>
          </>
        ) : (
          <div className="row">
            <button type="button" className="btn" onClick={() => void generate()} disabled={busy}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>
        )}
      </div>
      <div className="set-sub">
        <h3 className="set-sub-title">Open in Readlater</h3>
        <p className="small">Opens the page in Readlater in a new tab, where you confirm saving it (you need to be signed in here; no key).</p>
        <div className="row">
          <BookmarkletLink href={openHref}>Open in Readlater</BookmarkletLink>
          <CopyButton text={openHref} label="Copy code" what="Bookmarklet code" />
        </div>
      </div>
      <p className="small muted">On a phone: copy the code, bookmark any page, then edit that bookmark and paste the code as its address.</p>
    </Section>
  );
}
