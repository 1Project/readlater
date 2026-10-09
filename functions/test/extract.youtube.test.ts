import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractHtml, extractUrl, parseVideoUrl } from '../src/extract';
import { buildVideo, pageInfoFromHtml } from '../src/extract/video';
import {
  extractJsonAssignment,
  fetchTranscript,
  fmtTimestamp,
  groupCues,
  parsePlayerResponse,
  parseTranscript,
  pickCaptionTrack,
  transcriptHtml,
  type CaptionTrack,
} from '../src/extract/youtube';
import { fixture, mockFetch } from './fixtures/extract/mockFetch';

afterEach(() => vi.restoreAllMocks());

const ID = 'dQw4w9WgXcQ';
const OEMBED = {
  title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
  author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/@RickAstleyYT',
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
};

const track = (languageCode: string, asr = false): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=${ID}&lang=${languageCode}${asr ? '&kind=asr' : ''}`,
  languageCode,
  name: languageCode,
  asr,
});

describe('watch page parsing', () => {
  it('finds the player response with string-aware brace matching', () => {
    expect(extractJsonAssignment('var x = {"a":"} {","b":{"c":"\\"}"}};', 'x')).toEqual({ a: '} {', b: { c: '"}' } });
    expect(extractJsonAssignment('window["x"] = {"a":1};', 'x')).toEqual({ a: 1 });
    expect(extractJsonAssignment('var x = {broken', 'x')).toBeNull();
  });

  it('reads title, author, description, date and caption tracks (real page, trimmed)', () => {
    const p = parsePlayerResponse(fixture('youtube-watch.html'), ID)!;
    expect(p.videoId).toBe(ID);
    expect(p.title).toBe(OEMBED.title);
    expect(p.author).toBe('Rick Astley');
    expect(p.description).toMatch(/^The official video for “Never Gonna Give You Up” by Rick Astley\./);
    expect(p.publishedAt?.toISOString()).toBe('2009-10-25T06:57:33.000Z');
    expect(p.playability).toBe('OK');
    expect(p.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/\w+\.jpg$/);
    expect(p.tracks.map((t) => `${t.languageCode}${t.asr ? ':asr' : ''}`)).toEqual(['en', 'en:asr', 'de-DE', 'ja', 'pt-BR', 'es-419']);
    expect(p.tracks[0].baseUrl).toContain('&exp=xpe&');
    expect(parsePlayerResponse(fixture('youtube-watch.html'), 'aaaaaaaaaaa')).toBeNull();
    expect(parsePlayerResponse('<html></html>')).toBeNull();
  });

  it('ignores a captured page that belongs to another video', () => {
    const ref = parseVideoUrl('https://youtu.be/aaaaaaaaaaa')!;
    expect(pageInfoFromHtml(ref, fixture('youtube-watch.html'), ref.url)).toBeNull();
  });
});

describe('caption track choice', () => {
  it('prefers the spoken language, manual over auto-generated, then English', () => {
    expect(pickCaptionTrack([track('en', true), track('de'), track('en')])).toMatchObject({ languageCode: 'en', asr: false });
    expect(pickCaptionTrack([track('de', true), track('en'), track('de-DE')])).toMatchObject({ languageCode: 'de-DE', asr: false });
    expect(pickCaptionTrack([track('de', true), track('en')])).toMatchObject({ languageCode: 'de', asr: true });
    expect(pickCaptionTrack([track('fr'), track('en')])).toMatchObject({ languageCode: 'en' });
    expect(pickCaptionTrack([track('fr'), track('ja')], 'ja')).toMatchObject({ languageCode: 'ja' });
    expect(pickCaptionTrack([track('fr'), track('ja')])).toMatchObject({ languageCode: 'fr' });
    expect(pickCaptionTrack([])).toBeNull();
  });
});

describe('transcript parsing', () => {
  it('parses json3 (real auto-generated track)', () => {
    const cues = parseTranscript(fixture('youtube-asr.json3.json'));
    expect(cues[0]).toEqual({ start: 0.32, text: '[Music]' });
    expect(cues[1]).toEqual({ start: 18.8, text: "We're no strangers to" });
    expect(cues.length).toBeGreaterThan(40);
  });

  it('parses srv3 (manual track) and srv1', () => {
    const srv3 = parseTranscript(fixture('youtube-manual.srv3.xml'));
    expect(srv3[1]).toEqual({ start: 18.64, text: "♪ We're no strangers to love ♪" });
    expect(srv3[2].text).toBe('♪ You know the rules and so do I ♪');
    const srv1 = parseTranscript(fixture('youtube-asr.srv1.xml'));
    expect(srv1[1]).toEqual({ start: 18.8, text: "We're no strangers to" });
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('{not json')).toEqual([]);
  });

  it('groups cues into timestamped paragraphs', () => {
    const cues = [
      { start: 0, text: 'Hello there.' },
      { start: 10, text: 'This is a talk' },
      { start: 31, text: 'about reading.' },
      { start: 31.5, text: 'about reading.' }, // rolling duplicate
      { start: 40, text: 'Next part' },
      { start: 75, text: 'goes on.' },
    ];
    expect(groupCues(cues)).toEqual([
      { start: 0, text: 'Hello there. This is a talk about reading.' },
      { start: 40, text: 'Next part goes on.' },
    ]);
    // unpunctuated (old auto captions): ~45 s paragraphs
    const flat = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, text: `words ${i}` }));
    expect(groupCues(flat).map((p) => p.start)).toEqual([0, 60, 120, 180]);
    expect(fmtTimestamp(123.9)).toBe('2:03');
    expect(fmtTimestamp(3723)).toBe('1:02:03');
    expect(
      transcriptHtml(ID, { cues: [{ start: 123.4, text: 'A & B' }], languageCode: 'en', name: 'English', asr: true }),
    ).toBe('<h2>Transcript (auto-generated)</h2><p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=123s">2:03</a> A &amp; B</p>');
  });

  it('renders thumbnail + description + transcript', () => {
    const ref = parseVideoUrl(`https://youtu.be/${ID}`)!;
    const cues = parseTranscript(fixture('youtube-manual.srv3.xml'));
    const r = buildVideo(ref, OEMBED, { description: 'About the video.', publishedAt: null }, { cues, languageCode: 'en', name: 'English', asr: false });
    expect(r.html).toMatch(/^<figure><a href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"><img [^>]+><\/a><figcaption>/);
    expect(r.html).toContain('<p>About the video.</p><h2>Transcript</h2><p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=1s">0:01</a> [♪♪♪]');
    expect(r.html).toContain('<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=');
    expect(r.excerpt).toBe('About the video.');
    expect(r.wordCount).toBeGreaterThan(250);
  });
});

/** Routes: oEmbed, watch page, Innertube player (POST) and timedtext (page URLs need a token → empty). */
function youtubeRoutes(opts: { page?: { status?: number; body?: string }; innertube?: { status?: number; body?: string } } = {}) {
  return mockFetch([
    [/^https:\/\/www\.youtube\.com\/oembed\?/, { body: JSON.stringify(OEMBED), type: 'application/json' }],
    [`https://www.youtube.com/watch?v=${ID}`, opts.page ?? { body: fixture('youtube-watch.html') }],
    ['https://www.youtube.com/youtubei/v1/player', opts.innertube ?? { body: fixture('youtube-innertube-player.json'), type: 'application/json' }],
    [/^https:\/\/www\.youtube\.com\/api\/timedtext\?.*exp=xpe/, { body: '', type: 'text/xml' }],
    // Android-client track URLs answer srv3 whatever fmt is asked for.
    [/^https:\/\/www\.youtube\.com\/api\/timedtext\?/, { body: fixture('youtube-manual.srv3.xml'), type: 'text/xml; charset=UTF-8' }],
  ]);
}

describe('YouTube extraction (mocked network)', () => {
  it('adds the transcript via the Innertube tracks when page tracks need a token', async () => {
    const spy = youtubeRoutes();
    const r = await extractUrl(`https://www.youtube.com/watch?v=${ID}`);
    expect(r.type).toBe('video');
    expect(r.title).toBe(OEMBED.title);
    expect(r.html).toContain('<h2>Transcript</h2>');
    expect(r.html).toContain('We\'re no strangers to love');
    expect(r.publishedAt?.toISOString()).toBe('2009-10-25T06:57:33.000Z');
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('exp=xpe'))).toBe(false);
    const tt = calls.find((u) => u.includes('/api/timedtext'))!;
    expect(new URL(tt).searchParams.get('fmt')).toBe('json3');
    expect(new URL(tt).searchParams.get('lang')).toBe('en');
    expect(new URL(tt).searchParams.get('kind')).toBeNull();
  });

  it('falls back to the description when YouTube asks for a captcha / bot check', async () => {
    youtubeRoutes({
      page: { status: 429, body: 'captcha' },
      innertube: { body: '{"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you’re not a bot"}}' },
    });
    const r = await extractUrl(`https://youtu.be/${ID}`);
    expect(r.title).toBe(OEMBED.title);
    expect(r.html).toContain('▶ Watch on YouTube');
    expect(r.html).not.toContain('Transcript');
  });

  it('uses token-free page tracks directly', async () => {
    const page = fixture('youtube-watch.html').replace(/\\u0026exp=xpe/g, '');
    const spy = youtubeRoutes({ page: { body: page } });
    const r = await extractUrl(`https://www.youtube.com/watch?v=${ID}`);
    expect(r.html).toContain('<h2>Transcript</h2>');
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');
  });

  it('reads a captured watch page instead of fetching it, even without oEmbed', async () => {
    const spy = mockFetch([
      ['https://www.youtube.com/youtubei/v1/player', { body: fixture('youtube-innertube-player.json'), type: 'application/json' }],
      [/^https:\/\/www\.youtube\.com\/api\/timedtext\?/, { body: fixture('youtube-asr.json3.json'), type: 'application/json' }],
    ]);
    const r = await extractHtml(fixture('youtube-watch.html'), `https://www.youtube.com/watch?v=${ID}&t=42s`);
    expect(r.type).toBe('video');
    expect(r.title).toBe(OEMBED.title);
    expect(r.author).toBe('Rick Astley');
    expect(r.imageUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
    expect(r.html).toContain('<h2>Transcript</h2>');
    expect(r.excerpt).toMatch(/^The official video/);
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('fetchTranscript returns null when nothing loads', async () => {
    mockFetch([]);
    expect(await fetchTranscript(ID, [track('en')])).toBeNull();
  });
});
