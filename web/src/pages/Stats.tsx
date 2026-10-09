/**
 * /stats — reading statistics (docs/SPEC-2.md §7): totals, words read, streaks, saved / finished per week for
 * the last 12 weeks (a plain table with CSS bars, no chart library), top tags and sites. Pure maths in lib/stats.
 */
import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import { useHighlights, useItems } from '../lib/data';
import { computeStats } from '../lib/stats';
import './insights.css';

const WORDS_PER_MINUTE = 230;

const num = (n: number) => n.toLocaleString();
const days = (n: number) => `${num(n)} ${n === 1 ? 'day' : 'days'}`;

function hoursOf(words: number): string {
  const mins = Math.round(words / WORDS_PER_MINUTE);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `about ${mins} min`;
  const h = mins / 60;
  return `about ${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
}

function Bar({ value, max, kind }: { value: number; max: number; kind: 'saved' | 'finished' }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="stats-cell">
      <span className="stats-track" aria-hidden="true">
        {value ? <span className={`stats-bar stats-bar-${kind}`} style={{ width: `${Math.max(pct, 3)}%` }} /> : null}
      </span>
      <span className="stats-num">{num(value)}</span>
    </div>
  );
}

export default function Stats() {
  const items = useItems();
  const highlights = useHighlights();
  const stats = useMemo(() => (items && highlights ? computeStats(items, highlights) : undefined), [items, highlights]);

  if (!stats) {
    return (
      <main className="page stats-page">
        <h1 className="insights-title">Reading stats</h1>
        <Spinner />
      </main>
    );
  }

  if (!stats.totals.saved) {
    return (
      <main className="page stats-page">
        <h1 className="insights-title">Reading stats</h1>
        <EmptyState title="Nothing to count yet">
          <p>Save and finish a few articles, and your reading stats show up here.</p>
        </EmptyState>
      </main>
    );
  }

  const max = Math.max(1, ...stats.weeks.map((w) => Math.max(w.saved, w.finished)));
  const weekLabel = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const tiles: { label: string; value: string; note?: string }[] = [
    { label: 'Current streak', value: days(stats.streak.current), note: stats.streak.current ? undefined : 'archive an item to start one' },
    { label: 'Longest streak', value: days(stats.streak.longest) },
    { label: 'Words read', value: num(stats.wordsRead), note: stats.wordsRead ? hoursOf(stats.wordsRead) : undefined },
    { label: 'Finished', value: num(stats.totals.archived) },
    { label: 'Unread', value: num(stats.totals.unread) },
    { label: 'Saved', value: num(stats.totals.saved) },
    { label: 'Favorites', value: num(stats.totals.favorites) },
    { label: 'Highlights', value: num(stats.highlights) },
  ];

  return (
    <main className="page stats-page">
      <div className="page-head">
        <h1 className="insights-title">Reading stats</h1>
        <span className="spacer" />
        <RouterLink className="btn btn-small" to="/review">
          Daily review
        </RouterLink>
      </div>

      <dl className="stats-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="stats-tile">
            <dt className="small muted">{t.label}</dt>
            <dd>
              <span className="stats-value">{t.value}</span>
              {t.note ? <span className="small muted stats-note">{t.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      <h2 className="section-title">Last 12 weeks</h2>
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">
              <span className="stats-key stats-bar-saved" aria-hidden="true" /> Saved
            </th>
            <th scope="col">
              <span className="stats-key stats-bar-finished" aria-hidden="true" /> Finished
            </th>
          </tr>
        </thead>
        <tbody>
          {[...stats.weeks].reverse().map((w, i) => (
            <tr key={w.start.getTime()}>
              <th scope="row">{i === 0 ? 'This week' : weekLabel(w.start)}</th>
              <td>
                <Bar value={w.saved} max={max} kind="saved" />
              </td>
              <td>
                <Bar value={w.finished} max={max} kind="finished" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="stats-lists">
        <section aria-labelledby="stats-tags">
          <h2 id="stats-tags" className="section-title">
            Top tags
          </h2>
          {stats.topTags.length ? (
            <ol className="stats-rank">
              {stats.topTags.map((t) => (
                <li key={t.tag}>
                  <RouterLink to={`/?view=all&tag=${encodeURIComponent(t.tag)}`}>#{t.tag}</RouterLink>
                  <span className="stats-num">{num(t.count)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">No tags yet.</p>
          )}
        </section>
        <section aria-labelledby="stats-sites">
          <h2 id="stats-sites" className="section-title">
            Top sites
          </h2>
          {stats.topSites.length ? (
            <ol className="stats-rank">
              {stats.topSites.map((s) => (
                <li key={s.site}>
                  <span className="stats-site">{s.site}</span>
                  <span className="stats-num">{num(s.count)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">No sites yet.</p>
          )}
        </section>
      </div>
      <p className="small muted stats-footnote">Counts cover your Library (not unsaved Feed posts). A streak counts days on which you archived at least one item.</p>
    </main>
  );
}
