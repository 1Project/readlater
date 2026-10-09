/**
 * List of ItemRows with paging ("Show more", no infinite scroll — friendlier to e-ink) and
 * keyboard navigation.
 *
 * export default ItemList / export { ItemList }
 * Props (ItemListProps):
 *   items: Item[] | undefined          undefined = loading (shows a Spinner)
 *   categories: Category[] | undefined
 *   emptyText: ReactNode               shown (in an EmptyState) when items is []
 *   onOpen: (item: Item) => void       e.g. item => navigate(`/item/${item.id}`)
 *   compact?: boolean                  default: prefs.listDensity === 'compact'
 *   pageSize?: number                  default 50
 *   resetKey?: string                  when it changes (e.g. the filter query string) paging and selection reset
 *   keyboard?: boolean                 default true; set false when two lists share a page
 *   selectable?: boolean               bulk-select mode (checkboxes on rows; see ItemRow); `x` toggles the selected row
 *   checkedIds?: ReadonlySet<string>   checked rows in selectable mode
 *   onCheck?: (item: Item, checked: boolean) => void
 *   snippets?: ReadonlyMap<string, ReactNode>  per item id: shown instead of the excerpt (search: where the text matched)
 *
 * Keys (ignored while typing in a field, with modifier keys, or while a dialog is open):
 *   j / k  next / previous item      Enter / o  open selected
 *   e      archive / unarchive (feed: seen / new)      s  toggle favorite
 *   x      check / uncheck the selected row (only in selectable mode)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePrefs } from '../lib/prefs';
import type { Category, Item } from '../lib/types';
import EmptyState from './EmptyState';
import ItemRow from './ItemRow';
import { toggleArchive, toggleFavorite } from './itemActions';
import Spinner from './Spinner';
import './components.css';

export interface ItemListProps {
  items: Item[] | undefined;
  categories: Category[] | undefined;
  emptyText: ReactNode;
  onOpen: (item: Item) => void;
  compact?: boolean;
  pageSize?: number;
  resetKey?: string;
  keyboard?: boolean;
  selectable?: boolean;
  checkedIds?: ReadonlySet<string>;
  onCheck?: (item: Item, checked: boolean) => void;
  snippets?: ReadonlyMap<string, ReactNode>;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

export function ItemList({
  items,
  categories,
  emptyText,
  onOpen,
  compact,
  pageSize = 50,
  resetKey,
  keyboard = true,
  selectable = false,
  checkedIds,
  onCheck,
  snippets,
}: ItemListProps) {
  const prefs = usePrefs();
  const isCompact = compact ?? prefs.listDensity === 'compact';
  const [limit, setLimit] = useState(pageSize);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prevReset, setPrevReset] = useState(resetKey);
  const lastIndex = useRef(-1);
  const listRef = useRef<HTMLDivElement>(null);

  if (resetKey !== prevReset) {
    setPrevReset(resetKey);
    setLimit(pageSize);
    setSelectedId(null);
  }

  const list = items ?? [];
  const selectedIndex = selectedId ? list.findIndex((i) => i.id === selectedId) : -1;
  if (selectedIndex >= 0) lastIndex.current = selectedIndex;

  // The selected item left the list (archived, deleted…): select its neighbour instead.
  useEffect(() => {
    if (selectedId && selectedIndex < 0 && items) {
      const next = list[Math.min(lastIndex.current, list.length - 1)];
      setSelectedId(next ? next.id : null);
    }
  }, [selectedId, selectedIndex, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Latest values for the global key handler without re-binding it on every render.
  const state = useRef({ list, selectedIndex, onOpen, selectable, checkedIds, onCheck });
  state.current = { list, selectedIndex, onOpen, selectable, checkedIds, onCheck };

  // Keep the selected row visible and within the rendered page — only when the selection moves,
  // not on live list updates or "Show more".
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const scrollTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    scrollTarget.current = selectedId;
    const idx = state.current.list.findIndex((i) => i.id === selectedId);
    if (idx >= limitRef.current) setLimit(Math.ceil((idx + 1) / pageSize) * pageSize);
  }, [selectedId, pageSize]);
  useEffect(() => {
    const id = scrollTarget.current;
    if (!id) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
    if (el) {
      scrollTarget.current = null;
      el.scrollIntoView?.({ block: 'nearest' });
    }
  });

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('.dialog-backdrop, .menu-list')) return;
      const { list: l, selectedIndex: i, onOpen: open, selectable: selecting, checkedIds: checked, onCheck: check } = state.current;
      if (!l.length) return;
      const cur = i >= 0 ? l[i] : null;
      switch (e.key) {
        case 'j':
          e.preventDefault();
          setSelectedId(l[Math.min(i + 1, l.length - 1)].id);
          break;
        case 'k':
          e.preventDefault();
          setSelectedId(l[Math.max(i - 1, 0)].id);
          break;
        case 'Enter':
        case 'o': {
          // Enter on a focused link/button keeps its native behaviour.
          if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.closest('a, button')) return;
          if (!cur) return;
          e.preventDefault();
          open(cur);
          break;
        }
        case 'e':
          if (!cur) return;
          e.preventDefault();
          toggleArchive(cur);
          break;
        case 's':
          if (!cur) return;
          e.preventDefault();
          toggleFavorite(cur);
          break;
        case 'x':
          if (!cur || !selecting || !check) return;
          e.preventDefault();
          check(cur, !checked?.has(cur.id));
          break;
        default:
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyboard]);

  if (!items) return <Spinner />;
  if (items.length === 0) return <EmptyState title={emptyText} />;

  const shown = items.slice(0, limit);
  const remaining = items.length - shown.length;

  return (
    <div className="item-list" ref={listRef}>
      {shown.map((it) => (
        <ItemRow
          key={it.id}
          item={it}
          categories={categories}
          onOpen={onOpen}
          selected={it.id === selectedId}
          compact={isCompact}
          selectable={selectable}
          checked={selectable && !!checkedIds?.has(it.id)}
          onCheck={onCheck}
          snippet={snippets?.get(it.id)}
        />
      ))}
      {remaining > 0 ? (
        <div className="item-list-more">
          <button type="button" className="btn" onClick={() => setLimit((n) => n + pageSize)}>
            Show more ({remaining} left)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default ItemList;
