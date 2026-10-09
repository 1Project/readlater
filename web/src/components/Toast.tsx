/**
 * Transient notifications. One toast at a time (a new one replaces the current), auto-dismissed.
 *
 * Exports:
 *   ToastProvider: ({ children }) => JSX     mount once near the app root; renders the toast.
 *   useToast(): ToastFn                       hook returning the toast function
 *   toast: ToastFn                            same function, usable outside React (e.g. native.ts)
 *   type ToastFn = (message: string, opts?: ToastOptions) => void
 *   type ToastOptions = {
 *     action?: { label: string; onClick: () => void }   e.g. { label: 'Undo', onClick: undo }
 *     error?: boolean                                    styles it as an error and keeps it 6 s
 *     duration?: number                                  ms, default 3500
 *   }
 *   dismissToast(): void
 *
 * Tapping the toast's message dismisses it. role="status" so screen readers announce it.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import './components.css';

export interface ToastOptions {
  action?: { label: string; onClick: () => void };
  error?: boolean;
  duration?: number;
}
export type ToastFn = (message: string, opts?: ToastOptions) => void;

interface ToastState {
  id: number;
  message: string;
  opts: ToastOptions;
}

let current: ToastState | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (current) {
    current = null;
    emit();
  }
}

export const toast: ToastFn = (message, opts = {}) => {
  if (timer) clearTimeout(timer);
  current = { id: ++seq, message, opts };
  const ms = opts.duration ?? (opts.error ? 6000 : 3500);
  timer = setTimeout(dismissToast, ms);
  emit();
};

export function useToast(): ToastFn {
  return toast;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  const t = useSyncExternalStore(subscribe, () => current, () => null);
  // Clear a pending toast if the provider unmounts (e.g. sign-out remounts the tree).
  useEffect(() => () => dismissToast(), []);
  return (
    <>
      {children}
      <div className="toast-region" aria-live="polite" role="status">
        {t ? (
          <div key={t.id} className={`toast${t.opts.error ? ' toast-error' : ''}`}>
            <span className="toast-message" onClick={dismissToast}>
              {t.message}
            </span>
            {t.opts.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  const a = t.opts.action!;
                  dismissToast();
                  a.onClick();
                }}
              >
                {t.opts.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

export default ToastProvider;
