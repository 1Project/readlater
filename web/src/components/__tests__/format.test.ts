import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, hostname, itemSource, readingTime, relativeTime, toDate, typeLabel } from '../../lib/format';

const NOW = new Date('2026-10-09T12:00:00Z').getTime();

describe('format', () => {
  it('toDate accepts Timestamp-like, Date, ms and null', () => {
    const d = new Date(NOW);
    expect(toDate({ toDate: () => d })).toBe(d);
    expect(toDate(d)).toBe(d);
    expect(toDate(NOW)?.getTime()).toBe(NOW);
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate(new Date('nope'))).toBeNull();
  });

  it('relativeTime', () => {
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 2 * 86400_000, NOW)).toBe('2d ago');
    expect(relativeTime(NOW - 30 * 86400_000, NOW)).toBe(formatDate(NOW - 30 * 86400_000, NOW));
    expect(relativeTime({ toDate: () => new Date(NOW - 60_000) }, NOW)).toBe('1m ago');
  });

  it('formatDate includes the year only for other years', () => {
    expect(formatDate(new Date('2026-03-04T12:00:00Z'), NOW)).not.toMatch(/2026/);
    expect(formatDate(new Date('2024-03-04T12:00:00Z'), NOW)).toMatch(/2024/);
    expect(formatDate(null)).toBe('');
  });

  it('readingTime', () => {
    expect(readingTime({ readingMinutes: 5 })).toBe('5 min');
    expect(readingTime({ readingMinutes: null, wordCount: 460 })).toBe('2 min');
    expect(readingTime({ readingMinutes: null, wordCount: 10 })).toBe('1 min');
    expect(readingTime({ readingMinutes: 90 })).toBe('1 h 30 min');
    expect(readingTime({ readingMinutes: 120 })).toBe('2 h');
    expect(readingTime({ readingMinutes: null, wordCount: null })).toBe('');
    expect(readingTime({})).toBe('');
  });

  it('hostname', () => {
    expect(hostname('https://www.example.com/a?b')).toBe('example.com');
    expect(hostname('https://sub.example.org')).toBe('sub.example.org');
    expect(hostname('not a url')).toBe('');
    expect(hostname(null)).toBe('');
  });

  it('typeLabel', () => {
    expect(typeLabel('article')).toBe('Article');
    expect(typeLabel('tweet')).toBe('Post');
    expect(typeLabel('pdf')).toBe('PDF');
    expect(typeLabel('epub')).toBe('EPUB');
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('itemSource prefers author for posts/papers/books, site for articles', () => {
    expect(itemSource({ type: 'tweet', author: '@jack', siteName: 'X', url: 'https://x.com/jack/status/1' })).toBe('@jack');
    expect(itemSource({ type: 'article', author: 'Jane', siteName: 'The Site', url: 'https://site.com/a' })).toBe('The Site');
    expect(itemSource({ type: 'article', author: null, siteName: null, url: 'https://www.site.com/a' })).toBe('site.com');
    expect(itemSource({ type: 'epub', author: null, siteName: null, url: null })).toBe('');
  });
});
