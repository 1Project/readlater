import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOpml } from '../src/feeds/opml';

describe('parseOpml', () => {
  it('flattens nested outlines, matches xmlUrl case-insensitively, dedupes and skips non-feeds', () => {
    const feeds = parseOpml(readFileSync(join(__dirname, 'fixtures/feeds/subscriptions.opml'), 'utf8'));
    expect(feeds).toEqual([
      { title: 'Hacker News', xmlUrl: 'https://hnrss.org/frontpage', htmlUrl: 'https://news.ycombinator.com/' },
      { title: 'Deep & Nested', xmlUrl: 'https://deep.example.com/feed.xml', htmlUrl: null },
      { title: 'Top level', xmlUrl: 'https://top.example.com/rss', htmlUrl: 'https://top.example.com/' },
    ]);
  });

  it('handles a single outline and a missing title', () => {
    const opml = '<?xml version="1.0"?><opml version="1.0"><head/><body><outline xmlUrl="https://one.example.com/feed"/></body></opml>';
    expect(parseOpml(opml)).toEqual([{ title: '', xmlUrl: 'https://one.example.com/feed', htmlUrl: null }]);
  });

  it('returns nothing for an empty body and throws for non-OPML input', () => {
    expect(parseOpml('<opml version="2.0"><head><title>x</title></head><body></body></opml>')).toEqual([]);
    expect(() => parseOpml('hello')).toThrow(/OPML/);
    expect(() => parseOpml('<rss><channel/></rss>')).toThrow(/OPML/);
  });
});
