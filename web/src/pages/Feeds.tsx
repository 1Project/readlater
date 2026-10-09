/**
 * /feeds — manage RSS / Atom subscriptions: add by feed or site URL (addFeed), edit title / category /
 * tags / full text, refresh, delete (optionally keeping the entries), OPML import and export.
 */
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import CategorySelect from '../components/CategorySelect';
import Dialog from '../components/Dialog';
import EmptyState from '../components/EmptyState';
import { Back, Download, External, Refresh, Rss, Trash, Upload } from '../components/Icons';
import Spinner from '../components/Spinner';
import TagInput from '../components/TagInput';
import { useToast } from '../components/Toast';
import { addFeed, deleteFeed, feedsToOpml, importOpml, refreshFeeds, tagCounts, updateFeed, useCategories, useFeeds, useItems } from '../lib/data';
import { hostname, relativeTime } from '../lib/format';
import type { Feed } from '../lib/types';
import { openExternal } from '../native';
import { dateStamp, downloadText } from './settings/download';
import { errorMessage, Switch } from './settings/ui';
import './settings.css';

function normalizeInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function AddFeedForm({ tagSuggestions }: { tagSuggestions: string[] }) {
  const categories = useCategories();
  const [url, setUrl] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; title: string; added: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = normalizeInput(url);
    if (!u || busy) return;
    try {
      new URL(u);
    } catch {
      setError('That does not look like a web address.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await addFeed(u, categoryId, tags);
      setResult(res);
      setUrl('');
      setTags([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card feeds-add" onSubmit={(e) => void submit(e)}>
      <label className="set-label" htmlFor="feed-url">
        Add a feed
      </label>
      <div className="set-inline-form">
        <input
          id="feed-url"
          className="input"
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Site or feed address"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p className="small muted">Paste a blog or news site address — Readlater finds its feed. Newsletters with an RSS link work too.</p>
      <div className="feeds-add-options">
        <div className="field">
          <label className="field-label" htmlFor="feed-add-cat">
            Category <span className="muted">(optional)</span>
          </label>
          <CategorySelect id="feed-add-cat" value={categoryId} onChange={setCategoryId} categories={categories} allowCreate disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="feed-add-tags">
            Tags for new entries <span className="muted">(optional)</span>
          </label>
          <TagInput id="feed-add-tags" value={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>
      </div>
      {busy ? <Spinner label="Looking for the feed…" inline /> : null}
      {error ? <p className="error-text small">{error}</p> : null}
      {result ? (
        <p className="small" role="status">
          Added <strong>{result.title}</strong> — {plural(result.added, 'entry', 'entries')}.{' '}
          <RouterLink to={`/feed?feed=${encodeURIComponent(result.id)}`}>Show in Feed</RouterLink>
        </p>
      ) : null}
    </form>
  );
}

function EditFeedDialog({ feed, onClose, tagSuggestions }: { feed: Feed; onClose: () => void; tagSuggestions: string[] }) {
  const categories = useCategories();
  const toast = useToast();
  const [title, setTitle] = useState(feed.title);
  const [categoryId, setCategoryId] = useState(feed.categoryId);
  const [tags, setTags] = useState(feed.tags);
  const [fullText, setFullText] = useState(feed.fullText);
  const [busy, setBusy] = useState(false);

  async function save() {
    const patch: Parameters<typeof updateFeed>[1] = {};
    const t = title.trim();
    if (t && t !== feed.title) patch.title = t.slice(0, 200);
    if (categoryId !== feed.categoryId) patch.categoryId = categoryId;
    if (tags.join('\n') !== feed.tags.join('\n')) patch.tags = tags;
    if (fullText !== feed.fullText) patch.fullText = fullText;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await updateFeed(feed.id, patch);
      toast('Feed updated');
      onClose();
    } catch (e) {
      toast(`Could not update feed: ${errorMessage(e)}`, { error: true });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit feed"
      dismissable={!busy}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div className="field">
          <label className="field-label" htmlFor="feed-title">
            Title
          </label>
          <input id="feed-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <span className="small muted set-wrap">{feed.url}</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="feed-cat">
            Category
          </label>
          <CategorySelect id="feed-cat" value={categoryId} onChange={setCategoryId} categories={categories} allowCreate />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="feed-tags">
            Tags
          </label>
          <TagInput id="feed-tags" value={tags} onChange={setTags} suggestions={tagSuggestions} />
          <span className="small muted">Category and tags are added to new entries from this feed.</span>
        </div>
        <Switch
          label="Fetch full text"
          description="Many feeds only include a summary. Turn this on to download the whole article for each new entry. New entries take a little longer to appear."
          checked={fullText}
          onChange={setFullText}
        />
      </div>
    </Dialog>
  );
}

function DeleteFeedDialog({ feed, entries, onClose }: { feed: Feed; entries: number; onClose: () => void }) {
  const items = useItems();
  const toast = useToast();
  const [removeEntries, setRemoveEntries] = useState(true);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await deleteFeed(feed.id, items ?? [], removeEntries);
      toast(`Unsubscribed from ${feed.title}`);
      onClose();
    } catch (e) {
      toast(`Could not delete feed: ${errorMessage(e)}`, { error: true });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete feed"
      dismissable={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={() => void remove()} disabled={busy || items === undefined}>
            {busy ? 'Deleting…' : 'Delete feed'}
          </button>
        </>
      }
    >
      <p>
        Unsubscribe from <strong>{feed.title}</strong>?
      </p>
      {entries > 0 ? (
        <label className="set-check">
          <input type="checkbox" checked={removeEntries} onChange={(e) => setRemoveEntries(e.target.checked)} />
          <span>Also remove its {plural(entries, 'entry', 'entries')} from the Feed</span>
        </label>
      ) : null}
      <p className="small muted">Articles you saved to your library are always kept.</p>
    </Dialog>
  );
}

function FeedRow({
  feed,
  categoryName,
  newCount,
  onEdit,
  onDelete,
}: {
  feed: Feed;
  categoryName: string | null;
  newCount: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const site = feed.siteUrl || feed.url;

  async function refresh() {
    setBusy(true);
    try {
      const res = await refreshFeeds(feed.id);
      toast(res.added ? `${feed.title}: ${plural(res.added, 'new entry', 'new entries')}` : `${feed.title}: nothing new`);
    } catch (e) {
      toast(`Refresh failed: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="feeds-row">
      <div className="feeds-row-main">
        <RouterLink className="feeds-title" to={`/feed?feed=${encodeURIComponent(feed.id)}`}>
          {feed.title || hostname(feed.url) || feed.url}
        </RouterLink>
        <div className="small muted feeds-meta">
          <button type="button" className="link-like" onClick={() => void openExternal(site)}>
            {hostname(site) || site}
            <External size={14} />
          </button>
          <span>{feed.lastFetchedAt ? `updated ${relativeTime(feed.lastFetchedAt)}` : 'not fetched yet'}</span>
          {newCount ? <span>{newCount} new</span> : null}
        </div>
        {categoryName || feed.tags.length || feed.fullText ? (
          <div className="feeds-chips">
            {categoryName ? <span className="chip">{categoryName}</span> : null}
            {feed.tags.map((t) => (
              <span key={t} className="chip">
                #{t}
              </span>
            ))}
            {feed.fullText ? <span className="chip">Full text</span> : null}
          </div>
        ) : null}
        {feed.lastError ? <p className="error-text small feeds-error">Last update failed: {feed.lastError}</p> : null}
      </div>
      <div className="set-list-actions">
        <button type="button" className="btn btn-small btn-icon" aria-label={`Refresh ${feed.title}`} title="Refresh" onClick={() => void refresh()} disabled={busy}>
          {busy ? '…' : <Refresh size={18} />}
        </button>
        <button type="button" className="btn btn-small" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn-small btn-icon btn-danger" aria-label={`Delete ${feed.title}`} title="Delete" onClick={onDelete}>
          <Trash size={18} />
        </button>
      </div>
    </li>
  );
}

export default function Feeds() {
  const feeds = useFeeds();
  const items = useItems();
  const categories = useCategories();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Feed | null>(null);
  const [deleting, setDeleting] = useState<Feed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [opmlBusy, setOpmlBusy] = useState(false);
  const [opmlResult, setOpmlResult] = useState<string | null>(null);

  const sorted = useMemo(() => [...(feeds ?? [])].sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)), [feeds]);
  const tagSuggestions = useMemo(() => tagCounts(items ?? []).map((t) => t.tag), [items]);
  const { newCounts, entryCounts } = useMemo(() => {
    const n = new Map<string, number>();
    const all = new Map<string, number>();
    for (const i of items ?? []) {
      if (!i.feedId || i.location !== 'feed') continue;
      all.set(i.feedId, (all.get(i.feedId) ?? 0) + 1);
      if (i.status === 'unread') n.set(i.feedId, (n.get(i.feedId) ?? 0) + 1);
    }
    return { newCounts: n, entryCounts: all };
  }, [items]);
  const catName = (id: string | null) => (id ? (categories?.find((c) => c.id === id)?.name ?? null) : null);

  async function refreshAll() {
    setRefreshing(true);
    try {
      const res = await refreshFeeds();
      toast(res.added ? plural(res.added, 'new entry', 'new entries') : 'No new entries');
    } catch (e) {
      toast(`Refresh failed: ${errorMessage(e)}`, { error: true });
    } finally {
      setRefreshing(false);
    }
  }

  async function onOpml(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setOpmlBusy(true);
    setOpmlResult(null);
    try {
      const text = await file.text();
      if (!/<opml[\s>]/i.test(text)) throw new Error('This is not an OPML file');
      const res = await importOpml(text);
      const failed = res.failed.length ? ` Could not add ${res.failed.length}: ${res.failed.slice(0, 5).join(', ')}${res.failed.length > 5 ? '…' : ''}` : '';
      setOpmlResult(`Subscribed to ${plural(res.feeds, 'feed')}.${failed}`);
    } catch (err) {
      setOpmlResult(`Import failed: ${errorMessage(err)}`);
    } finally {
      setOpmlBusy(false);
    }
  }

  function exportOpml() {
    if (!feeds?.length) return;
    downloadText(`readlater-feeds-${dateStamp()}.opml`, feedsToOpml(sorted), 'text/x-opml').catch((e: unknown) =>
      toast(`Export failed: ${errorMessage(e)}`, { error: true }),
    );
  }

  return (
    <main className="page feeds-page">
      <div className="page-head">
        <RouterLink className="btn btn-ghost" to="/feed">
          <Back size={18} /> Feed
        </RouterLink>
        <h1 className="set-title feeds-heading">Feeds</h1>
      </div>

      <AddFeedForm tagSuggestions={tagSuggestions} />

      <div className="feeds-toolbar">
        <button type="button" className="btn btn-small" onClick={() => void refreshAll()} disabled={refreshing || !feeds?.length}>
          <Refresh size={18} /> {refreshing ? 'Refreshing…' : 'Refresh all'}
        </button>
        <span className="spacer" />
        <input ref={fileRef} type="file" accept=".opml,.xml,text/x-opml,application/xml,text/xml" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => void onOpml(e)} />
        <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()} disabled={opmlBusy}>
          <Upload size={18} /> {opmlBusy ? 'Importing…' : 'Import OPML'}
        </button>
        <button type="button" className="btn btn-small" onClick={exportOpml} disabled={!feeds?.length}>
          <Download size={18} /> Export OPML
        </button>
      </div>
      {opmlResult ? (
        <p className="small" role="status">
          {opmlResult}
        </p>
      ) : null}

      {feeds === undefined ? (
        <Spinner />
      ) : feeds.length === 0 ? (
        <EmptyState icon={<Rss size={32} />} title="No feeds yet">
          <p>Add a blog, newsletter or news site above, or import an OPML file from another feed reader.</p>
        </EmptyState>
      ) : (
        <>
          <p className="small muted feeds-count">{plural(feeds.length, 'feed')} · checked for new posts every hour</p>
          <ul className="feeds-list">
            {sorted.map((f) => (
              <FeedRow
                key={f.id}
                feed={f}
                categoryName={catName(f.categoryId)}
                newCount={newCounts.get(f.id) ?? 0}
                onEdit={() => setEditing(f)}
                onDelete={() => setDeleting(f)}
              />
            ))}
          </ul>
        </>
      )}

      {editing ? <EditFeedDialog key={editing.id} feed={editing} tagSuggestions={tagSuggestions} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteFeedDialog key={deleting.id} feed={deleting} entries={entryCounts.get(deleting.id) ?? 0} onClose={() => setDeleting(null)} /> : null}
    </main>
  );
}
