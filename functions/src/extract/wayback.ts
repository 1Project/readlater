/**
 * Internet Archive (Wayback Machine) fallback for dead, blocked or paywalled pages.
 *
 * Lookup: the availability API (`archive.org/wayback/available`), falling back to the `web/2id_/<url>`
 * redirect (latest capture) when the API itself is rate limited or down. Snapshots are fetched in the
 * `id_` form, which serves the original bytes without the Wayback toolbar or URL rewriting.
 */
import { FetchError, fetchBuffer, fetchJson, type FetchResult } from '../http';
import { escapeHtml } from './html';
import { NOTE_CLASS } from './sanitize';
import type { Extracted } from './types';

export interface Snapshot {
  /** 14-digit capture timestamp (YYYYMMDDhhmmss, UTC). */
  timestamp: string;
  /** The URL as it was archived (scheme/host spelling may differ from the requested one). */
  original: string;
}

const TS_RE = /^\d{14}$/;
const SNAPSHOT_URL_RE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})[a-z_]*\/(.+)$/i;

/** Parse a `web.archive.org/web/<ts>[flags]/<original>` URL. Pure. */
export function parseSnapshotUrl(url: string): Snapshot | null {
  const m = SNAPSHOT_URL_RE.exec(url.trim());
  if (!m) return null;
  // Wayback collapses "//" after the scheme in some redirects (http:/example.com).
  let original = m[2].replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^https?:\/\//i.test(original)) original = `http://${original.replace(/^\/+/, '')}`;
  return { timestamp: m[1], original };
}

/** Original-bytes snapshot URL (no toolbar, no rewritten links). */
export function snapshotUrl(s: Snapshot): string {
  return `https://web.archive.org/web/${s.timestamp}id_/${s.original}`;
}

/** Archived copy of an image (Wayback redirects to the nearest capture of that image). */
export function archivedImageUrl(timestamp: string, src: string): string {
  return /^https?:\/\/web\.archive\.org\//i.test(src) ? src : `https://web.archive.org/web/${timestamp}im_/${src}`;
}

/** "March 5, 2024" from a Wayback timestamp. Pure. */
export function snapshotDate(timestamp: string): string {
  const d = new Date(Date.UTC(+timestamp.slice(0, 4), +timestamp.slice(4, 6) - 1, +timestamp.slice(6, 8)));
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** The note shown at the top of archived content (the sanitizer keeps exactly this class on <p>). */
export function archiveNote(timestamp: string): string {
  return `<p class="${NOTE_CLASS}"><em>Loaded from the Internet Archive snapshot of ${escapeHtml(snapshotDate(timestamp))}.</em></p>`;
}

interface AvailabilityResponse {
  archived_snapshots?: { closest?: { available?: boolean; status?: string; url?: string; timestamp?: string } };
}

/** The availability API answer → snapshot (only successful captures). Pure. */
export function parseAvailability(r: AvailabilityResponse, requested: string): Snapshot | null {
  const c = r.archived_snapshots?.closest;
  if (!c || c.available === false || !c.url) return null;
  if (c.status && !/^2\d\d$/.test(c.status)) return null;
  const s = parseSnapshotUrl(c.url);
  if (s) return s;
  return c.timestamp && TS_RE.test(c.timestamp) ? { timestamp: c.timestamp, original: requested } : null;
}

/** Network errors worth retrying from the archive: HTTP errors, timeouts, DNS/connection failures. */
export function isArchiveWorthyError(e: unknown): boolean {
  if (!(e instanceof FetchError)) return false;
  if (e.status) return e.status >= 400;
  return /^(Timed out|Could not fetch)/.test(e.message);
}

const PAYWALL_MARKUP = [
  /["']?isAccessibleForFree["']?\s*[:=]\s*["']?false\b/i,
  /<meta[^>]+(?:name|property)=["'](?:article:content_tier|content_tier)["'][^>]+content=["'](?:locked|metered|premium)["']/i,
  /\b(?:class|id)=["'][^"']*\b(?:paywall|pay-wall|paywalled|subscriber-only|subscribers-only|subscriber-content|premium-content|premium-article|regwall|reg-wall|registration-wall|meter-wall|metered-content|article-locked|locked-content|content-locked|gated-content|piano-offer|tp-modal|tp-backdrop)\b/i,
];

const SUBSCRIBE_TEXT =
  /\b(?:subscribe|subscription|subscribers? only|already a subscriber|sign in to (?:read|continue)|log in to (?:read|continue)|create (?:a )?free account|register to (?:read|continue)|unlock (?:this|the full) (?:article|story))\b/i;

/** Does a page that yielded little text look paywalled? `text` is the extracted plain text. Pure. */
export function looksPaywalled(html: string, text: string): boolean {
  if (PAYWALL_MARKUP.some((re) => re.test(html))) return true;
  return SUBSCRIBE_TEXT.test(text);
}

/** Bot walls / challenge pages served with a 200. Pure. */
export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 50_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '';
  if (/^\s*(?:just a moment\.*|attention required!?(?: \| cloudflare)?|access denied|are you a robot\??|please verify you are a human|security check|pardon our interruption|robot or human\??)\s*$/i.test(title)) return true;
  return /cf-browser-verification|challenge-platform\/|_Incapsula_Resource|px-captcha|captcha-delivery\.com/i.test(head);
}

/**
 * Latest successful capture of `url` from the availability API: a snapshot, null when nothing is archived,
 * or undefined when the API could not be asked (it is often rate limited).
 */
export async function lookupSnapshot(url: string): Promise<Snapshot | null | undefined> {
  try {
    const r = await fetchJson<AvailabilityResponse>(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeoutMs: 15_000 });
    return parseAvailability(r, url);
  } catch {
    return undefined;
  }
}

/** Fetch the latest snapshot of `url`, or null when there is none or the archive is unreachable. */
export async function fetchSnapshot(url: string): Promise<{ snapshot: Snapshot; res: FetchResult } | null> {
  const snap = await lookupSnapshot(url);
  if (snap === null) return null;
  // Without the lookup, the "2id_" redirect resolves the latest capture by itself.
  const target = snap ? snapshotUrl(snap) : `https://web.archive.org/web/2id_/${url}`;
  let res: FetchResult;
  try {
    res = await fetchBuffer(target, { maxBytes: 50 * 1024 * 1024, timeoutMs: 30_000 });
  } catch {
    return null;
  }
  // Wayback may redirect to a neighbouring capture; the final URL carries the real timestamp.
  const final = parseSnapshotUrl(res.url) ?? snap;
  if (!final) return null;
  return { snapshot: { timestamp: final.timestamp, original: snap?.original ?? final.original }, res };
}

/** Mark archived content: note on top, images served from the archive, canonical URL = the requested one. */
export function markArchived(r: Extracted, snapshot: Snapshot, requestedUrl: string): Extracted {
  const html = r.html.replace(/(<img\b[^>]*?\bsrc=")(https?:\/\/[^"]+)(")/gi, (_m, a: string, src: string, b: string) =>
    a + escapeHtml(archivedImageUrl(snapshot.timestamp, src.replace(/&amp;/g, '&'))) + b,
  );
  return {
    ...r,
    // The note is not part of `text` (search, excerpt, word count stay about the article).
    html: archiveNote(snapshot.timestamp) + html,
    imageUrl: r.imageUrl ? archivedImageUrl(snapshot.timestamp, r.imageUrl) : null,
    canonicalUrl: requestedUrl,
  };
}
