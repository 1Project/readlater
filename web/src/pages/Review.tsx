/**
 * /review — daily review (docs/SPEC-2.md §4): five highlights a day, picked deterministically from the date
 * (the same set on every device), one card at a time. "Shuffle" picks another five.
 *
 * Next: the Next button, tapping the card, → / j / Space. Previous: the Previous button, ← / k.
 * The picks are fixed when the page opens, so live highlight updates never reshuffle a review in progress.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import EmptyState from '../components/EmptyState';
import { Highlight as HighlightIcon } from '../components/Icons';
import { isTypingTarget } from '../components/ItemList';
import Spinner from '../components/Spinner';
import { useHighlights, useItems } from '../lib/data';
import { itemSource } from '../lib/format';
import { dailyHighlights, dayKey } from '../lib/stats';
import type { Highlight, Item } from '../lib/types';
import './insights.css';

const PER_DAY = 5;

export default function Review() {
  const highlights = useHighlights();
  const items = useItems();
  const [round, setRound] = useState(0);
  const [index, setIndex] = useState(0);
  const [frozen, setFrozen] = useState<{ key: string; ids: string[] } | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const today = useMemo(() => new Date(), []);
  const key = `${dayKey(today)}#${round}`;

  const itemsById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const pool = useMemo(() => (highlights && items ? highlights.filter((h) => h.text.trim() && itemsById.has(h.itemId)) : undefined), [highlights, items, itemsById]);

  // Fix the picks for this day/round once the data is there.
  if (pool && frozen?.key !== key) {
    setFrozen({ key, ids: dailyHighlights(pool, today, PER_DAY, round).map((h) => h.id) });
  }

  const byId = useMemo(() => new Map((highlights ?? []).map((h) => [h.id, h])), [highlights]);
  const picks = useMemo(() => (frozen ? frozen.ids.map((id) => byId.get(id)).filter((h): h is Highlight => !!h) : []), [frozen, byId]);
  const done = picks.length > 0 && index >= picks.length;
  const current = done ? null : picks[Math.min(index, picks.length - 1)];

  const next = () => setIndex((i) => Math.min(i + 1, picks.length));
  const prev = () => setIndex((i) => Math.max(i - 1, 0));
  const shuffle = () => {
    setRound((r) => r + 1);
    setIndex(0);
  };

  const keys = useRef({ next, prev });
  keys.current = { next, prev };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('.dialog-backdrop, .menu-list')) return;
      if (e.key === 'ArrowRight' || e.key === 'j' || (e.key === ' ' && !(e.target instanceof HTMLElement && e.target.closest('a, button')))) {
        e.preventDefault();
        keys.current.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        keys.current.prev();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Move focus to the new card so screen readers announce it.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [index, round]);

  const onCardClick = (e: MouseEvent) => {
    if ((e.target as Element).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    next();
  };

  const head = (
    <div className="page-head">
      <h1 className="insights-title">Daily review</h1>
      <span className="spacer" />
      {picks.length && pool && pool.length > PER_DAY ? (
        <button type="button" className="btn btn-small" onClick={shuffle}>
          Shuffle
        </button>
      ) : null}
    </div>
  );

  if (!pool || !frozen) {
    return (
      <main className="page review-page">
        {head}
        <Spinner />
      </main>
    );
  }

  if (!picks.length) {
    return (
      <main className="page review-page">
        {head}
        <EmptyState icon={<HighlightIcon size={32} />} title="No highlights to review yet">
          <p>Select text while reading and tap “Highlight”. A few of your highlights come back here every day.</p>
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="page review-page">
      {head}
      <p className="small muted review-date">
        {today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        {round ? ' · shuffled' : ''}
      </p>

      {done ? (
        <section className="card review-done" ref={cardRef} tabIndex={-1} aria-live="polite">
          <p className="review-done-title">Done for today</p>
          <p className="small muted">You reviewed {picks.length === 1 ? '1 highlight' : `${picks.length} highlights`}. New ones are picked tomorrow.</p>
          <div className="row page-center-row">
            <button type="button" className="btn" onClick={() => setIndex(0)}>
              Start over
            </button>
            {pool.length > PER_DAY ? (
              <button type="button" className="btn" onClick={shuffle}>
                Review {PER_DAY} more
              </button>
            ) : null}
            <RouterLink className="btn" to="/highlights">
              All highlights
            </RouterLink>
          </div>
        </section>
      ) : current ? (
        <article className="card review-card" ref={cardRef} tabIndex={-1} aria-roledescription="highlight" aria-label={`Highlight ${index + 1} of ${picks.length}`} onClick={onCardClick}>
          <p className="small muted review-count" aria-hidden="true">
            {index + 1} / {picks.length}
          </p>
          <blockquote className="review-quote" data-color={current.color ?? 'yellow'}>
            {current.text}
          </blockquote>
          {current.note ? <p className="review-note">{current.note}</p> : null}
          <ReviewSource itemId={current.itemId} highlightId={current.id} item={itemsById.get(current.itemId)} />
        </article>
      ) : null}

      <nav className="review-nav" aria-label="Review">
        <button type="button" className="btn review-nav-btn" onClick={prev} disabled={index === 0}>
          ← Previous
        </button>
        <span className="review-dots" aria-hidden="true">
          {picks.map((h, i) => (
            <span key={h.id} className={`review-dot${i === index ? ' current' : i < index ? ' seen' : ''}`} />
          ))}
        </span>
        <button type="button" className="btn btn-primary review-nav-btn" onClick={next} disabled={done}>
          {index === picks.length - 1 ? 'Finish' : 'Next →'}
        </button>
      </nav>
    </main>
  );
}

function ReviewSource({ itemId, highlightId, item }: { itemId: string; highlightId: string; item: Item | undefined }) {
  const source = item ? itemSource(item) : '';
  const at = `/item/${encodeURIComponent(itemId)}?hl=${encodeURIComponent(highlightId)}`;
  return (
    <footer className="review-source">
      <RouterLink className="review-doc" to={`/item/${encodeURIComponent(itemId)}`}>
        {item?.title || item?.url || 'Untitled'}
      </RouterLink>
      {source ? <span className="small muted">{source}</span> : null}
      <RouterLink className="btn btn-small review-open" to={at}>
        Open in document
      </RouterLink>
    </footer>
  );
}
