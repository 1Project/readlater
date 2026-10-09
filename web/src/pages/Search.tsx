/**
 * Search: instant client-side metadata search (lib/filters searchItems) plus server full-text
 * results (searchFullText callable), merged with metadata matches first. Query in `?q=`, scope in `?in=`.
 * Results found only in the full text show where they matched: a snippet from the copy cached on this
 * device, or "Matched in the full text".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import BulkBar, { SelectToggle, useSelection } from '../components/BulkActions';
import EmptyState from '../components/EmptyState';
import { Close, Search as SearchIcon } from '../components/Icons';
import ItemList from '../components/ItemList';
import { cachedContentText, searchFullText, tagCounts, useCategories, useItems } from '../lib/data';
import { inScope, parseScope, parseSearchQuery, SEARCH_SCOPES, searchItems, textSnippet, type SearchScope, type Snippet } from '../lib/filters';
import type { Item } from '../lib/types';
import './pages.css';

type FullText = { q: string; ids: string[] } | null;

/** Full-text-only results that get a snippet (each reads the device cache only). */
const MAX_SNIPPETS = 30;

export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const items = useItems();
  const categories = useCategories();
  const urlQ = params.get('q') ?? '';
  const scope = parseScope(params.get('in'));
  const [input, setInput] = useState(urlQ);
  const [fullText, setFullText] = useState<FullText>(null);
  const [ftState, setFtState] = useState<'idle' | 'loading' | 'offline' | 'error'>('idle');
  const lastWritten = useRef(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow external URL changes (back/forward, links) without fighting the user's typing.
  if (urlQ !== lastWritten.current) {
    lastWritten.current = urlQ;
    if (urlQ !== input) setInput(urlQ);
  }

  // Debounced URL update so the query survives reloads and back navigation.
  useEffect(() => {
    if (input === lastWritten.current) return;
    const t = window.setTimeout(() => {
      lastWritten.current = input;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (input) next.set('q', input);
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => window.clearTimeout(t);
  }, [input, setParams]);

  // Full-text search via the callable, debounced; stale responses are ignored.
  const q = input.trim();
  const ftQuery = useMemo(() => parseSearchQuery(q).terms.join(' '), [q]);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    if (ftQuery.length < 2) {
      setFtState('idle');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setFtState('offline');
      return;
    }
    setFtState('loading');
    const t = window.setTimeout(() => {
      searchFullText(ftQuery)
        .then((res) => {
          if (id !== reqId.current) return;
          setFullText({ q: ftQuery, ids: res.ids });
          setFtState('idle');
        })
        .catch((e: unknown) => {
          if (id !== reqId.current) return;
          console.warn('full-text search failed', e);
          setFtState(navigator.onLine === false ? 'offline' : 'error');
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [ftQuery]);

  const { results, textOnly } = useMemo(() => {
    if (!items || !q) return { results: undefined, textOnly: [] as Item[] };
    const meta = searchItems(items, q).filter((i) => inScope(i, scope));
    // Full-text ids apply only if they belong to the current free-text terms; #tag filters still apply.
    if (!fullText || fullText.q !== ftQuery) return { results: meta, textOnly: [] as Item[] };
    const tags = parseSearchQuery(q).tags;
    const seen = new Set(meta.map((i) => i.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const extra: Item[] = [];
    for (const id of fullText.ids) {
      const it = byId.get(id);
      if (!it || seen.has(id) || !inScope(it, scope)) continue;
      if (tags.length && !tags.every((t) => it.tags.some((tag) => tag.startsWith(t)))) continue;
      seen.add(id);
      extra.push(it);
    }
    return { results: [...meta, ...extra], textOnly: extra };
  }, [items, q, scope, fullText, ftQuery]);

  // Where a full-text-only result matched, from the content cached on this device.
  const [found, setFound] = useState<{ q: string; byId: Map<string, Snippet | null> }>({ q: '', byId: new Map() });
  const textOnlyKey = textOnly
    .slice(0, MAX_SNIPPETS)
    .map((i) => `${i.id}:${i.contentChunks}`)
    .join(',');
  useEffect(() => {
    if (!textOnlyKey) return;
    const terms = parseSearchQuery(ftQuery).terms;
    const todo = textOnly.slice(0, MAX_SNIPPETS);
    let alive = true;
    void Promise.all(todo.map(async (it) => [it.id, textSnippet((await cachedContentText(it)) ?? '', terms)] as const)).then((pairs) => {
      if (alive) setFound({ q: ftQuery, byId: new Map(pairs) });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textOnlyKey, ftQuery]);
  const snippets = useMemo(() => {
    const m = new Map<string, ReactNode>();
    for (const it of textOnly) {
      const sn = found.q === ftQuery ? found.byId.get(it.id) : undefined;
      m.set(
        it.id,
        sn ? (
          <>
            {sn.before}
            <mark>{sn.match}</mark>
            {sn.after}
          </>
        ) : (
          <em>Matched in the full text</em>
        ),
      );
    }
    return m;
  }, [textOnly, found, ftQuery]);

  function setScope(s: SearchScope) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (s === 'all') next.delete('in');
        else next.set('in', s);
        return next;
      },
      { replace: true },
    );
  }

  const open = (item: Item) => void navigate(`/item/${encodeURIComponent(item.id)}`);
  const selection = useSelection(results, `${q}|${scope}`);
  const tagSuggestions = useMemo(() => tagCounts(items ?? []).map((t) => t.tag), [items]);

  return (
    <main className="page search-page">
      <h1 className="visually-hidden">Search</h1>
      <form
        className="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          inputRef.current?.blur();
        }}
      >
        <SearchIcon className="search-box-icon" />
        <input
          ref={inputRef}
          id="search-input"
          className="input search-input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Search your library"
          aria-label="Search"
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && input) {
              e.preventDefault();
              setInput('');
            }
          }}
        />
        {input ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon search-clear"
            aria-label="Clear search"
            onClick={() => {
              setInput('');
              inputRef.current?.focus();
            }}
          >
            <Close />
          </button>
        ) : null}
      </form>

      <div className="scope-chips" role="group" aria-label="Search in">
        {SEARCH_SCOPES.map((s) => (
          <button key={s.value} type="button" className={`chip${scope === s.value ? ' active' : ''}`} aria-pressed={scope === s.value} onClick={() => setScope(s.value)}>
            {s.label}
          </button>
        ))}
      </div>

      {q ? (
        <>
          <div className="list-status small muted" aria-live="polite">
            <span>{results ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : ''}</span>
            <span className="row">
              <span>
                {ftState === 'loading'
                  ? 'Searching full text…'
                  : ftState === 'offline'
                    ? 'Offline — searching titles and tags only'
                    : ftState === 'error'
                      ? 'Full-text search unavailable — showing title and tag matches'
                      : ''}
              </span>
              {results?.length ? <SelectToggle selection={selection} /> : null}
            </span>
          </div>
          <ItemList
            items={results}
            categories={categories}
            emptyText={ftState === 'loading' ? 'Searching…' : `Nothing found for “${q}”`}
            onOpen={open}
            resetKey={`${q}|${scope}`}
            selectable={selection.active}
            checkedIds={selection.checkedIds}
            onCheck={selection.toggle}
            snippets={snippets}
          />
          {selection.active && results?.length ? <BulkBar selection={selection} categories={categories} tagSuggestions={tagSuggestions} context="search" /> : null}
        </>
      ) : (
        <EmptyState title="Search everything you saved">
          <p>Matches titles, authors, sites, tags and notes instantly, and the full text of articles, papers and books. Use #tag to filter by tag.</p>
        </EmptyState>
      )}
    </main>
  );
}
