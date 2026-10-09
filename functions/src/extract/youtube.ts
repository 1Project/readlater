/**
 * YouTube watch-page data and transcripts.
 *
 * Caption tracks come from the page's `ytInitialPlayerResponse` and, because those URLs increasingly need a
 * browser proof-of-origin token (`exp=xpe`, answered with an empty body), from the Innertube player API as
 * the Android client, whose track URLs work without one. Transcripts are parsed from json3, srv3 or srv1.
 */
import { fetchText } from '../http';
import { escapeHtml, toDate } from './html';
import { decodeEntities } from './text';

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  /** Automatic speech recognition (auto-generated) track. */
  asr: boolean;
}

export interface PlayerInfo {
  videoId: string | null;
  title: string | null;
  author: string | null;
  channelUrl: string | null;
  description: string | null;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  lengthSeconds: number | null;
  /** OK, LOGIN_REQUIRED (bot check / age gate), ERROR, UNPLAYABLE, … */
  playability: string | null;
  tracks: CaptionTrack[];
}

export interface Cue {
  /** Start in seconds. */
  start: number;
  text: string;
}

export interface Transcript {
  cues: Cue[];
  languageCode: string;
  name: string;
  asr: boolean;
}

type Json = Record<string, unknown>;

/** Untrusted JSON access: the object at `path` (or {}), an array (or []), a non-empty string (or null). */
function obj(v: unknown, ...path: string[]): Json {
  let cur = v;
  for (const k of path) cur = cur && typeof cur === 'object' ? (cur as Json)[k] : undefined;
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Json) : {};
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The JSON object literal assigned to `name` in inline script (string-aware brace matching). Pure. */
export function extractJsonAssignment(html: string, name: string): Json | null {
  const re = new RegExp(`(?:var\\s+|window\\[["']|window\\.)?${name}(?:["']\\])?\\s*=\\s*\\{`, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Json;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/** Innertube text: a string, `{ simpleText }` or `{ runs: [{ text }] }`. */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = obj(v);
  return str(o.simpleText) ?? arr(o.runs).map((r) => str(obj(r).text) ?? '').join('');
}

/** Caption tracks from a player response (`captions.playerCaptionsTracklistRenderer.captionTracks`). Pure. */
export function captionTracks(player: unknown): CaptionTrack[] {
  const out: CaptionTrack[] = [];
  for (const item of arr(obj(player, 'captions', 'playerCaptionsTracklistRenderer').captionTracks)) {
    const t = obj(item);
    const baseUrl = str(t.baseUrl);
    if (!baseUrl || !/^https:\/\/(?:www\.)?youtube\.com\/api\/timedtext\?/.test(baseUrl)) continue;
    const languageCode = str(t.languageCode) ?? '';
    out.push({ baseUrl, languageCode, name: text(t.name) || languageCode, asr: t.kind === 'asr' });
  }
  return out;
}

/** Player data from a watch page; null when the page has no player response for `videoId`. Pure. */
export function parsePlayerResponse(html: string, videoId?: string): PlayerInfo | null {
  const p = extractJsonAssignment(html, 'ytInitialPlayerResponse');
  if (!p) return null;
  const vd = obj(p, 'videoDetails');
  const mf = obj(p, 'microformat', 'playerMicroformatRenderer');
  const id = str(vd.videoId);
  // After in-app navigation a captured page still carries the first video's player response.
  if (videoId && id && id !== videoId) return null;
  const thumbs = [...arr(obj(vd, 'thumbnail').thumbnails), ...arr(obj(mf, 'thumbnail').thumbnails)]
    .map((t) => ({ url: str(obj(t).url), width: Number(obj(t).width) || 0 }))
    .filter((t): t is { url: string; width: number } => !!t.url && /^https:\/\/i\d?\.ytimg\.com\/vi\//.test(t.url)) // not vi_webp
    .sort((a, b) => b.width - a.width);
  const desc = str(vd.shortDescription) ?? text(mf.description);
  const len = Number(vd.lengthSeconds ?? mf.lengthSeconds);
  const channelId = str(vd.channelId);
  return {
    videoId: id,
    title: str(vd.title) ?? (text(mf.title) || null),
    author: str(vd.author) ?? str(mf.ownerChannelName),
    channelUrl: str(mf.ownerProfileUrl)?.replace(/^http:/, 'https:') ?? (channelId ? `https://www.youtube.com/channel/${channelId}` : null),
    description: desc.trim() || null,
    publishedAt: toDate(mf.publishDate ?? mf.uploadDate ?? null),
    thumbnailUrl: thumbs.length ? thumbs[0].url.split('?')[0] : id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
    lengthSeconds: Number.isFinite(len) && len > 0 ? len : null,
    playability: str(obj(p, 'playabilityStatus').status),
    tracks: captionTracks(p),
  };
}

const base = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];

/**
 * Best track: the spoken language (the ASR track's language) or `preferLang`, then English; within a
 * language manual captions beat auto-generated ones. Pure.
 */
export function pickCaptionTrack(tracks: CaptionTrack[], preferLang?: string | null): CaptionTrack | null {
  if (!tracks.length) return null;
  const spoken = tracks.find((t) => t.asr)?.languageCode ?? preferLang ?? null;
  const langs = [spoken, preferLang, 'en'].filter((l): l is string => !!l);
  for (const lang of langs) {
    const exact = tracks.find((t) => !t.asr && t.languageCode.toLowerCase() === lang.toLowerCase());
    if (exact) return exact;
    const sameBase = tracks.find((t) => !t.asr && base(t.languageCode) === base(lang));
    if (sameBase) return sameBase;
    const auto = tracks.find((t) => t.asr && base(t.languageCode) === base(lang));
    if (auto) return auto;
  }
  return tracks.find((t) => !t.asr) ?? tracks[0];
}

function cleanCue(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}

/** Cues from a timedtext body in json3, srv3 (`<p t= d=>` with optional `<s>` words) or srv1 (`<text start=>`). Pure. */
export function parseTranscript(body: string): Cue[] {
  const s = body.trim();
  if (!s) return [];
  const out: Cue[] = [];
  if (s.startsWith('{')) {
    let j: unknown;
    try {
      j = JSON.parse(s);
    } catch {
      return [];
    }
    for (const item of arr(obj(j).events)) {
      const ev = obj(item);
      const t = cleanCue(arr(ev.segs).map((x) => str(obj(x).utf8) ?? '').join(''));
      if (t) out.push({ start: (Number(ev.tStartMs) || 0) / 1000, text: t });
    }
    return out;
  }
  const strip = (inner: string) => cleanCue(decodeEntities(decodeEntities(inner.replace(/<[^>]*>/g, ''))));
  const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (let m = srv3.exec(s); m; m = srv3.exec(s)) {
    const t = /\bt="(\d+)"/.exec(m[1]);
    const txt = strip(m[2]);
    if (t && txt) out.push({ start: Number(t[1]) / 1000, text: txt });
  }
  if (out.length) return out;
  const srv1 = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (let m = srv1.exec(s); m; m = srv1.exec(s)) {
    const t = /\bstart="([\d.]+)"/.exec(m[1]);
    // srv1 double-escapes entities (&amp;#39;).
    const txt = strip(m[2]);
    if (t && txt) out.push({ start: Number(t[1]), text: txt });
  }
  return out;
}

export interface Paragraph {
  start: number;
  text: string;
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;

/**
 * Group cues into paragraphs: close at a sentence end once a paragraph spans ≥ 30 s; transcripts without
 * punctuation (older auto captions) close every ~45 s; never longer than 90 s. Repeated cues are dropped. Pure.
 */
export function groupCues(cues: Cue[]): Paragraph[] {
  const ends = cues.filter((c) => SENTENCE_END.test(c.text)).length;
  const punctuated = cues.length > 0 && ends / cues.length >= 0.1;
  const out: Paragraph[] = [];
  let cur: { start: number; parts: string[] } | null = null;
  let prev = '';
  for (const c of cues) {
    if (c.text === prev) continue;
    prev = c.text;
    if (!cur) cur = { start: c.start, parts: [] };
    cur.parts.push(c.text);
    const span = c.start - cur.start;
    const close = (punctuated && SENTENCE_END.test(c.text) && span >= 30) || (!punctuated && span >= 45) || span >= 90;
    if (close) {
      out.push({ start: cur.start, text: cur.parts.join(' ') });
      cur = null;
    }
  }
  if (cur) out.push({ start: cur.start, text: cur.parts.join(' ') });
  return out;
}

/** 123 → "2:03", 3723 → "1:02:03". */
export function fmtTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Transcript section: heading + one paragraph per group, each starting with a timestamp link. Pure. */
export function transcriptHtml(videoId: string, t: Transcript): string {
  const paras = groupCues(t.cues);
  if (!paras.length) return '';
  const heading = `<h2>Transcript${t.asr ? ' (auto-generated)' : ''}</h2>`;
  const body = paras
    .map((p) => {
      const s = Math.floor(p.start);
      const href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${s}s`;
      return `<p><a href="${escapeHtml(href)}">${fmtTimestamp(s)}</a> ${escapeHtml(p.text)}</p>`;
    })
    .join('');
  return heading + body;
}

function withFormat(url: string, fmt: string): string {
  const u = new URL(url);
  u.searchParams.set('fmt', fmt);
  return u.href;
}

/** Download and parse one track (json3 first; the format-less URL as fallback). */
async function loadTrack(track: CaptionTrack): Promise<Transcript | null> {
  for (const url of [withFormat(track.baseUrl, 'json3'), track.baseUrl]) {
    try {
      const r = await fetchText(url, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, accept: '*/*' });
      const cues = parseTranscript(r.text);
      if (cues.length) return { cues, languageCode: track.languageCode, name: track.name, asr: track.asr };
    } catch {
      // try the next form
    }
  }
  return null;
}

const INNERTUBE_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' };

/** Caption tracks via the Innertube player API (Android client); [] when blocked (bot check) or unavailable. */
export async function innertubeTracks(videoId: string): Promise<CaptionTrack[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': `com.google.android.youtube/${INNERTUBE_CLIENT.clientVersion} (Linux; U; Android 14) gzip`,
        'accept-language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, videoId }),
    });
    if (!res.ok) return [];
    const j: unknown = await res.json();
    const id = str(obj(j, 'videoDetails').videoId);
    if (id && id !== videoId) return [];
    return captionTracks(j);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Page tracks whose URLs need a browser proof-of-origin token (they answer with an empty body). */
const needsPoToken = (t: CaptionTrack) => /[?&]exp=xpe(?:&|$)/.test(t.baseUrl);

/**
 * Fetch the best transcript for a video: page tracks that work without a token, then Innertube (Android)
 * tracks, then the remaining page tracks. Null when none can be loaded (no captions, captcha, bot check).
 */
export async function fetchTranscript(videoId: string, pageTracks: CaptionTrack[] = []): Promise<Transcript | null> {
  const page = pickCaptionTrack(pageTracks);
  if (page && !needsPoToken(page)) {
    const t = await loadTrack(page);
    if (t) return t;
  }
  const it = pickCaptionTrack(await innertubeTracks(videoId), page?.languageCode);
  if (it) {
    const t = await loadTrack(it);
    if (t) return t;
  }
  if (page && needsPoToken(page)) return loadTrack(page);
  return null;
}
