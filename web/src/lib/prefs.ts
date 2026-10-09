import { useSyncExternalStore } from 'react';

/**
 * Per-device preferences, stored in localStorage under `rl.<key>`.
 *
 * Exports: types Theme, FontFamily, ReaderMode, Prefs; DEFAULT_PREFS; getPrefs(); setPref(key, value); usePrefs();
 * applyTheme(); THEMES and FONT_FAMILIES ({ value, label }[] for pickers); fontStack(family) → CSS font-family value.
 */
export type Theme = 'system' | 'light' | 'dark' | 'sepia' | 'eink';
export type FontFamily = 'serif' | 'sans' | 'mono' | 'literata' | 'atkinson';
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
  /** Archive a library item automatically when the reader reaches its end. */
  autoArchive: boolean;
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
  autoArchive: false,
};

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
  { value: 'eink', label: 'E-ink' },
];

export const FONT_FAMILIES: { value: FontFamily; label: string }[] = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' },
  { value: 'mono', label: 'Mono' },
  { value: 'literata', label: 'Literata' },
  { value: 'atkinson', label: 'Atkinson' },
];

/**
 * CSS font-family value for a reader font (the variables are defined in styles.css; Literata and Atkinson
 * Hyperlegible are bundled web fonts). Unknown values fall back to the serif stack.
 */
export function fontStack(family: FontFamily | string): string {
  return FONT_FAMILIES.some((f) => f.value === family) ? `var(--font-${family})` : 'var(--font-serif)';
}

const listeners = new Set<() => void>();

function read<K extends keyof Prefs>(key: K): Prefs[K] {
  try {
    const raw = localStorage.getItem(`rl.${key}`);
    if (raw != null) {
      const v = JSON.parse(raw) as Prefs[K];
      if (valid(key, v)) return v;
    }
  } catch {
    /* ignore */
  }
  // e-ink default: paginate when the theme is eink and the user never chose.
  if (key === 'readerMode' && read('theme') === 'eink') return 'paginate' as Prefs[K];
  return DEFAULT_PREFS[key];
}

/** Ignore stored values this version does not understand (e.g. written by a newer build). */
function valid<K extends keyof Prefs>(key: K, v: unknown): boolean {
  switch (key) {
    case 'theme':
      return THEMES.some((t) => t.value === v);
    case 'fontFamily':
      return FONT_FAMILIES.some((f) => f.value === v);
    default:
      return typeof v === typeof DEFAULT_PREFS[key];
  }
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
  // Keep in sync with --bg in styles.css.
  meta.setAttribute('content', dark ? '#121214' : t === 'sepia' ? '#f4ecd8' : '#ffffff');
}

if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    applyTheme();
    listeners.forEach((l) => l());
  });
}
