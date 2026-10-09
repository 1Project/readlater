/**
 * /highlights — every highlight, grouped by document (newest activity first). Filter, edit notes inline,
 * delete, and export the shown highlights as Markdown.
 */
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import EmptyState from '../components/EmptyState';
import { Download, Highlight as HighlightIcon, Note, Trash } from '../components/Icons';
import Spinner from '../components/Spinner';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/useConfirm';
import { deleteHighlight, updateHighlightNote, useHighlights, useItems } from '../lib/data';
import { normalizeText } from '../lib/filters';
import { itemSource, relativeTime } from '../lib/format';
import type { Highlight } from '../lib/types';
import { dateStamp, downloadText } from './settings/download';
import { groupHighlights, highlightsMarkdown, type ItemHighlights } from './settings/highlightGroups';
import { errorMessage } from './settings/ui';
import './settings.css';

const PAGE = 30;

function HighlightCard({ h, linked }: { h: Highlight; linked: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(h.note);

  function save() {
    setEditing(false);
    const v = note.trim();
    if (v === h.note.trim()) return;
    updateHighlightNote(h.id, v).catch((e: unknown) => toast(`Could not save note: ${errorMessage(e)}`, { error: true }));
  }

  async function remove() {
    const ok = await confirm('Delete this highlight and its note?', { title: 'Delete highlight', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    deleteHighlight(h.id).catch((e: unknown) => toast(`Could not delete: ${errorMessage(e)}`, { error: true }));
  }

  return (
    <li className="hls-card">
      <blockquote className="hls-quote" data-color={h.color ?? 'yellow'}>
        {linked ? (
          <RouterLink className="hls-quote-link" to={`/item/${encodeURIComponent(h.itemId)}?hl=${encodeURIComponent(h.id)}`} title="Open in document">
            {h.text}
          </RouterLink>
        ) : (
          h.text
        )}
      </blockquote>
      {editing ? (
        <div className="hls-note-edit">
          <textarea
            className="textarea"
            value={note}
            aria-label="Note"
            placeholder="Your note"
            maxLength={5000}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setNote(h.note);
                setEditing(false);
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="row">
            <button type="button" className="btn btn-primary btn-small" onClick={save}>
              Save note
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setNote(h.note);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : h.note ? (
        <p className="hls-note">{h.note}</p>
      ) : null}
      {!editing ? (
        <div className="hls-actions">
          <span className="small muted">{relativeTime(h.createdAt) || 'just now'}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setNote(h.note);
              setEditing(true);
            }}
          >
            <Note size={18} /> {h.note ? 'Edit note' : 'Add note'}
          </button>
          <button type="button" className="btn btn-small btn-ghost btn-icon btn-danger" aria-label="Delete highlight" title="Delete" onClick={() => void remove()}>
            <Trash size={18} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

function Group({ g }: { g: ItemHighlights }) {
  const source = g.item ? itemSource(g.item) : '';
  return (
    <section className="hls-group" aria-label={g.item?.title || 'Highlights'}>
      <h2 className="hls-title">
        {g.item ? (
          <RouterLink to={`/item/${encodeURIComponent(g.itemId)}`}>{g.item.title || g.item.url || 'Untitled'}</RouterLink>
        ) : (
          <span className="muted">Deleted document</span>
        )}
      </h2>
      {source ? <p className="small muted hls-source">{source}</p> : null}
      <ul className="hls-list">
        {g.highlights.map((h) => (
          <HighlightCard key={h.id} h={h} linked={!!g.item} />
        ))}
      </ul>
    </section>
  );
}

export default function Highlights() {
  const highlights = useHighlights();
  const items = useItems();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const groups = useMemo(() => (highlights && items ? groupHighlights(highlights, items) : undefined), [highlights, items]);

  const shown = useMemo(() => {
    if (!groups) return undefined;
    const terms = normalizeText(filter).split(' ').filter(Boolean);
    if (!terms.length) return groups;
    const out: ItemHighlights[] = [];
    for (const g of groups) {
      const doc = normalizeText([g.item?.title, g.item?.author, g.item?.siteName, ...(g.item?.tags ?? [])].filter(Boolean).join(' '));
      const hs = g.highlights.filter((h) => {
        const hay = `${doc} ${normalizeText(`${h.text} ${h.note}`)}`;
        return terms.every((t) => hay.includes(t));
      });
      if (hs.length) out.push({ ...g, highlights: hs });
    }
    return out;
  }, [groups, filter]);

  const count = shown?.reduce((n, g) => n + g.highlights.length, 0) ?? 0;

  function exportMd() {
    if (!shown?.length) return;
    downloadText(`readlater-highlights-${dateStamp()}.md`, highlightsMarkdown(shown), 'text/markdown').catch((e: unknown) =>
      toast(`Export failed: ${errorMessage(e)}`, { error: true }),
    );
  }

  if (!groups || !shown) {
    return (
      <main className="page hls-page">
        <Spinner />
      </main>
    );
  }

  return (
    <main className="page hls-page">
      <div className="page-head">
        <h1 className="set-title">Highlights</h1>
        <span className="spacer" />
        {groups.length ? (
          <RouterLink className="btn btn-small" to="/review">
            Daily review
          </RouterLink>
        ) : null}
        <button type="button" className="btn btn-small" onClick={exportMd} disabled={!shown.length}>
          <Download size={18} /> Export Markdown
        </button>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={<HighlightIcon size={32} />} title="No highlights yet">
          <p>Select text while reading and tap “Highlight”. Your highlights and notes from every document collect here.</p>
        </EmptyState>
      ) : (
        <>
          <input
            className="input hls-filter"
            type="search"
            placeholder="Filter highlights, notes and titles"
            aria-label="Filter highlights"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setLimit(PAGE);
            }}
          />
          <p className="small muted" role="status">
            {count} {count === 1 ? 'highlight' : 'highlights'} in {shown.length} {shown.length === 1 ? 'document' : 'documents'}
          </p>
          {shown.length === 0 ? (
            <EmptyState title="No highlights match">
              <button type="button" className="btn" onClick={() => setFilter('')}>
                Clear filter
              </button>
            </EmptyState>
          ) : (
            <>
              {shown.slice(0, limit).map((g) => (
                <Group key={g.itemId} g={g} />
              ))}
              {shown.length > limit ? (
                <div className="row page-center-row">
                  <button type="button" className="btn" onClick={() => setLimit((l) => l + PAGE)}>
                    Show more ({shown.length - limit} more {shown.length - limit === 1 ? 'document' : 'documents'})
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </main>
  );
}
