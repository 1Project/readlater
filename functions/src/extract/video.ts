/** YouTube / Vimeo: oEmbed metadata + description from the watch page when available; YouTube transcripts. */
import { fetchJson, fetchText } from '../http';
import { collapseWs, escapeHtml, parseHtml, textToHtml, toDate } from './html';
import { extractMeta } from './meta';
import { sanitizeHtml } from './sanitize';
import { finalize } from './text';
import type { Extracted } from './types';
import { fetchTranscript, parsePlayerResponse, transcriptHtml, type PlayerInfo, type Transcript } from './youtube';

export interface VideoRef {
  provider: 'youtube' | 'vimeo';
  id: string;
  url: string; // canonical watch URL
}

/** Recognise YouTube and Vimeo video URLs. */
export function parseVideoUrl(input: string): VideoRef | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const yt = (id: string | null | undefined): VideoRef | null =>
    id && /^[\w-]{11}$/.test(id) ? { provider: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` } : null;
  if (host === 'youtu.be') return yt(u.pathname.split('/')[1]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return yt(u.searchParams.get('v'));
    const m = /^\/(?:shorts|live|embed|v|e)\/([\w-]{11})/.exec(u.pathname);
    return m ? yt(m[1]) : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d{5,12})(?:\/([0-9a-f]{6,}))?/.exec(u.pathname);
    if (!m) return null;
    return { provider: 'vimeo', id: m[1], url: `https://vimeo.com/${m[1]}${m[2] ? `/${m[2]}` : ''}` };
  }
  return null;
}

export interface OEmbed {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  provider_name?: string;
  description?: string;
  upload_date?: string;
  duration?: number;
}

/** Full description and publish date from a YouTube watch page (embedded player JSON). Pure. */
export function parseYouTubePage(html: string): { description: string | null; publishedAt: Date | null } {
  let description: string | null = null;
  const m = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (m) {
    try {
      description = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      description = null;
    }
  }
  const d = /"(?:publishDate|uploadDate)":"([^"]+)"/.exec(html)?.[1] ?? /itemprop="(?:datePublished|uploadDate)" content="([^"]+)"/.exec(html)?.[1];
  return { description: description?.trim() || null, publishedAt: toDate(d ?? null) };
}

export interface PageInfo {
  description: string | null;
  publishedAt: Date | null;
  /** YouTube player data (title, author, caption tracks) when the watch page had it. */
  player?: PlayerInfo | null;
}

/**
 * Build the video item from oEmbed + optional page data: thumbnail, description, then the transcript
 * (YouTube) as timestamped paragraphs. Pure.
 */
export function buildVideo(ref: VideoRef, o: OEmbed, page: PageInfo, transcript: Transcript | null = null): Extracted {
  const provider = ref.provider === 'youtube' ? 'YouTube' : 'Vimeo';
  const title = collapseWs(o.title) || `${provider} video`;
  const thumb = o.thumbnail_url && /^https?:\/\//.test(o.thumbnail_url) ? o.thumbnail_url : null;
  const desc = page.description ?? o.description ?? null;
  const parts = [
    `<figure>${thumb ? `<a href="${escapeHtml(ref.url)}"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(title)}"></a>` : ''}` +
      `<figcaption><a href="${escapeHtml(ref.url)}">▶ Watch on ${provider}</a>` +
      (o.author_name ? ` · ${o.author_url ? `<a href="${escapeHtml(o.author_url)}">${escapeHtml(o.author_name)}</a>` : escapeHtml(o.author_name)}` : '') +
      `</figcaption></figure>`,
  ];
  if (desc) parts.push(textToHtml(desc));
  if (transcript && ref.provider === 'youtube') parts.push(transcriptHtml(ref.id, transcript));
  return finalize({
    type: 'video',
    html: sanitizeHtml(parts.join('')),
    title,
    author: o.author_name ?? null,
    siteName: provider,
    excerpt: desc,
    imageUrl: thumb,
    publishedAt: page.publishedAt ?? toDate(o.upload_date ?? null),
    canonicalUrl: ref.url,
  });
}

/** oEmbed-like metadata from the YouTube player response (when oEmbed itself is unavailable). Pure. */
export function oembedFromPlayer(ref: VideoRef, p: PlayerInfo | null | undefined): OEmbed | null {
  if (!p?.title) return null;
  return {
    title: p.title,
    author_name: p.author ?? undefined,
    author_url: p.channelUrl ?? undefined,
    thumbnail_url: p.thumbnailUrl ?? `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
    provider_name: 'YouTube',
  };
}

/** Description, date and (YouTube) player data from a watch page's HTML. Pure. */
export function pageInfoFromHtml(ref: VideoRef, html: string, url: string): PageInfo | null {
  if (ref.provider === 'youtube') {
    const player = parsePlayerResponse(html, ref.id);
    if (player) return { description: player.description, publishedAt: player.publishedAt, player };
    // A page for another video (captured after in-app navigation) tells us nothing about this one.
    if (/ytInitialPlayerResponse/.test(html)) return null;
    const yt = parseYouTubePage(html);
    if (yt.description || yt.publishedAt) return yt;
  }
  const dom = parseHtml(html, url);
  try {
    const meta = extractMeta(dom.window.document, url);
    return { description: meta.description, publishedAt: meta.publishedAt };
  } finally {
    dom.window.close();
  }
}

const NO_PAGE: PageInfo = { description: null, publishedAt: null, player: null };

async function pageInfo(ref: VideoRef, pageHtml?: string): Promise<PageInfo> {
  if (pageHtml) {
    const fromCapture = pageInfoFromHtml(ref, pageHtml, ref.url);
    if (fromCapture && (ref.provider !== 'youtube' || fromCapture.player)) return fromCapture;
  }
  try {
    const r = await fetchText(ref.url, { timeoutMs: 15_000 });
    const host = new URL(r.url).hostname;
    if (!/(youtube\.com|vimeo\.com)$/.test(host)) return NO_PAGE; // consent / captcha page
    return pageInfoFromHtml(ref, r.text, r.url) ?? NO_PAGE;
  } catch {
    return NO_PAGE;
  }
}

/**
 * Extract a YouTube/Vimeo video. `pageHtml` is a watch page captured by the browser extension; it is used
 * instead of fetching the page when it belongs to this video.
 */
export async function extractVideo(ref: VideoRef, opts: { pageHtml?: string } = {}): Promise<Extracted> {
  const endpoint =
    ref.provider === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(ref.url)}`;
  const [o, { page, transcript }] = await Promise.all([
    fetchJson<OEmbed>(endpoint).catch(() => null),
    pageInfo(ref, opts.pageHtml).then(async (page) => ({
      page,
      transcript: ref.provider === 'youtube' ? await fetchTranscript(ref.id, page.player?.tracks ?? []).catch(() => null) : null,
    })),
  ]);
  const meta = o ?? oembedFromPlayer(ref, page.player);
  if (!meta) throw new Error('This video is unavailable (private, removed or embedding disabled)');
  return buildVideo(ref, meta, page, transcript);
}
