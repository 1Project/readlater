/**
 * Public share links (docs/SPEC-2.md §6): callables `createShare({ itemId, includeHighlights })` →
 * `{ token, url }` and `revokeShare({ token })` → `{ ok: true }`.
 *
 * A share is a read-only snapshot in top-level `shares/{token}`
 *   { owner, title, author, siteName, url, html, highlights: [{ text, note }], createdAt, updatedAt }
 * (public `get`, server writes only), rendered by the web app at `/s/{token}`. The item carries `shareToken`.
 * `owner` = sha256(`${uid}/${itemId}`) ties the snapshot to its item without telling readers the owner's uid
 * (snapshots made before this carry plain `uid` and `itemId`, which are still honoured).
 * Sharing an already shared item refreshes the snapshot and keeps the token (and so the link).
 * `cleanupShare` deletes the snapshot when its item is deleted.
 */
import './options';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { readContent } from './content';
import { publicUrl } from './integrations';
import { enforce, HOUR } from './rateLimit';
import { htmlToPlainText } from './searchIndex';
import { BASE62, randomString, sha256 } from './util';

export const SHARE_TOKEN_LENGTH = 22;
export const SHARE_TOKEN_RE = /^[A-Za-z0-9]{22}$/;
export const generateShareToken = (): string => randomString(SHARE_TOKEN_LENGTH, BASE62);

/** Byte budgets keeping the snapshot under Firestore's 1 MiB document limit. */
export const MAX_SHARE_HTML_BYTES = 900 * 1024;
export const MAX_SHARE_HIGHLIGHT_BYTES = 80 * 1024;
const MAX_META_CHARS = 500;
const TRUNCATED_NOTE = '<p><em>This shared copy is shortened.</em></p>';

export const sharesCol = () => db.collection('shares');

/** Opaque owner id of a share: which user's item it was made from, without exposing either id. */
export const shareOwner = (uid: string, itemId: string): string => sha256(`${uid}/${itemId}`);

/** Whether a stored share snapshot belongs to this user's item. */
export function shareBelongsTo(share: { get: (k: string) => unknown }, uid: string, itemId: string): boolean {
  const owner = share.get('owner');
  if (typeof owner === 'string' && owner) return owner === shareOwner(uid, itemId);
  return share.get('uid') === uid && share.get('itemId') === itemId;
}
export const shareUrl = (token: string, origin = publicUrl()): string => `${origin}/s/${token}`;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Cut HTML to at most `maxBytes` UTF-8 bytes. The cut lands right after a tag (never inside a tag, an
 * entity or a multi-byte character); the browser's parser closes elements left open. Returns the input
 * unchanged when it fits.
 */
export function truncateHtml(html: string, maxBytes = MAX_SHARE_HTML_BYTES): { html: string; truncated: boolean } {
  if (byteLength(html) <= maxBytes) return { html, truncated: false };
  const budget = Math.max(0, maxBytes - byteLength(TRUNCATED_NOTE));
  // Largest character index whose prefix fits the byte budget.
  let lo = 0;
  let hi = Math.min(html.length, budget);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(html.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const head = html.slice(0, lo);
  const lastClose = head.lastIndexOf('>');
  const lastOpen = head.lastIndexOf('<');
  let cut: number;
  if (lastClose >= 0 && lastClose > lastOpen) cut = lastClose + 1; // ends after a complete tag
  else if (lastOpen >= 0) cut = lastOpen; // inside a tag: drop the partial tag
  else cut = 0;
  // Prefer ending after a closing block tag so the last paragraph is complete.
  const block = /<\/(?:p|h[1-6]|li|ul|ol|blockquote|pre|figure|table|section|div)>/gi;
  let lastBlock = -1;
  for (let m = block.exec(head); m && m.index + m[0].length <= cut; m = block.exec(head)) lastBlock = m.index + m[0].length;
  if (lastBlock > cut * 0.9) cut = lastBlock;
  return { html: html.slice(0, cut) + TRUNCATED_NOTE, truncated: true };
}

export interface ShareHighlight {
  text: string;
  note: string;
}

interface HighlightDoc {
  text: string;
  note: string;
  createdAt: number;
}

/** Highlights in reading order (position of their text in the content), within a byte budget. */
export function orderHighlights(list: HighlightDoc[], plainText: string, maxBytes = MAX_SHARE_HIGHLIGHT_BYTES): ShareHighlight[] {
  const positioned = list
    .filter((h) => h.text)
    .map((h) => {
      const at = plainText.indexOf(h.text.replace(/\s+/g, ' ').trim());
      return { ...h, at: at < 0 ? Number.MAX_SAFE_INTEGER : at };
    })
    .sort((a, b) => a.at - b.at || a.createdAt - b.createdAt);
  const out: ShareHighlight[] = [];
  let used = 0;
  for (const h of positioned) {
    const size = byteLength(h.text) + byteLength(h.note) + 16;
    if (used + size > maxBytes) break;
    used += size;
    out.push({ text: h.text, note: h.note });
  }
  return out;
}

const meta = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_META_CHARS) : null);

/** Build the snapshot fields (without uid/itemId/timestamps) for an item. */
export async function buildSnapshot(uid: string, itemId: string, item: Record<string, unknown>, includeHighlights: boolean) {
  const itemRef = db.collection('users').doc(uid).collection('items').doc(itemId);
  const { html } = truncateHtml(await readContent(itemRef));
  let highlights: ShareHighlight[] = [];
  if (includeHighlights) {
    const snap = await db.collection('users').doc(uid).collection('highlights').where('itemId', '==', itemId).get();
    const list = snap.docs.map((d) => ({
      text: String(d.get('text') ?? ''),
      note: String(d.get('note') ?? ''),
      createdAt: (d.get('createdAt') as Timestamp | undefined)?.toMillis?.() ?? 0,
    }));
    highlights = orderHighlights(list, htmlToPlainText(html));
  }
  return {
    title: meta(item.title) ?? 'Untitled',
    author: meta(item.author),
    siteName: meta(item.siteName),
    url: meta(item.url),
    html,
    highlights,
  };
}

export async function createShareForUser(uid: string, itemId: string, includeHighlights: boolean): Promise<{ token: string; url: string }> {
  const itemRef = db.collection('users').doc(uid).collection('items').doc(itemId);
  const snap = await itemRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Document not found');
  const item = snap.data() ?? {};
  if (!item.contentChunks) throw new HttpsError('failed-precondition', 'This document has no content to share yet');
  const snapshot = await buildSnapshot(uid, itemId, item, includeHighlights);

  // Reuse the item's current share (same link) when it is still ours, else mint a new token.
  const existing = typeof item.shareToken === 'string' && SHARE_TOKEN_RE.test(item.shareToken) ? item.shareToken : null;
  if (existing) {
    const reused = await db.runTransaction(async (tx) => {
      const ref = sharesCol().doc(existing);
      const cur = await tx.get(ref);
      if (!cur.exists || !shareBelongsTo(cur, uid, itemId)) return false;
      tx.update(ref, { ...snapshot, owner: shareOwner(uid, itemId), uid: FieldValue.delete(), itemId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (reused) return { token: existing, url: shareUrl(existing) };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateShareToken();
    try {
      const batch = db.batch();
      batch.create(sharesCol().doc(token), {
        owner: shareOwner(uid, itemId),
        ...snapshot,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(itemRef, { shareToken: token });
      await batch.commit();
      return { token, url: shareUrl(token) };
    } catch (e) {
      if ((e as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw e;
    }
  }
  throw new HttpsError('internal', 'Could not create a link, please try again');
}

export async function revokeShareForUser(uid: string, token: string): Promise<void> {
  const ref = sharesCol().doc(token);
  const items = db.collection('users').doc(uid).collection('items');
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) throw new HttpsError('not-found', 'Share link not found');
    const found = await tx.get(items.where('shareToken', '==', token).limit(1));
    const item = found.docs[0] ?? null;
    // Legacy snapshots name their item; current ones are matched through the item that carries the token.
    const legacyId = typeof cur.get('itemId') === 'string' ? String(cur.get('itemId')) : '';
    const itemId = item?.id ?? legacyId;
    if (!itemId || !shareBelongsTo(cur, uid, itemId)) throw new HttpsError('not-found', 'Share link not found');
    const target = item && item.id === itemId ? item : await tx.get(items.doc(itemId));
    tx.delete(ref);
    if (target.exists && target.get('shareToken') === token) tx.update(target.ref, { shareToken: FieldValue.delete() });
  });
}

function requireUid(request: { auth?: { uid: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  return uid;
}

export const createShare = onCall({ region: REGION, memory: '512MiB' }, async (request) => {
  const uid = requireUid(request);
  const data = (request.data ?? {}) as { itemId?: unknown; includeHighlights?: unknown };
  const itemId = typeof data.itemId === 'string' ? data.itemId : '';
  if (!itemId || itemId.length > 128 || itemId.includes('/')) throw new HttpsError('invalid-argument', 'Invalid item id');
  await enforce(`share:${uid}`, 100, HOUR, 'Too many share links created, please try again later');
  return createShareForUser(uid, itemId, data.includeHighlights === true);
});

export const revokeShare = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  const token = (request.data as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) throw new HttpsError('invalid-argument', 'Invalid share token');
  await revokeShareForUser(uid, token);
  return { ok: true as const };
});

/** A deleted item must not stay public. */
export const cleanupShare = onDocumentDeleted('users/{uid}/items/{itemId}', async (event) => {
  const token = event.data?.get('shareToken');
  if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return;
  const ref = sharesCol().doc(token);
  const snap = await ref.get();
  if (snap.exists && shareBelongsTo(snap, event.params.uid, event.params.itemId)) await ref.delete();
});
