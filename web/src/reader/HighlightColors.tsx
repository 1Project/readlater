/**
 * Highlight colours (SPEC-2 §3): yellow (default), green, blue, pink. Rendered as mark.hl[data-color];
 * the e-ink theme shows them as solid / double / dotted / wavy underlines (reader.css).
 *
 * Exports:
 *   COLOR_NAMES: Record<HighlightColor, string>     'Yellow', …
 *   normalizeColor(c: unknown): HighlightColor       unknown values → 'yellow'
 *   readLastColor(): HighlightColor                  colour for new highlights (per device, localStorage)
 *   writeLastColor(c: HighlightColor): void
 *   ColorPicker  { value: HighlightColor; onChange(c); label?: string (group name, default 'Highlight colour') }
 *                four toggle buttons, each showing a sample of the highlight style in the current theme
 */
import { HIGHLIGHT_COLORS, type HighlightColor } from '../lib/types';

export const COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
};

const LAST_COLOR_KEY = 'rl.reader.hlColor';

export function normalizeColor(c: unknown): HighlightColor {
  return HIGHLIGHT_COLORS.includes(c as HighlightColor) ? (c as HighlightColor) : 'yellow';
}

export function readLastColor(): HighlightColor {
  try {
    return normalizeColor(localStorage.getItem(LAST_COLOR_KEY));
  } catch {
    return 'yellow';
  }
}

export function writeLastColor(c: HighlightColor): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, c);
  } catch {
    /* ignore */
  }
}

export function ColorPicker({ value, onChange, label = 'Highlight colour' }: { value: HighlightColor; onChange: (c: HighlightColor) => void; label?: string }) {
  return (
    <div className="hl-colors" role="group" aria-label={label}>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="hl-color"
          aria-pressed={value === c}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          onClick={() => onChange(c)}
        >
          <mark className="hl-sample" data-color={c} aria-hidden="true">
            Aa
          </mark>
        </button>
      ))}
    </div>
  );
}
