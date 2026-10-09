/**
 * Background import of links. Runs outside React (module state) so it keeps going when the user
 * leaves the Settings page; progress is observable with useImportProgress().
 *
 * Exports:
 *   interface ImportProgress { label, total, done, added, failed, duplicates, skipped, running, cancelled, errors: string[] }
 *   startImport(label, entries, { duplicates?, skipped?, archiveAll? }): boolean   false if another import is running
 *   cancelImport(): void
 *   clearImport(): void              forget a finished import's summary
 *   useImportProgress(): ImportProgress | null
 */
import { useSyncExternalStore } from 'react';
import { toast } from '../../components/Toast';
import { addUrl } from '../../lib/data';
import type { ImportEntry } from '../../lib/importers';
import { getPrefs } from '../../lib/prefs';

export interface ImportProgress {
  label: string;
  total: number;
  done: number;
  added: number;
  failed: number;
  duplicates: number;
  skipped: number;
  running: boolean;
  cancelled: boolean;
  /** First few failures, "url — reason". */
  errors: string[];
}

const CONCURRENCY = 4;
/** Mutable job being worked on; `snapshot` is the immutable copy React renders. */
let job: ImportProgress | null = null;
let snapshot: ImportProgress | null = null;
let cancelFlag = false;
const listeners = new Set<() => void>();
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function emitNow() {
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  snapshot = job ? { ...job, errors: [...job.errors] } : null;
  listeners.forEach((l) => l());
}

/** Throttled: e-ink screens should not repaint for every single link. */
function emitSoon() {
  if (emitTimer) return;
  emitTimer = setTimeout(emitNow, getPrefs().theme === 'eink' ? 1500 : 300);
}

export function useImportProgress(): ImportProgress | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

export function cancelImport(): void {
  if (job?.running) cancelFlag = true;
}

export function clearImport(): void {
  if (job?.running) return;
  job = null;
  emitNow();
}

export function startImport(label: string, entries: ImportEntry[], opts: { duplicates?: number; skipped?: number; archiveAll?: boolean } = {}): boolean {
  if (job?.running) return false;
  cancelFlag = false;
  const s: ImportProgress = {
    label,
    total: entries.length,
    done: 0,
    added: 0,
    failed: 0,
    duplicates: opts.duplicates ?? 0,
    skipped: opts.skipped ?? 0,
    running: entries.length > 0,
    cancelled: false,
    errors: [],
  };
  job = s;
  emitNow();
  if (!entries.length) return true;

  let next = 0;
  const worker = async () => {
    while (!cancelFlag && next < entries.length) {
      const e = entries[next++];
      try {
        // Keep the original save date (Stats, save order) and archive / favorite in the same write.
        await addUrl(e.url, {
          title: e.title,
          tags: e.tags,
          source: 'import',
          createdAt: e.addedAt ? new Date(e.addedAt) : undefined,
          status: e.archived || opts.archiveAll ? 'archived' : undefined,
          favorite: e.favorite || undefined,
        });
        s.added++;
      } catch (err) {
        s.failed++;
        if (s.errors.length < 5) s.errors.push(`${e.url} — ${(err as Error)?.message || 'failed'}`);
      }
      s.done++;
      emitSoon();
    }
  };

  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker)).then(() => {
    s.running = false;
    s.cancelled = cancelFlag;
    cancelFlag = false;
    emitNow();
    const parts = [`${s.added} ${s.added === 1 ? 'link' : 'links'} imported`];
    if (s.failed) parts.push(`${s.failed} failed`);
    toast(s.cancelled ? `Import stopped: ${parts.join(', ')}` : parts.join(', '), { error: s.failed > 0 && s.added === 0 });
  });
  return true;
}
