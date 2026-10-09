/** YouTube / Vimeo: oEmbed metadata + description from the watch page when available. */
import { fetchJson, fetchText } from '../http';
import { collapseWs, escapeHtml, parseHtml, textToHtml, toDate } from './html';
import { extractMeta } from './meta';
import { sanitizeHtml } from './sanitize';
import { finalize } from './text';
import type { Extracted } from './types';

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

interface OEmbed {
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

/** Build the video item from oEmbed + optional page data. Pure. */
export function buildVideo(ref: VideoRef, o: OEmbed, page: { description: string | null; publishedAt: Date | null }): Extracted {
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

async function pageInfo(ref: VideoRef): Promise<{ description: string | null; publishedAt: Date | null }> {
  try {
    const r = await fetchText(ref.url, { timeoutMs: 15_000 });
    const host = new URL(r.url).hostname;
    if (!/(youtube\.com|vimeo\.com)$/.test(host)) return { description: null, publishedAt: null }; // consent / captcha page
    if (ref.provider === 'youtube') {
      const yt = parseYouTubePage(r.text);
      if (yt.description || yt.publishedAt) return yt;
    }
    const dom = parseHtml(r.text, r.url);
    try {
      const meta = extractMeta(dom.window.document, r.url);
      return { description: meta.description, publishedAt: meta.publishedAt };
    } finally {
      dom.window.close();
    }
  } catch {
    return { description: null, publishedAt: null };
  }
}

export async function extractVideo(ref: VideoRef): Promise<Extracted> {
  const endpoint =
    ref.provider === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(ref.url)}`;
  const [o, page] = await Promise.all([
    fetchJson<OEmbed>(endpoint).catch(() => null),
    pageInfo(ref),
  ]);
  if (!o) throw new Error('This video is unavailable (private, removed or embedding disabled)');
  return buildVideo(ref, o, page);
}
