/**
 * Edit an item's title, tags, category and note.
 *
 * export default EditItemDialog / export { EditItemDialog }
 * Props (EditItemDialogProps):
 *   item: Item | null      the item to edit (dialog renders nothing when null)
 *   open: boolean
 *   onClose: () => void
 *
 * Fields are (re)initialised from `item` each time the dialog opens. Only changed fields are written
 * (via updateItem, not awaited so it works offline); changing the title also sets titleLocked: true so
 * the server never overwrites it. An emptied title falls back to the previous one.
 */
import { useId, useMemo, useState } from 'react';
import { tagCounts, updateItem, useCategories, useItems } from '../lib/data';
import type { Item, ItemPatch } from '../lib/types';
import CategorySelect from './CategorySelect';
import Dialog from './Dialog';
import TagInput from './TagInput';
import { toast } from './Toast';
import './components.css';

export interface EditItemDialogProps {
  item: Item | null;
  open: boolean;
  onClose: () => void;
}

export function EditItemDialog({ item, open, onClose }: EditItemDialogProps) {
  const items = useItems();
  const categories = useCategories();
  const suggestions = useMemo(() => tagCounts(items ?? []).map((t) => t.tag), [items]);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const uid = useId();

  // Re-initialise the fields when the dialog opens or switches to another item (not on every live
  // update of the item while editing). Done during render to avoid a frame with stale values.
  const initKey = open && item ? item.id : null;
  const [initFor, setInitFor] = useState<string | null>(null);
  if (initKey !== initFor) {
    setInitFor(initKey);
    if (initKey && item) {
      setTitle(item.title);
      setTags(item.tags);
      setCategoryId(item.categoryId);
      setNote(item.note);
    }
  }

  if (!item) return null;

  function save() {
    if (!item) return;
    const p: ItemPatch = {};
    const t = title.trim();
    if (t && t !== item.title) {
      p.title = t.slice(0, 500);
      p.titleLocked = true;
    }
    if (tags.join('\n') !== item.tags.join('\n')) p.tags = tags;
    if (categoryId !== item.categoryId) p.categoryId = categoryId;
    if (note !== item.note) p.note = note.slice(0, 20000);
    if (Object.keys(p).length) {
      updateItem(item.id, p).catch((e: unknown) => toast(`Could not save: ${(e as Error)?.message || 'unknown error'}`, { error: true }));
    }
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit"
      onSubmit={save}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div className="field">
          <label htmlFor={`${uid}-title`} className="field-label">
            Title
          </label>
          <textarea
            id={`${uid}-title`}
            className="textarea title-field"
            rows={3}
            value={title}
            maxLength={500}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-tags`} className="field-label">
            Tags
          </label>
          <TagInput id={`${uid}-tags`} value={tags} onChange={setTags} suggestions={suggestions} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-cat`} className="field-label">
            Category
          </label>
          <CategorySelect id={`${uid}-cat`} value={categoryId} onChange={setCategoryId} categories={categories} allowCreate />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-note`} className="field-label">
            Note
          </label>
          <textarea
            id={`${uid}-note`}
            className="textarea"
            rows={4}
            value={note}
            placeholder="Your thoughts on this document…"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}

export default EditItemDialog;
