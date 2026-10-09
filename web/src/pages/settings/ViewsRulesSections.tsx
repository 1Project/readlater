/**
 * Settings › Saved views (#views: rename, reorder, delete; views are created from the Library's "Save view")
 * and Auto rules (#rules: when <field> <op> <value> then <actions>, applied by the server when an item is
 * first processed).
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import CategorySelect from '../../components/CategorySelect';
import { Plus, Trash } from '../../components/Icons';
import Spinner from '../../components/Spinner';
import TagInput from '../../components/TagInput';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/useConfirm';
import { cleanRule, createRule, deleteRule, deleteView, reorderViews, tagCounts, updateRule, updateView, useCategories, useFeeds, useItems, useRules, useViews } from '../../lib/data';
import { describeViewParams } from '../../lib/filters';
import { typeLabel } from '../../lib/format';
import { ITEM_SOURCES, type Category, type Feed, type ItemSource, type ItemType, type Rule, type RuleField, type RuleInput, type RuleOp, type SavedView } from '../../lib/types';
import { InlineRename } from './OrganizeSections';
import { errorMessage, Section } from './ui';

// ---------------------------------------------------------------------------
// Saved views

export function SavedViewsSection() {
  const views = useViews();
  const categories = useCategories();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const fail = (what: string) => (e: unknown) => toast(`${what}: ${errorMessage(e)}`, { error: true });

  function move(list: SavedView[], index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((v) => v.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorderViews(ids).catch(fail('Could not reorder'));
  }

  async function remove(v: SavedView) {
    const ok = await confirm(`Delete the view “${v.name}”? No items are deleted.`, { title: 'Delete view', confirmLabel: 'Delete', danger: true });
    if (ok) deleteView(v.id).catch(fail('Could not delete view'));
  }

  return (
    <Section
      id="views"
      title="Saved views"
      intro={
        <>
          Filter the <RouterLink to="/">Library</RouterLink> by category, tag or type, then choose <strong>Save view</strong>. Views appear as
          shortcuts above the filters.
        </>
      }
    >
      {views === undefined ? (
        <Spinner />
      ) : views.length === 0 ? (
        <p className="muted small">No saved views yet.</p>
      ) : (
        <ul className="set-list">
          {views.map((v, i) => (
            <li key={v.id} className="set-list-row">
              {editing === v.id ? (
                <InlineRename
                  initial={v.name}
                  label="View name"
                  onCancel={() => setEditing(null)}
                  onSave={(name) => {
                    setEditing(null);
                    updateView(v.id, { name }).catch(fail('Could not rename'));
                  }}
                />
              ) : (
                <>
                  <div className="set-list-main">
                    <RouterLink className="set-list-name" to={v.params ? `/?${v.params}` : '/'}>
                      {v.name}
                    </RouterLink>
                    <span className="small muted">{describeViewParams(v.params, categories)}</span>
                  </div>
                  <div className="set-list-actions">
                    <button type="button" className="btn btn-small btn-icon" aria-label={`Move ${v.name} up`} disabled={i === 0} onClick={() => move(views, i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      aria-label={`Move ${v.name} down`}
                      disabled={i === views.length - 1}
                      onClick={() => move(views, i, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setEditing(v.id)}>
                      Rename
                    </button>
                    <button type="button" className="btn btn-small btn-icon btn-danger" aria-label={`Delete ${v.name}`} onClick={() => void remove(v)}>
                      <Trash size={18} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Auto rules

const FIELDS: { value: RuleField; label: string; placeholder?: string }[] = [
  { value: 'domain', label: 'Site', placeholder: 'example.com' },
  { value: 'url', label: 'Link', placeholder: 'example.com/blog/' },
  { value: 'title', label: 'Title', placeholder: 'weekly digest' },
  { value: 'feed', label: 'Feed' },
  { value: 'type', label: 'Type' },
  { value: 'source', label: 'Saved from' },
];

const OPS: { value: RuleOp; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'contains', label: 'contains' },
  { value: 'endsWith', label: 'ends with' },
];

const TYPES: ItemType[] = ['article', 'tweet', 'paper', 'pdf', 'epub', 'video', 'other'];

const SOURCE_LABELS: Record<ItemSource, string> = {
  web: 'Web app',
  app: 'Phone app',
  extension: 'Browser extension',
  bookmarklet: 'Bookmarklet',
  api: 'API / Shortcut',
  telegram: 'Telegram',
  email: 'Email',
  feed: 'Feed',
  import: 'Import',
};

/** Fields whose value is picked from a list (with the `is` operator). */
function valueOptions(field: RuleField, feeds: Feed[] | undefined): { value: string; label: string }[] | null {
  if (field === 'type') return TYPES.map((t) => ({ value: t, label: typeLabel(t) }));
  if (field === 'source') return ITEM_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }));
  if (field === 'feed') return [...(feeds ?? [])].sort((a, b) => a.title.localeCompare(b.title)).map((f) => ({ value: f.id, label: f.title || f.url }));
  return null;
}

function valueLabel(r: Pick<Rule, 'match'>, feeds: Feed[] | undefined): string {
  const { field, op, value } = r.match;
  if (op === 'is') {
    const opt = valueOptions(field, feeds)?.find((o) => o.value === value);
    if (opt) return opt.label;
  }
  return value;
}

export function describeRule(r: Pick<Rule, 'match' | 'actions'>, categories: Category[] | undefined, feeds: Feed[] | undefined): string {
  const field = FIELDS.find((f) => f.value === r.match.field)?.label ?? r.match.field;
  const op = OPS.find((o) => o.value === r.match.op)?.label ?? r.match.op;
  const then: string[] = [];
  const a = r.actions;
  if (a.addTags?.length) then.push(`add ${a.addTags.map((t) => `#${t}`).join(' ')}`);
  if (a.categoryId !== undefined) then.push(a.categoryId ? `category ${categories?.find((c) => c.id === a.categoryId)?.name ?? '(deleted)'}` : 'no category');
  if (a.location) then.push(a.location === 'feed' ? 'move to Feed' : 'move to Library');
  if (a.favorite) then.push('favorite');
  if (a.archive) then.push('archive');
  return `When ${field.toLowerCase()} ${op} “${valueLabel(r, feeds)}” → ${then.join(', ') || 'nothing'}`;
}

interface Draft {
  name: string;
  field: RuleField;
  op: RuleOp;
  value: string;
  tags: string[];
  categoryId: string | null;
  location: '' | 'library' | 'feed';
  favorite: boolean;
  archive: boolean;
}

const EMPTY: Draft = { name: '', field: 'domain', op: 'is', value: '', tags: [], categoryId: null, location: '', favorite: false, archive: false };

function draftOf(r: Rule): Draft {
  return {
    name: r.name,
    field: r.match.field,
    op: r.match.op,
    value: r.match.value,
    tags: r.actions.addTags ?? [],
    categoryId: r.actions.categoryId ?? null,
    location: r.actions.location ?? '',
    favorite: !!r.actions.favorite,
    archive: !!r.actions.archive,
  };
}

function inputOf(d: Draft, enabled: boolean): RuleInput {
  return {
    name: d.name,
    enabled,
    match: { field: d.field, op: d.op, value: d.value },
    actions: {
      addTags: d.tags,
      ...(d.categoryId ? { categoryId: d.categoryId } : {}),
      ...(d.location ? { location: d.location } : {}),
      favorite: d.favorite,
      archive: d.archive,
    },
  };
}

function RuleForm({
  initial,
  categories,
  feeds,
  tagSuggestions,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  categories: Category[] | undefined;
  feeds: Feed[] | undefined;
  tagSuggestions: string[];
  submitLabel: string;
  onSubmit: (d: Draft) => string | null;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const options = d.op === 'is' ? valueOptions(d.field, feeds) : null;
  const placeholder = FIELDS.find((f) => f.value === d.field)?.placeholder ?? (d.field === 'feed' ? 'part of the feed title' : '');

  function changeField(field: RuleField) {
    // Fields with a fixed list of values start with "is" and the first value.
    const list = valueOptions(field, feeds);
    setD((x) => ({ ...x, field, op: list ? 'is' : x.op, value: list ? (list[0]?.value ?? '') : x.field === field ? x.value : '' }));
  }

  function changeOp(op: RuleOp) {
    const list = op === 'is' ? valueOptions(d.field, feeds) : null;
    setD((x) => ({ ...x, op, value: list && !list.some((o) => o.value === x.value) ? (list[0]?.value ?? '') : x.value }));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(onSubmit(d));
  }

  return (
    <form className="card set-rule-form" onSubmit={submit} noValidate>
      <fieldset className="set-fieldset">
        <legend className="set-label">When</legend>
        <div className="set-rule-when">
          <select className="select" aria-label="Field" value={d.field} onChange={(e) => changeField(e.target.value as RuleField)}>
            {FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Condition" value={d.op} onChange={(e) => changeOp(e.target.value as RuleOp)}>
            {OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {options ? (
            <select className="select set-rule-value" aria-label="Value" value={d.value} onChange={(e) => set('value', e.target.value)}>
              {options.length ? null : <option value="">No feeds yet</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input className="input set-rule-value" aria-label="Value" placeholder={placeholder} value={d.value} maxLength={500} onChange={(e) => set('value', e.target.value)} />
          )}
        </div>
      </fieldset>
      <fieldset className="set-fieldset">
        <legend className="set-label">Then</legend>
        <TagInput value={d.tags} onChange={(t) => set('tags', t)} suggestions={tagSuggestions} placeholder="Add tags…" aria-label="Add tags" />
        <div className="set-rule-then">
          <CategorySelect value={d.categoryId} onChange={(id) => set('categoryId', id)} categories={categories} allowCreate noneLabel="Keep category" aria-label="Set category" />
          <select className="select" aria-label="Move to" value={d.location} onChange={(e) => set('location', e.target.value as Draft['location'])}>
            <option value="">Don’t move</option>
            <option value="library">Move to Library</option>
            <option value="feed">Move to Feed</option>
          </select>
        </div>
        <label className="set-check">
          <input type="checkbox" checked={d.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          <span>Add to favorites</span>
        </label>
        <label className="set-check">
          <input type="checkbox" checked={d.archive} onChange={(e) => set('archive', e.target.checked)} />
          <span>Archive</span>
        </label>
      </fieldset>
      <label className="field">
        <span className="field-label">
          Name <span className="muted">(optional)</span>
        </span>
        <input className="input" value={d.name} maxLength={100} onChange={(e) => set('name', e.target.value)} />
      </label>
      {error ? (
        <p className="error-text small" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function RulesSection() {
  const rules = useRules();
  const categories = useCategories();
  const feeds = useFeeds();
  const items = useItems();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const tagSuggestions = useMemo(() => tagCounts(items ?? []).map((t) => t.tag), [items]);
  const fail = (what: string) => (e: unknown) => toast(`${what}: ${errorMessage(e)}`, { error: true });

  /** Validate first (cleanRule throws a readable message); returns an error message for the form, or null. */
  function save(d: Draft, existing?: Rule): string | null {
    try {
      const input = cleanRule(inputOf(d, existing ? existing.enabled : true));
      if (existing) updateRule(existing.id, input).catch(fail('Could not save rule'));
      else createRule(input).catch(fail('Could not add rule'));
    } catch (e) {
      return errorMessage(e);
    }
    return null;
  }

  async function remove(r: Rule) {
    const ok = await confirm('Delete this rule? Items it already changed stay as they are.', { title: 'Delete rule', confirmLabel: 'Delete', danger: true });
    if (ok) deleteRule(r.id).catch(fail('Could not delete rule'));
  }

  return (
    <Section id="rules" title="Auto rules" intro="Tag, file or archive new items automatically. Rules run once, when an item is saved, in the order listed.">
      {rules === undefined ? (
        <Spinner />
      ) : rules.length === 0 ? (
        <p className="muted small">No rules yet.</p>
      ) : (
        <ul className="set-list">
          {rules.map((r) => (
            <li key={r.id} className="set-list-row">
              {editing === r.id ? (
                <RuleForm
                  initial={draftOf(r)}
                  categories={categories}
                  feeds={feeds}
                  tagSuggestions={tagSuggestions}
                  submitLabel="Save rule"
                  onCancel={() => setEditing(null)}
                  onSubmit={(d) => {
                    const err = save(d, r);
                    if (!err) setEditing(null);
                    return err;
                  }}
                />
              ) : (
                <>
                  <div className="set-list-main">
                    <span className={`set-list-name${r.enabled ? '' : ' muted'}`}>{r.name || describeRule(r, categories, feeds)}</span>
                    {r.name ? <span className="small muted">{describeRule(r, categories, feeds)}</span> : null}
                  </div>
                  <div className="set-list-actions">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={`Rule enabled: ${r.name || describeRule(r, categories, feeds)}`}
                      className={`btn btn-small set-switch${r.enabled ? ' on' : ''}`}
                      onClick={() => updateRule(r.id, { enabled: !r.enabled }).catch(fail('Could not update rule'))}
                    >
                      <span className="set-switch-knob" aria-hidden="true" />
                      <span className="set-switch-state">{r.enabled ? 'On' : 'Off'}</span>
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setEditing(r.id)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-small btn-icon btn-danger" aria-label="Delete rule" onClick={() => void remove(r)}>
                      <Trash size={18} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <RuleForm
          initial={EMPTY}
          categories={categories}
          feeds={feeds}
          tagSuggestions={tagSuggestions}
          submitLabel="Add rule"
          onCancel={() => setAdding(false)}
          onSubmit={(d) => {
            const err = save(d);
            if (!err) {
              setAdding(false);
              toast('Rule added');
            }
            return err;
          }}
        />
      ) : (
        <div className="row">
          <button type="button" className="btn" onClick={() => setAdding(true)} disabled={rules === undefined}>
            <Plus size={18} /> New rule
          </button>
        </div>
      )}
    </Section>
  );
}
