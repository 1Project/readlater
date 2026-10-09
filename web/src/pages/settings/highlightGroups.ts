/**
 * Group highlights by item (used by the Highlights page and the Markdown export in Settings).
 *
 * Exports:
 *   interface ItemHighlights { itemId; item: Item | null; highlights: Highlight[]; latest: number }
 *   groupHighlights(highlights, items): ItemHighlights[]   groups newest first (by latest highlight); highlights oldest first
 *                                                           within a group (≈ reading order)
 *   highlightsMarkdown(groups): string                      Markdown export (lib/importers highlightsToMarkdown)
 */
import { highlightsToMarkdown } from '../../lib/importers';
import { toDate } from '../../lib/format';
import type { Highlight, Item } from '../../lib/types';

export interface ItemHighlights {
  itemId: string;
  item: Item | null;
  highlights: Highlight[];
  latest: number;
}

/** Pending server timestamps are null locally: treat them as "now" so new highlights sort first. */
const time = (h: Highlight) => toDate(h.createdAt)?.getTime() ?? Date.now();

export function groupHighlights(highlights: Highlight[], items: Item[]): ItemHighlights[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map<string, ItemHighlights>();
  for (const h of highlights) {
    let g = groups.get(h.itemId);
    if (!g) {
      g = { itemId: h.itemId, item: byId.get(h.itemId) ?? null, highlights: [], latest: 0 };
      groups.set(h.itemId, g);
    }
    g.highlights.push(h);
    g.latest = Math.max(g.latest, time(h));
  }
  const out = [...groups.values()];
  for (const g of out) g.highlights.sort((a, b) => time(a) - time(b));
  return out.sort((a, b) => b.latest - a.latest);
}

export function highlightsMarkdown(groups: ItemHighlights[]): string {
  return highlightsToMarkdown(
    groups.map((g) => ({
      title: g.item?.title || g.item?.url || 'Untitled',
      url: g.item?.url ?? null,
      author: g.item?.author ?? null,
      highlights: g.highlights.map((h) => ({ text: h.text, note: h.note, createdAt: toDate(h.createdAt) })),
    })),
  );
}
