/** Server-side "save a URL" used by the `saveUrl` callable and the HTTP `api` endpoint. */
import './options';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { cleanSaveUrl, guessType, normalizeTags, placeholderTitle } from './util';

export interface SaveInput {
  url: string;
  title?: string | null;
  tags?: string[];
  /** undefined = leave as is (existing) / null (new); a string must be an existing category id. */
  categoryId?: string | null;
}

export interface SaveResult {
  id: string;
  title: string;
  existing: boolean;
}

/** Same field set & defaults as web/src/lib/data.ts newItemData(). */
export function newItemData(x: Record<string, unknown>): Record<string, unknown> {
  return {
    url: null,
    type: 'article',
    location: 'library',
    status: 'unread',
    favorite: false,
    title: '',
    titleLocked: false,
    author: null,
    siteName: null,
    excerpt: null,
    imageUrl: null,
    publishedAt: null,
    wordCount: null,
    readingMinutes: null,
    categoryId: null,
    tags: [],
    note: '',
    progress: 0,
    fetchStatus: 'pending',
    fetchError: null,
    contentChunks: 0,
    file: null,
    feedId: null,
    paper: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastOpenedAt: null,
    archivedAt: null,
    ...x,
  };
}

const userDoc = (uid: string) => db.collection('users').doc(uid);

/** Keep a category id only if it exists for this user. */
async function validCategoryId(uid: string, id: string | null | undefined): Promise<string | null | undefined> {
  if (id === undefined || id === null) return id;
  if (typeof id !== 'string' || !id || id.length > 128 || id.includes('/')) return null;
  const snap = await userDoc(uid).collection('categories').doc(id).get();
  return snap.exists ? id : null;
}

/** Find a category by name (case-insensitive) or create it. Returns its id, or null for an empty name. */
export async function categoryIdByName(uid: string, rawName: unknown): Promise<string | null> {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (!name) return null;
  const col = userDoc(uid).collection('categories');
  const all = await col.get();
  const hit = all.docs.find((d) => String(d.get('name') ?? '').trim().toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const ref = await col.add({ name, order: Date.now(), createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}

/**
 * Save a URL for a user. If the URL is already saved (library or feed), the existing item is moved to the
 * library and marked unread (tags merged, category replaced when given) — same as the web client's addUrl().
 */
export async function saveForUser(uid: string, input: SaveInput): Promise<SaveResult> {
  const url = cleanSaveUrl(input.url);
  if (!url) throw new HttpsError('invalid-argument', 'A valid http(s) URL is required');
  const tags = normalizeTags(input.tags ?? []);
  const categoryId = await validCategoryId(uid, input.categoryId);
  const items = userDoc(uid).collection('items');
  const dup = await items.where('url', '==', url).limit(1).get();
  if (!dup.empty) {
    const d = dup.docs[0];
    const patch: Record<string, unknown> = { location: 'library', status: 'unread', archivedAt: null, updatedAt: FieldValue.serverTimestamp() };
    if (tags.length) patch.tags = normalizeTags([...((d.get('tags') as string[] | undefined) ?? []), ...tags]);
    if (categoryId !== undefined) patch.categoryId = categoryId;
    await d.ref.update(patch);
    return { id: d.id, title: String(d.get('title') ?? '') || placeholderTitle(url), existing: true };
  }
  const ref = items.doc();
  const title = (typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '') || placeholderTitle(url);
  await ref.set(
    newItemData({
      url,
      type: guessType(url),
      title,
      titleLocked: false,
      tags,
      categoryId: categoryId ?? null,
      location: 'library',
      fetchStatus: 'pending',
    }),
  );
  return { id: ref.id, title, existing: false };
}

export const saveUrl = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const data = (request.data ?? {}) as { url?: unknown; tags?: unknown; categoryId?: unknown; title?: unknown };
  const res = await saveForUser(uid, {
    url: typeof data.url === 'string' ? data.url : '',
    title: typeof data.title === 'string' ? data.title : null,
    tags: normalizeTags(data.tags),
    categoryId: typeof data.categoryId === 'string' ? data.categoryId : data.categoryId === null ? null : undefined,
  });
  return { id: res.id };
});
