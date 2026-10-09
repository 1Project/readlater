/**
 * Reader toolbar: Back · title · Archive · Favorite · Edit · Highlights · Typography · More.
 * Sticky at the top in scroll mode; an overlay (shown/hidden by the reader) in pages mode.
 *
 * export default ReaderToolbar
 * Props: see ReaderToolbarProps.
 */
import { Archive, Back, Check, External, Highlight, Link, Plus, Refresh, Star, StarFilled, Tag, Trash, Type, Unarchive, Undo, Book } from '../components/Icons';
import Menu from '../components/Menu';
import type { Item } from '../lib/types';

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
}

export interface ReaderToolbarProps {
  item: Item;
  overlay: boolean;
  hidden: boolean;
  highlightCount: number;
  hasContents: boolean;
  typographyOpen: boolean;
  actions: ReaderActions;
}

export default function ReaderToolbar({ item, overlay, hidden, highlightCount, hasContents, typographyOpen, actions }: ReaderToolbarProps) {
  const feed = item.location === 'feed';
  const archived = item.status === 'archived';
  const archiveLabel = feed ? (archived ? 'Mark as new' : 'Mark seen') : archived ? 'Unarchive' : 'Archive';
  const ArchiveIcon = feed ? (archived ? Undo : Check) : archived ? Unarchive : Archive;
  const hasOriginal = !!item.url || !!item.file;

  return (
    <header className={`reader-toolbar${overlay ? ' reader-toolbar-overlay' : ''}`} hidden={hidden}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Back" title="Back (Esc)" onClick={actions.back}>
        <Back />
      </button>
      <span className="reader-toolbar-title truncate">{item.title}</span>
      <span className="spacer" />
      <button type="button" className="btn btn-ghost btn-icon" aria-label={archiveLabel} title={`${archiveLabel} (e)`} onClick={actions.archive}>
        <ArchiveIcon />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
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
          hasOriginal && { label: item.url ? 'Open original' : 'Open file', icon: <External size={18} />, onSelect: actions.openOriginal },
          !!item.url && { label: 'Copy link', icon: <Link size={18} />, onSelect: actions.copyLink },
          !!(item.url || item.file) && { label: 'Fetch again', icon: <Refresh size={18} />, onSelect: actions.refetch },
          'separator',
          { label: 'Delete', icon: <Trash size={18} />, danger: true, onSelect: actions.remove },
        ]}
      />
    </header>
  );
}
