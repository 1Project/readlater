/**
 * "Add" dialog: save a link, or upload a PDF / EPUB.
 *
 * export default AddDialog / export { AddDialog }
 * Props (AddDialogProps):
 *   open: boolean
 *   onClose: () => void
 *   onSaved?: (id: string) => void    called with the new (or existing) item id after saving
 *   initialUrl?: string               pre-fill the link field (e.g. from a global paste / drop)
 *   initialFile?: File | null         pre-select a file (e.g. from a global file drop)
 *
 * Link: text field (focused on open) + "Paste" button (navigator.clipboard.readText when available).
 * File: "Choose PDF or EPUB" button (≤ 100 MB) with upload progress; closing during an upload keeps
 * it running in the background and reports the result with a toast.
 * Tags (TagInput, suggestions from existing tags) and category (CategorySelect with "+ New category…").
 * Files and links can be dropped onto the dialog. Uses addUrl / uploadFile from lib/data. After a save
 * a toast with an "Open" action is shown.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { addUrl, extractUrl, MAX_UPLOAD_BYTES, tagCounts, uploadFile, useCategories, useItems } from '../lib/data';
import { formatBytes } from '../lib/format';
import CategorySelect from './CategorySelect';
import Dialog from './Dialog';
import { Close, Upload } from './Icons';
import ProgressBar from './ProgressBar';
import TagInput from './TagInput';
import { toast } from './Toast';
import './components.css';

export interface AddDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (id: string) => void;
  initialUrl?: string;
  initialFile?: File | null;
}

const ACCEPT = '.pdf,.epub,application/pdf,application/epub+zip';

function fileProblem(f: File): string | null {
  const n = f.name.toLowerCase();
  const ok = n.endsWith('.pdf') || n.endsWith('.epub') || f.type === 'application/pdf' || f.type === 'application/epub+zip';
  if (!ok) return 'Only PDF and EPUB files can be uploaded.';
  if (f.size > MAX_UPLOAD_BYTES) return `File is too large (${formatBytes(f.size)}). The limit is 100 MB.`;
  return null;
}

export function AddDialog({ open, onClose, onSaved, initialUrl, initialFile }: AddDialogProps) {
  const navigate = useNavigate();
  const items = useItems();
  const categories = useCategories();
  const suggestions = useMemo(() => tagCounts(items ?? []).map((t) => t.tag), [items]);
  const uid = useId();

  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  // Reset the form each time the dialog opens (state set during render, see React docs
  // "adjusting state when a prop changes").
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && !busy) {
      setUrl(initialUrl ?? '');
      const problem = initialFile ? fileProblem(initialFile) : null;
      setFile(initialFile && !problem ? initialFile : null);
      setError(problem);
      setTags([]);
      setCategoryId(null);
      setProgress(null);
      setDragging(false);
    }
  }

  function chooseFile(f: File | null | undefined) {
    if (!f) return;
    const problem = fileProblem(f);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(f);
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      const found = extractUrl(text);
      if (found) {
        setUrl(found);
        setError(null);
      } else {
        setError(text.trim() ? 'The clipboard does not contain a link.' : 'The clipboard is empty.');
      }
    } catch {
      setError('Clipboard access was blocked. Long-press the field and paste instead.');
    }
    urlInput.current?.focus();
  }

  function done(id: string, label: string) {
    onSaved?.(id);
    toast(label, { action: { label: 'Open', onClick: () => navigate(`/item/${encodeURIComponent(id)}`) } });
  }

  async function submit() {
    if (busy) return;
    setError(null);
    if (file) {
      setBusy(true);
      setProgress(0);
      const name = file.name;
      try {
        const id = await uploadFile(file, name, { tags, categoryId, onProgress: setProgress });
        setBusy(false);
        setProgress(null);
        if (openRef.current) onClose();
        done(id, `Uploaded “${name}”`);
      } catch (e) {
        setBusy(false);
        setProgress(null);
        const msg = (e as Error)?.message || 'Upload failed';
        if (openRef.current) setError(msg);
        else toast(`Upload of “${name}” failed: ${msg}`, { error: true });
      }
      return;
    }
    const target = extractUrl(url);
    if (!target) {
      setError(url.trim() ? 'That does not look like a link.' : 'Enter a link or choose a file.');
      urlInput.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const id = await addUrl(target, { tags, categoryId });
      setBusy(false);
      onClose();
      done(id, 'Saved to Library');
    } catch (e) {
      setBusy(false);
      setError((e as Error)?.message || 'Could not save the link');
    }
  }

  function close() {
    if (busy && file) toast(`Uploading “${file.name}” in the background…`);
    onClose();
  }

  // Drag & drop anywhere on the page while the dialog is open (this also stops the browser from
  // navigating away to a dropped file when it misses the dialog).
  const dropRef = useRef({ busy, chooseFile, setUrl, setFile, setError });
  dropRef.current = { busy, chooseFile, setUrl, setFile, setError };
  useEffect(() => {
    if (!open) return;
    const accepts = (e: DragEvent) => {
      const types = [...(e.dataTransfer?.types ?? [])];
      return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
    };
    const onOver = (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = dropRef.current.busy ? 'none' : 'copy';
      setDragging(!dropRef.current.busy);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false); // left the window
    };
    const onDrop = (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      setDragging(false);
      const d = dropRef.current;
      if (d.busy || !e.dataTransfer) return;
      const f = e.dataTransfer.files?.[0];
      if (f) {
        d.chooseFile(f);
        return;
      }
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      const found = extractUrl(text.split(/\r?\n/).find((l) => l && !l.startsWith('#')) ?? '');
      if (found) {
        d.setFile(null);
        d.setUrl(found);
        d.setError(null);
      } else {
        d.setError('Drop a link, a PDF or an EPUB file.');
      }
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      setDragging(false);
    };
  }, [open]);

  const uploading = busy && !!file;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add to Library"
      onSubmit={() => void submit()}
      className={`add-dialog${dragging ? ' dragging' : ''}`}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {uploading ? 'Hide' : 'Cancel'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {uploading ? 'Uploading…' : busy ? 'Saving…' : file ? 'Upload' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-stack">
        {file ? (
          <div className="field">
            <span className="field-label">File</span>
            <div className="add-file">
              <span className="add-file-name truncate">{file.name}</span>
              <span className="muted small">{formatBytes(file.size)}</span>
              {!busy ? (
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove file" onClick={() => setFile(null)}>
                  <Close />
                </button>
              ) : null}
            </div>
            {progress != null ? (
              <div className="add-progress">
                <ProgressBar value={progress} size="normal" label="Upload progress" />
                <span className="small muted">{Math.round(progress * 100)}%</span>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${uid}-url`} className="field-label">
                Link
              </label>
              <div className="add-url-row">
                <input
                  ref={urlInput}
                  id={`${uid}-url`}
                  className="input"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  placeholder="https://…"
                  value={url}
                  disabled={busy}
                  data-autofocus
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(null);
                  }}
                />
                {canPaste ? (
                  <button type="button" className="btn" onClick={() => void paste()} disabled={busy}>
                    Paste
                  </button>
                ) : null}
              </div>
            </div>
            <div className="add-or">
              <span>or</span>
            </div>
            <div className="field">
              <button type="button" className="btn add-file-button" onClick={() => fileInput.current?.click()} disabled={busy}>
                <Upload /> Choose PDF or EPUB
              </button>
              <span className="small muted">Up to 100 MB. You can also drop a file or link here.</span>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  chooseFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor={`${uid}-tags`} className="field-label">
            Tags <span className="muted">(optional)</span>
          </label>
          <TagInput id={`${uid}-tags`} value={tags} onChange={setTags} suggestions={suggestions} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-cat`} className="field-label">
            Category <span className="muted">(optional)</span>
          </label>
          <CategorySelect id={`${uid}-cat`} value={categoryId} onChange={setCategoryId} categories={categories} allowCreate disabled={busy} />
        </div>
        {error ? (
          <p className="error-text small" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export default AddDialog;
