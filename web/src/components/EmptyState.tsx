/**
 * Centered empty-list message.
 *
 * export default EmptyState / export { EmptyState }
 * Props: {
 *   title: ReactNode          main line
 *   children?: ReactNode      secondary text (muted)
 *   icon?: ReactNode          e.g. <Inbox size={32} />
 *   action?: ReactNode        e.g. a button
 * }
 */
import type { ReactNode } from 'react';
import './components.css';

export interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, children, icon, action }: EmptyStateProps) {
  return (
    <div className="empty empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
