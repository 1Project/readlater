/**
 * Loading indicator. Shows a small rotating ring plus text; in the e-ink theme and with
 * prefers-reduced-motion the ring is hidden and only the static text remains.
 *
 * export default Spinner / export { Spinner }
 * Props: { label?: string (default 'Loading…'); inline?: boolean (no padding, flows in text); className?: string }
 */
import './components.css';

export function Spinner({ label = 'Loading…', inline, className }: { label?: string; inline?: boolean; className?: string }) {
  return (
    <span className={`loading${inline ? ' loading-inline' : ''}${className ? ` ${className}` : ''}`} role="status">
      <span className="loading-ring" aria-hidden="true" />
      <span className="loading-label">{label}</span>
    </span>
  );
}

export default Spinner;
