/** Feed: items from subscribed RSS/Atom feeds (location 'feed'). New / Seen tabs, filter by feed and category. */
import { useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import CategorySelect from '../components/CategorySelect';
import EmptyState from '../components/EmptyState';
import { Check, Refresh, Rss } from '../components/Icons';
import ItemList from '../components/ItemList';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/useConfirm';
import { bulkUpdate, refreshFeeds, useCategories, useFeeds, useItems } from '../lib/data';
import { FEED_VIEWS, filterItems, parseFeedView, sortItems } from '../lib/filters';
import type { Item } from '../lib/types';
import './pages.css';

export default function Feed() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const items = useItems();
  const feeds = useFeeds();
  const categories = useCategories();
  const toast = useToast();
  const confirm = useConfirm();
  const [refreshing, setRefreshing] = useState(false);

  const view = parseFeedView(params.get('view'));
  const rawFeed = params.get('feed') || null;
  const feedId = rawFeed && feeds && !feeds.some((f) => f.id === rawFeed) ? null : rawFeed;
  const rawCat = params.get('cat') || null;
  const cat = rawCat && categories && !categories.some((c) => c.id === rawCat) ? null : rawCat;

  const feedItems = useMemo(() => (items ? items.filter((i) => i.location === 'feed') : undefined), [items]);

  const { list, counts } = useMemo(() => {
    if (!feedItems) return { list: undefined, counts: null };
    const base = filterItems(feedItems, { feedId, categoryId: cat });
    const counts = { new: filterItems(base, { view: 'new' }).length, seen: filterItems(base, { view: 'seen' }).length };
    return { list: sortItems(filterItems(base, { view }), 'new', 'publishedAt'), counts };
  }, [feedItems, feedId, cat, view]);

  const newPerFeed = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of feedItems ?? []) if (it.status === 'unread' && it.feedId) m.set(it.feedId, (m.get(it.feedId) ?? 0) + 1);
    return m;
  }, [feedItems]);
  const sortedFeeds = useMemo(() => [...(feeds ?? [])].sort((a, b) => a.title.localeCompare(b.title)), [feeds]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  async function markAllSeen() {
    if (!list?.length) return;
    const ids = list.map((i) => i.id);
    const ok = await confirm(`Mark ${ids.length} ${ids.length === 1 ? 'item' : 'items'} as seen?`, { title: 'Mark all as seen', confirmLabel: 'Mark as seen' });
    if (!ok) return;
    bulkUpdate(ids, { status: 'archived' }).catch((e: unknown) => toast(`Could not update: ${(e as Error)?.message ?? 'unknown error'}`, { error: true }));
    toast(`Marked ${ids.length} as seen`, {
      action: {
        label: 'Undo',
        onClick: () => void bulkUpdate(ids, { status: 'unread' }).catch(() => toast('Could not undo', { error: true })),
      },
    });
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await refreshFeeds(feedId ?? undefined);
      toast(res.added ? `${res.added} new ${res.added === 1 ? 'item' : 'items'}` : 'No new items');
    } catch (e) {
      toast(navigator.onLine ? `Refresh failed: ${(e as Error)?.message ?? 'unknown error'}` : 'You are offline', { error: true });
    } finally {
      setRefreshing(false);
    }
  }

  const open = (item: Item) => void navigate(`/item/${encodeURIComponent(item.id)}`);
  const noFeeds = feeds !== undefined && feeds.length === 0;
  const filtered = !!(feedId || cat);

  return (
    <main className="page feed-page">
      <div className="page-head">
        <nav className="tabs" aria-label="Feed views">
          {FEED_VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              className={`tab${view === v.value ? ' active' : ''}`}
              aria-current={view === v.value ? 'page' : undefined}
              onClick={() => update({ view: v.value === 'new' ? null : v.value })}
            >
              {v.label}
              {counts ? <span className="tab-count">{counts[v.value]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <RouterLink className="btn btn-ghost" to="/feeds">
          <Rss /> Manage feeds
        </RouterLink>
      </div>

      {!noFeeds ? (
        <div className="filters">
          <select className="select filter-select" value={feedId ?? ''} aria-label="Filter by feed" onChange={(e) => update({ feed: e.target.value || null })}>
            <option value="">All feeds</option>
            {sortedFeeds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title || f.url}
                {newPerFeed.get(f.id) ? ` (${newPerFeed.get(f.id)})` : ''}
              </option>
            ))}
          </select>
          <CategorySelect className="filter-select" value={cat} onChange={(id) => update({ cat: id })} categories={categories} includeAll aria-label="Filter by category" />
        </div>
      ) : null}

      {list && !noFeeds ? (
        <div className="list-status small muted">
          <span>
            {list.length} {list.length === 1 ? 'item' : 'items'}
          </span>
          <div className="row">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void refresh()} disabled={refreshing}>
              <Refresh /> {refreshing ? 'Checking…' : 'Refresh'}
            </button>
            {view === 'new' && list.length ? (
              <button type="button" className="btn btn-small" onClick={() => void markAllSeen()}>
                <Check /> Mark all as seen
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {noFeeds ? (
        <EmptyState
          icon={<Rss size={32} />}
          title="No feeds yet"
          action={
            <RouterLink className="btn btn-primary" to="/feeds">
              Add a feed
            </RouterLink>
          }
        >
          <p>Follow blogs, newsletters and sites with RSS. New posts show up here; save the ones you want to read to your library.</p>
        </EmptyState>
      ) : list && list.length === 0 ? (
        filtered ? (
          <EmptyState
            title="Nothing here for this filter"
            action={
              <button type="button" className="btn" onClick={() => update({ feed: null, cat: null })}>
                Show all feeds
              </button>
            }
          />
        ) : view === 'new' ? (
          <EmptyState title="You're all caught up">
            <p>
              New posts appear here as your feeds update. <RouterLink to="/feeds">Manage feeds</RouterLink>
            </p>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing seen yet">
            <p>Items you mark as seen move here.</p>
          </EmptyState>
        )
      ) : (
        <ItemList items={list} categories={categories} emptyText="No items" onOpen={open} resetKey={params.toString()} />
      )}
    </main>
  );
}
