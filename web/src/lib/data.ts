/**
 * Data access layer. All Firestore / Storage / Functions access from the UI goes
 * through this module so pages stay simple. See docs/SPEC.md and docs/SPEC-2.md for the model.
 *
 * SPEC-2 additions:
 *   useViews / createView / updateView / reorderViews / deleteView          saved Library views
 *   useRules / createRule / updateRule / deleteRule                         auto rules
 *   useIntegration('telegram' | 'email')                                    live server mirror (null = not set up)
 *   createTelegramLink / unlinkTelegram / getInboundEmail / getAppConfig    integration callables
 *   aiCall(itemId, action, question?, force?)                               the `ai` callable
 *   createShare / revokeShare / exportEpub                                  sharing & export callables
 *   addHighlight({ ..., color? }) / updateHighlightColor(id, color)         highlight colours
 *   bulkPatch / bulkAddTags / bulkDelete                                    bulk list actions
 *   currentSource(): 'app' | 'web'                                          `source` set by addUrl / uploadFile
 *   cachedContentText(item): Promise<string | null>                         cached content as text (search snippets)
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
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
  getDocFromCache,
  getDocsFromCache,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { getServices } from './firebase';
import type {
  AiAction,
  AiResult,
  ApiKeyInfo,
  ApiKeyScope,
  AppConfig,
  Category,
  Feed,
  Highlight,
  HighlightColor,
  IntegrationDoc,
  IntegrationName,
  Item,
  ItemPatch,
  ItemSource,
  ItemType,
  Rule,
  RuleInput,
  SavedView,
} from './types';

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

/**
 * Redeem a login code and sign in. `verifier` is required for codes made for the native app's sign-in
 * hand-off (createLoginCode with a `challenge`).
 */
export async function redeemLoginCode(code: string, verifier?: string): Promise<void> {
  const { auth } = getServices();
  const req: { code: string; verifier?: string } = { code: normalizeCode(code) };
  if (verifier) req.verifier = verifier;
  const res = await call<typeof req, { token: string }>('redeemLoginCode', req);
  await signInWithCustomToken(auth, res.token);
}

/** A one-time code for another device; with `challenge` (PKCE S256) only the holder of its verifier can redeem it. */
export function createLoginCode(challenge?: string): Promise<{ code: string; expiresAt: number }> {
  return call('createLoginCode', challenge ? { challenge } : {});
}

// ---------------------------------------------------------------------------
// Callables

/** Client-side wait per callable; longer than the function's own timeout for the slow ones (server budgets 180–540 s). */
const CALL_TIMEOUT_MS: Record<string, number> = {
  addFeed: 190_000,
  refreshFeeds: 560_000,
  importOpml: 560_000,
  exportEpub: 560_000,
};

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  const fn = httpsCallable<Req, Res>(getServices().functions, name, { timeout: CALL_TIMEOUT_MS[name] ?? 120_000 });
  const res = await fn(data);
  return res.data;
}

/** scope 'save': the key can only save (GET/POST /api/save), e.g. for the bookmarklet that runs inside other pages. */
export const createApiKey = (name: string, scope: ApiKeyScope = 'all') =>
  call<{ name: string; scope?: ApiKeyScope }, { id: string; key: string }>('createApiKey', scope === 'all' ? { name } : { name, scope });
export const revokeApiKey = (id: string) => call<{ id: string }, { ok: true }>('revokeApiKey', { id });
export const searchFullText = (q: string, limit = 200) => call<{ q: string; limit: number }, { ids: string[] }>('search', { q, limit });
export const addFeed = (url: string, categoryId: string | null = null, tags: string[] = []) =>
  call<{ url: string; categoryId: string | null; tags: string[] }, { id: string; title: string; added: number }>('addFeed', { url, categoryId, tags });
export const refreshFeeds = (feedId?: string) => call<{ feedId?: string }, { added: number }>('refreshFeeds', feedId ? { feedId } : {});
export const importOpml = (opml: string) => call<{ opml: string }, { feeds: number; failed: string[] }>('importOpml', { opml });

/** Feature flags (no auth needed). Use the cached `useConfig()` from lib/config instead of calling this directly. */
export const getAppConfig = () => call<Record<string, never>, AppConfig>('getConfig', {});
export const createTelegramLink = () => call<Record<string, never>, { url: string }>('createTelegramLink', {});
export const unlinkTelegram = () => call<Record<string, never>, { ok: true }>('unlinkTelegram', {});
/** The user's newsletter address (created on first call). reset = true replaces it with a new one. */
export const getInboundEmail = (reset = false) => call<{ reset?: boolean }, { address: string }>('getInboundEmail', reset ? { reset: true } : {});

/** AI helpers on a document. Throws when AI is not configured (check useConfig().ai first). */
export function aiCall<A extends AiAction>(itemId: string, action: A, question?: string, force = false): Promise<AiResult<A>> {
  const req: { itemId: string; action: A; question?: string; force?: boolean } = { itemId, action };
  if (question) req.question = question;
  if (force) req.force = true;
  return call<typeof req, AiResult<A>>('ai', req);
}

/** Create (or refresh) the public link of a document. Sharing an already shared item keeps its link. */
export const createShare = (itemId: string, includeHighlights = false) =>
  call<{ itemId: string; includeHighlights: boolean }, { token: string; url: string }>('createShare', { itemId, includeHighlights });
export const revokeShare = (token: string) => call<{ token: string }, { ok: true }>('revokeShare', { token });
export const MAX_EPUB_ITEMS = 200;
/** Build an EPUB of up to MAX_EPUB_ITEMS documents; resolves with a download URL. */
export const exportEpub = (itemIds: string[]) => call<{ itemIds: string[] }, { url: string; name: string }>('exportEpub', { itemIds });

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
    source: x.source ?? null,
    aiSummary: x.aiSummary && typeof x.aiSummary.text === 'string' ? { text: x.aiSummary.text, createdAt: x.aiSummary.createdAt ?? null, model: x.aiSummary.model ?? '' } : null,
    shareToken: typeof x.shareToken === 'string' && x.shareToken ? x.shareToken : null,
    processingAt: x.processingAt ?? null,
    retryAt: x.retryAt ?? null,
  };
}

/** `source` recorded on items created by this client. */
export function currentSource(): Extract<ItemSource, 'app' | 'web'> {
  try {
    return Capacitor.isNativePlatform() ? 'app' : 'web';
  } catch {
    return 'web';
  }
}

const itemsCol = () => collection(getServices().db, 'users', uid(), 'items');
const itemDoc = (id: string) => doc(getServices().db, 'users', uid(), 'items', id);

// ---------------------------------------------------------------------------
// Live collections (one shared subscription per collection, ref-counted)

type Store<T> = { data: T[] | undefined; listeners: Set<() => void>; unsub: (() => void) | null; key: string };
const stores = new Map<string, Store<unknown>>();

function useCollection<T>(name: 'items' | 'categories' | 'feeds' | 'highlights' | 'apiKeys' | 'views' | 'rules', map: (d: QueryDocumentSnapshot<DocumentData>) => T, order: string): T[] | undefined {
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
          (err) => {
            // The listener is dead (e.g. permission-denied right after sign-out): forget it and its data, so the
            // next subscriber starts a new one instead of showing stale lists forever.
            console.error(`subscription ${name} failed`, err);
            store.unsub = null;
            store.data = undefined;
            store.listeners.forEach((l) => l());
          },
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
        color: isHighlightColor(x.color) ? x.color : 'yellow',
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
      return {
        id: d.id,
        name: x.name ?? '',
        prefix: x.prefix ?? '',
        scope: x.scope === 'save' || (x.scope === undefined && x.name === 'Bookmarklet') ? 'save' : 'all',
        createdAt: x.createdAt ?? null,
        lastUsedAt: x.lastUsedAt ?? null,
      };
    },
    'createdAt',
  );
}

export function useViews(): SavedView[] | undefined {
  const views = useCollection<SavedView>(
    'views',
    (d) => {
      const x = d.data();
      return { id: d.id, name: x.name ?? '', params: x.params ?? '', order: typeof x.order === 'number' ? x.order : 0, createdAt: x.createdAt ?? null };
    },
    'createdAt',
  );
  return views ? [...views].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) : undefined;
}

export function useRules(): Rule[] | undefined {
  const rules = useCollection<Rule>(
    'rules',
    (d) => {
      const x = d.data();
      const m = (x.match ?? {}) as Partial<Rule['match']>;
      return {
        id: d.id,
        name: x.name ?? '',
        enabled: x.enabled !== false,
        match: { field: m.field ?? 'domain', op: m.op ?? 'is', value: m.value ?? '' },
        actions: (x.actions ?? {}) as Rule['actions'],
        createdAt: x.createdAt ?? null,
      };
    },
    'createdAt',
  );
  // Oldest first: rules apply in creation order.
  return rules ? [...rules].reverse() : undefined;
}

/**
 * Live server mirror of an integration (`users/{uid}/integrations/{name}`).
 * undefined while loading, null when not linked / not created.
 */
export function useIntegration<N extends IntegrationName>(name: N): IntegrationDoc<N> | null | undefined {
  const user = useUser();
  const key = user ? `${user.uid}/${name}` : '';
  const [state, setState] = useState<{ key: string; value: IntegrationDoc<N> | null | undefined }>({ key, value: undefined });
  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(getServices().db, 'users', user.uid, 'integrations', name),
      (snap) => {
        const x = snap.data();
        let value: IntegrationDoc<N> | null = null;
        if (snap.exists() && x) {
          value = (
            name === 'telegram'
              ? { chatId: Number(x.chatId), username: typeof x.username === 'string' && x.username ? x.username : null, linkedAt: x.linkedAt ?? null }
              : typeof x.address === 'string' && x.address
                ? { address: x.address, createdAt: x.createdAt ?? null }
                : null
          ) as IntegrationDoc<N> | null;
        }
        setState({ key: `${user.uid}/${name}`, value });
      },
      (err) => {
        console.error(`integration ${name} failed`, err);
        setState({ key: `${user.uid}/${name}`, value: null });
      },
    );
  }, [user, name]);
  return state.key === key ? state.value : undefined;
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
  /** Defaults to currentSource(). Recorded only when a new item is created. */
  source?: ItemSource;
  /** When it was originally saved (imports); new items only. Defaults to now. */
  createdAt?: Date;
  /** 'archived' saves straight to the archive (imports); default 'unread'. */
  status?: 'unread' | 'archived';
  favorite?: boolean;
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
  const archived = opts.status === 'archived';
  const existing = await findByUrl(url).catch(() => null);
  if (existing) {
    const patch: Record<string, unknown> = {
      location: 'library',
      status: archived ? 'archived' : 'unread',
      archivedAt: archived ? (existing.archivedAt ?? serverTimestamp()) : null,
      updatedAt: serverTimestamp(),
    };
    if (opts.tags?.length) patch.tags = normalizeTags([...existing.tags, ...opts.tags]);
    if (opts.categoryId !== undefined) patch.categoryId = opts.categoryId;
    if (opts.favorite) patch.favorite = true;
    // Not awaited, like the create below: offline, the promise would settle only when the server acks.
    void updateDoc(itemDoc(existing.id), patch).catch((e) => console.error('save failed', e));
    return existing.id;
  }
  const ref = doc(itemsCol());
  const createdAt = opts.createdAt && !Number.isNaN(opts.createdAt.getTime()) ? Timestamp.fromDate(opts.createdAt) : null;
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
    source: opts.source ?? currentSource(),
    ...(createdAt ? { createdAt } : {}),
    ...(archived ? { status: 'archived', archivedAt: createdAt ?? serverTimestamp() } : {}),
    ...(opts.favorite ? { favorite: true } : {}),
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
    source: opts.source ?? currentSource(),
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

/**
 * Settle a set of writes. Every batch is committed at once, so the local cache (and the offline queue) gets all
 * of them immediately; online the promise waits for the server, offline it resolves right away (the SDK only
 * settles writes when the server acknowledges them, which would leave the UI waiting until reconnect).
 */
function settleWrites(writes: Promise<void>[]): Promise<void> {
  const all = Promise.all(writes).then(() => undefined);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    all.catch((e) => console.error('offline write failed', e));
    return Promise.resolve();
  }
  return all;
}

const WRITES_PER_BATCH = 400;

/** Commit `ops` (one write each) in batches of WRITES_PER_BATCH, all at once. */
function commitInBatches<T>(list: T[], op: (batch: ReturnType<typeof writeBatch>, x: T) => void): Promise<void> {
  const commits: Promise<void>[] = [];
  for (let i = 0; i < list.length; i += WRITES_PER_BATCH) {
    const batch = writeBatch(getServices().db);
    for (const x of list.slice(i, i + WRITES_PER_BATCH)) op(batch, x);
    commits.push(batch.commit());
  }
  return settleWrites(commits);
}

function patchData(patch: ItemPatch): Record<string, unknown> {
  const data: Record<string, unknown> = { ...patch, updatedAt: serverTimestamp() };
  if (patch.tags) data.tags = normalizeTags(patch.tags);
  if (patch.status === 'archived') data.archivedAt = serverTimestamp();
  if (patch.status === 'unread') data.archivedAt = null;
  return data;
}

export async function bulkUpdate(ids: string[], patch: ItemPatch): Promise<void> {
  await commitInBatches(ids, (batch, id) => batch.update(itemDoc(id), patchData(patch)));
}

/** Apply a different patch to each item (batched; 400 writes per batch). */
export async function bulkPatch(patches: { id: string; patch: ItemPatch }[]): Promise<void> {
  await commitInBatches(patches, (batch, { id, patch }) => batch.update(itemDoc(id), patchData(patch)));
}

/** Add tags to several items, keeping their existing tags. Items that already have them all are skipped. */
export async function bulkAddTags(items: Pick<Item, 'id' | 'tags'>[], tags: string[]): Promise<void> {
  const add = normalizeTags(tags);
  if (!add.length) return;
  const patches = items
    .filter((it) => add.some((t) => !it.tags.includes(t)))
    .map((it) => ({ id: it.id, patch: { tags: normalizeTags([...it.tags, ...add]) } }));
  await bulkPatch(patches);
}

export async function bulkDelete(ids: string[]): Promise<void> {
  await commitInBatches(ids, (batch, id) => batch.delete(itemDoc(id)));
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

/**
 * Plain text of an item's content when this device already has it cached (never touches the network),
 * else null. Used for full-text search snippets.
 */
export async function cachedContentText(item: Pick<Item, 'id' | 'contentChunks'>): Promise<string | null> {
  if (!item.contentChunks) return null;
  const { db } = getServices();
  try {
    const parts = await Promise.all(
      Array.from({ length: item.contentChunks }, (_, i) => getDocFromCache(doc(db, 'users', uid(), 'items', item.id, 'content', String(i)))),
    );
    const html = parts.map((p) => (p.exists() ? String(p.data().html ?? '') : '')).join('');
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    // Block elements become line breaks, so words of adjacent paragraphs do not run together.
    body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, br, div, section').forEach((el) => el.append(' '));
    return body.textContent ?? '';
  } catch {
    return null;
  }
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
  const uncategorise = bulkUpdate(items.filter((i) => i.categoryId === id).map((i) => i.id), { categoryId: null });
  await settleWrites([uncategorise, deleteDoc(doc(getServices().db, 'users', uid(), 'categories', id))]);
}

/** Rename (or merge) a tag across all items. Pass newTag = '' to delete the tag. */
export async function renameTag(oldTag: string, newTag: string, items: Item[]): Promise<void> {
  const n = normalizeTag(newTag);
  const affected = items.filter((i) => i.tags.includes(oldTag));
  await commitInBatches(affected, (batch, it) => {
    const tags = normalizeTags(it.tags.map((t) => (t === oldTag ? n : t)).filter(Boolean));
    batch.update(itemDoc(it.id), { tags, updatedAt: serverTimestamp() });
  });
}

// ---------------------------------------------------------------------------
// Feeds

export async function updateFeed(id: string, patch: Partial<Pick<Feed, 'title' | 'categoryId' | 'tags' | 'fullText'>>): Promise<void> {
  const data: Record<string, unknown> = { ...patch };
  if (patch.tags) data.tags = normalizeTags(patch.tags);
  await settleWrites([updateDoc(doc(getServices().db, 'users', uid(), 'feeds', id), data)]);
}

/** Delete a feed. If removeItems, also deletes its unsaved feed items. */
export async function deleteFeed(id: string, items: Item[], removeItems = true): Promise<void> {
  const ids = removeItems ? items.filter((i) => i.feedId === id && i.location === 'feed').map((i) => i.id) : [];
  await settleWrites([bulkDelete(ids), deleteDoc(doc(getServices().db, 'users', uid(), 'feeds', id))]);
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

export function isHighlightColor(v: unknown): v is HighlightColor {
  return v === 'yellow' || v === 'green' || v === 'blue' || v === 'pink';
}

export async function addHighlight(h: Pick<Highlight, 'itemId' | 'text' | 'prefix' | 'suffix'> & { note?: string; color?: HighlightColor }): Promise<string> {
  const ref = doc(collection(getServices().db, 'users', uid(), 'highlights'));
  void setDoc(ref, {
    itemId: h.itemId,
    text: h.text.slice(0, 5000),
    prefix: h.prefix.slice(-32),
    suffix: h.suffix.slice(0, 32),
    note: (h.note ?? '').slice(0, 5000),
    color: isHighlightColor(h.color) ? h.color : 'yellow',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }).catch((e) => console.error('highlight failed', e));
  return ref.id;
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  await updateDoc(doc(getServices().db, 'users', uid(), 'highlights', id), { note: note.slice(0, 5000), updatedAt: serverTimestamp() });
}

export async function updateHighlightColor(id: string, color: HighlightColor): Promise<void> {
  if (!isHighlightColor(color)) throw new Error('Unknown highlight colour');
  await updateDoc(doc(getServices().db, 'users', uid(), 'highlights', id), { color, updatedAt: serverTimestamp() });
}

export async function deleteHighlight(id: string): Promise<void> {
  await deleteDoc(doc(getServices().db, 'users', uid(), 'highlights', id));
}

// ---------------------------------------------------------------------------
// Saved views

const viewsCol = () => collection(getServices().db, 'users', uid(), 'views');

function cleanViewName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('Enter a name for the view');
  return clean;
}

function cleanViewParams(params: string): string {
  const p = params.replace(/^\?/, '');
  if (p.length > 1000) throw new Error('This view has too many filters to save');
  return p;
}

/** Save a Library query string (without '?') as a named view. Returns its id (written without waiting for the server). */
export async function createView(name: string, params: string): Promise<string> {
  const ref = doc(viewsCol());
  void setDoc(ref, { name: cleanViewName(name), params: cleanViewParams(params), order: Date.now(), createdAt: serverTimestamp() }).catch((e) =>
    console.error('create view failed', e),
  );
  return ref.id;
}

export async function updateView(id: string, patch: Partial<Pick<SavedView, 'name' | 'params' | 'order'>>): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = cleanViewName(patch.name);
  if (patch.params !== undefined) data.params = cleanViewParams(patch.params);
  if (patch.order !== undefined) data.order = patch.order;
  await updateDoc(doc(viewsCol(), id), data);
}

export async function reorderViews(idsInOrder: string[]): Promise<void> {
  const batch = writeBatch(getServices().db);
  idsInOrder.forEach((id, i) => batch.update(doc(viewsCol(), id), { order: i }));
  await batch.commit();
}

export async function deleteView(id: string): Promise<void> {
  await deleteDoc(doc(viewsCol(), id));
}

// ---------------------------------------------------------------------------
// Auto rules

const rulesCol = () => collection(getServices().db, 'users', uid(), 'rules');

/** Validate and normalise a rule before writing (mirrors firestore.rules). */
export function cleanRule(r: RuleInput): RuleInput {
  const value = r.match.value.trim().slice(0, 500);
  if (!value) throw new Error('Enter a value to match');
  const actions: RuleInput['actions'] = {};
  const tags = normalizeTags(r.actions.addTags ?? []);
  if (tags.length) actions.addTags = tags;
  if (r.actions.categoryId !== undefined) actions.categoryId = r.actions.categoryId;
  if (r.actions.location) actions.location = r.actions.location;
  if (r.actions.favorite) actions.favorite = true;
  if (r.actions.archive) actions.archive = true;
  if (!Object.keys(actions).length) throw new Error('Choose at least one action');
  return {
    name: r.name.replace(/\s+/g, ' ').trim().slice(0, 100),
    enabled: !!r.enabled,
    match: { field: r.match.field, op: r.match.op, value },
    actions,
  };
}

export async function createRule(rule: RuleInput): Promise<string> {
  const ref = doc(rulesCol());
  void setDoc(ref, { ...cleanRule(rule), createdAt: serverTimestamp() }).catch((e) => console.error('create rule failed', e));
  return ref.id;
}

/** Replace a rule's fields (pass the whole rule), or just toggle `enabled`. */
export async function updateRule(id: string, patch: RuleInput | Pick<RuleInput, 'enabled'>): Promise<void> {
  const data = 'match' in patch ? cleanRule(patch as RuleInput) : { enabled: !!patch.enabled };
  await updateDoc(doc(rulesCol(), id), data);
}

export async function deleteRule(id: string): Promise<void> {
  await deleteDoc(doc(rulesCol(), id));
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
