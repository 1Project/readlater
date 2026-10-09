/** Settings › Appearance (theme, list density, images) and Reader typography. Per-device prefs (lib/prefs). */
import { setPref, usePrefs, type FontFamily, type Prefs, type ReaderMode, type Theme } from '../../lib/prefs';
import { Section, Segmented, Switch } from './ui';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'eink', label: 'E-ink' },
];

export function AppearanceSection() {
  const prefs = usePrefs();
  return (
    <Section id="appearance" title="Appearance" intro="Saved on this device only.">
      <div className="set-field">
        <span className="set-label">Theme</span>
        <Segmented big label="Theme" value={prefs.theme} options={THEMES} onChange={(v) => setPref('theme', v)} />
        <p className="small muted set-note">E-ink is for black &amp; white e-readers: pure black on white, no animations, bigger buttons, page turns in the reader.</p>
      </div>
      <div className="set-field">
        <span className="set-label">List density</span>
        <Segmented
          label="List density"
          value={prefs.listDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          onChange={(v) => setPref('listDensity', v)}
        />
      </div>
      <Switch label="Show images in lists" description="Thumbnails next to items in the library and feed." checked={prefs.showImages} onChange={(v) => setPref('showImages', v)} />
    </Section>
  );
}

const FONTS: { value: FontFamily; label: string; css: string }[] = [
  { value: 'serif', label: 'Serif', css: 'var(--font-serif)' },
  { value: 'sans', label: 'Sans', css: 'var(--font-sans)' },
  { value: 'mono', label: 'Mono', css: 'var(--font-mono)' },
];

const MODES: { value: ReaderMode; label: string }[] = [
  { value: 'scroll', label: 'Scroll' },
  { value: 'paginate', label: 'Pages' },
];

function round(n: number, step: number): number {
  const decimals = step < 1 ? String(step).split('.')[1]?.length ?? 1 : 0;
  return Number(n.toFixed(decimals));
}

function Stepper({
  label,
  prefKey,
  value,
  min,
  max,
  step,
  format,
}: {
  label: string;
  prefKey: 'fontSize' | 'lineHeight' | 'width';
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  const set = (v: number) => setPref(prefKey, round(Math.min(max, Math.max(min, v)), step) as Prefs[typeof prefKey]);
  const id = `set-${prefKey}`;
  return (
    <div className="set-field">
      <div className="row">
        <label className="set-label" htmlFor={id}>
          {label}
        </label>
        <span className="spacer" />
        <output className="set-value" htmlFor={id}>
          {format(value)}
        </output>
      </div>
      <div className="set-stepper">
        <button type="button" className="btn btn-icon set-step-btn" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - step)}>
          −
        </button>
        <input id={id} className="set-range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
        <button type="button" className="btn btn-icon set-step-btn" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + step)}>
          +
        </button>
      </div>
    </div>
  );
}

export function ReaderSection() {
  const prefs = usePrefs();
  const font = FONTS.find((f) => f.value === prefs.fontFamily) ?? FONTS[0];
  return (
    <Section id="reader" title="Reader" intro="Typography for reading articles, papers and books on this device.">
      <div className="set-field">
        <span className="set-label">Font</span>
        <Segmented
          label="Font"
          value={prefs.fontFamily}
          options={FONTS.map((f) => ({ value: f.value, label: f.label, style: { fontFamily: f.css } }))}
          onChange={(v) => setPref('fontFamily', v)}
        />
      </div>
      <Stepper label="Text size" prefKey="fontSize" value={prefs.fontSize} min={14} max={28} step={1} format={(v) => `${v}px`} />
      <Stepper label="Line spacing" prefKey="lineHeight" value={prefs.lineHeight} min={1.3} max={2} step={0.1} format={(v) => v.toFixed(1)} />
      <Stepper label="Line width" prefKey="width" value={prefs.width} min={50} max={90} step={2} format={(v) => `${v} characters`} />
      <Switch label="Justify text" description="Align both edges of each paragraph." checked={prefs.justify} onChange={(v) => setPref('justify', v)} />
      <div className="set-field">
        <span className="set-label">Default reading mode</span>
        <Segmented label="Default reading mode" value={prefs.readerMode} options={MODES} onChange={(v) => setPref('readerMode', v)} />
        <p className="small muted set-note">Pages turn with a tap on the left or right side of the screen, arrow keys, or the volume buttons in the Android app.</p>
      </div>
      <div className="set-preview" aria-label="Preview">
        <p
          style={{
            fontFamily: font.css,
            fontSize: `${prefs.fontSize}px`,
            lineHeight: prefs.lineHeight,
            maxWidth: `${prefs.width}ch`,
            textAlign: prefs.justify ? 'justify' : 'start',
            hyphens: prefs.justify ? 'auto' : 'manual',
          }}
        >
          The best reading happens slowly. Save what catches your eye during the day, then come back to it when you have the time and attention it
          deserves — in a quiet, clean page that is set the way you like it.
        </p>
      </div>
    </Section>
  );
}
