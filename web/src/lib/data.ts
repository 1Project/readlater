/**
 * Data access layer. All Firestore / Storage / Functions access from the UI goes
 * through this module so pages stay simple. See docs/SPEC.md for the model.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromCache,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { getServices } from './firebase';
import type { ApiKeyInfo, Category, Feed, Highlight, Item, ItemPatch, ItemType } from './types';

// ---------------------------------------------------------------------------
// Auth

let currentUser: User | null | undefined = undefined; // undefined = not yet known
const authListeners = new Set<() => void>();

/** Call once after initFirebase(). */
export function startAuthListener(): void {
  onAuthStateChanged(getServices().auth, (u) => {
    currentUser = u;
    authListeners.forEach((l) => l());
  });
}

/** undefined while loading, null when signed out. */
export function useUser(): User | null | undefined {
  return useSyncExternalStore(
    (cb) => {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
    () => currentUser,
  );
}

function uid(): string {
  const u = getServices().auth.currentUser;
  if (!u) throw new Error('Not signed in');
  return u.uid;
}

export async function signInWithGoogle(): Promise<void> {
  const { auth } = getServices();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw e;
  }
}

export async function signOut(): Promise<void> {
  await fbSignOut(getServices().auth);
}

/** Normalise a login code as typed by a human. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function redeemLoginCode(code: string): Promise<void> {
  const { auth } = getServices();
  const res = await call<{ code: string }, { token: string }>('redeemLoginCode', { code: normalizeCode(code) });
  await signInWithCustomToken(auth, res.token);
}

export function createLoginCode(): Promise<{ code: string; expiresAt: number }> {
  return call('createLoginCode', {});
}

// ---------------------------------------------------------------------------
// Callables

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  const fn = httpsCallable<Req, Res>(getServices().functions, name, { timeout: 120_000 });
  const res = await fn(data);
  return res.data;
}

export const createApiKey = (name: string) => call<{ name: string }, { id: string; key: string }>('createApiKey', { name });
export const revokeApiKey = (id: string) => call<{ id: string }, { ok: true }>('revokeApiKey', { id });
export const searchFullText = (q: string, limit = 200) => call<{ q: string; limit: number }, { ids: string[] }>('search', { q, limit });
export const addFeed = (url: string, categoryId: string | null = null, tags: string[] = []) =>
  call<{ url: string; categoryId: string | null; tags: string[] }, { id: string; title: string; added: number }>('addFeed', { url, categoryId, tags });
export const refreshFeeds = (feedId?: string) => call<{ feedId?: string }, { added: number }>('refreshFeeds', feedId ? { feedId } : {});
export const importOpml = (opml: string) => call<{ opml: string }, { feeds: number; failed: string[] }>('importOpml', { opml });

// ---------------------------------------------------------------------------
// Helpers

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 30);
}

/** Pull the first http(s) URL out of arbitrary shared text. */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[).,;!?]+$/, '');
  const t = text.trim();
  if (/^10\.\d{4,9}\/\S+$/.test(t)) return `https://doi.org/${t}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

export function guessType(url: string): ItemType {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^mobile\./, '');
    if (/^(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(host) && /\/status(es)?\/\d+/.test(u.pathname)) return 'tweet';
    if (host === 'arxiv.org' || host === 'doi.org' || host.endsWith('.semanticscholar.org') || host === 'openreview.net') return 'paper';
    if (/\.pdf$/i.test(u.pathname)) return 'pdf';
    if (/\.epub$/i.test(u.pathname)) return 'epub';
    if (/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)vimeo\.com$/.test(host)) return 'video';
  } catch {
    /* ignore */
  }
  return 'article';
}

function placeholderTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return url;
  }
}

function itemFromDoc(d: QueryDocumentSnapshot<DocumentData> | { id: string; data: () => DocumentData | undefined }): Item {
  const x = (d.data() ?? {}) as Partial<Item>;
  return {
    id: d.id,
    url: x.url ?? null,
    type: x.type ?? 'article',
    location: x.location ?? 'library',
    status: x.status ?? 'unread',
    favorite: !!x.favorite,
    title: x.title ?? '',
    titleLocked: !!x.titleLocked,
    author: x.author ?? null,
    siteName: x.siteName ?? null,
    excerpt: x.excerpt ?? null,
    imageUrl: x.imageUrl ?? null,
    publishedAt: x.publishedAt ?? null,
    wordCount: x.wordCount ?? null,
    readingMinutes: x.readingMinutes ?? null,
    categoryId: x.categoryId ?? null,
    tags: Array.isArray(x.tags) ? x.tags : [],
    note: x.note ?? '',
    progress: typeof x.progress === 'number' ? x.progress : 0,
    fetchStatus: x.fetchStatus ?? 'done',
    fetchError: x.fetchError ?? null,
    contentChunks: x.contentChunks ?? 0,
    file: x.file ?? null,
    feedId: x.feedId ?? null,
    paper: x.paper ?? null,
    createdAt: x.createdAt ?? null,
    updatedAt: x.updatedAt ?? null,
    lastOpenedAt: x.lastOpenedAt ?? null,
    archivedAt: x.archivedAt ?? null,
  };
}

const itemsCol = () => collection(getServices().db, 'users', uid(), 'items');
const itemDoc = (id: string) => doc(getServices().db, 'users', uid(), 'items', id);

// ---------------------------------------------------------------------------
// Live collections (one shared subscription per collection, ref-counted)

type Store<T> = { data: T[] | undefined; listeners: Set<() => void>; unsub: (() => void) | null; key: string };
const stores = new Map<string, Store<unknown>>();

function useCollection<T>(name: 'items' | 'categories' | 'feeds' | 'highlights' | 'apiKeys', map: (d: QueryDocumentSnapshot<DocumentData>) => T, order: string): T[] | undefined {
  const user = useUser();
  const key = user ? `${user.uid}/${name}` : '';
  const store = key ? getStore<T>(key, name, map, order) : null;
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!store) return () => {};
      store.listeners.add(cb);
      if (!store.unsub) {
        const q = query(collection(getServices().db, 'users', key.split('/')[0], name), orderBy(order, 'desc'));
        store.unsub = onSnapshot(
          q,
          (snap) => {
            store.data = snap.docs.map(map);
            store.listeners.forEach((l) => l());
          },
          (err) => console.error(`subscription ${name} failed`, err),
        );
      }
      return () => {
        store.listeners.delete(cb);
        // Keep the subscription alive briefly to avoid churn between page switches.
        setTimeout(() => {
          if (store.listeners.size === 0 && store.unsub) {
            store.unsub();
            store.unsub = null;
          }
        }, 30_000);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return useSyncExternalStore(subscribe, () => store?.data);
}

function getStore<T>(key: string, _name: string, _map: unknown, _order: string): Store<T> {
  let s = stores.get(key) as Store<T> | undefined;
  if (!s) {
    s = { data: undefined, listeners: new Set(), unsub: null, key };
    stores.set(key, s as Store<unknown>);
  }
  return s;
}

/** All items (library + feed), newest first. undefined while loading. */
export function useItems(): Item[] | undefined {
  return useCollection('items', itemFromDoc, 'createdAt');
}

export function useCategories(): Category[] | undefined {
  const cats = useCollection<Category>(
    'categories',
    (d) => {
      const x = d.data();
      return { id: d.id, name: x.name ?? '', order: x.order ?? 0, createdAt: x.createdAt ?? null };
    },
    'createdAt',
  );
  return cats ? [...cats].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) : undefined;
}

export function useFeeds(): Feed[] | undefined {
  return useCollection<Feed>(
    'feeds',
    (d) => {
      const x = d.data();
      return {
        id: d.id,
        url: x.url ?? '',
        title: x.title ?? x.url ?? '',
        siteUrl: x.siteUrl ?? null,
        categoryId: x.categoryId ?? null,
        tags: x.tags ?? [],
        fullText: !!x.fullText,
        lastFetchedAt: x.lastFetchedAt ?? null,
        lastError: x.lastError ?? null,
        createdAt: x.createdAt ?? null,
      };
    },
    'createdAt',
  );
}

export function useHighlights(): Highlight[] | undefined {
  return useCollection<Highlight>(
    'highlights',
    (d) => {
      const x = d.data();
      return {
        id: d.id,
        itemId: x.itemId,
        text: x.text ?? '',
        note: x.note ?? '',
        prefix: x.prefix ?? '',
        suffix: x.suffix ?? '',
        createdAt: x.createdAt ?? null,
        updatedAt: x.updatedAt ?? null,
      };
    },
    'createdAt',
  );
}

export function useApiKeys(): ApiKeyInfo[] | undefined {
  return useCollection<ApiKeyInfo>(
    'apiKeys',
    (d) => {
      const x = d.data();
      return { id: d.id, name: x.name ?? '', prefix: x.prefix ?? '', createdAt: x.createdAt ?? null, lastUsedAt: x.lastUsedAt ?? null };
    },
    'createdAt',
  );
}

/** A single item, live. undefined while loading, null if missing. */
export function useItem(id: string | undefined): Item | null | undefined {
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const user = useUser();
  useEffect(() => {
    if (!id || !user) return;
    return onSnapshot(
      doc(getServices().db, 'users', user.uid, 'items', id),
      (snap) => setItem(snap.exists() ? itemFromDoc(snap) : null),
      () => setItem(null),
    );
  }, [id, user]);
  return item;
}

/** All distinct tags with counts, most used first. */
export function tagCounts(items: Item[]): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Item mutations

export interface AddOptions {
  title?: string;
  tags?: string[];
  categoryId?: string | null;
  location?: 'library' | 'feed';
}

/** Find an existing item with the same URL (library or feed). */
export async function findByUrl(url: string): Promise<Item | null> {
  const q = query(itemsCol(), where('url', '==', url));
  let snap;
  try {
    snap = await getDocs(q);
  } catch {
    snap = await getDocsFromCache(q);
  }
  return snap.empty ? null : itemFromDoc(snap.docs[0]);
}

/** Save a URL. Returns the item id (existing one if the URL was already saved — it is moved to the library and marked unread). */
export async function addUrl(rawUrl: string, opts: AddOptions = {}): Promise<string> {
  const url = extractUrl(rawUrl) ?? rawUrl.trim();
  new URL(url); // throws on invalid input
  if (url.length > 2048) throw new Error('This link is too long to save');
  const existing = await findByUrl(url).catch(() => null);
  if (existing) {
    const patch: Record<string, unknown> = { location: 'library', status: 'unread', archivedAt: null, updatedAt: serverTimestamp() };
    if (opts.tags?.length) patch.tags = normalizeTags([...existing.tags, ...opts.tags]);
    if (opts.categoryId !== undefined) patch.categoryId = opts.categoryId;
    await updateDoc(itemDoc(existing.id), patch);
    return existing.id;
  }
  const ref = doc(itemsCol());
  // Do not await the write: with offline persistence the promise resolves only once the server acks.
  void setDoc(ref, newItemData({
    url,
    type: guessType(url),
    title: (opts.title?.replace(/\s+/g, ' ').trim() || placeholderTitle(url)).slice(0, 500),
    titleLocked: false,
    tags: normalizeTags(opts.tags ?? []),
    categoryId: opts.categoryId ?? null,
    location: opts.location ?? 'library',
    fetchStatus: 'pending',
  })).catch((e) => console.error('save failed', e));
  return ref.id;
}

function newItemData(x: Record<string, unknown>): Record<string, unknown> {
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
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastOpenedAt: null,
    archivedAt: null,
    ...x,
  };
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Upload a PDF or EPUB file as a new item. onProgress gets 0..1. Returns the item id. */
export async function uploadFile(file: File | Blob, name: string, opts: AddOptions & { onProgress?: (p: number) => void } = {}): Promise<string> {
  const lower = name.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
  const isEpub = lower.endsWith('.epub') || file.type === 'application/epub+zip';
  if (!isPdf && !isEpub) throw new Error('Only PDF and EPUB files are supported');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is larger than 100 MB');
  const contentType = isPdf ? 'application/pdf' : 'application/epub+zip';
  const ref = doc(itemsCol());
  const safeName = name.replace(/[^\w.\- ]+/g, '_').slice(-120) || (isPdf ? 'file.pdf' : 'book.epub');
  const path = `users/${uid()}/uploads/${ref.id}/${safeName}`;
  await setDoc(ref, newItemData({
    type: isPdf ? 'pdf' : 'epub',
    title: (opts.title?.trim() || name.replace(/\.(pdf|epub)$/i, '')).slice(0, 500),
    tags: normalizeTags(opts.tags ?? []),
    categoryId: opts.categoryId ?? null,
    fetchStatus: 'uploading',
    file: { path, name: safeName, contentType, size: file.size },
  }));
  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef(getServices().storage, path), file, { contentType });
    task.on('state_changed', (s) => opts.onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0), reject, () => resolve());
  });
  await updateDoc(ref, { fetchStatus: 'pending', updatedAt: serverTimestamp() });
  return ref.id;
}

export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  const data: Record<string, unknown> = { ...patch, updatedAt: serverTimestamp() };
  if (patch.tags) data.tags = normalizeTags(patch.tags);
  if (patch.status === 'archived') data.archivedAt = serverTimestamp();
  if (patch.status === 'unread') data.archivedAt = null;
  // Fire-and-forget friendly: callers may await, but offline writes resolve only on sync.
  await updateDoc(itemDoc(id), data);
}

/** Apply without waiting for server ack (good for offline / e-ink snappiness). */
export function updateItemLater(id: string, patch: ItemPatch): void {
  updateItem(id, patch).catch((e) => console.error('update failed', e));
}

export async function markOpened(id: string): Promise<void> {
  await updateDoc(itemDoc(id), { lastOpenedAt: serverTimestamp() });
}

export async function refetchItem(id: string): Promise<void> {
  await updateDoc(itemDoc(id), { fetchStatus: 'pending', fetchError: null, updatedAt: serverTimestamp() });
}

export async function deleteItem(id: string): Promise<void> {
  await deleteDoc(itemDoc(id));
}

export async function bulkUpdate(ids: string[], patch: ItemPatch): Promise<void> {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(getServices().db);
    for (const id of ids.slice(i, i + 400)) {
      const data: Record<string, unknown> = { ...patch, updatedAt: serverTimestamp() };
      if (patch.tags) data.tags = normalizeTags(patch.tags);
      if (patch.status === 'archived') data.archivedAt = serverTimestamp();
      if (patch.status === 'unread') data.archivedAt = null;
      batch.update(itemDoc(id), data);
    }
    await batch.commit();
  }
}

/** Load the readable HTML content of an item (concatenated chunks). Returns '' if none. */
export async function loadContent(item: Pick<Item, 'id' | 'contentChunks'>): Promise<string> {
  if (!item.contentChunks) return '';
  const { db } = getServices();
  const parts = await Promise.all(
    Array.from({ length: item.contentChunks }, (_, i) => getDoc(doc(db, 'users', uid(), 'items', item.id, 'content', String(i)))),
  );
  return parts.map((p) => (p.exists() ? (p.data().html as string) : '')).join('');
}

/** Warm the offline cache with content of unread library items (best effort). */
export async function prefetchContent(items: Item[], max = 40): Promise<void> {
  const todo = items.filter((i) => i.location === 'library' && i.status === 'unread' && i.contentChunks > 0).slice(0, max);
  for (const it of todo) {
    try {
      await loadContent(it);
    } catch {
      /* ignore */
    }
  }
}

/** Download URL for the stored original file (pdf/epub). */
export async function fileUrl(item: Pick<Item, 'file'>): Promise<string | null> {
  if (!item.file) return null;
  return getDownloadURL(storageRef(getServices().storage, item.file.path));
}

// ---------------------------------------------------------------------------
// Categories & tags

export async function createCategory(name: string): Promise<string> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('Enter a category name');
  const ref = doc(collection(getServices().db, 'users', uid(), 'categories'));
  // Do not await the server ack, so creating a category also works offline (the local cache has it at once).
  void setDoc(ref, { name: clean, order: Date.now(), createdAt: serverTimestamp() }).catch((e) => console.error('create category failed', e));
  return ref.id;
}

export async function renameCategory(id: string, name: string): Promise<void> {
  await updateDoc(doc(getServices().db, 'users', uid(), 'categories', id), { name: name.trim().slice(0, 60) });
}

export async function reorderCategories(idsInOrder: string[]): Promise<void> {
  const batch = writeBatch(getServices().db);
  idsInOrder.forEach((id, i) => batch.update(doc(getServices().db, 'users', uid(), 'categories', id), { order: i }));
  await batch.commit();
}

/** Delete a category; items in it become uncategorised. */
export async function deleteCategory(id: string, items: Item[]): Promise<void> {
  await bulkUpdate(items.filter((i) => i.categoryId === id).map((i) => i.id), { categoryId: null });
  await deleteDoc(doc(getServices().db, 'users', uid(), 'categories', id));
}

/** Rename (or merge) a tag across all items. Pass newTag = '' to delete the tag. */
export async function renameTag(oldTag: string, newTag: string, items: Item[]): Promise<void> {
  const n = normalizeTag(newTag);
  const affected = items.filter((i) => i.tags.includes(oldTag));
  for (let i = 0; i < affected.length; i += 400) {
    const batch = writeBatch(getServices().db);
    for (const it of affected.slice(i, i + 400)) {
      const tags = normalizeTags(it.tags.map((t) => (t === oldTag ? n : t)).filter(Boolean));
      batch.update(itemDoc(it.id), { tags, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// Feeds

export async function updateFeed(id: string, patch: Partial<Pick<Feed, 'title' | 'categoryId' | 'tags' | 'fullText'>>): Promise<void> {
  const data: Record<string, unknown> = { ...patch };
  if (patch.tags) data.tags = normalizeTags(patch.tags);
  await updateDoc(doc(getServices().db, 'users', uid(), 'feeds', id), data);
}

/** Delete a feed. If removeItems, also deletes its unsaved feed items. */
export async function deleteFeed(id: string, items: Item[], removeItems = true): Promise<void> {
  if (removeItems) {
    const ids = items.filter((i) => i.feedId === id && i.location === 'feed').map((i) => i.id);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(getServices().db);
      ids.slice(i, i + 400).forEach((x) => batch.delete(itemDoc(x)));
      await batch.commit();
    }
  }
  await deleteDoc(doc(getServices().db, 'users', uid(), 'feeds', id));
}

export function feedsToOpml(feeds: Feed[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = feeds
    .map((f) => `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.siteUrl ? ` htmlUrl="${esc(f.siteUrl)}"` : ''}/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Readlater feeds</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
}

// ---------------------------------------------------------------------------
// Highlights

export async function addHighlight(h: Pick<Highlight, 'itemId' | 'text' | 'prefix' | 'suffix'> & { note?: string }): Promise<string> {
  const ref = doc(collection(getServices().db, 'users', uid(), 'highlights'));
  void setDoc(ref, {
    itemId: h.itemId,
    text: h.text.slice(0, 5000),
    prefix: h.prefix.slice(-32),
    suffix: h.suffix.slice(0, 32),
    note: (h.note ?? '').slice(0, 5000),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }).catch((e) => console.error('highlight failed', e));
  return ref.id;
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  await updateDoc(doc(getServices().db, 'users', uid(), 'highlights', id), { note: note.slice(0, 5000), updatedAt: serverTimestamp() });
}

export async function deleteHighlight(id: string): Promise<void> {
  await deleteDoc(doc(getServices().db, 'users', uid(), 'highlights', id));
}

// ---------------------------------------------------------------------------
// Export

export function exportJson(items: Item[], categories: Category[], feeds: Feed[], highlights: Highlight[]): string {
  const ts = (t: { toDate(): Date } | null) => (t ? t.toDate().toISOString() : null);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      feeds: feeds.map((f) => ({ url: f.url, title: f.title, siteUrl: f.siteUrl, categoryId: f.categoryId, tags: f.tags })),
      items: items.map((i) => ({
        id: i.id,
        url: i.url,
        type: i.type,
        location: i.location,
        status: i.status,
        favorite: i.favorite,
        title: i.title,
        author: i.author,
        siteName: i.siteName,
        categoryId: i.categoryId,
        tags: i.tags,
        note: i.note,
        progress: i.progress,
        createdAt: ts(i.createdAt),
        archivedAt: ts(i.archivedAt),
      })),
      highlights: highlights.map((h) => ({ itemId: h.itemId, text: h.text, note: h.note, createdAt: ts(h.createdAt) })),
    },
    null,
    2,
  );
}
