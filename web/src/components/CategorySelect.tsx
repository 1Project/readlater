/**
 * Category picker built on a native <select> (best on touch screens and e-ink).
 *
 * export default CategorySelect / export { CategorySelect }
 * Props (CategorySelectProps):
 *   value: string | null                   selected category id; null = "No category" (or "All" with includeAll)
 *   onChange: (id: string | null) => void
 *   categories: Category[] | undefined     from useCategories() (undefined while loading)
 *   allowCreate?: boolean                  adds "+ New category…"; choosing it shows an inline name field,
 *                                          calls createCategory(name) and then onChange(newId). An existing
 *                                          name (case-insensitive) just selects that category.
 *   includeAll?: boolean                   filter mode: first option is allLabel and maps to null
 *   allLabel?: string                      default 'All categories'
 *   noneLabel?: string                     default 'No category' (ignored with includeAll)
 *   id?: string; className?: string; disabled?: boolean; 'aria-label'?: string (default 'Category')
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { createCategory } from '../lib/data';
import type { Category } from '../lib/types';
import './components.css';

export interface CategorySelectProps {
  value: string | null;
  onChange: (id: string | null) => void;
  categories: Category[] | undefined;
  allowCreate?: boolean;
  includeAll?: boolean;
  allLabel?: string;
  noneLabel?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

const NEW = '__new__';
const NONE = '';

export function CategorySelect({
  value,
  onChange,
  categories,
  allowCreate,
  includeAll,
  allLabel = 'All categories',
  noneLabel = 'No category',
  id,
  className,
  disabled,
  'aria-label': ariaLabel = 'Category',
}: CategorySelectProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Name of a just-created category until the live subscription delivers it.
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);

  const list = categories ?? [];
  const known = value == null || list.some((c) => c.id === value);

  async function create(e?: FormEvent) {
    e?.preventDefault();
    const n = name.trim();
    if (!n) {
      setError('Enter a name');
      return;
    }
    const existing = list.find((c) => c.name.trim().toLowerCase() === n.toLowerCase());
    if (existing) {
      onChange(existing.id);
      reset();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const newId = await createCategory(n);
      setPending({ id: newId, name: n });
      onChange(newId);
      reset();
    } catch (err) {
      setError((err as Error).message || 'Could not create category');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCreating(false);
    setName('');
    setError(null);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault(); // don't submit an enclosing form
      void create();
    } else if (e.key === 'Escape') {
      e.preventDefault(); // keep an enclosing dialog open
      reset();
    }
  }

  if (creating) {
    return (
      <div className={`category-create${className ? ` ${className}` : ''}`}>
        <div className="row category-create-row">
          <input
            id={id}
            className="input"
            type="text"
            value={name}
            maxLength={60}
            placeholder="New category name"
            aria-label="New category name"
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={reset}>
            Cancel
          </button>
        </div>
        {error ? <div className="error-text small">{error}</div> : null}
      </div>
    );
  }

  return (
    <select
      id={id}
      className={`select category-select${className ? ` ${className}` : ''}`}
      value={value ?? NONE}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) {
          setCreating(true);
          return;
        }
        onChange(v === NONE ? null : v);
      }}
    >
      <option value={NONE}>{includeAll ? allLabel : noneLabel}</option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name || 'Untitled'}
        </option>
      ))}
      {!known && value ? <option value={value}>{pending?.id === value ? pending.name : categories ? 'Deleted category' : 'Loading…'}</option> : null}
      {allowCreate ? <option value={NEW}>+ New category…</option> : null}
    </select>
  );
}

export default CategorySelect;
