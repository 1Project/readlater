/**
 * Click/tap-to-open dropdown menu (no hover behaviour). Closes on outside tap, Esc, or after a choice.
 * Arrow keys / Home / End move between entries when opened from the keyboard.
 *
 * export default Menu / export { Menu }
 * Props (MenuProps):
 *   items: (MenuEntry | null | false | undefined)[]   falsy entries are skipped (handy for conditionals)
 *   label: string                 accessible name of the trigger button (e.g. 'More actions')
 *   children?: ReactNode          trigger content; default the "More" (⋯) icon
 *   buttonClassName?: string      default 'btn btn-ghost btn-icon'
 *   align?: 'start' | 'end'       which edge of the trigger the menu lines up with; default 'end'
 *   title?: string                tooltip of the trigger (defaults to label)
 * type MenuEntry = MenuItem | 'separator'
 * type MenuItem = { label: ReactNode; onSelect: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { More } from './Icons';
import './components.css';

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}
export type MenuEntry = MenuItem | 'separator';

export interface MenuProps {
  items: (MenuEntry | null | false | undefined)[];
  label: string;
  children?: ReactNode;
  buttonClassName?: string;
  align?: 'start' | 'end';
  title?: string;
}

export function Menu({ items, label, children, buttonClassName = 'btn btn-ghost btn-icon', align = 'end', title }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  const menuId = useId();

  const entries = items.filter((x): x is MenuEntry => !!x);
  // Drop leading/trailing/double separators produced by conditional entries.
  const clean = entries.filter((e, i) => e !== 'separator' || (i > 0 && i < entries.length - 1 && entries[i - 1] !== 'separator'));

  const menuItems = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];

  useLayoutEffect(() => {
    if (!open || !listRef.current || !triggerRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const h = listRef.current.offsetHeight;
    setUp(t.bottom + h + 8 > window.innerHeight && t.top - h - 8 > 0);
    if (focusFirst.current) {
      menuItems()[0]?.focus();
      focusFirst.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); // tells an enclosing Dialog not to close
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    const els = menuItems();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % els.length;
    else if (e.key === 'ArrowUp') next = i <= 0 ? els.length - 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    else if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      els[next].focus();
    }
  }

  function choose(item: MenuItem) {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    item.onSelect();
  }

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          focusFirst.current = e.detail === 0; // opened with Enter/Space
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            focusFirst.current = true;
            setOpen(true);
          }
        }}
      >
        {children ?? <More />}
      </button>
      {open ? (
        <div
          ref={listRef}
          id={menuId}
          className={`menu-list menu-${align}${up ? ' menu-up' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
        >
          {clean.map((entry, i) =>
            entry === 'separator' ? (
              <div key={`sep-${i}`} className="menu-separator" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`menu-item${entry.danger ? ' danger' : ''}`}
                disabled={entry.disabled}
                onClick={() => choose(entry)}
              >
                {entry.icon ? <span className="menu-icon">{entry.icon}</span> : null}
                <span className="menu-label">{entry.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export default Menu;
