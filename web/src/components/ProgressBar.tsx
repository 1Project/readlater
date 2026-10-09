/**
 * Thin horizontal progress bar.
 *
 * export default ProgressBar / export { ProgressBar }
 * Props: {
 *   value: number          0..1 (clamped)
 *   label?: string         accessible name, default 'Progress'
 *   size?: 'thin' | 'normal'  'thin' (3px, for list rows) default; 'normal' (8px, e.g. uploads)
 *   className?: string
 * }
 */
import './components.css';

export interface ProgressBarProps {
  value: number;
  label?: string;
  size?: 'thin' | 'normal';
  className?: string;
}

export function ProgressBar({ value, label = 'Progress', size = 'thin', className }: ProgressBarProps) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const pct = Math.round(v * 100);
  return (
    <div
      className={`progress progress-${size}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="progress-fill" style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export default ProgressBar;
