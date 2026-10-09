/**
 * Tag editor: chips for the current tags plus a text field.
 *
 * export default TagInput / export { TagInput }
 * Props (TagInputProps):
 *   value: string[]                     current tags (normalized)
 *   onChange: (tags: string[]) => void  receives a normalized, de-duplicated list (max 30)
 *   suggestions: string[]               known tags, most relevant first (e.g. tagCounts(items).map(t => t.tag))
 *   placeholder?: string                default 'Add tags…'
 *   id?: string                         id of the inner <input> (for <label htmlFor>)
 *   autoFocus?: boolean
 *   'aria-label'?: string               default 'Tags'
 *
 * Typing then Enter, comma or Tab adds the tag (normalizeTag from lib/data); pending text is also
 * committed on blur. Backspace in an empty field removes the last tag. Arrow keys move through the
 * suggestion list (prefix matches first), Enter picks the highlighted one. Suggestions are plain
 * buttons below the field so they work with touch and on e-ink.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { normalizeTag, normalizeTags } from '../lib/data';
import { Close } from './Icons';
import './components.css';

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
}

const MAX_TAGS = 30;
const MAX_SUGGESTIONS = 8;

/*
 * Hiding the suggestion row on blur shifts everything below it up. When the blur comes from pressing a
 * button further down (e.g. a dialog's Save), the button moves away between mousedown and mouseup and the
 * click is lost. So while a pointer press is in progress, hiding waits until its click has been handled.
 */
let pressing = false;
let releaseTimer = 0;
const afterPress: (() => void)[] = [];

function release() {
  window.clearTimeout(releaseTimer);
  // Run after the click handlers of this press.
  window.setTimeout(() => {
    pressing = false;
    afterPress.splice(0).forEach((f) => f());
  }, 0);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => {
    window.clearTimeout(releaseTimer);
    pressing = true;
  }, true);
  // Touch: compatibility mouse events and the click follow pointerup, so wait for the click (or give up).
  const up = () => {
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(release, 600);
  };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  document.addEventListener('click', release, true);
}

function whenPressEnds(f: () => void) {
  if (pressing) afterPress.push(f);
  else f();
}

export function TagInput({ value, onChange, suggestions, placeholder = 'Add tags…', id, autoFocus, 'aria-label': ariaLabel = 'Tags' }: TagInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-suggestions`;
  const full = value.length >= MAX_TAGS;

  const matches = useMemo(() => {
    const q = normalizeTag(text);
    const pool = suggestions.filter((s) => s && !value.includes(s));
    if (!q) return pool.slice(0, MAX_SUGGESTIONS);
    const prefix = pool.filter((s) => s.startsWith(q) && s !== q);
    const inner = pool.filter((s) => !s.startsWith(q) && s.includes(q));
    return [...prefix, ...inner].slice(0, MAX_SUGGESTIONS);
  }, [suggestions, value, text]);

  const showSuggestions = !full && matches.length > 0 && (focused || text.length > 0);

  function add(raw: string[]) {
    const next = normalizeTags([...value, ...raw]);
    if (next.length !== value.length || next.some((t, i) => t !== value[i])) onChange(next);
  }

  function commitText(): boolean {
    const t = normalizeTag(text);
    setText('');
    setActive(-1);
    if (!t) return false;
    add([t]);
    return true;
  }

  function pick(tag: string) {
    add([tag]);
    setText('');
    setActive(-1);
    inputRef.current?.focus();
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && showSuggestions) {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && showSuggestions) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? matches.length - 1 : a - 1));
    } else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && !e.shiftKey)) {
      if (showSuggestions && active >= 0 && active < matches.length) {
        e.preventDefault();
        pick(matches[active]);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        commitText();
      } else if (e.key === ',') {
        e.preventDefault();
      }
      // Enter / Tab with an empty field fall through (submit the form / move focus).
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && (text || active >= 0)) {
      e.preventDefault(); // keep an enclosing dialog open; just clear the field
      setText('');
      setActive(-1);
    }
  }

  function onInput(v: string) {
    // Virtual keyboards often don't report ',' in keydown, and pasted text may contain several tags.
    if (v.includes(',')) {
      const parts = v.split(',');
      const rest = parts.pop() ?? '';
      add(parts);
      setText(rest.trimStart());
    } else {
      setText(v);
    }
    setActive(-1);
  }

  return (
    <div className="tag-input-wrap">
      <div
        className={`tag-input${focused ? ' focused' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.map((t) => (
          <span key={t} className="chip tag-chip">
            <span className="tag-chip-label">{t}</span>
            <button type="button" className="tag-chip-remove" aria-label={`Remove tag ${t}`} onClick={() => remove(t)}>
              <Close size={14} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          className="tag-input-field"
          type="text"
          value={text}
          placeholder={full ? 'Tag limit reached' : value.length ? '' : placeholder}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={showSuggestions && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          disabled={full}
          autoFocus={autoFocus}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            commitText();
            whenPressEnds(() => setFocused(inputRef.current === document.activeElement));
          }}
        />
      </div>
      {showSuggestions ? (
        <div className="tag-suggestions" id={listId} role="listbox" aria-label="Suggested tags">
          {matches.map((s, i) => (
            <button
              key={s}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`chip tag-suggestion${i === active ? ' active' : ''}`}
              // Keep focus in the field so blur doesn't commit the half-typed text first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default TagInput;
