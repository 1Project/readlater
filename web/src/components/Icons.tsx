/**
 * Inline SVG icons (24x24 grid, stroke = currentColor). Decorative by default (aria-hidden);
 * give the surrounding button an aria-label, or pass `title` to make the icon itself labelled.
 *
 * Props (all icons): IconProps = SVGProps<SVGSVGElement> & { size?: number (default 20); title?: string }
 *
 * Exports: Archive, Unarchive, Star, StarFilled, Trash, Tag, Folder, External, Back, Settings,
 *   Search, Plus, Rss, Highlight, More, Check, Close, ChevronLeft, ChevronRight, Refresh,
 *   Upload, Download, Note, Book, FileText, Link, Type, Inbox, Eye, Undo; type IconProps.
 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function make(name: string, children: ReactNode) {
  function Icon({ size = 20, title, className, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        className={className ? `icon ${className}` : 'icon'}
        {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {children}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

const STAR = 'M12 3.2l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17.1 6.6 20l1.1-6.1-4.5-4.3 6.1-.8z';

export const Archive = make(
  'Archive',
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </>,
);

export const Unarchive = make(
  'Unarchive',
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M12 17v-6" />
    <path d="m9 13.5 3-3 3 3" />
  </>,
);

export const Star = make('Star', <path d={STAR} />);
export const StarFilled = make('StarFilled', <path d={STAR} fill="currentColor" />);

export const Trash = make(
  'Trash',
  <>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </>,
);

export const Tag = make(
  'Tag',
  <>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </>,
);

export const Folder = make('Folder', <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);

export const External = make(
  'External',
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>,
);

export const Back = make(
  'Back',
  <>
    <path d="M19 12H5" />
    <path d="m11 18-6-6 6-6" />
  </>,
);

export const Settings = make(
  'Settings',
  <>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="18" r="2" />
  </>,
);

export const Search = make(
  'Search',
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </>,
);

export const Plus = make('Plus', <path d="M12 5v14M5 12h14" />);

export const Rss = make(
  'Rss',
  <>
    <path d="M5 11a8 8 0 0 1 8 8" />
    <path d="M5 5a14 14 0 0 1 14 14" />
    <circle cx="6" cy="18" r="1.5" fill="currentColor" />
  </>,
);

export const Highlight = make(
  'Highlight',
  <>
    <path d="m14 5 5 5-8 8H6v-5z" />
    <path d="m11.5 7.5 5 5" />
    <path d="M4 21h16" />
  </>,
);

export const More = make(
  'More',
  <>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </>,
);

export const Check = make('Check', <path d="m5 12.5 4.5 4.5L19 7" />);
export const Close = make('Close', <path d="M6 6l12 12M18 6 6 18" />);
export const ChevronLeft = make('ChevronLeft', <path d="m15 6-6 6 6 6" />);
export const ChevronRight = make('ChevronRight', <path d="m9 6 6 6-6 6" />);

export const Refresh = make(
  'Refresh',
  <>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v5h-5" />
  </>,
);

export const Upload = make(
  'Upload',
  <>
    <path d="M12 15V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </>,
);

export const Download = make(
  'Download',
  <>
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </>,
);

export const Note = make(
  'Note',
  <>
    <path d="M5 4h14v11l-5 5H5z" />
    <path d="M14 20v-5h5" />
    <path d="M8 9h8M8 12.5h4" />
  </>,
);

export const Book = make(
  'Book',
  <>
    <path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
    <path d="M4 19a2 2 0 0 1 2-2h13" />
  </>,
);

export const FileText = make(
  'FileText',
  <>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h6" />
  </>,
);

export const Link = make(
  'Link',
  <>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </>,
);

export const Type = make(
  'Type',
  <>
    <path d="M5 7V5h14v2" />
    <path d="M12 5v14" />
    <path d="M9 19h6" />
  </>,
);

export const Inbox = make(
  'Inbox',
  <>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
  </>,
);

export const Eye = make(
  'Eye',
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const Undo = make(
  'Undo',
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </>,
);
