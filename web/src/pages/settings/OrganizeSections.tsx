/** Settings › Categories (add, rename, reorder, delete) and Tags (rename / merge, delete). */
import { useMemo, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import { Plus, Trash } from '../../components/Icons';
import Spinner from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/useConfirm';
import { createCategory, deleteCategory, normalizeTag, renameCategory, renameTag, reorderCategories, tagCounts, useCategories, useItems } from '../../lib/data';
import type { Category } from '../../lib/types';
import { errorMessage, Section } from './ui';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function InlineRename({ initial, label, onSave, onCancel }: { initial: string; label: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v || v === initial) onCancel();
    else onSave(v);
  };
  return (
    <form className="set-rename" onSubmit={submit}>
      <input
        className="input"
        value={value}
        aria-label={label}
        maxLength={60}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="row">
        <button type="submit" className="btn btn-primary btn-small">
          Save
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CategoriesSection() {
  const categories = useCategories();
  const items = useItems();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items ?? []) if (i.categoryId) m.set(i.categoryId, (m.get(i.categoryId) ?? 0) + 1);
    return m;
  }, [items]);

  const fail = (what: string) => (e: unknown) => toast(`${what}: ${errorMessage(e)}`, { error: true });

  function add(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (categories?.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      toast(`“${n}” already exists`);
      return;
    }
    setName('');
    createCategory(n).catch(fail('Could not add category'));
  }

  function move(list: Category[], index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((c) => c.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorderCategories(ids).catch(fail('Could not reorder'));
  }

  async function remove(c: Category) {
    const n = counts.get(c.id) ?? 0;
    const ok = await confirm(n ? `${plural(n, 'item')} in “${c.name}” will become uncategorised. Nothing is deleted.` : `Delete the empty category “${c.name}”?`, {
      title: 'Delete category',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    deleteCategory(c.id, items ?? []).catch(fail('Could not delete category'));
  }

  return (
    <Section id="categories" title="Categories" intro="Group your library into a few broad areas. Each item has at most one category.">
      {categories === undefined ? (
        <Spinner />
      ) : categories.length === 0 ? (
        <p className="muted small">No categories yet.</p>
      ) : (
        <ul className="set-list">
          {categories.map((c, i) => (
            <li key={c.id} className="set-list-row">
              {editing === c.id ? (
                <InlineRename
                  initial={c.name}
                  label="Category name"
                  onCancel={() => setEditing(null)}
                  onSave={(v) => {
                    setEditing(null);
                    renameCategory(c.id, v).catch(fail('Could not rename'));
                  }}
                />
              ) : (
                <>
                  <div className="set-list-main">
                    <RouterLink className="set-list-name" to={`/?view=all&cat=${encodeURIComponent(c.id)}`}>
                      {c.name}
                    </RouterLink>
                    <span className="small muted">{plural(counts.get(c.id) ?? 0, 'item')}</span>
                  </div>
                  <div className="set-list-actions">
                    <button type="button" className="btn btn-small btn-icon" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(categories, i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      aria-label={`Move ${c.name} down`}
                      disabled={i === categories.length - 1}
                      onClick={() => move(categories, i, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setEditing(c.id)}>
                      Rename
                    </button>
                    <button type="button" className="btn btn-small btn-icon btn-danger" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
                      <Trash size={18} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="set-inline-form" onSubmit={add}>
        <input className="input" placeholder="New category" aria-label="New category name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={!name.trim() || categories === undefined}>
          <Plus size={18} /> Add
        </button>
      </form>
    </Section>
  );
}

/** Tags listed before "Show all". */
const TOP_TAGS = 8;

export function TagsSection() {
  const items = useItems();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const tags = useMemo(() => (items ? tagCounts(items) : undefined), [items]);
  const matching = useMemo(() => {
    const f = normalizeTag(filter);
    return tags && f ? tags.filter((t) => t.tag.includes(f)) : tags;
  }, [tags, filter]);
  // The most used tags first; the rest behind "Show all" (a long tag list made the page very tall on phones).
  const capped = !all && !filter && !!matching && matching.length > TOP_TAGS;
  const shown = capped ? matching!.slice(0, TOP_TAGS) : matching;

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await work();
      toast(done);
    } catch (e) {
      toast(`Could not update tags: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function rename(oldTag: string, raw: string) {
    setEditing(null);
    const next = normalizeTag(raw);
    if (!next || next === oldTag || !items) return;
    const existing = tags?.find((t) => t.tag === next);
    if (existing) {
      const ok = await confirm(`“${next}” already exists on ${plural(existing.count, 'item')}. Merge “${oldTag}” into it?`, {
        title: 'Merge tags',
        confirmLabel: 'Merge',
      });
      if (!ok) return;
    }
    await run(() => renameTag(oldTag, next, items), existing ? `Merged into “${next}”` : `Renamed to “${next}”`);
  }

  async function remove(tag: string, count: number) {
    if (!items) return;
    const ok = await confirm(`Remove the tag “${tag}” from ${plural(count, 'item')}? The items themselves are kept.`, {
      title: 'Delete tag',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(() => renameTag(tag, '', items), `Deleted “${tag}”`);
  }

  return (
    <Section id="tags" title="Tags" intro="Rename a tag to the name of another one to merge them.">
      {tags === undefined ? (
        <Spinner />
      ) : tags.length === 0 ? (
        <p className="muted small">No tags yet. Add tags when saving or from an item’s menu.</p>
      ) : (
        <>
          {tags.length > TOP_TAGS ? (
            <input className="input set-filter" type="search" placeholder="Filter tags" aria-label="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
          ) : null}
          {busy ? <p className="small muted" role="status">Updating…</p> : null}
          <ul className="set-list">
            {(shown ?? []).map(({ tag, count }) => (
              <li key={tag} className="set-list-row">
                {editing === tag ? (
                  <InlineRename initial={tag} label="Tag name" onCancel={() => setEditing(null)} onSave={(v) => void rename(tag, v)} />
                ) : (
                  <>
                    <div className="set-list-main">
                      <RouterLink className="set-list-name" to={`/?view=all&tag=${encodeURIComponent(tag)}`}>
                        #{tag}
                      </RouterLink>
                      <span className="small muted">{plural(count, 'item')}</span>
                    </div>
                    <div className="set-list-actions">
                      <button type="button" className="btn btn-small" disabled={busy} onClick={() => setEditing(tag)}>
                        Rename
                      </button>
                      <button type="button" className="btn btn-small btn-icon btn-danger" aria-label={`Delete tag ${tag}`} disabled={busy} onClick={() => void remove(tag, count)}>
                        <Trash size={18} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          {capped ? (
            <button type="button" className="btn btn-small set-show-all" onClick={() => setAll(true)}>
              Show all ({matching!.length})
            </button>
          ) : null}
          {shown && shown.length === 0 ? <p className="muted small">No tags match “{filter}”.</p> : null}
        </>
      )}
    </Section>
  );
}
