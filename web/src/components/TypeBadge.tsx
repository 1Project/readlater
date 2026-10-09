/**
 * Small outlined label for an item's type ("Article", "Post", "Paper", "PDF", "EPUB", "Video", "Other").
 *
 * export default TypeBadge / export { TypeBadge }
 * Props: { type: ItemType; className?: string }
 */
import type { ItemType } from '../lib/types';
import { typeLabel } from '../lib/format';
import './components.css';

export function TypeBadge({ type, className }: { type: ItemType; className?: string }) {
  return <span className={`type-badge type-${type}${className ? ` ${className}` : ''}`}>{typeLabel(type)}</span>;
}

export default TypeBadge;
