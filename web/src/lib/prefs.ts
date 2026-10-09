import { useSyncExternalStore } from 'react';

/** Per-device preferences, stored in localStorage under `rl.<key>`. */
export type Theme = 'system' | 'light' | 'dark' | 'eink';
export type FontFamily = 'serif' | 'sans' | 'mono';
export type ReaderMode = 'scroll' | 'paginate';

export interface Prefs {
  theme: Theme;
  fontFamily: FontFamily;
  fontSize: number; // px, 14..28
  lineHeight: number; // 1.3..2
  width: number; // max content width in ch, 50..90
  justify: boolean;
  readerMode: ReaderMode;
  listDensity: 'comfortable' | 'compact';
  showImages: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  fontFamily: 'serif',
  fontSize: 19,
  lineHeight: 1.6,
  width: 68,
  justify: false,
  readerMode: 'scroll',
  listDensity: 'comfortable',
  showImages: true,
};

const listeners = new Set<() => void>();

function read<K extends keyof Prefs>(key: K): Prefs[K] {
  try {
    const raw = localStorage.getItem(`rl.${key}`);
    if (raw != null) return JSON.parse(raw) as Prefs[K];
  } catch {
    /* ignore */
  }
  // e-ink default: paginate when the theme is eink and the user never chose.
  if (key === 'readerMode' && read('theme') === 'eink') return 'paginate' as Prefs[K];
  return DEFAULT_PREFS[key];
}

let snapshot: Prefs = computeSnapshot();

function computeSnapshot(): Prefs {
  const out = {} as Prefs;
  (Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]).forEach((k) => {
    (out as unknown as Record<string, unknown>)[k] = read(k);
  });
  return out;
}

export function getPrefs(): Prefs {
  return snapshot;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try {
    localStorage.setItem(`rl.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  snapshot = computeSnapshot();
  if (key === 'theme') applyTheme();
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

/** Resolve the `system` theme and set data-theme on <html>. */
export function applyTheme(): void {
  const t = snapshot.theme;
  const root = document.documentElement;
  root.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.dataset.scheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]') ?? document.head.appendChild(document.createElement('meta'));
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', dark ? '#111111' : '#ffffff');
}

if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    applyTheme();
    listeners.forEach((l) => l());
  });
}
