/**
 * Accessible modal dialog rendered in a portal on document.body.
 *
 * export default Dialog / export { Dialog }
 * Props (DialogProps):
 *   open: boolean
 *   onClose: () => void               called on Esc, backdrop click and the × button
 *   title: ReactNode                  heading (also the accessible name)
 *   children: ReactNode               body
 *   footer?: ReactNode                action row (buttons), right-aligned
 *   onSubmit?: (e: FormEvent) => void when given, body + footer are wrapped in a <form>; a
 *                                     type="submit" button in the footer submits (Enter in a field too).
 *                                     preventDefault() is already called.
 *   className?: string                extra class on .dialog
 *   dismissable?: boolean             default true; false disables Esc/backdrop/× (e.g. while saving)
 *
 * On open it focuses the first element marked [data-autofocus], else the first input/select/textarea,
 * else the dialog itself; Tab is trapped inside; focus returns to the opener on close; body scroll is
 * locked. Stacked dialogs work: only the topmost reacts to Esc. No animation.
 */
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Close } from './Icons';
import './components.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  className?: string;
  dismissable?: boolean;
}

const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELDS = 'input:not([disabled]):not([type="hidden"]):not([type="file"]), select:not([disabled]), textarea:not([disabled])';

export function Dialog({ open, onClose, title, children, footer, onSubmit, className, dismissable = true }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('dialog');
    stack.push(token);
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const el = ref.current;
    if (el) {
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(`.dialog-body ${FIELDS}`) ?? el;
      target.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token || !ref.current) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // e.g. an open Menu inside the dialog handled it
        e.preventDefault();
        e.stopPropagation();
        if (dismissRef.current) onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (!nodes.length) {
          e.preventDefault();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (!ref.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || active === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const inner = (
    <>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </>
  );

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current && dismissable) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div ref={ref} className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon dialog-close" aria-label="Close" onClick={onClose} disabled={!dismissable}>
            <Close />
          </button>
        </div>
        {onSubmit ? (
          <form
            className="dialog-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Dialog;
