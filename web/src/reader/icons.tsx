/**
 * Reader-only inline SVG icons, drawn like components/Icons (24×24 grid, stroke = currentColor,
 * decorative: label the surrounding button).
 *
 * Exports: Listen, Play, Pause, SkipBack, SkipForward, Copy, Share, Sparkle; type ReaderIconProps = { size?: number }
 */
import type { ReactNode } from 'react';

export interface ReaderIconProps {
  size?: number;
}

function make(name: string, children: ReactNode) {
  function Icon({ size = 20 }: ReaderIconProps) {
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
        aria-hidden="true"
        className="icon"
      >
        {children}
      </svg>
    );
  }
  Icon.displayName = `ReaderIcon${name}`;
  return Icon;
}

export const Listen = make(
  'Listen',
  <>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <path d="M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z" />
  </>,
);
export const Play = make('Play', <path d="M7 4.5v15l12-7.5z" fill="currentColor" />);
export const Pause = make('Pause', <path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" />);
export const SkipBack = make('SkipBack', <path d="M6 5v14M19 5 9 12l10 7z" />);
export const SkipForward = make('SkipForward', <path d="M18 5v14M5 5l10 7-10 7z" />);
export const Copy = make(
  'Copy',
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </>,
);
export const Share = make(
  'Share',
  <>
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </>,
);
export const Sparkle = make('Sparkle', <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />);
