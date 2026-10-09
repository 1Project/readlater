/** Library list: view tabs, filters (category, tag, type), sort. All state lives in the URL query. */
import { useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import CategorySelect from '../components/CategorySelect';
import EmptyState from '../components/EmptyState';
import { Inbox } from '../components/Icons';
import ItemList from '../components/ItemList';
import { tagCounts, useCategories, useItems } from '../lib/data';
import {
  filterItems,
  LIBRARY_VIEWS,
  parseLibraryView,
  parseSort,
  parseTypeFilter,
  SORT_KEYS,
  sortItems,
  TYPE_FILTERS,
  type LibraryView,
} from '../lib/filters';
import type { Item } from '../lib/types';
import './pages.css';

const TOP_TAGS = 8;

export default function Library() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const items = useItems();
  const categories = useCategories();
  const [allTags, setAllTags] = useState(false);

  const view = parseLibraryView(params.get('view'));
  const type = parseTypeFilter(params.get('type'));
  const sort = parseSort(params.get('sort'));
  const tag = params.get('tag') || null;
  const rawCat = params.get('cat') || null;
  // Ignore a category that no longer exists (once categories have loaded).
  const cat = rawCat && categories && !categories.some((c) => c.id === rawCat) ? null : rawCat;
  const filtered = !!(cat || tag || type !== 'all');

  const library = useMemo(() => (items ? items.filter((i) => i.location === 'library') : undefined), [items]);

  const { list, counts, processing } = useMemo(() => {
    if (!library) return { list: undefined, counts: null, processing: 0 };
    const base = filterItems(library, { categoryId: cat, tag, type });
    const counts = Object.fromEntries(LIBRARY_VIEWS.map((v) => [v.value, filterItems(base, { view: v.value }).length])) as Record<LibraryView, number>;
    const inView = filterItems(base, { view });
    const list = sortItems(inView, sort, view === 'archive' ? 'archivedAt' : 'createdAt');
    const processing = inView.filter((i) => i.fetchStatus === 'pending' || i.fetchStatus === 'processing' || i.fetchStatus === 'uploading').length;
    return { list, counts, processing };
  }, [library, cat, tag, type, view, sort]);

  const tags = useMemo(() => tagCounts(library ?? []), [library]);
  const shownTags = allTags ? tags : tags.slice(0, TOP_TAGS);
  const activeTagHidden = tag && !shownTags.some((t) => t.tag === tag);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const open = (item: Item) => void navigate(`/item/${encodeURIComponent(item.id)}`);

  return (
    <main className="page library-page">
      <nav className="tabs" aria-label="Library views">
        {LIBRARY_VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            className={`tab${view === v.value ? ' active' : ''}`}
            aria-current={view === v.value ? 'page' : undefined}
            onClick={() => update({ view: v.value === 'unread' ? null : v.value })}
          >
            {v.label}
            {counts ? <span className="tab-count">{counts[v.value]}</span> : null}
          </button>
        ))}
      </nav>

      <div className="filters">
        <CategorySelect
          className="filter-select"
          value={cat}
          onChange={(id) => update({ cat: id })}
          categories={categories}
          includeAll
          aria-label="Filter by category"
        />
        <select className="select filter-select" value={type} aria-label="Filter by type" onChange={(e) => update({ type: e.target.value === 'all' ? null : e.target.value })}>
          {TYPE_FILTERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select className="select filter-select" value={sort} aria-label="Sort" onChange={(e) => update({ sort: e.target.value === 'new' ? null : e.target.value })}>
          {SORT_KEYS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {tags.length ? (
        <div className="tag-filter" role="group" aria-label="Filter by tag">
          {activeTagHidden ? (
            <button type="button" className="chip active" aria-pressed="true" onClick={() => update({ tag: null })}>
              #{tag}
            </button>
          ) : null}
          {shownTags.map((t) => (
            <button
              key={t.tag}
              type="button"
              className={`chip${t.tag === tag ? ' active' : ''}`}
              aria-pressed={t.tag === tag}
              onClick={() => update({ tag: t.tag === tag ? null : t.tag })}
            >
              #{t.tag} <span className="chip-count">{t.count}</span>
            </button>
          ))}
          {tags.length > TOP_TAGS ? (
            <button type="button" className="chip chip-more" aria-expanded={allTags} onClick={() => setAllTags((x) => !x)}>
              {allTags ? 'fewer' : `more… (${tags.length - TOP_TAGS})`}
            </button>
          ) : null}
        </div>
      ) : null}

      {list ? (
        <div className="list-status small muted" aria-live="polite">
          <span>
            {list.length} {list.length === 1 ? 'item' : 'items'}
            {processing ? ` · fetching ${processing}…` : ''}
          </span>
          {filtered ? (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => update({ cat: null, tag: null, type: null })}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {list && list.length === 0 ? (
        <LibraryEmpty view={view} filtered={filtered} libraryEmpty={(library ?? []).length === 0} onClear={() => update({ cat: null, tag: null, type: null })} />
      ) : (
        <ItemList items={list} categories={categories} emptyText="No items" onOpen={open} resetKey={params.toString()} />
      )}
    </main>
  );
}

function requestAdd() {
  window.dispatchEvent(new CustomEvent('readlater:add'));
}

function LibraryEmpty({ view, filtered, libraryEmpty, onClear }: { view: LibraryView; filtered: boolean; libraryEmpty: boolean; onClear: () => void }) {
  if (libraryEmpty) {
    return (
      <EmptyState
        icon={<Inbox size={32} />}
        title="Your library is empty"
        action={
          <button type="button" className="btn btn-primary" onClick={requestAdd}>
            + Add a link
          </button>
        }
      >
        <p>
          Paste a link with + Add, share from your phone, or use the bookmarklet in <RouterLink to="/settings">Settings</RouterLink>. You can also
          upload PDFs and EPUBs, or follow sites in the <RouterLink to="/feed">Feed</RouterLink>.
        </p>
      </EmptyState>
    );
  }
  if (filtered) {
    return (
      <EmptyState
        title="Nothing matches these filters"
        action={
          <button type="button" className="btn" onClick={onClear}>
            Clear filters
          </button>
        }
      />
    );
  }
  switch (view) {
    case 'unread':
      return (
        <EmptyState
          title="All caught up"
          action={
            <button type="button" className="btn" onClick={requestAdd}>
              + Add a link
            </button>
          }
        >
          <p>
            Nothing left to read. Finished items are in the <RouterLink to="/?view=archive">Archive</RouterLink>; new posts from your feeds
            are in the <RouterLink to="/feed">Feed</RouterLink>.
          </p>
        </EmptyState>
      );
    case 'archive':
      return (
        <EmptyState title="The archive is empty">
          <p>Archive an item when you are done with it — use the archive button on an item, or press e.</p>
        </EmptyState>
      );
    case 'favorites':
      return (
        <EmptyState title="No favorites yet">
          <p>Tap the star on an item (or press s) to keep it here.</p>
        </EmptyState>
      );
    case 'all':
      return <EmptyState title="No items" />;
  }
}
