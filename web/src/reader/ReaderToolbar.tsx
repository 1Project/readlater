/**
 * Reader toolbar: Back · title · Archive · Favorite · Edit · Highlights · Listen · Typography · More.
 * Sticky at the top in scroll mode; an overlay (shown/hidden by the reader) in pages mode.
 * With `progress` (scroll mode) it shows "35% · 34 min left" after the title (wide screens) and a thin
 * static progress line along its bottom edge.
 * More: Contents, feed actions, (Listen when `listenInMenu`), Summarize / Ask about this… (when `ai`),
 * Open original, Copy link, Share public link…, Download as EPUB, Fetch again, Delete.
 *
 * export default ReaderToolbar
 * Props: see ReaderToolbarProps.
 */
import { Archive, Back, Check, Download, External, Highlight, Link, Plus, Refresh, Star, StarFilled, Tag, Trash, Type, Unarchive, Undo, Book } from '../components/Icons';
import { useSyncExternalStore } from 'react';
import { canRefetch } from '../components/itemActions';
import Menu from '../components/Menu';
import type { Item } from '../lib/types';
import type { ProgressStore } from './Reader';
import { Listen, Share, Sparkle } from './icons';

export interface ReaderActions {
  back: () => void;
  archive: () => void;
  favorite: () => void;
  edit: () => void;
  typography: () => void;
  highlights: () => void;
  contents: () => void;
  openOriginal: () => void;
  copyLink: () => void;
  refetch: () => void;
  remove: () => void;
  saveToLibrary: () => void;
  toggleSeen: () => void;
  listen: () => void;
  summarize: () => void;
  ask: () => void;
  share: () => void;
  downloadEpub: () => void;
}

export interface ReaderToolbarProps {
  item: Item;
  overlay: boolean;
  hidden: boolean;
  highlightCount: number;
  hasContents: boolean;
  typographyOpen: boolean;
  /** Text-to-speech is possible (an engine exists and the article text is shown). */
  canListen: boolean;
  /** The Listen player is open. */
  listening: boolean;
  /** Put Listen into the More menu instead of the bar (narrow e-ink screens with big tap targets). */
  listenInMenu: boolean;
  /** AI features are enabled on the server. */
  ai: boolean;
  actions: ReaderActions;
  /** Reading progress to show (scroll mode); null hides it. */
  progress?: ProgressStore | null;
}

function ReadingProgress({ store, minutes }: { store: ProgressStore; minutes: number | null }) {
  // Whole percents only, so scrolling re-renders this at most a hundred times.
  const pct = useSyncExternalStore(store.subscribe, () => Math.round(Math.max(0, Math.min(1, store.get())) * 100));
  const left = minutes ? Math.ceil(minutes * (1 - pct / 100)) : 0;
  const text = `${pct}%${left > 0 && pct < 100 ? ` · ${left} min left` : ''}`;
  return (
    <>
      <span className="reader-progress small" role="status" aria-label={`Read ${text}`}>
        {text}
      </span>
      <span className="reader-progress-line" aria-hidden="true" style={{ transform: `scaleX(${pct / 100})` }} />
    </>
  );
}

export default function ReaderToolbar({
  item,
  overlay,
  hidden,
  highlightCount,
  hasContents,
  typographyOpen,
  canListen,
  listening,
  listenInMenu,
  ai,
  actions,
  progress,
}: ReaderToolbarProps) {
  const feed = item.location === 'feed';
  const archived = item.status === 'archived';
  const archiveLabel = feed ? (archived ? 'Mark as new' : 'Mark seen') : archived ? 'Unarchive' : 'Archive';
  const ArchiveIcon = feed ? (archived ? Undo : Check) : archived ? Unarchive : Archive;
  const hasOriginal = !!item.url || !!item.file;
  const hasText = item.contentChunks > 0;

  return (
    <header className={`reader-toolbar${overlay ? ' reader-toolbar-overlay' : ''}`} hidden={hidden}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Back" title="Back (Esc)" onClick={actions.back}>
        <Back />
      </button>
      <span className="reader-toolbar-title truncate">{item.title}</span>
      {progress ? <ReadingProgress store={progress} minutes={item.readingMinutes} /> : null}
      <span className="spacer" />
      <button type="button" className="btn btn-ghost btn-icon" aria-label={archiveLabel} title={`${archiveLabel} (e)`} onClick={actions.archive}>
        <ArchiveIcon />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon reader-fav"
        aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={item.favorite}
        title="Favorite (s)"
        onClick={actions.favorite}
      >
        {item.favorite ? <StarFilled /> : <Star />}
      </button>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Edit tags, category and note" title="Tags, category & note" onClick={actions.edit}>
        <Tag />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon reader-hl-button"
        aria-label={`Highlights (${highlightCount})`}
        title={`Highlights (${highlightCount})`}
        onClick={actions.highlights}
      >
        <Highlight />
        {highlightCount > 0 ? <span className="reader-badge">{highlightCount}</span> : null}
      </button>
      {canListen && !listenInMenu ? (
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Listen" title="Listen" aria-pressed={listening} onClick={actions.listen}>
          <Listen />
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Text settings"
        title="Text settings (t)"
        aria-expanded={typographyOpen}
        data-typography-toggle=""
        onClick={actions.typography}
      >
        <Type />
      </button>
      <Menu
        label="More actions"
        items={[
          hasContents && { label: 'Contents', icon: <Book size={18} />, onSelect: actions.contents },
          feed && { label: 'Save to library', icon: <Plus size={18} />, onSelect: actions.saveToLibrary },
          feed && { label: archived ? 'Mark as new' : 'Mark seen', icon: archived ? <Undo size={18} /> : <Check size={18} />, onSelect: actions.toggleSeen },
          (hasContents || feed) && 'separator',
          canListen && listenInMenu && { label: listening ? 'Stop listening' : 'Listen', icon: <Listen size={18} />, onSelect: actions.listen },
          ai && hasText && { label: 'Summarize', icon: <Sparkle size={18} />, onSelect: actions.summarize },
          ai && hasText && { label: 'Ask about this…', icon: <Sparkle size={18} />, onSelect: actions.ask },
          ((canListen && listenInMenu) || (ai && hasText)) && 'separator',
          hasOriginal && { label: item.url ? 'Open original' : 'Open file', icon: <External size={18} />, onSelect: actions.openOriginal },
          !!item.url && { label: 'Copy link', icon: <Link size={18} />, onSelect: actions.copyLink },
          hasText && { label: 'Share public link…', icon: <Share size={18} />, onSelect: actions.share },
          hasText && { label: 'Download as EPUB', icon: <Download size={18} />, onSelect: actions.downloadEpub },
          canRefetch(item) && { label: 'Fetch again', icon: <Refresh size={18} />, onSelect: actions.refetch },
          'separator',
          { label: 'Delete', icon: <Trash size={18} />, danger: true, onSelect: actions.remove },
        ]}
      />
    </header>
  );
}
