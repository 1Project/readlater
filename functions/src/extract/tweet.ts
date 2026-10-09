/** X/Twitter posts via the FxTwitter API, with the official oEmbed endpoint as fallback. */
import { FetchError, fetchJson } from '../http';
import { collapseWs, escapeHtml, linkify, newlinesToParagraphs, parseHtml, toDate } from './html';
import { sanitizeHtml } from './sanitize';
import { finalize, htmlToText, truncate } from './text';
import type { Extracted } from './types';

const HOST_RE =
  /^(?:(?:www|mobile|m)\.)?(?:twitter\.com|x\.com)$|^(?:[a-z]+\.)?(?:fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com|twittpr\.com)$|^(?:www\.)?(?:nitter\.net|xcancel\.com)$/i;

/** Status id from any X/Twitter (or mirror) status URL, else null. */
export function parseTweetUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!HOST_RE.test(u.hostname)) return null;
  const m = /^\/(?:i\/web|i|[A-Za-z0-9_]{1,30})\/status(?:es)?\/(\d{1,25})(?:[/?#]|$)/.exec(u.pathname + (u.pathname.endsWith('/') ? '' : '/'));
  return m ? m[1] : null;
}

// --- FxTwitter API shapes (only the fields we use) ---

interface FxFacet {
  type: string;
  indices: [number, number];
  original?: string;
  replacement?: string;
  display?: string;
}
interface FxPhoto {
  type: string;
  url: string;
  width?: number;
  height?: number;
  altText?: string;
}
interface FxVideo {
  type: string;
  url: string;
  thumbnail_url?: string | null;
  duration?: number;
}
interface FxArticleBlock {
  key?: string;
  type: string;
  text: string;
  data?: Record<string, unknown>;
  entityRanges?: { key: number; length: number; offset: number }[];
  inlineStyleRanges?: { length: number; offset: number; style: string }[];
}
interface FxArticleMedia {
  media_id?: string;
  id?: string;
  media_info?: {
    original_img_url?: string;
    media_url_https?: string;
    video_info?: unknown;
  };
}
interface FxArticle {
  title?: string;
  preview_text?: string;
  cover_media?: FxArticleMedia;
  content?: {
    blocks?: FxArticleBlock[];
    entityMap?: { key: string; value: { type: string; data: Record<string, unknown> } }[] | Record<string, { type: string; data: Record<string, unknown> }>;
  };
  media_entities?: FxArticleMedia[];
}
export interface FxTweet {
  id: string;
  url: string;
  text: string;
  raw_text?: { text: string; display_text_range?: [number, number]; facets?: FxFacet[] };
  author: { name: string; screen_name: string; avatar_url?: string | null; url?: string };
  created_at?: string;
  created_timestamp?: number;
  replying_to?: string | { screen_name?: string } | null;
  media?: { photos?: FxPhoto[]; videos?: FxVideo[]; all?: (FxPhoto | FxVideo)[]; external?: { url: string; thumbnail_url?: string } };
  quote?: FxTweet | { type: 'tombstone'; message?: string };
  poll?: { choices: { label: string; count: number; percentage: number }[]; total_votes: number; ends_at?: string; time_left_en?: string };
  article?: FxArticle;
  community_note?: { text: string } | null;
  lang?: string | null;
}

const nf = new Intl.NumberFormat('en-US');

function fmtDate(d: Date | null): string {
  return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}

function fmtDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function profileUrl(handle: string): string {
  return `https://x.com/${encodeURIComponent(handle)}`;
}

/** Tweet text → inline HTML with links (from facets when available). Newlines preserved. */
export function tweetTextHtml(t: Pick<FxTweet, 'text' | 'raw_text'>): string {
  const raw = t.raw_text;
  if (!raw?.text || !raw.facets) return linkify(t.text ?? '');
  const text = raw.text;
  const [start, end] = raw.display_text_range ?? [0, text.length];
  const facets = [...raw.facets].filter((f) => f.indices[0] >= start && f.indices[0] < end).sort((a, b) => a.indices[0] - b.indices[0]);
  let out = '';
  let pos = start;
  for (const f of facets) {
    const [s, e] = f.indices;
    if (s < pos) continue;
    out += escapeHtml(text.slice(pos, s));
    const seg = text.slice(s, Math.min(e, end));
    switch (f.type) {
      case 'url': {
        const href = f.replacement || f.original || seg;
        const label = f.display || href.replace(/^https?:\/\/(www\.)?/, '');
        out += /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(seg);
        break;
      }
      case 'mention': {
        const handle = (f.replacement ?? f.original ?? seg).replace(/^@/, '');
        out += `<a href="${escapeHtml(profileUrl(handle))}">${escapeHtml(seg)}</a>`;
        break;
      }
      case 'hashtag': {
        const tag = seg.replace(/^[#＃]/, '');
        out += `<a href="https://x.com/hashtag/${encodeURIComponent(tag)}">${escapeHtml(seg)}</a>`;
        break;
      }
      case 'media':
        break;
      case 'bold':
        out += `<strong>${escapeHtml(seg)}</strong>`;
        break;
      case 'italic':
        out += `<em>${escapeHtml(seg)}</em>`;
        break;
      default:
        out += escapeHtml(seg);
    }
    pos = Math.min(e, end);
  }
  out += escapeHtml(text.slice(pos, end));
  return out.trim();
}

function plainText(t: Pick<FxTweet, 'text' | 'raw_text'>): string {
  return htmlToText(newlinesToParagraphs(tweetTextHtml(t)));
}

function mediaHtml(t: FxTweet, tweetUrl: string): string {
  const parts: string[] = [];
  const all = t.media?.all ?? [...(t.media?.photos ?? []), ...(t.media?.videos ?? [])];
  for (const m of all) {
    if (m.type === 'photo') {
      const p = m as FxPhoto;
      parts.push(`<figure><img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.altText ?? '')}"></figure>`);
    } else if (m.type === 'video' || m.type === 'gif') {
      const v = m as FxVideo;
      const label = m.type === 'gif' ? 'GIF' : `Video${v.duration ? ` (${fmtDuration(v.duration)})` : ''}`;
      const thumb = v.thumbnail_url ? `<a href="${escapeHtml(tweetUrl)}"><img src="${escapeHtml(v.thumbnail_url)}" alt="${escapeHtml(label)}"></a>` : '';
      parts.push(`<figure>${thumb}<figcaption><a href="${escapeHtml(tweetUrl)}">▶ ${escapeHtml(label)} — watch on X</a></figcaption></figure>`);
    }
  }
  if (t.media?.external?.url) {
    const ex = t.media.external;
    const thumb = ex.thumbnail_url ? `<img src="${escapeHtml(ex.thumbnail_url)}" alt="Video">` : '';
    parts.push(`<figure><a href="${escapeHtml(ex.url)}">${thumb || escapeHtml(ex.url)}</a></figure>`);
  }
  return parts.join('');
}

function pollHtml(poll: NonNullable<FxTweet['poll']>): string {
  const items = poll.choices
    .map((c) => `<li>${escapeHtml(c.label)} — ${Math.round(c.percentage * 10) / 10}% (${nf.format(c.count)})</li>`)
    .join('');
  const status = poll.time_left_en ? escapeHtml(poll.time_left_en) : 'Final results';
  return `<ul>${items}</ul><p><small>${nf.format(poll.total_votes)} votes · ${status}</small></p>`;
}

function authorLine(t: FxTweet, tweetUrl: string, date: Date | null): string {
  const a = t.author;
  return (
    `<p><strong>${escapeHtml(a.name || a.screen_name)}</strong> ` +
    `<a href="${escapeHtml(profileUrl(a.screen_name))}">@${escapeHtml(a.screen_name)}</a>` +
    (date ? ` · <a href="${escapeHtml(tweetUrl)}">${escapeHtml(fmtDate(date))}</a>` : '') +
    `</p>`
  );
}

// --- X long-form articles (Draft.js content state) ---

type EntityValue = { type: string; data: Record<string, unknown> };

function entityLookup(content: NonNullable<FxArticle['content']>): (key: number) => EntityValue | undefined {
  const em = content.entityMap;
  if (!em) return () => undefined;
  if (Array.isArray(em)) {
    const m = new Map(em.map((e) => [String(e.key), e.value]));
    return (k) => m.get(String(k));
  }
  return (k) => em[String(k)];
}

function articleMediaUrl(a: FxArticle, mediaId: string): string | null {
  const m = (a.media_entities ?? []).find((x) => x.media_id === mediaId || x.id === mediaId);
  return m?.media_info?.original_img_url ?? m?.media_info?.media_url_https ?? null;
}

/** Inline text of a block with bold/italic/code styles and link entities applied. */
function blockInline(b: FxArticleBlock, entity: (k: number) => EntityValue | undefined): string {
  const text = b.text ?? '';
  if (!text) return '';
  const n = text.length;
  const bounds = new Set<number>([0, n]);
  for (const r of b.inlineStyleRanges ?? []) bounds.add(r.offset).add(Math.min(n, r.offset + r.length));
  for (const r of b.entityRanges ?? []) bounds.add(r.offset).add(Math.min(n, r.offset + r.length));
  const pts = [...bounds].filter((x) => x >= 0 && x <= n).sort((a, b2) => a - b2);
  let out = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    let seg = escapeHtml(text.slice(s, e)).replace(/\n/g, '<br>');
    const styles = new Set((b.inlineStyleRanges ?? []).filter((r) => r.offset <= s && r.offset + r.length >= e).map((r) => r.style.toLowerCase()));
    if (styles.has('code')) seg = `<code>${seg}</code>`;
    if (styles.has('bold')) seg = `<strong>${seg}</strong>`;
    if (styles.has('italic')) seg = `<em>${seg}</em>`;
    if (styles.has('strikethrough')) seg = `<s>${seg}</s>`;
    const link = (b.entityRanges ?? []).find((r) => r.offset <= s && r.offset + r.length >= e);
    const ent = link ? entity(link.key) : undefined;
    const href = ent && ent.type.toUpperCase() === 'LINK' ? String(ent.data.url ?? ent.data.href ?? '') : '';
    if (href && /^https?:\/\//i.test(href)) seg = `<a href="${escapeHtml(href)}">${seg}</a>`;
    out += seg;
  }
  return out;
}

/** Render an X article's Draft.js blocks to HTML. Pure. */
export function articleToHtml(a: FxArticle): string {
  const content = a.content ?? {};
  const blocks = content.blocks ?? [];
  const entity = entityLookup(content);
  const parts: string[] = [];
  const cover = a.cover_media?.media_info?.original_img_url;
  if (cover) parts.push(`<figure><img src="${escapeHtml(cover)}" alt=""></figure>`);
  if (a.title) parts.push(`<h2>${escapeHtml(a.title)}</h2>`);
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushList = () => {
    if (list) parts.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const b of blocks) {
    const type = (b.type ?? 'unstyled').toLowerCase();
    if (type === 'unordered-list-item' || type === 'ordered-list-item') {
      const tag = type === 'ordered-list-item' ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(blockInline(b, entity));
      continue;
    }
    flushList();
    const inline = blockInline(b, entity);
    switch (type) {
      case 'header-one':
        if (inline) parts.push(`<h2>${inline}</h2>`);
        break;
      case 'header-two':
        if (inline) parts.push(`<h3>${inline}</h3>`);
        break;
      case 'header-three':
      case 'header-four':
      case 'header-five':
      case 'header-six':
        if (inline) parts.push(`<h4>${inline}</h4>`);
        break;
      case 'blockquote':
        if (inline) parts.push(`<blockquote><p>${inline}</p></blockquote>`);
        break;
      case 'code-block':
        parts.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`);
        break;
      case 'atomic': {
        for (const r of b.entityRanges ?? []) {
          const ent = entity(r.key);
          if (!ent) continue;
          const t = ent.type.toUpperCase();
          if (t === 'MEDIA') {
            const items = (ent.data.mediaItems as { mediaId?: string }[] | undefined) ?? [];
            for (const it of items) {
              const url = it.mediaId ? articleMediaUrl(a, it.mediaId) : null;
              if (url) parts.push(`<figure><img src="${escapeHtml(url)}" alt=""></figure>`);
            }
          } else if (t === 'TWEET') {
            const id = String(ent.data.tweetId ?? '');
            if (/^\d+$/.test(id)) parts.push(`<p><a href="https://x.com/i/status/${id}">Embedded post</a></p>`);
          } else if (t === 'MARKDOWN') {
            const md = String(ent.data.markdown ?? '').replace(/^```[\w-]*\n?|\n?```$/g, '');
            if (md.trim()) parts.push(`<pre><code>${escapeHtml(md)}</code></pre>`);
          } else if (t === 'DIVIDER') {
            parts.push('<hr>');
          } else if (t === 'LINK' && typeof ent.data.url === 'string') {
            parts.push(`<p><a href="${escapeHtml(ent.data.url)}">${escapeHtml(ent.data.url)}</a></p>`);
          }
        }
        break;
      }
      default:
        if (inline) parts.push(`<p>${inline}</p>`);
    }
  }
  flushList();
  return parts.join('');
}

function isTweet(q: FxTweet['quote']): q is FxTweet {
  return !!q && (q as FxTweet).author !== undefined && (q as { type?: string }).type !== 'tombstone';
}

function replyingTo(t: FxTweet): string | null {
  const r = t.replying_to;
  if (!r) return null;
  return typeof r === 'string' ? r : r.screen_name ?? null;
}

function tweetBodyHtml(t: FxTweet, depth: number): string {
  const tweetUrl = `https://x.com/${t.author.screen_name}/status/${t.id}`;
  const date = toDate(t.created_timestamp ? t.created_timestamp * 1000 : t.created_at ?? null);
  const parts: string[] = [authorLine(t, tweetUrl, date)];
  const reply = replyingTo(t);
  if (reply) parts.push(`<p><small>Replying to <a href="${escapeHtml(profileUrl(reply))}">@${escapeHtml(reply)}</a></small></p>`);
  const textHtml = newlinesToParagraphs(tweetTextHtml(t));
  if (t.article) {
    // The post text of an article is just its link; show the article itself.
    if (htmlToText(textHtml.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '')).trim()) parts.push(textHtml);
    parts.push(articleToHtml(t.article));
  } else {
    parts.push(textHtml);
  }
  parts.push(mediaHtml(t, tweetUrl));
  if (t.poll?.choices?.length) parts.push(pollHtml(t.poll));
  if (t.quote) {
    if (isTweet(t.quote) && depth < 2) parts.push(`<blockquote>${tweetBodyHtml(t.quote, depth + 1)}</blockquote>`);
    else if (!isTweet(t.quote)) parts.push(`<blockquote><p>${escapeHtml(t.quote.message ?? 'Quoted post unavailable')}</p></blockquote>`);
  }
  if (t.community_note?.text && depth === 0) {
    parts.push(`<aside><p><strong>Community note</strong></p>${newlinesToParagraphs(linkify(t.community_note.text))}</aside>`);
  }
  return parts.join('');
}

/** FxTwitter JSON → Extracted. Pure. */
export function buildTweet(t: FxTweet): Extracted {
  const handle = t.author.screen_name;
  const html = sanitizeHtml(tweetBodyHtml(t, 0));
  const textOnly = plainText(t).replace(/\s+/g, ' ').trim();
  const firstLine = t.article?.title ? collapseWs(t.article.title) : textOnly;
  const kind = t.media?.videos?.length ? 'Video' : t.media?.photos?.length ? 'Photo' : 'Post';
  const firstPhoto = (t.media?.photos ?? [])[0]?.url ?? null;
  const firstVideo = (t.media?.videos ?? []).find((v) => v.thumbnail_url)?.thumbnail_url ?? null;
  const quotePhoto = isTweet(t.quote) ? (t.quote.media?.photos ?? [])[0]?.url ?? null : null;
  return finalize({
    type: 'tweet',
    html,
    title: `@${handle}: ${firstLine ? truncate(firstLine, 80) : kind}`,
    author: `${collapseWs(t.author.name) || handle} (@${handle})`,
    siteName: 'X',
    description: t.article?.preview_text ?? null,
    imageUrl: t.article?.cover_media?.media_info?.original_img_url ?? firstPhoto ?? firstVideo ?? quotePhoto ?? t.author.avatar_url ?? null,
    publishedAt: t.created_timestamp ? t.created_timestamp * 1000 : t.created_at ?? null,
    canonicalUrl: `https://x.com/${handle}/status/${t.id}`,
  });
}

interface OEmbed {
  url?: string;
  author_name?: string;
  author_url?: string;
  html?: string;
}

/** Official oEmbed response → Extracted (text only, no media). Pure. */
export function buildTweetFromOembed(o: OEmbed, id: string): Extracted {
  const handle = (o.author_url ?? '').split('/').filter(Boolean).pop() ?? 'unknown';
  const dom = parseHtml(`<body>${o.html ?? ''}</body>`, 'https://x.com/');
  try {
    const doc = dom.window.document;
    const bq = doc.querySelector('blockquote');
    const p = bq?.querySelector('p');
    // Drop pic.twitter.com links (media we can't show here).
    p?.querySelectorAll('a').forEach((a) => {
      if (/^pic\.(twitter|x)\.com\//i.test(collapseWs(a.textContent))) a.remove();
    });
    const links = bq ? Array.from(bq.querySelectorAll(':scope > a')) : [];
    const dateText = links.length ? collapseWs(links[links.length - 1].textContent) : '';
    const date = toDate(dateText);
    const tweetUrl = o.url ?? `https://x.com/${handle}/status/${id}`;
    const body = sanitizeHtml(p?.innerHTML ?? '', 'https://x.com/');
    const author = { name: o.author_name ?? handle, screen_name: handle };
    const html = sanitizeHtml(authorLine({ author } as FxTweet, tweetUrl, date) + (body ? `<p>${body}</p>` : ''));
    const text = htmlToText(body).replace(/\s+/g, ' ').trim();
    return finalize({
      type: 'tweet',
      html,
      title: `@${handle}: ${text ? truncate(text, 80) : 'Post'}`,
      author: `${author.name} (@${handle})`,
      siteName: 'X',
      publishedAt: date,
      canonicalUrl: `https://x.com/${handle}/status/${id}`,
    });
  } finally {
    dom.window.close();
  }
}

export async function extractTweet(id: string): Promise<Extracted> {
  let fxError: unknown = null;
  try {
    const r = await fetchJson<{ code: number; message?: string; tweet?: FxTweet }>(`https://api.fxtwitter.com/status/${id}`, {
      headers: { 'user-agent': 'Readlater/1.0 (read-it-later; +https://github.com/FxEmbed/FxEmbed)' },
    });
    if (r.code === 200 && r.tweet) return buildTweet(r.tweet);
    fxError = new FetchError(r.message ?? 'not found', r.code);
  } catch (e) {
    fxError = e;
  }
  try {
    const o = await fetchJson<OEmbed>(
      `https://publish.x.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}&omit_script=1&dnt=true`,
    );
    if (o.html) return buildTweetFromOembed(o, id);
  } catch {
    // fall through to the error below
  }
  const status = fxError instanceof FetchError ? fxError.status : undefined;
  if (status === 404) throw new Error('This post was not found (it may have been deleted)');
  if (status === 401 || status === 403) throw new Error('This post is from a protected or suspended account');
  throw new Error('Could not load this post from X');
}
