/**
 * Pure reading statistics for the Stats page (/stats) and the deterministic daily highlight pick for
 * /review. No React, no Firebase. Days and weeks are local time; weeks start on Monday.
 *
 * Only library items count (feed items marked "seen" are archived too, but they were never saved).
 *
 * Exports:
 *   dayKey(date): string                         'YYYY-MM-DD' (local)
 *   startOfWeek(date): Date                      Monday 00:00 local
 *   weeklyActivity(items, now?, weeks = 12)      [{ start, saved, finished }], oldest week first
 *   wordsRead(items): number                     sum of wordCount of archived library items
 *   readingStreaks(items, now?)                  { current, longest } in days with ≥ 1 archived item
 *   topTags(items, n = 10) / topSites(items, n = 10)
 *   libraryTotals(items)                         { saved, unread, archived, favorites }
 *   computeStats(items, highlights, now?)        everything above in one object (Stats)
 *   seededRandom(seed): () => number             deterministic PRNG in [0, 1)
 *   seededShuffle(list, seed): T[]               new array
 *   dailyHighlights(highlights, date, count = 5, round = 0)   same picks all day; round > 0 = "Shuffle"
 */
import { hostname, toDate, type DateLike } from './format';
import type { Highlight, Item } from './types';

type StatItem = Pick<Item, 'location' | 'status' | 'favorite' | 'tags' | 'wordCount' | 'siteName' | 'url'> & {
  createdAt: DateLike;
  archivedAt: DateLike;
};

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfWeek(d: Date): Date {
  const monday = (d.getDay() + 6) % 7; // 0 = Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - monday);
}

const library = <T extends StatItem>(items: T[]) => items.filter((i) => i.location === 'library');

/** Local day `n` days before `d` (DST-safe). */
const daysBefore = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);

export interface WeekActivity {
  start: Date;
  saved: number;
  finished: number;
}

export function weeklyActivity(items: StatItem[], now: Date = new Date(), weeks = 12): WeekActivity[] {
  const current = startOfWeek(now);
  const rows: WeekActivity[] = [];
  for (let i = weeks - 1; i >= 0; i--) rows.push({ start: daysBefore(current, i * 7), saved: 0, finished: 0 });
  const index = new Map(rows.map((r, i) => [dayKey(r.start), i]));
  const rowOf = (d: Date | null) => (d ? index.get(dayKey(startOfWeek(d))) : undefined);
  for (const it of library(items)) {
    // A pending server timestamp (just saved) counts as now.
    const saved = rowOf(toDate(it.createdAt) ?? now);
    if (saved !== undefined) rows[saved].saved++;
    if (it.status === 'archived') {
      const finished = rowOf(toDate(it.archivedAt));
      if (finished !== undefined) rows[finished].finished++;
    }
  }
  return rows;
}

export function wordsRead(items: StatItem[]): number {
  return library(items).reduce((n, it) => n + (it.status === 'archived' && typeof it.wordCount === 'number' && it.wordCount > 0 ? it.wordCount : 0), 0);
}

export function readingStreaks(items: StatItem[], now: Date = new Date()): { current: number; longest: number } {
  const days = new Set<string>();
  for (const it of library(items)) {
    if (it.status !== 'archived') continue;
    const d = toDate(it.archivedAt);
    if (d) days.add(dayKey(d));
  }
  if (!days.size) return { current: 0, longest: 0 };

  // Longest: walk the sorted days and count runs of consecutive dates.
  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const [y, m, d] = sorted[i - 1].split('-').map(Number);
    run = dayKey(new Date(y, m - 1, d + 1)) === sorted[i] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // Current: ends today, or yesterday when nothing was finished yet today.
  let start = days.has(dayKey(now)) ? 0 : days.has(dayKey(daysBefore(now, 1))) ? 1 : -1;
  let current = 0;
  if (start >= 0) {
    while (days.has(dayKey(daysBefore(now, start)))) {
      current++;
      start++;
    }
  }
  return { current, longest };
}

export function topTags(items: StatItem[], n = 10): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of library(items)) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, n);
}

export function topSites(items: StatItem[], n = 10): { site: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of library(items)) {
    const site = it.siteName?.trim() || hostname(it.url);
    if (site) m.set(site, (m.get(site) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site))
    .slice(0, n);
}

export function libraryTotals(items: StatItem[]): { saved: number; unread: number; archived: number; favorites: number } {
  const lib = library(items);
  return {
    saved: lib.length,
    unread: lib.filter((i) => i.status === 'unread').length,
    archived: lib.filter((i) => i.status === 'archived').length,
    favorites: lib.filter((i) => i.favorite).length,
  };
}

export interface Stats {
  weeks: WeekActivity[];
  totals: { saved: number; unread: number; archived: number; favorites: number };
  wordsRead: number;
  streak: { current: number; longest: number };
  topTags: { tag: string; count: number }[];
  topSites: { site: string; count: number }[];
  highlights: number;
}

export function computeStats(items: StatItem[], highlights: unknown[], now: Date = new Date()): Stats {
  return {
    weeks: weeklyActivity(items, now),
    totals: libraryTotals(items),
    wordsRead: wordsRead(items),
    streak: readingStreaks(items, now),
    topTags: topTags(items),
    topSites: topSites(items),
    highlights: highlights.length,
  };
}

// ---------------------------------------------------------------------------
// Deterministic randomness (daily review)

/** mulberry32 seeded with a 32-bit FNV-1a hash of `seed`. */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(list: readonly T[], seed: string): T[] {
  const out = [...list];
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The highlights to review on `date`: the same `count` picks all day on every device (independent of the
 * order the list arrives in). `round` > 0 gives a different set (the "Shuffle" button).
 */
export function dailyHighlights<T extends Pick<Highlight, 'id'>>(highlights: readonly T[], date: Date, count = 5, round = 0): T[] {
  const stable = [...highlights].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return seededShuffle(stable, `${dayKey(date)}#${round}`).slice(0, count);
}
