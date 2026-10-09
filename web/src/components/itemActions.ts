/**
 * Item actions shared by ItemRow, ItemList keyboard shortcuts and (optionally) the reader.
 * Writes are not awaited (offline-friendly); failures surface as an error toast.
 * Reversible actions show a toast with "Undo".
 *
 * Exports (all take an Item):
 *   toggleFavorite(item): void
 *   toggleArchive(item): void      library: unread <-> archived; feed items: same as toggleSeen
 *   toggleSeen(item): void         feed: unread (new) <-> archived (seen)
 *   saveToLibrary(item): void      feed -> library, status unread
 *   retryFetch(item): void         refetchItem (sets fetchStatus 'pending')
 *   canRefetch(item): boolean      "Fetch again" is possible: done / error, or a run that has not finished in
 *                                  STALE_PROCESSING_MS (the server refuses to queue an item while a run is live)
 *   isStalled(item): boolean       processing for longer than STALE_PROCESSING_MS
 *   deleteWithConfirm(item): Promise<boolean>   asks first (useConfirm), resolves true when deleted
 *   openOriginal(item): void       opens item.url, or the stored file (pdf/epub) via fileUrl(), with openExternal()
 */
import { deleteItem, fileUrl, refetchItem, updateItem } from '../lib/data';
import type { Item, ItemPatch } from '../lib/types';
import { openExternal } from '../native';
import { toast } from './Toast';
import { confirmDialog } from './useConfirm';

function fail(what: string) {
  return (e: unknown) => {
    console.error(what, e);
    toast(`${what}: ${(e as Error)?.message || 'unknown error'}`, { error: true });
  };
}

function patch(item: Item, p: ItemPatch, what = 'Could not update') {
  updateItem(item.id, p).catch(fail(what));
}

export function toggleFavorite(item: Item): void {
  patch(item, { favorite: !item.favorite });
}

export function toggleSeen(item: Item): void {
  const seen = item.status === 'archived';
  patch(item, { status: seen ? 'unread' : 'archived' });
  toast(seen ? 'Marked as new' : 'Marked as seen', {
    action: { label: 'Undo', onClick: () => patch(item, { status: item.status }) },
  });
}

export function toggleArchive(item: Item): void {
  if (item.location === 'feed') {
    toggleSeen(item);
    return;
  }
  const archived = item.status === 'archived';
  patch(item, { status: archived ? 'unread' : 'archived' });
  toast(archived ? 'Moved back to Library' : 'Archived', {
    action: { label: 'Undo', onClick: () => patch(item, { status: item.status }) },
  });
}

export function saveToLibrary(item: Item): void {
  patch(item, { location: 'library', status: 'unread' }, 'Could not save');
  toast('Saved to Library', {
    action: { label: 'Undo', onClick: () => patch(item, { location: item.location, status: item.status }) },
  });
}

export function retryFetch(item: Item): void {
  refetchItem(item.id).catch(fail('Could not retry'));
}

/** Same as the server's limit (firestore.rules requeueAllowed): a run older than this is dead. */
export const STALE_PROCESSING_MS = 10 * 60_000;

export function isStalled(item: Item, now = Date.now()): boolean {
  if (item.fetchStatus !== 'processing') return false;
  const at = item.processingAt?.toMillis?.();
  // Items from before processingAt existed: fall back to the last update.
  const since = at ?? item.updatedAt?.toMillis?.() ?? now;
  return now - since > STALE_PROCESSING_MS;
}

export function canRefetch(item: Item): boolean {
  if (!item.url && !item.file) return false;
  return item.fetchStatus === 'done' || item.fetchStatus === 'error' || isStalled(item);
}

export async function deleteWithConfirm(item: Item): Promise<boolean> {
  const name = item.title.length > 80 ? `${item.title.slice(0, 80)}…` : item.title || 'this item';
  const ok = await confirmDialog(`Delete “${name}”? Its highlights are deleted too. This cannot be undone.`, {
    title: 'Delete item',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  deleteItem(item.id).catch(fail('Could not delete'));
  toast('Deleted');
  return true;
}

export function openOriginal(item: Item): void {
  const target = item.url ? Promise.resolve(item.url) : fileUrl(item);
  target
    .then((url) => {
      if (!url) throw new Error('No original link or file');
      return openExternal(url);
    })
    .catch(fail('Could not open'));
}
