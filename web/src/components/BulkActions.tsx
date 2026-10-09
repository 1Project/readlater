/**
 * Bulk select for item lists (Library, Feed, Search): a "Select" toggle, the selection state and a sticky
 * action bar.
 *
 * Exports:
 *   useSelection(list: Item[] | undefined, resetKey?: string): Selection
 *     { active, start(), stop(), checkedIds: Set<string> (only ids still in the list), selected: Item[],
 *       toggle(item, on), selectAll(), clear() } — the selection is cleared when resetKey changes
 *   SelectToggle({ selection }): "Select" / "Done" button for the list header
 *   default BulkBar / { BulkBar } props (BulkBarProps):
 *     selection: Selection
 *     categories: Category[] | undefined
 *     tagSuggestions: string[]                 e.g. tagCounts(items).map(t => t.tag)
 *     context?: 'library' | 'feed' | 'search'  picks the primary buttons and labels (feed: Seen / New)
 *
 * Actions: Archive, Unarchive, Favorite (or remove), Add tags… (TagInput dialog), Category… (CategorySelect
 * dialog), Move to Library, Export EPUB (≤ MAX_EPUB_ITEMS, downloads the built book), Delete… (confirmation).
 * Reversible actions offer Undo. Esc leaves select mode (outside fields, dialogs and menus).
 * Usage: pass `selectable={selection.active} checkedIds={selection.checkedIds} onCheck={selection.toggle}` to ItemList
 * and render <BulkBar> after the list while selection.active.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { bulkAddTags, bulkDelete, bulkPatch, bulkUpdate, exportEpub, MAX_EPUB_ITEMS } from '../lib/data';
import type { Category, Item, ItemPatch } from '../lib/types';
import { isNative, openExternal } from '../native';
import CategorySelect from './CategorySelect';
import Dialog from './Dialog';
import { Archive, Book, Check, Folder, Plus, Star, StarFilled, Tag, Trash, Unarchive, Undo } from './Icons';
import { isTypingTarget } from './ItemList';
import Menu, { type MenuEntry } from './Menu';
import TagInput from './TagInput';
import { toast } from './Toast';
import { confirmDialog } from './useConfirm';
import './components.css';

export interface Selection {
  active: boolean;
  start: () => void;
  stop: () => void;
  /** Checked ids that are still in the list. */
  checkedIds: ReadonlySet<string>;
  /** Checked items, in list order. */
  selected: Item[];
  toggle: (item: Item, on: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  /** Number of items in the list (what "Select all" selects). */
  total: number;
}

export function useSelection(list: Item[] | undefined, resetKey?: string): Selection {
  const [active, setActive] = useState(false);
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    setIds(new Set());
  }

  const selected = useMemo(() => (list ?? []).filter((i) => ids.has(i.id)), [list, ids]);
  const checkedIds = useMemo(() => new Set(selected.map((i) => i.id)), [selected]);

  const toggle = useCallback((item: Item, on: boolean) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setIds(new Set((list ?? []).map((i) => i.id))), [list]);
  const clear = useCallback(() => setIds(new Set()), []);
  const start = useCallback(() => setActive(true), []);
  const stop = useCallback(() => {
    setActive(false);
    setIds(new Set());
  }, []);

  return { active, start, stop, checkedIds, selected, toggle, selectAll, clear, total: list?.length ?? 0 };
}

export function SelectToggle({ selection, disabled }: { selection: Selection; disabled?: boolean }) {
  return selection.active ? (
    <button type="button" className="btn btn-small" aria-pressed="true" onClick={selection.stop}>
      Done
    </button>
  ) : (
    <button type="button" className="btn btn-ghost btn-small" onClick={selection.start} disabled={disabled}>
      <Check size={16} /> Select
    </button>
  );
}

export interface BulkBarProps {
  selection: Selection;
  categories: Category[] | undefined;
  tagSuggestions: string[];
  context?: 'library' | 'feed' | 'search';
}

const plural = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

function fail(what: string) {
  return (e: unknown) => {
    console.error(what, e);
    toast(`${what}: ${(e as Error)?.message || 'unknown error'}`, { error: true });
  };
}

/** Apply `patch` to every item, with an Undo that restores each item's previous values. */
function patchAll(items: Item[], patch: ItemPatch, message: string) {
  const keys = Object.keys(patch) as (keyof ItemPatch)[];
  const before = items.map((it) => ({ id: it.id, patch: Object.fromEntries(keys.map((k) => [k, it[k]])) as ItemPatch }));
  bulkUpdate(
    items.map((i) => i.id),
    patch,
  ).catch(fail('Could not update'));
  toast(message, { action: { label: 'Undo', onClick: () => void bulkPatch(before).catch(fail('Could not undo')) } });
}

function startDownload(url: string, name: string) {
  if (isNative()) {
    void openExternal(url).catch(fail('Could not open the EPUB'));
    return;
  }
  // The file is served with Content-Disposition: attachment, so this downloads without leaving the page.
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function BulkBar({ selection, categories, tagSuggestions, context = 'library' }: BulkBarProps) {
  const { selected, total, selectAll, clear, stop } = selection;
  const [dialog, setDialog] = useState<'tags' | 'category' | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const n = selected.length;
  const feed = context === 'feed';

  // Esc leaves select mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('.dialog-backdrop, .menu-list')) return;
      e.preventDefault();
      stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stop]);

  const anyUnread = selected.some((i) => i.status === 'unread');
  const anyArchived = selected.some((i) => i.status === 'archived');
  const allFavorite = n > 0 && selected.every((i) => i.favorite);
  const anyFeed = selected.some((i) => i.location === 'feed');

  const archive = () => {
    const todo = selected.filter((i) => i.status === 'unread');
    patchAll(todo, { status: 'archived' }, feed ? `Marked ${plural(todo.length)} as seen` : `Archived ${plural(todo.length)}`);
    clear();
  };
  const unarchive = () => {
    const todo = selected.filter((i) => i.status === 'archived');
    patchAll(todo, { status: 'unread' }, feed ? `Marked ${plural(todo.length)} as new` : `Moved ${plural(todo.length)} back to Library`);
    clear();
  };
  const favorite = () => {
    const on = !allFavorite;
    const todo = selected.filter((i) => i.favorite !== on);
    patchAll(todo, { favorite: on }, on ? `Added ${plural(todo.length)} to favorites` : `Removed ${plural(todo.length)} from favorites`);
    clear();
  };
  const toLibrary = () => {
    const todo = selected.filter((i) => i.location === 'feed');
    patchAll(todo, { location: 'library', status: 'unread' }, `Saved ${plural(todo.length)} to Library`);
    clear();
  };
  const remove = async () => {
    const items = selected;
    const ok = await confirmDialog(`Delete ${plural(items.length)}? Their highlights are deleted too. This cannot be undone.`, {
      title: 'Delete items',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    bulkDelete(items.map((i) => i.id)).catch(fail('Could not delete'));
    toast(`Deleted ${plural(items.length)}`);
    clear();
  };
  const epub = async () => {
    if (!n || n > MAX_EPUB_ITEMS || exporting) return;
    setExporting(true);
    toast(`Building an EPUB of ${plural(n)}…`, { duration: 60_000 });
    try {
      const res = await exportEpub(selected.map((i) => i.id));
      startDownload(res.url, res.name);
      toast(`EPUB ready: ${res.name}`, { duration: 10_000, action: { label: 'Download again', onClick: () => startDownload(res.url, res.name) } });
    } catch (e) {
      fail('Could not export')(e);
    } finally {
      setExporting(false);
    }
  };
  const openTags = () => {
    setTags([]);
    setDialog('tags');
  };
  const openCategory = () => {
    const shared = selected.every((i) => i.categoryId === selected[0]?.categoryId) ? (selected[0]?.categoryId ?? null) : null;
    setCategoryId(shared);
    setDialog('category');
  };

  const actions = {
    archive: { label: feed ? 'Mark seen' : 'Archive', icon: <Archive size={18} />, onSelect: archive, disabled: !anyUnread },
    unarchive: { label: feed ? 'Mark new' : 'Unarchive', icon: feed ? <Undo size={18} /> : <Unarchive size={18} />, onSelect: unarchive, disabled: !anyArchived },
    favorite: {
      label: allFavorite ? 'Unfavorite' : 'Favorite',
      icon: allFavorite ? <StarFilled size={18} /> : <Star size={18} />,
      onSelect: favorite,
      disabled: !n,
    },
    tags: { label: 'Add tags…', icon: <Tag size={18} />, onSelect: openTags, disabled: !n },
    category: { label: 'Category…', icon: <Folder size={18} />, onSelect: openCategory, disabled: !n },
    library: { label: 'Move to Library', icon: <Plus size={18} />, onSelect: toLibrary, disabled: !anyFeed },
    epub: {
      label: exporting ? 'Exporting EPUB…' : n > MAX_EPUB_ITEMS ? `Export EPUB (max ${MAX_EPUB_ITEMS})` : 'Export EPUB',
      icon: <Book size={18} />,
      onSelect: () => void epub(),
      disabled: !n || n > MAX_EPUB_ITEMS || exporting,
    },
    remove: { label: 'Delete…', icon: <Trash size={18} />, onSelect: () => void remove(), disabled: !n, danger: true },
  };
  type Key = keyof typeof actions;
  const primary: Key[] = feed
    ? ['library', anyUnread || !anyArchived ? 'archive' : 'unarchive', 'tags']
    : [anyUnread || !anyArchived ? 'archive' : 'unarchive', 'favorite', 'tags'];
  const order: Key[] = ['archive', 'unarchive', 'favorite', 'tags', 'category', 'library', 'epub', 'remove'];
  const rest: MenuEntry[] = order
    .filter((k) => !primary.includes(k) && (k !== 'library' || context !== 'library'))
    .map((k) => (k === 'remove' ? (['separator', actions[k]] as MenuEntry[]) : [actions[k] as MenuEntry]))
    .flat();

  const tagItems = selected;
  const applyTags = () => {
    if (!tags.length) {
      setDialog(null);
      return;
    }
    bulkAddTags(tagItems, tags).catch(fail('Could not add tags'));
    toast(`Tagged ${plural(tagItems.length)}`);
    setDialog(null);
    clear();
  };
  const applyCategory = () => {
    const name = categoryId ? (categories?.find((c) => c.id === categoryId)?.name ?? 'the category') : null;
    patchAll(selected, { categoryId }, name ? `Moved ${plural(n)} to ${name}` : `Removed the category from ${plural(n)}`);
    setDialog(null);
    clear();
  };

  return (
    <div className="bulk-bar" role="region" aria-label="Selected items">
      <div className="bulk-bar-head">
        <span className="bulk-count" aria-live="polite">
          {n ? `${n} selected` : 'Tap items to select them'}
        </span>
        {n < total ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={selectAll}>
            Select all ({total})
          </button>
        ) : null}
        {n ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={clear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="bulk-bar-actions" role="toolbar" aria-label="Bulk actions">
        {primary.map((k) => {
          const a = actions[k];
          return (
            <button key={k} type="button" className="btn btn-small" onClick={a.onSelect} disabled={a.disabled}>
              {a.icon} {a.label}
            </button>
          );
        })}
        <Menu items={rest} label="Other bulk actions" align="end" />
      </div>

      <Dialog
        open={dialog === 'tags'}
        onClose={() => setDialog(null)}
        title="Add tags"
        onSubmit={applyTags}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!tags.length}>
              Add tags
            </button>
          </>
        }
      >
        <p className="small muted bulk-dialog-note">Added to {plural(tagItems.length)}; their other tags are kept.</p>
        <TagInput value={tags} onChange={setTags} suggestions={tagSuggestions} autoFocus aria-label="Tags" />
      </Dialog>

      <Dialog
        open={dialog === 'category'}
        onClose={() => setDialog(null)}
        title="Set category"
        onSubmit={applyCategory}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Apply
            </button>
          </>
        }
      >
        <p className="small muted bulk-dialog-note">For {plural(n)}.</p>
        <CategorySelect value={categoryId} onChange={setCategoryId} categories={categories} allowCreate aria-label="Category" />
      </Dialog>
    </div>
  );
}

export default BulkBar;
