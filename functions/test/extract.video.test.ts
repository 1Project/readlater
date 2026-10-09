import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, parseVideoUrl } from '../src/extract';
import { buildVideo, parseYouTubePage } from '../src/extract/video';
import { mockFetch } from './fixtures/extract/mockFetch';

afterEach(() => vi.restoreAllMocks());

const YT_OEMBED = {
  title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
  author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/@RickAstleyYT',
  type: 'video',
  provider_name: 'YouTube',
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
};

describe('parseVideoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/76979871', 'vimeo', '76979871'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'vimeo', '76979871'],
    ['https://player.vimeo.com/video/76979871', 'vimeo', '76979871'],
  ])('%s', (url, provider, id) => {
    expect(parseVideoUrl(url)).toMatchObject({ provider, id });
  });

  it.each(['https://www.youtube.com/@RickAstleyYT', 'https://www.youtube.com/watch?v=short', 'https://vimeo.com/about', 'https://example.com/watch?v=dQw4w9WgXcQ'])(
    'rejects %s',
    (url) => expect(parseVideoUrl(url)).toBeNull(),
  );
});

describe('video extraction', () => {
  it('reads the full description and date from the YouTube page JSON', () => {
    const page = '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Line one \\"quoted\\"\\nhttps://example.com/link\\n\\nPara two"},"microformat":{"playerMicroformatRenderer":{"publishDate":"2009-10-24T23:57:33-07:00"}}};</script>';
    const r = parseYouTubePage(page);
    expect(r.description).toBe('Line one "quoted"\nhttps://example.com/link\n\nPara two');
    expect(r.publishedAt?.toISOString()).toBe('2009-10-25T06:57:33.000Z');
    expect(parseYouTubePage('<html></html>')).toEqual({ description: null, publishedAt: null });
  });

  it('builds thumbnail + link + description', () => {
    const ref = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')!;
    const r = buildVideo(ref, YT_OEMBED, { description: 'Hello\nhttps://example.com', publishedAt: null });
    expect(r.type).toBe('video');
    expect(r.title).toBe(YT_OEMBED.title);
    expect(r.author).toBe('Rick Astley');
    expect(r.siteName).toBe('YouTube');
    expect(r.imageUrl).toBe(YT_OEMBED.thumbnail_url);
    expect(r.canonicalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.html).toBe(
      '<figure><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"></a>' +
        '<figcaption><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">▶ Watch on YouTube</a> · <a href="https://www.youtube.com/@RickAstleyYT">Rick Astley</a></figcaption></figure>' +
        '<p>Hello<br><a href="https://example.com/">https://example.com</a></p>',
    );
  });

  it('uses oEmbed and tolerates a blocked watch page (mocked network)', async () => {
    mockFetch([
      [/^https:\/\/www\.youtube\.com\/oembed\?/, { body: JSON.stringify(YT_OEMBED), type: 'application/json' }],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { status: 429, body: 'captcha' }],
    ]);
    const r = await extractUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(r.title).toBe(YT_OEMBED.title);
    expect(r.html).toContain('▶ Watch on YouTube');
  });

  it('reports unavailable videos', async () => {
    mockFetch([]);
    await expect(extractUrl('https://vimeo.com/76979871')).rejects.toThrow(/video is unavailable/);
  });
});
