/**
 * Small building blocks for the settings page.
 *
 * Exports:
 *   Section({ id, title, intro?, children })                 <section id> with heading; target of the in-page index
 *   Segmented<T>({ value, options: {value,label,style?}[], onChange, label, big? })   row of pressed/unpressed buttons
 *   Switch({ checked, onChange, label, description? })       full-width on/off row (role="switch")
 *   errorMessage(e): string                                  readable text for a thrown error / callable error
 */
import { useId, type CSSProperties, type ReactNode } from 'react';

export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  const hid = `${id}-title`;
  return (
    <section id={id} className="set-section" aria-labelledby={hid}>
      <h2 id={hid} className="set-section-title">
        {title}
      </h2>
      {intro ? <p className="set-intro muted">{intro}</p> : null}
      {children}
    </section>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  style?: CSSProperties;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  big,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  label: string;
  big?: boolean;
}) {
  return (
    <div className={`set-seg${big ? ' set-seg-big' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="btn set-seg-btn" aria-pressed={value === o.value} style={o.style} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="set-switch-row">
      <div className="set-switch-text">
        <span id={`${id}-l`} className="set-label">
          {label}
        </span>
        {description ? (
          <span id={`${id}-d`} className="small muted">
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        className={`btn set-switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="set-switch-knob" aria-hidden="true" />
        <span className="set-switch-state">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

export function errorMessage(e: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You are offline';
  const msg = (e as { message?: string })?.message;
  return msg ? msg.replace(/^Firebase:\s*/, '').replace(/\s*\(\w+\/[\w-]+\)\.?$/, '') : 'Something went wrong';
}
