import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, parseTweetUrl } from '../src/extract';
import { articleToHtml, buildTweet, buildTweetFromOembed, tweetTextHtml, type FxTweet } from '../src/extract/tweet';
import { fixture, fixtureJson, mockFetch } from './fixtures/extract/mockFetch';

afterEach(() => vi.restoreAllMocks());

describe('parseTweetUrl', () => {
  it.each([
    ['https://x.com/jack/status/20', '20'],
    ['https://twitter.com/jack/status/20?s=20&t=abc', '20'],
    ['https://mobile.twitter.com/jack/status/20', '20'],
    ['https://www.x.com/jack/statuses/20/', '20'],
    ['https://x.com/i/status/1585341984679469056', '1585341984679469056'],
    ['https://x.com/i/web/status/1585341984679469056', '1585341984679469056'],
    ['https://fxtwitter.com/elonmusk/status/1585341984679469056', '1585341984679469056'],
    ['https://d.fxtwitter.com/elonmusk/status/1585341984679469056', '1585341984679469056'],
    ['https://vxtwitter.com/a_b/status/123/photo/1', '123'],
    ['https://fixupx.com/a/status/123', '123'],
  ])('%s → %s', (url, id) => {
    expect(parseTweetUrl(url)).toBe(id);
  });

  it.each(['https://x.com/jack', 'https://x.com/home', 'https://example.com/jack/status/20', 'https://x.com/i/article/123', 'not a url'])(
    'rejects %s',
    (url) => expect(parseTweetUrl(url)).toBeNull(),
  );
});

describe('buildTweet', () => {
  it('builds a video tweet (real FxTwitter response)', () => {
    const { tweet } = fixtureJson<{ tweet: FxTweet }>('fxtwitter-video.json');
    const r = buildTweet(tweet);
    expect(r.type).toBe('tweet');
    expect(r.title).toBe('@elonmusk: Entering Twitter HQ – let that sink in!');
    expect(r.author).toBe('Elon Musk (@elonmusk)');
    expect(r.siteName).toBe('X');
    expect(r.publishedAt?.toISOString()).toBe('2022-10-26T18:45:58.000Z');
    expect(r.canonicalUrl).toBe('https://x.com/elonmusk/status/1585341984679469056');
    expect(r.imageUrl).toMatch(/^https:\/\/pbs\.twimg\.com\/ext_tw_video_thumb\//);
    expect(r.html).toContain('<strong>Elon Musk</strong> <a href="https://x.com/elonmusk">@elonmusk</a>');
    expect(r.html).toContain('<p>Entering Twitter HQ – let that sink in!</p>');
    expect(r.html).toMatch(/<img src="https:\/\/pbs\.twimg\.com\/ext_tw_video_thumb\/[^"]+" alt="Video \(0:09\)">/);
    expect(r.html).toContain('▶ Video (0:09) — watch on X');
    expect(r.html).not.toContain('t.co');
  });

  it('renders facets, photos, poll, reply context, quote and community note', () => {
    const { tweet } = fixtureJson<{ tweet: FxTweet }>('fxtwitter-rich.json');
    const r = buildTweet(tweet);
    expect(r.title).toBe('@readlater_dev: Hey @jack, read this: example.com/article #reading Second paragraph & <more>');
    expect(r.html).toContain('Replying to <a href="https://x.com/jack">@jack</a>');
    expect(r.html).toContain(
      '<p>Hey <a href="https://x.com/jack">@jack</a>, read this: <a href="https://example.com/article">example.com/article</a> <a href="https://x.com/hashtag/reading">#reading</a></p><p>Second paragraph &amp; &lt;more&gt;</p>',
    );
    expect(r.html).toContain('<figure><img src="https://pbs.twimg.com/media/PHOTO1.jpg?name=orig" alt="A stack of books"></figure>');
    expect(r.html).toContain('<li>Paper — 60% (120)</li><li>E-ink — 40% (80)</li>');
    expect(r.html).toContain('200 votes · Final results');
    expect(r.html).toMatch(/<blockquote><p><strong>Other Person<\/strong> <a href="https:\/\/x.com\/other">@other<\/a> · <a href="https:\/\/x.com\/other\/status\/1799999999999999999">Jun 14, 2024<\/a><\/p><p>The original thought.<\/p><figure><img src="https:\/\/pbs.twimg.com\/media\/QUOTED.jpg" alt=""><\/figure><\/blockquote>/);
    expect(r.html).toContain('<aside><p><strong>Community note</strong></p><p>Context: see <a href="https://example.org/context">https://example.org/context</a></p></aside>');
    expect(r.imageUrl).toBe('https://pbs.twimg.com/media/PHOTO1.jpg?name=orig');
    expect(r.html).not.toContain('pic999');
    expect(r.excerpt).toBe('Hey @jack, read this: example.com/article #reading Second paragraph & <more>');
  });

  it('renders an X long-form article', () => {
    const { tweet } = fixtureJson<{ tweet: FxTweet }>('fxtwitter-article.json');
    const r = buildTweet(tweet);
    expect(r.title).toBe('@writer: How I Read 100 Books');
    expect(r.imageUrl).toBe('https://pbs.twimg.com/media/COVER.jpg');
    expect(r.excerpt).toBe('A long-form note on reading habits.');
    const html = articleToHtml(tweet.article!);
    expect(html).toBe(
      '<figure><img src="https://pbs.twimg.com/media/COVER.jpg" alt=""></figure><h2>How I Read 100 Books</h2>' +
        '<p>It started with a <strong>simple</strong> rule.</p><h3>The rules</h3>' +
        '<ul><li>Read every day</li><li>Quit <em>bad</em> books</li></ul>' +
        '<figure><img src="https://pbs.twimg.com/media/INLINE.jpg" alt=""></figure>' +
        '<p>More at <a href="https://blog.example.com/">my blog</a>.</p>' +
        '<p><a href="https://x.com/i/status/20">Embedded post</a></p>' +
        '<blockquote><p>Books are uniquely portable magic.</p></blockquote>' +
        '<pre><code>console.log(&#39;hi&#39;)</code></pre>',
    );
    // The bare article link is not repeated as post text.
    expect(r.html).not.toContain('x.com/i/article');
    expect(r.html).toContain('<h3>The rules</h3>');
  });

  it('falls back to plain text when facets are missing', () => {
    expect(tweetTextHtml({ text: 'see https://a.com/x <b>' })).toBe('see <a href="https://a.com/x">https://a.com/x</a> &lt;b&gt;');
  });
});

describe('oEmbed fallback', () => {
  it('parses the official oEmbed HTML', () => {
    const r = buildTweetFromOembed(fixtureJson('oembed-tweet.json'), '1585341984679469056');
    expect(r.title).toBe('@elonmusk: Entering Twitter HQ – let that sink in!');
    expect(r.author).toBe('Elon Musk (@elonmusk)');
    expect(r.publishedAt?.getUTCFullYear()).toBe(2022);
    expect(r.html).toContain('<p>Entering Twitter HQ – let that sink in!</p>');
    expect(r.html).not.toContain('pic.twitter.com');
  });

  it('is used when FxTwitter fails', async () => {
    const spy = mockFetch([
      ['https://api.fxtwitter.com/status/1585341984679469056', { status: 500, body: 'error' }],
      [/^https:\/\/publish\.x\.com\/oembed\?url=/, { body: fixture('oembed-tweet.json'), type: 'application/json' }],
    ]);
    const r = await extractUrl('https://twitter.com/elonmusk/status/1585341984679469056?s=46');
    expect(r.type).toBe('tweet');
    expect(r.author).toBe('Elon Musk (@elonmusk)');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('uses FxTwitter first and reports missing posts', async () => {
    mockFetch([['https://api.fxtwitter.com/status/1585341984679469056', { body: fixture('fxtwitter-video.json'), type: 'application/json' }]]);
    const r = await extractUrl('https://x.com/elonmusk/status/1585341984679469056');
    expect(r.title).toMatch(/^@elonmusk: /);
    vi.restoreAllMocks();
    mockFetch([['https://api.fxtwitter.com/status/1', { status: 404, body: '{"code":404,"message":"NOT_FOUND"}', type: 'application/json' }]]);
    await expect(extractUrl('https://x.com/a/status/1')).rejects.toThrow(/not found/);
  });
});
