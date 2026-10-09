/**
 * Non-modal reader settings panel (stays open while the text re-flows behind it).
 *
 * export default TypographyPanel
 * Props: { open: boolean; onClose: () => void }
 * Edits per-device prefs (lib/prefs): font size (− / +), family, line height, width, justify,
 * images on/off, theme quick switch (auto/light/dark/e-ink) and reading mode (Scroll / Pages).
 * Closes on Esc, on the × button and when tapping outside it (except on the toolbar button that
 * toggles it, marked [data-typography-toggle]).
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Close } from '../components/Icons';
import { setPref, usePrefs, type FontFamily, type Prefs, type ReaderMode, type Theme } from '../lib/prefs';

export interface TypographyPanelProps {
  open: boolean;
  onClose: () => void;
}

export const FONT_SIZE = { min: 14, max: 28, step: 1 };
export const LINE_HEIGHT = { min: 1.3, max: 2, step: 0.1 };
export const WIDTH = { min: 50, max: 90, step: 5 };

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function Stepper({ label, value, display, min, max, step, onChange, decLabel, incLabel }: {
  label: string;
  value: number;
  display: ReactNode;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  decLabel: string;
  incLabel: string;
}) {
  return (
    <div className="typo-row">
      <span className="typo-label">{label}</span>
      <div className="typo-stepper">
        <button type="button" className="btn btn-icon" aria-label={decLabel} disabled={value <= min + 1e-9} onClick={() => onChange(clamp(round1(value - step), min, max))}>
          −
        </button>
        <span className="typo-value" aria-live="polite">
          {display}
        </span>
        <button type="button" className="btn btn-icon" aria-label={incLabel} disabled={value >= max - 1e-9} onClick={() => onChange(clamp(round1(value + step), min, max))}>
          +
        </button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; style?: CSSProperties }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="typo-row">
      <span className="typo-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" className="btn" aria-pressed={value === o.value} style={o.style} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TypographyPanel({ open, onClose }: TypographyPanelProps) {
  const prefs = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('[data-typography-toggle]')) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!open) return null;

  const set = <K extends keyof Prefs>(k: K) => (v: Prefs[K]) => setPref(k, v);

  return (
    <div className="typo-panel" ref={ref} role="dialog" aria-label="Reading settings">
      <div className="typo-head">
        <strong>Text</strong>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
          <Close />
        </button>
      </div>
      <Stepper
        label="Size"
        value={prefs.fontSize}
        display={`${prefs.fontSize}px`}
        {...FONT_SIZE}
        onChange={set('fontSize')}
        decLabel="Smaller text"
        incLabel="Larger text"
      />
      <Segmented<FontFamily>
        label="Font"
        value={prefs.fontFamily}
        onChange={set('fontFamily')}
        options={[
          { value: 'serif', label: 'Serif', style: { fontFamily: 'var(--font-serif)' } },
          { value: 'sans', label: 'Sans', style: { fontFamily: 'var(--font-sans)' } },
          { value: 'mono', label: 'Mono', style: { fontFamily: 'var(--font-mono)' } },
        ]}
      />
      <Stepper
        label="Line height"
        value={prefs.lineHeight}
        display={prefs.lineHeight.toFixed(1)}
        {...LINE_HEIGHT}
        onChange={set('lineHeight')}
        decLabel="Tighter lines"
        incLabel="Looser lines"
      />
      <Stepper
        label="Width"
        value={prefs.width}
        display={`${prefs.width}ch`}
        {...WIDTH}
        onChange={set('width')}
        decLabel="Narrower column"
        incLabel="Wider column"
      />
      <Segmented<'left' | 'justify'>
        label="Align"
        value={prefs.justify ? 'justify' : 'left'}
        onChange={(v) => setPref('justify', v === 'justify')}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'justify', label: 'Justify' },
        ]}
      />
      <Segmented<'show' | 'hide'>
        label="Images"
        value={prefs.showImages ? 'show' : 'hide'}
        onChange={(v) => setPref('showImages', v === 'show')}
        options={[
          { value: 'show', label: 'Show' },
          { value: 'hide', label: 'Hide' },
        ]}
      />
      <Segmented<ReaderMode>
        label="Mode"
        value={prefs.readerMode}
        onChange={set('readerMode')}
        options={[
          { value: 'scroll', label: 'Scroll' },
          { value: 'paginate', label: 'Pages' },
        ]}
      />
      <Segmented<Theme>
        label="Theme"
        value={prefs.theme}
        onChange={set('theme')}
        options={[
          { value: 'system', label: 'Auto' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'eink', label: 'E-ink' },
        ]}
      />
    </div>
  );
}
