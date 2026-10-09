/**
 * Promise-based confirmation dialog.
 *
 * Exports:
 *   ConfirmProvider: ({ children }) => JSX   mount once near the app root (inside or next to ToastProvider)
 *   useConfirm(): ConfirmFn
 *   confirmDialog: ConfirmFn                  same function, usable outside React
 *   type ConfirmFn = (message: ReactNode, opts?: ConfirmOptions) => Promise<boolean>
 *   type ConfirmOptions = { title?: string; confirmLabel?: string (default 'OK'); cancelLabel?: string;
 *                           danger?: boolean (red confirm button, Cancel gets initial focus) }
 *
 * If no ConfirmProvider is mounted it falls back to window.confirm().
 * Only one confirmation is shown at a time; a new request resolves the previous one with false.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import Dialog from './Dialog';

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
export type ConfirmFn = (message: ReactNode, opts?: ConfirmOptions) => Promise<boolean>;

interface Pending {
  id: number;
  message: ReactNode;
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}

let pending: Pending | null = null;
let mounted = 0;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function settle(v: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(v);
}

export const confirmDialog: ConfirmFn = (message, opts = {}) => {
  if (mounted === 0) {
    const text = typeof message === 'string' ? message : opts.title ?? 'Are you sure?';
    return Promise.resolve(window.confirm(text));
  }
  if (pending) settle(false);
  return new Promise<boolean>((resolve) => {
    pending = { id: ++seq, message, opts, resolve };
    emit();
  });
};

export function useConfirm(): ConfirmFn {
  return confirmDialog;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  mounted++;
  return () => {
    listeners.delete(cb);
    mounted--;
    if (mounted === 0 && pending) settle(false);
  };
}

export function ConfirmProvider({ children }: { children?: ReactNode }) {
  const p = useSyncExternalStore(subscribe, () => pending, () => null);
  const danger = !!p?.opts.danger;
  return (
    <>
      {children}
      <Dialog
        key={p?.id ?? 0}
        open={!!p}
        onClose={() => settle(false)}
        title={p?.opts.title ?? 'Please confirm'}
        className="confirm-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => settle(false)} {...(danger ? { 'data-autofocus': true } : {})}>
              {p?.opts.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn ${danger ? 'btn-danger btn-danger-solid' : 'btn-primary'}`}
              onClick={() => settle(true)}
              {...(!danger ? { 'data-autofocus': true } : {})}
            >
              {p?.opts.confirmLabel ?? 'OK'}
            </button>
          </>
        }
      >
        <div className="confirm-message">{p?.message}</div>
      </Dialog>
    </>
  );
}

export default ConfirmProvider;
