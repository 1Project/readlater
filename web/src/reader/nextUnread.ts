/**
 * "Next unread →" at the end of a document.
 *
 * export nextUnread(items: Item[], current: Item): Item | null
 *   Unread items in the same location (library or feed) ordered newest first by createdAt, as the lists
 *   show them; returns the first one saved before `current` (its successor in that order), wrapping to the
 *   newest. The current item is never returned. Items still being written (createdAt null) count as newest.
 */
import type { Item } from '../lib/types';

function created(i: Item): number {
  return i.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
}

/** Newest first; ties broken by id so the order is stable. */
function compare(a: Item, b: Item): number {
  return created(b) - created(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function nextUnread(items: Item[], current: Item): Item | null {
  const list = items.filter((i) => i.id !== current.id && i.location === current.location && i.status === 'unread').sort(compare);
  if (!list.length) return null;
  return list.find((i) => compare(current, i) < 0) ?? list[0];
}
