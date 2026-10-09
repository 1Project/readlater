/** Settings › Export (JSON, highlights Markdown, feeds OPML) and Account (who is signed in, sign out, version). */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/useConfirm';
import { exportJson, feedsToOpml, signOut, useCategories, useFeeds, useHighlights, useItems, useUser } from '../../lib/data';
import { dateStamp, downloadText } from './download';
import { groupHighlights, highlightsMarkdown } from './highlightGroups';
import { errorMessage, Section } from './ui';

export function ExportSection() {
  const items = useItems();
  const categories = useCategories();
  const feeds = useFeeds();
  const highlights = useHighlights();
  const toast = useToast();
  const loading = !items || !categories || !feeds || !highlights;

  const save = (name: string, text: string, mime: string) => void downloadText(name, text, mime).catch((e: unknown) => toast(`Export failed: ${errorMessage(e)}`, { error: true }));

  return (
    <Section id="export" title="Export" intro="Your data is yours. Download it any time.">
      <div className="set-export">
        <div className="set-export-row">
          <div>
            <span className="set-label">Everything (JSON)</span>
            <span className="small muted">
              {items ? `${items.length} items` : '…'}, categories, feeds, tags, notes and highlights
            </span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={loading}
            onClick={() => save(`readlater-${dateStamp()}.json`, exportJson(items!, categories!, feeds!, highlights!), 'application/json')}
          >
            <Download size={18} /> JSON
          </button>
        </div>
        <div className="set-export-row">
          <div>
            <span className="set-label">Highlights (Markdown)</span>
            <span className="small muted">{highlights ? `${highlights.length} highlights, grouped by document` : '…'}</span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!items || !highlights || highlights.length === 0}
            onClick={() => save(`readlater-highlights-${dateStamp()}.md`, highlightsMarkdown(groupHighlights(highlights!, items!)), 'text/markdown')}
          >
            <Download size={18} /> Markdown
          </button>
        </div>
        <div className="set-export-row">
          <div>
            <span className="set-label">Feeds (OPML)</span>
            <span className="small muted">{feeds ? `${feeds.length} feeds, for any RSS reader` : '…'}</span>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!feeds || feeds.length === 0}
            onClick={() => save(`readlater-feeds-${dateStamp()}.opml`, feedsToOpml(feeds!), 'text/x-opml')}
          >
            <Download size={18} /> OPML
          </button>
        </div>
      </div>
    </Section>
  );
}

export function AccountSection() {
  const user = useUser();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const google = user?.providerData.some((p) => p.providerId === 'google.com');
  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev';

  async function doSignOut() {
    const ok = await confirm('Your library stays in your account. You can sign in again any time, on this or any other device.', {
      title: 'Sign out?',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await signOut();
      void navigate('/login', { replace: true });
    } catch (e) {
      toast(`Could not sign out: ${errorMessage(e)}`, { error: true });
      setBusy(false);
    }
  }

  return (
    <Section id="account" title="Account">
      <div className="set-account">
        <p>
          Signed in as <strong className="set-wrap">{user?.email || user?.displayName || 'this account'}</strong>
          <br />
          <span className="small muted">{google ? 'With Google' : 'With a code from another device'}</span>
        </p>
        <button type="button" className="btn" onClick={() => void doSignOut()} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      <p className="small muted">Readlater {version}</p>
    </Section>
  );
}
