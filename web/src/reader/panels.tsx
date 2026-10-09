/**
 * Reader dialogs.
 *
 * Exports:
 *   HighlightsPanel   { open, onClose, highlights: Highlight[] (document order), missing: Set<string>,
 *                       onJump(id), onEdit(id), onCopyMarkdown() }
 *                                                       "Highlights (n)" list with jump-to and "Copy as Markdown"
 *   ContentsPanel     { open, onClose, chapters: Chapter[], onJump(index) }   EPUB table of contents
 *   HighlightDialog   { highlight: Highlight | null, onClose }                 edit note / colour, delete
 *   NewNoteDialog     { quote: string | null, color: HighlightColor, onClose, onSave(note, color) }
 *                                                                            note for a new highlight
 *   type Chapter = { title: string; el: Element }
 */
import { useId, useState } from 'react';
import Dialog from '../components/Dialog';
import { toast } from '../components/Toast';
import { deleteHighlight, updateHighlightColor, updateHighlightNote } from '../lib/data';
import type { Highlight, HighlightColor } from '../lib/types';
import { ColorPicker, normalizeColor, writeLastColor } from './HighlightColors';
import { Copy } from './icons';

export interface Chapter {
  title: string;
  el: Element;
}

export function HighlightsPanel({
  open,
  onClose,
  highlights,
  missing,
  onJump,
  onEdit,
  onCopyMarkdown,
}: {
  open: boolean;
  onClose: () => void;
  highlights: Highlight[];
  missing: Set<string>;
  onJump: (id: string) => void;
  onEdit: (id: string) => void;
  onCopyMarkdown: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Highlights (${highlights.length})`}
      className="reader-list-dialog"
      footer={
        highlights.length > 0 ? (
          <button type="button" className="btn" onClick={onCopyMarkdown}>
            <Copy size={18} /> Copy as Markdown
          </button>
        ) : undefined
      }
    >
      {highlights.length === 0 ? (
        <p className="muted">Select text in the article and choose “Highlight” to save a passage.</p>
      ) : (
        <ul className="reader-hl-list">
          {highlights.map((h) => {
            const lost = missing.has(h.id);
            return (
              <li key={h.id} className="reader-hl-entry">
                <button type="button" className="reader-hl-jump" disabled={lost} onClick={() => onJump(h.id)}>
                  <span className="reader-hl-text" data-color={normalizeColor(h.color)}>
                    {h.text}
                  </span>
                  {h.note ? <span className="reader-hl-note">{h.note}</span> : null}
                  {lost ? <span className="small muted">Not found in the current text</span> : null}
                </button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => onEdit(h.id)}>
                  {h.note ? 'Edit note' : 'Add note'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

export function ContentsPanel({ open, onClose, chapters, onJump }: { open: boolean; onClose: () => void; chapters: Chapter[]; onJump: (index: number) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Contents" className="reader-list-dialog">
      {chapters.length === 0 ? (
        <p className="muted">This document has no chapters.</p>
      ) : (
        <ol className="reader-toc">
          {chapters.map((c, i) => (
            <li key={i}>
              <button type="button" className="reader-toc-link" onClick={() => onJump(i)}>
                {c.title}
              </button>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

export function HighlightDialog({ highlight, onClose }: { highlight: Highlight | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [color, setColor] = useState<HighlightColor>('yellow');
  const [forId, setForId] = useState<string | null>(null);
  const fieldId = useId();
  // (Re)initialise when a different highlight is opened.
  if (highlight && highlight.id !== forId) {
    setForId(highlight.id);
    setNote(highlight.note);
    setColor(normalizeColor(highlight.color));
  }
  if (!highlight && forId !== null) setForId(null);

  const save = () => {
    if (!highlight) return;
    if (note.trim() !== highlight.note.trim()) {
      updateHighlightNote(highlight.id, note.trim()).catch((e: unknown) => toast(`Could not save the note: ${(e as Error).message}`, { error: true }));
    }
    if (color !== normalizeColor(highlight.color)) {
      writeLastColor(color);
      updateHighlightColor(highlight.id, color).catch((e: unknown) => toast(`Could not change the colour: ${(e as Error).message}`, { error: true }));
    }
    onClose();
  };

  const remove = () => {
    if (!highlight) return;
    deleteHighlight(highlight.id).catch((e: unknown) => toast(`Could not delete: ${(e as Error).message}`, { error: true }));
    toast('Highlight deleted');
    onClose();
  };

  return (
    <Dialog
      open={!!highlight}
      onClose={onClose}
      title="Highlight"
      onSubmit={save}
      footer={
        <>
          <button type="button" className="btn btn-danger" onClick={remove}>
            Delete
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </>
      }
    >
      {highlight ? (
        <div className="form-stack">
          <blockquote className="reader-quote" data-color={color}>
            {highlight.text}
          </blockquote>
          <div className="field">
            <span className="field-label">Colour</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <label className="field" htmlFor={fieldId}>
            <span className="field-label">Note</span>
            <textarea id={fieldId} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" maxLength={5000} />
          </label>
        </div>
      ) : null}
    </Dialog>
  );
}

export function NewNoteDialog({
  quote,
  color: initialColor,
  onClose,
  onSave,
}: {
  quote: string | null;
  color: HighlightColor;
  onClose: () => void;
  onSave: (note: string, color: HighlightColor) => void;
}) {
  const [note, setNote] = useState('');
  const [color, setColor] = useState<HighlightColor>(initialColor);
  const [forQuote, setForQuote] = useState<string | null>(null);
  const fieldId = useId();
  if (quote !== forQuote) {
    setForQuote(quote);
    setNote('');
    setColor(initialColor);
  }
  return (
    <Dialog
      open={quote !== null}
      onClose={onClose}
      title="Highlight with note"
      onSubmit={() => onSave(note.trim(), color)}
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
        <blockquote className="reader-quote" data-color={color}>
          {quote}
        </blockquote>
        <div className="field">
          <span className="field-label">Colour</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <label className="field" htmlFor={fieldId}>
          <span className="field-label">Note</span>
          <textarea id={fieldId} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why does this matter?" maxLength={5000} />
        </label>
      </div>
    </Dialog>
  );
}
