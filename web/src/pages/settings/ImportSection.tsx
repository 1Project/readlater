/**
 * Settings › Import: paste links, or import a Pocket / Instapaper / Readwise Reader export, browser bookmarks
 * or an OPML feed list. Parsing is in lib/importers; links are saved in the background by importRunner.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import ProgressBar from '../../components/ProgressBar';
import { useToast } from '../../components/Toast';
import { importOpml, useItems } from '../../lib/data';
import { dedupeEntries, FORMAT_LABELS, parseImport, parseUrlList, type ImportEntry, type ImportFormat } from '../../lib/importers';
import { cancelImport, clearImport, startImport, useImportProgress } from './importRunner';
import { errorMessage, Section, Switch } from './ui';

const ACCEPT = '.csv,.html,.htm,.txt,.opml,.xml,text/csv,text/html,text/plain,text/x-opml,application/xml,text/xml';

interface Preview {
  name: string;
  format: ImportFormat;
  fresh: ImportEntry[];
  duplicates: number;
  skipped: number;
  archived: number;
}

export function ImportSection() {
  const items = useItems();
  const progress = useImportProgress();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [archiveAll, setArchiveAll] = useState(false);
  const [opmlBusy, setOpmlBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const running = !!progress?.running;
  const ready = items !== undefined;

  function prepare(name: string, format: ImportFormat, entries: ImportEntry[], skipped: number): Preview {
    const { fresh, duplicates } = dedupeEntries(
      entries,
      (items ?? []).map((i) => i.url),
    );
    return { name, format, fresh, duplicates, skipped, archived: fresh.filter((e) => e.archived).length };
  }

  function importPasted() {
    const entries = parseUrlList(text);
    if (!entries.length) {
      setMessage('No links found. Put one link per line.');
      return;
    }
    const p = prepare('Pasted links', 'urls', entries, 0);
    setMessage(null);
    if (!p.fresh.length) {
      setMessage(`All ${entries.length} links are already saved.`);
      return;
    }
    if (startImport('Pasted links', p.fresh, { duplicates: p.duplicates })) setText('');
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMessage(null);
    setPreview(null);
    if (file.size > 50 * 1024 * 1024) {
      setMessage('That file is too large (max 50 MB).');
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch (err) {
      setMessage(`Could not read the file: ${errorMessage(err)}`);
      return;
    }
    const parsed = parseImport(file.name, content);
    if (parsed.format === 'opml') {
      setOpmlBusy(true);
      try {
        const res = await importOpml(content);
        const failed = res.failed.length ? ` ${res.failed.length} could not be added: ${res.failed.slice(0, 5).join(', ')}${res.failed.length > 5 ? '…' : ''}` : '';
        setMessage(`Subscribed to ${res.feeds} ${res.feeds === 1 ? 'feed' : 'feeds'}.${failed}`);
      } catch (err) {
        setMessage(`Could not import feeds: ${errorMessage(err)}`);
      } finally {
        setOpmlBusy(false);
      }
      return;
    }
    if (!parsed.entries.length) {
      setMessage(`No links found in ${file.name}.`);
      return;
    }
    setPreview(prepare(file.name, parsed.format, parsed.entries, parsed.skipped));
  }

  function confirmFile() {
    if (!preview) return;
    if (!startImport(`${FORMAT_LABELS[preview.format]} · ${preview.name}`, preview.fresh, { duplicates: preview.duplicates, skipped: preview.skipped, archiveAll })) {
      toast('Another import is still running');
      return;
    }
    setPreview(null);
  }

  return (
    <Section id="import" title="Import" intro="Bring your reading list from elsewhere. Links already in Readlater are skipped.">
      <div className="set-sub">
        <label className="set-sub-title" htmlFor="import-urls">
          Paste links
        </label>
        <textarea
          id="import-urls"
          className="textarea"
          rows={5}
          placeholder={'https://example.com/article\nhttps://example.org/post'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row">
          <button type="button" className="btn" disabled={!text.trim() || running || !ready} onClick={importPasted}>
            Import links
          </button>
          <span className="small muted">One per line.</span>
        </div>
      </div>

      <div className="set-sub">
        <h3 className="set-sub-title">Import a file</h3>
        <ul className="small set-formats">
          <li>Pocket export (CSV, or the older HTML file)</li>
          <li>Instapaper CSV</li>
          <li>Readwise Reader CSV export</li>
          <li>Browser bookmarks (HTML)</li>
          <li>
            OPML — subscribes to the feeds (see <RouterLink to="/feeds">Feeds</RouterLink>)
          </li>
        </ul>
        <input ref={fileRef} type="file" accept={ACCEPT} className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} />
        <button type="button" className="btn" disabled={running || !ready || opmlBusy} onClick={() => fileRef.current?.click()}>
          {opmlBusy ? 'Importing feeds…' : 'Choose file…'}
        </button>
      </div>

      {preview ? (
        <div className="set-key-box">
          <p>
            <strong>{preview.name}</strong> <span className="small muted">({FORMAT_LABELS[preview.format]})</span>
          </p>
          <p className="small">
            {preview.fresh.length} new {preview.fresh.length === 1 ? 'link' : 'links'}
            {preview.archived ? `, ${preview.archived} of them archived` : ''}
            {preview.duplicates ? ` · ${preview.duplicates} already saved or repeated` : ''}
            {preview.skipped ? ` · ${preview.skipped} skipped` : ''}
          </p>
          {preview.fresh.length ? (
            <>
              <Switch label="Put everything in the Archive" description="Useful for large bookmark collections you don’t plan to read soon." checked={archiveAll} onChange={setArchiveAll} />
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={confirmFile} disabled={running}>
                  Import {preview.fresh.length}
                </button>
                <button type="button" className="btn" onClick={() => setPreview(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                OK
              </button>
            </div>
          )}
        </div>
      ) : null}

      {message ? (
        <p className="small" role="status">
          {message}
        </p>
      ) : null}

      {progress ? (
        <div className="set-progress" role="status" aria-live="polite">
          <p className="small">
            <strong>{progress.label}</strong>
          </p>
          {progress.running ? <ProgressBar value={progress.total ? progress.done / progress.total : 0} size="normal" label="Import progress" /> : null}
          <p className="small">
            {progress.running ? `Saving ${progress.done} of ${progress.total}…` : progress.cancelled ? 'Stopped.' : 'Done.'} {progress.added} added
            {progress.failed ? `, ${progress.failed} failed` : ''}
            {progress.duplicates ? `, ${progress.duplicates} already saved` : ''}
            {progress.skipped ? `, ${progress.skipped} skipped` : ''}.
            {progress.running ? ' You can leave this page; the import continues in the background.' : ' Articles are fetched in the background.'}
          </p>
          {progress.errors.length ? (
            <ul className="small error-text set-errors">
              {progress.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div className="row">
            {progress.running ? (
              <button type="button" className="btn btn-small" onClick={cancelImport}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn btn-small" onClick={clearImport}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      ) : null}
    </Section>
  );
}
