import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advertisedFeeds, discoverFeedUrls, fallbackFeedUrls, feedUrlsFromUrl, youtubeChannelId } from '../src/feeds/discover';

const page = readFileSync(join(__dirname, 'fixtures/feeds/page.html'), 'utf8');

describe('advertised feeds', () => {
  it('finds rss/atom/json-feed alternates in any attribute order, comment feeds last, API json skipped', () => {
    expect(discoverFeedUrls(page, 'https://some.example.com/blog/post')).toEqual([
      'https://some.example.com/feed/',
      'https://some.example.com/atom.xml?x=1&y=2',
      'https://some.example.com/blog/feed.json',
      'https://some.example.com/comments/feed/',
    ]);
  });

  it('honours <base href>', () => {
    const html = '<head><base href="https://cdn.example.org/site/"><link rel="alternate" type="application/atom+xml" href="atom.xml"></head>';
    expect(advertisedFeeds(html, 'https://example.org/')).toEqual(['https://cdn.example.org/site/atom.xml']);
  });

  it('accepts rel lists and type parameters, ignores other links', () => {
    const html = `<link rel="alternate nofollow" type="application/rss+xml; charset=utf-8" href="/rss">
      <link rel="alternate" type="text/html" href="/other"><link rel="feed" href="/x">`;
    expect(advertisedFeeds(html, 'https://a.example.com/')).toEqual(['https://a.example.com/rss']);
  });
});

describe('fallbacks', () => {
  it('tries common paths at the site root when nothing is advertised', () => {
    const urls = discoverFeedUrls('<html><head><title>x</title></head></html>', 'https://plain.example.com/');
    expect(urls).toEqual([
      'https://plain.example.com/feed',
      'https://plain.example.com/rss',
      'https://plain.example.com/atom.xml',
      'https://plain.example.com/index.xml',
      'https://plain.example.com/feed.xml',
      'https://plain.example.com/rss.xml',
    ]);
  });

  it('tries a section path before the root, but not for deep article paths', () => {
    expect(fallbackFeedUrls('https://x.example.com/blog').slice(0, 2)).toEqual(['https://x.example.com/blog/feed', 'https://x.example.com/blog/rss']);
    expect(fallbackFeedUrls('https://x.example.com/blog')).toHaveLength(12);
    expect(fallbackFeedUrls('https://x.example.com/2026/10/09/some-post')[0]).toBe('https://x.example.com/feed');
  });

  it('never returns the page itself', () => {
    expect(discoverFeedUrls('', 'https://plain.example.com/feed')).not.toContain('https://plain.example.com/feed');
  });
});

describe('well-known sites', () => {
  it('YouTube channel, playlist and legacy user URLs', () => {
    expect(feedUrlsFromUrl('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA')).toEqual([
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA',
    ]);
    expect(feedUrlsFromUrl('https://www.youtube.com/playlist?list=PL123abc')).toEqual(['https://www.youtube.com/feeds/videos.xml?playlist_id=PL123abc']);
    expect(feedUrlsFromUrl('https://youtube.com/user/someone')).toEqual(['https://www.youtube.com/feeds/videos.xml?user=someone']);
  });

  it('YouTube @handle pages: channel id from the HTML', () => {
    const html = '<html><head><meta itemprop="channelId" content="UCHnyfMqiRRG1u-2MsSQLbXA"></head><body>{"browseId":"UCxxxxxxxxxxxxxxxxxxxxxx"}</body></html>';
    expect(youtubeChannelId(html)).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(discoverFeedUrls(html, 'https://www.youtube.com/@veritasium')[0]).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA',
    );
    expect(youtubeChannelId('<script>var x = {"externalId":"UC1234567890123456789012"}</script>')).toBe('UC1234567890123456789012');
  });

  it('Substack', () => {
    expect(feedUrlsFromUrl('https://astralcodexten.substack.com/p/some-post')).toEqual(['https://astralcodexten.substack.com/feed']);
    expect(discoverFeedUrls('<script src="https://substackcdn.com/x.js"></script>', 'https://www.custom-substack.com/')).toEqual([
      'https://www.custom-substack.com/feed',
    ]);
  });

  it('Medium users, publications, tags and subdomains', () => {
    expect(feedUrlsFromUrl('https://medium.com/@karpathy')).toEqual(['https://medium.com/feed/@karpathy']);
    expect(feedUrlsFromUrl('https://medium.com/@karpathy/software-2-0-a64152b37c35')).toEqual(['https://medium.com/feed/@karpathy']);
    expect(feedUrlsFromUrl('https://medium.com/better-programming')).toEqual(['https://medium.com/feed/better-programming']);
    expect(feedUrlsFromUrl('https://medium.com/tag/rust')).toEqual(['https://medium.com/feed/tag/rust']);
    expect(feedUrlsFromUrl('https://karpathy.medium.com/')).toEqual(['https://karpathy.medium.com/feed']);
    expect(feedUrlsFromUrl('https://medium.com/feed/@karpathy')).toEqual([]);
  });

  it('Reddit', () => {
    expect(feedUrlsFromUrl('https://www.reddit.com/r/programming/')).toEqual(['https://www.reddit.com/r/programming/.rss']);
    expect(feedUrlsFromUrl('https://old.reddit.com/r/rust/top')).toEqual(['https://www.reddit.com/r/rust/top/.rss']);
    expect(feedUrlsFromUrl('https://reddit.com/u/spez')).toEqual(['https://www.reddit.com/user/spez/.rss']);
    expect(feedUrlsFromUrl('https://www.reddit.com/r/rust/.rss')).toEqual([]);
  });

  it('GitHub repositories and users', () => {
    expect(feedUrlsFromUrl('https://github.com/vitejs/vite')).toEqual(['https://github.com/vitejs/vite/releases.atom']);
    expect(feedUrlsFromUrl('https://github.com/vitejs/vite/tree/main/docs')).toEqual(['https://github.com/vitejs/vite/releases.atom']);
    expect(feedUrlsFromUrl('https://github.com/torvalds')).toEqual(['https://github.com/torvalds.atom']);
    expect(feedUrlsFromUrl('https://github.com/vitejs/vite/releases.atom')).toEqual([]);
    expect(feedUrlsFromUrl('https://github.com/settings/profile')).toEqual([]);
  });

  it('special rules come before advertised feeds; no fallbacks then', () => {
    const urls = discoverFeedUrls('<html></html>', 'https://github.com/vitejs/vite');
    expect(urls).toEqual(['https://github.com/vitejs/vite/releases.atom']);
  });

  it('ignores unrelated or invalid URLs', () => {
    expect(feedUrlsFromUrl('https://example.com/r/foo')).toEqual([]);
    expect(feedUrlsFromUrl('not a url')).toEqual([]);
  });
});
