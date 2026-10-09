/**
 * One item in a list (library, feed, search results).
 *
 * export default ItemRow / export { ItemRow }
 * Props (ItemRowProps):
 *   item: Item
 *   categories: Category[] | undefined    to show the category name (useCategories())
 *   onOpen: (item: Item) => void           called when the title / row body is tapped (title is also a real
 *                                          <a href="/item/:id"> so ctrl/middle-click opens a new tab)
 *   selected?: boolean                     keyboard selection highlight (ItemList manages it)
 *   compact?: boolean                      no excerpt / thumbnail, tighter spacing
 *   selectable?: boolean                   bulk-select mode: a checkbox before the title; tapping the row toggles
 *                                          it instead of opening the item, and the per-row actions are hidden
 *   checked?: boolean                      checkbox state in selectable mode
 *   onCheck?: (item: Item, checked: boolean) => void
 *   snippet?: ReactNode                    shown instead of the excerpt (search: where the full text matched)
 *
 * Shows: title (bold, 2-line clamp), excerpt, then one footer row: meta line (source · type · reading time ·
 * relative date) with the category and at most MAX_ROW_TAGS tag chips under it (links to library filters for
 * library items; "+N" for the rest), next to the actions. Thin progress bar when 0 < progress < 1, fetch state
 * (uploading / fetching / error + Retry; a run stuck for 10 minutes offers Retry; rate-limited items and failed
 * previews of feed posts are shown muted, without Retry), optional thumbnail (prefs.showImages).
 * Always-visible actions: library → favorite, archive/unarchive, more; feed → Save (to library), Seen / Mark
 * new, more. Every action button is described by the row's title (aria-describedby). More menu: Edit…
 * (EditItemDialog), Open original / Open file, Favorite (feed), Fetch again, Delete (with confirmation).
 */
import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { usePrefs } from '../lib/prefs';
import { hostname, itemSource, readingTime, relativeTime, toDate, typeLabel } from '../lib/format';
import type { Category, Item } from '../lib/types';
import EditItemDialog from './EditItemDialog';
import { Archive, Check, External, FileText, Folder, Plus, Refresh, Star, StarFilled, Trash, Type, Unarchive, Undo } from './Icons';
import { canRefetch, deleteWithConfirm, isStalled, openOriginal, retryFetch, saveToLibrary, toggleArchive, toggleFavorite, toggleSeen } from './itemActions';
import Menu from './Menu';
import ProgressBar from './ProgressBar';
import Spinner from './Spinner';
import './components.css';

export interface ItemRowProps {
  item: Item;
  categories: Category[] | undefined;
  onOpen: (item: Item) => void;
  selected?: boolean;
  compact?: boolean;
  selectable?: boolean;
  checked?: boolean;
  onCheck?: (item: Item, checked: boolean) => void;
  snippet?: ReactNode;
}

/** An upload that has not finished after this long was most likely interrupted. */
const STALE_UPLOAD_MS = 30 * 60_000;
/** Tag chips shown on a row; the rest are summarised as "+N". */
export const MAX_ROW_TAGS = 3;

function FetchState({ item }: { item: Item }) {
  switch (item.fetchStatus) {
    case 'uploading': {
      const since = toDate(item.updatedAt)?.getTime() ?? Date.now();
      if (Date.now() - since > STALE_UPLOAD_MS) {
        return (
          <div className="item-state">
            <span className="error-text">Upload did not finish.</span>
            <button type="button" className="btn btn-small" onClick={() => void deleteWithConfirm(item)}>
              Delete
            </button>
          </div>
        );
      }
      return (
        <div className="item-state">
          <Spinner inline label="Uploading…" />
        </div>
      );
    }
    case 'pending':
      return (
        <div className="item-state">
          <Spinner inline label="Fetching…" />
        </div>
      );
    case 'processing':
      if (isStalled(item)) {
        return (
          <div className="item-state">
            <span className="item-state-muted">This is taking unusually long.</span>
            <button type="button" className="btn btn-small" onClick={() => retryFetch(item)}>
              <Refresh size={16} /> Retry
            </button>
          </div>
        );
      }
      return (
        <div className="item-state">
          <Spinner inline label="Processing…" />
        </div>
      );
    case 'error':
      // Waiting for its turn (per-user fetch limit): the server fetches it again by itself.
      if (item.retryAt) {
        return (
          <div className="item-state">
            <span className="item-state-muted">Queued: it is fetched automatically soon.</span>
          </div>
        );
      }
      // A feed post the user has not saved: the preview failed, but Save / Open original still work.
      if (item.location === 'feed') {
        return (
          <div className="item-state">
            <span className="item-state-muted">Preview unavailable</span>
          </div>
        );
      }
      return (
        <div className="item-state">
          <span className="error-text item-error">{item.fetchError || 'Could not fetch this page.'}</span>
          <button type="button" className="btn btn-small" onClick={() => retryFetch(item)}>
            <Refresh size={16} /> Retry
          </button>
        </div>
      );
    default:
      return null;
  }
}

export function ItemRow({ item, categories, onOpen, selected, compact, selectable, checked = false, onCheck, snippet }: ItemRowProps) {
  const prefs = usePrefs();
  const [editing, setEditing] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const isFeed = item.location === 'feed';
  const category = item.categoryId ? categories?.find((c) => c.id === item.categoryId) : undefined;
  const title = item.title.trim() || hostname(item.url) || item.file?.name || 'Untitled';
  const date = relativeTime(isFeed ? (item.publishedAt ?? item.createdAt) : item.createdAt);
  const meta = [itemSource(item), typeLabel(item.type), readingTime(item), date, !isFeed && item.status === 'archived' ? 'Archived' : '']
    .filter(Boolean)
    .join(' · ');
  const showThumb = prefs.showImages && !compact && !!item.imageUrl && !imgFailed;
  const progress = item.progress > 0 && item.progress < 1 ? item.progress : 0;

  function onTitleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (selectable) {
      e.preventDefault();
      onCheck?.(item, !checked);
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(item);
  }

  function onBodyClick(e: MouseEvent<HTMLDivElement>) {
    if ((e.target as Element).closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection()?.toString()) return; // user is selecting text
    if (selectable) onCheck?.(item, !checked);
    else onOpen(item);
  }

  const shownTags = item.tags.slice(0, MAX_ROW_TAGS);
  const hiddenTags = item.tags.length - shownTags.length;
  const chips =
    item.tags.length > 0 || category ? (
      <div className="item-chips">
        {category ? (
          isFeed ? (
            <span className="chip item-chip item-category">
              <Folder size={14} /> <span className="chip-text">{category.name}</span>
            </span>
          ) : (
            <RouterLink className="chip item-chip item-category" to={`/?view=all&cat=${encodeURIComponent(category.id)}`}>
              <Folder size={14} /> <span className="chip-text">{category.name}</span>
            </RouterLink>
          )
        ) : null}
        {shownTags.map((t) =>
          isFeed ? (
            <span key={t} className="chip item-chip">
              #{t}
            </span>
          ) : (
            <RouterLink key={t} className="chip item-chip" to={`/?view=all&tag=${encodeURIComponent(t)}`}>
              #{t}
            </RouterLink>
          ),
        )}
        {hiddenTags > 0 ? (
          <span className="chip item-chip item-more-tags" title={item.tags.slice(MAX_ROW_TAGS).map((t) => `#${t}`).join(' ')}>
            +{hiddenTags}
          </span>
        ) : null}
      </div>
    ) : null;
  const titleId = `item-title-${item.id}`;

  return (
    <article
      className={`item-row${selected ? ' selected' : ''}${compact ? ' compact' : ''}${selectable && checked ? ' checked' : ''}`}
      data-item-id={item.id}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="item-body" onClick={onBodyClick}>
        {selectable ? (
          <label className="item-check">
            <input type="checkbox" checked={checked} onChange={(e) => onCheck?.(item, e.target.checked)} aria-label={`Select “${title}”`} />
          </label>
        ) : null}
        <div className="item-text">
          <h3 className="item-title" id={titleId}>
            <a href={`/item/${encodeURIComponent(item.id)}`} onClick={onTitleClick}>
              {title}
            </a>
          </h3>
          {snippet ? (
            <p className="item-excerpt item-snippet">{snippet}</p>
          ) : !compact && item.excerpt ? (
            <p className="item-excerpt">{item.excerpt}</p>
          ) : null}
        </div>
        {showThumb ? (
          <img className="item-thumb" src={item.imageUrl!} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setImgFailed(true)} />
        ) : null}
      </div>
      {progress ? <ProgressBar value={progress} label="Reading progress" className="item-progress" /> : null}
      <FetchState item={item} />
      <div className="item-footer">
        <div className="item-info">
          {meta ? <div className="item-meta">{meta}</div> : null}
          {chips}
        </div>
        <div className="item-actions" hidden={selectable}>
          {isFeed ? (
            <>
              <button type="button" className="btn btn-small" onClick={() => saveToLibrary(item)} title="Save to Library" aria-describedby={titleId}>
                <Plus size={16} /> Save
              </button>
              {item.status === 'archived' ? (
                <button type="button" className="btn btn-small" onClick={() => toggleSeen(item)} title="Mark as new" aria-describedby={titleId}>
                  <Undo size={16} /> New
                </button>
              ) : (
                <button type="button" className="btn btn-small" onClick={() => toggleSeen(item)} title="Mark as seen" aria-describedby={titleId}>
                  <Check size={16} /> Seen
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-icon item-fav"
                aria-pressed={item.favorite}
                aria-label="Favorite"
                aria-describedby={titleId}
                title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => toggleFavorite(item)}
              >
                {item.favorite ? <StarFilled /> : <Star />}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={item.status === 'archived' ? 'Move back to Library' : 'Archive'}
                aria-describedby={titleId}
                title={item.status === 'archived' ? 'Move back to Library' : 'Archive'}
                onClick={() => toggleArchive(item)}
              >
                {item.status === 'archived' ? <Unarchive /> : <Archive />}
              </button>
            </>
          )}
          <Menu
            label="More actions"
            describedBy={titleId}
            items={[
              { label: 'Edit…', icon: <Type size={18} />, onSelect: () => setEditing(true) },
              item.url
                ? { label: 'Open original', icon: <External size={18} />, onSelect: () => openOriginal(item) }
                : item.file
                  ? { label: 'Open file', icon: <FileText size={18} />, onSelect: () => openOriginal(item) }
                  : null,
              isFeed
                ? {
                    label: item.favorite ? 'Remove from favorites' : 'Add to favorites',
                    icon: item.favorite ? <StarFilled size={18} /> : <Star size={18} />,
                    onSelect: () => toggleFavorite(item),
                  }
                : null,
              canRefetch(item) ? { label: 'Fetch again', icon: <Refresh size={18} />, onSelect: () => retryFetch(item) } : null,
              'separator',
              { label: 'Delete…', icon: <Trash size={18} />, danger: true, onSelect: () => void deleteWithConfirm(item) },
            ]}
          />
        </div>
      </div>
      {editing ? <EditItemDialog item={item} open onClose={() => setEditing(false)} /> : null}
    </article>
  );
}

export default ItemRow;
