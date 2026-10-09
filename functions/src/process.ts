/** processItem: extract content for pending items; cleanupItem: remove derived data when an item is deleted. */
import './options';
import { randomUUID } from 'node:crypto';
import type { DocumentReference } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { bucket, db, REGION } from './admin';
import { readContent, writeContent } from './content';
import { extractEpub, extractPdf, extractUrl } from './extract';
import type { Extracted, UploadImage } from './extract/types';
import { decideAction, donePatch, errorMessage, fileKind, itemKeywords, merged, type ItemData, type StoredFile } from './processLogic';
import { htmlToPlainText } from './searchIndex';
import { safeFileName, storageDownloadUrl, withTimeout } from './util';

const ITEM_PATH = 'users/{uid}/items/{itemId}';
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const EXTRACT_DEADLINE_MS = 270_000;

const itemRef = (uid: string, itemId: string) => db.collection('users').doc(uid).collection('items').doc(itemId);
const searchRef = (uid: string, itemId: string) => db.collection('users').doc(uid).collection('search').doc(itemId);
const filesPrefix = (uid: string, itemId: string) => `users/${uid}/files/${itemId}/`;

/** Atomically move pending → processing. Returns the item data, or null if someone else got it first. */
async function claim(ref: DocumentReference): Promise<ItemData | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('fetchStatus') !== 'pending') return null;
    tx.update(ref, { fetchStatus: 'processing', fetchError: null, updatedAt: FieldValue.serverTimestamp() });
    return snap.data() as ItemData;
  });
}

/** Save a buffer to Storage with a download token; returns its public (token) URL. */
async function saveWithToken(path: string, data: Uint8Array | Buffer, contentType: string): Promise<string> {
  const b = bucket();
  const token = randomUUID();
  await b.file(path).save(Buffer.from(data), {
    resumable: false,
    contentType,
    metadata: { contentType, cacheControl: 'private, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
  });
  return storageDownloadUrl(b.name, path, token);
}

function imageUploader(uid: string, itemId: string): UploadImage {
  const done = new Map<string, Promise<string>>();
  const used = new Set<string>();
  return (name, data, contentType) => {
    const existing = done.get(name);
    if (existing) return existing;
    let file = safeFileName(name, 'image');
    for (let i = 2; used.has(file); i++) file = `${i}_${safeFileName(name, 'image')}`;
    used.add(file);
    const p = saveWithToken(`${filesPrefix(uid, itemId)}img/${file}`, data, contentType || 'application/octet-stream');
    done.set(name, p);
    return p;
  };
}

async function extractItem(uid: string, itemId: string, item: ItemData): Promise<Extracted> {
  const uploadImage = imageUploader(uid, itemId);
  const file = item.file as StoredFile | null | undefined;
  if (file?.path) {
    const f = bucket().file(file.path);
    const [exists] = await f.exists();
    if (!exists) throw new Error('The uploaded file could not be found. Please upload it again.');
    const [meta] = await f.getMetadata();
    if (Number(meta.size ?? 0) > MAX_FILE_BYTES) throw new Error('File is larger than 100 MB');
    const [buf] = await f.download();
    const kind = fileKind({ name: file.name, contentType: file.contentType || String(meta.contentType ?? ''), path: file.path }, buf);
    if (kind === 'pdf') return extractPdf(buf, { name: file.name, url: typeof item.url === 'string' ? item.url : undefined });
    if (kind === 'epub') {
      const opts = { uploadImage, name: file.name };
      return extractEpub(buf, opts);
    }
    throw new Error('Unsupported file type (only PDF and EPUB are supported)');
  }
  if (typeof item.url === 'string' && item.url) {
    return extractUrl(item.url, { uploadImage });
  }
  throw new Error('Nothing to extract: the item has no URL or file');
}

/** Store a file returned by extraction (e.g. a downloaded PDF) as the item's original. */
async function storeOriginal(uid: string, itemId: string, file: NonNullable<Extracted['file']>): Promise<StoredFile> {
  const ext = /epub/i.test(file.contentType) ? 'epub' : 'pdf';
  const path = `${filesPrefix(uid, itemId)}original.${ext}`;
  await saveWithToken(path, file.buffer, file.contentType);
  return { path, name: safeFileName(file.name || `original.${ext}`, `original.${ext}`), contentType: file.contentType, size: file.buffer.length };
}

async function writeIndex(uid: string, itemId: string, item: ItemData, bodyText: string): Promise<void> {
  await searchRef(uid, itemId).set({ kw: itemKeywords(item, bodyText) });
}

async function existingText(ref: DocumentReference, item: ItemData): Promise<string> {
  if (!Number(item.contentChunks ?? 0)) return '';
  return htmlToPlainText(await readContent(ref));
}

/** Remove all derived data of an item (content, search doc, highlights, storage). Errors are logged, not thrown. */
export async function purgeItemData(uid: string, itemId: string, opts: { highlights: boolean; uploads: boolean }): Promise<void> {
  const ref = itemRef(uid, itemId);
  const tasks: Promise<unknown>[] = [
    db.recursiveDelete(ref.collection('content')),
    searchRef(uid, itemId).delete(),
    bucket().deleteFiles({ prefix: filesPrefix(uid, itemId) }),
  ];
  if (opts.uploads) tasks.push(bucket().deleteFiles({ prefix: `users/${uid}/uploads/${itemId}/` }));
  if (opts.highlights) {
    tasks.push(
      (async () => {
        const snap = await db.collection('users').doc(uid).collection('highlights').where('itemId', '==', itemId).get();
        const w = db.bulkWriter();
        snap.docs.forEach((d) => w.delete(d.ref));
        await w.close();
      })(),
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') logger.warn('cleanup step failed', { uid, itemId, error: String(r.reason) });
}

async function processOne(uid: string, itemId: string): Promise<void> {
  const ref = itemRef(uid, itemId);
  const item = await claim(ref);
  if (!item) return;
  try {
    const ex = await withTimeout(extractItem(uid, itemId, item), EXTRACT_DEADLINE_MS, 'Timed out while extracting this item');
    const file = ex.file && !item.file ? await storeOriginal(uid, itemId, ex.file) : null;
    const chunks = await writeContent(ref, ex.html);
    const final = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = snap.data() as ItemData;
      const patch = donePatch(cur, ex, chunks, file);
      tx.update(ref, patch);
      return merged(cur, patch);
    });
    if (!final) {
      // Deleted while we were working (cleanupItem may already have run): remove what we just wrote.
      await purgeItemData(uid, itemId, { highlights: false, uploads: false });
      return;
    }
    await writeIndex(uid, itemId, final, ex.text);
    logger.info('processed', { uid, itemId, type: ex.type, words: ex.wordCount, chunks });
  } catch (e) {
    const message = errorMessage(e);
    logger.warn('processing failed', { uid, itemId, error: message });
    const final = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.update(ref, { fetchStatus: 'error', fetchError: message, updatedAt: FieldValue.serverTimestamp() });
      return { ...(snap.data() as ItemData), fetchStatus: 'error', fetchError: message };
    });
    if (final) await writeIndex(uid, itemId, final, await existingText(ref, final).catch(() => ''));
  }
}

export const processItem = onDocumentWritten({ document: ITEM_PATH, region: REGION, timeoutSeconds: 300, memory: '1GiB' }, async (event) => {
  const { uid, itemId } = event.params as { uid: string; itemId: string };
  const before = event.data?.before?.exists ? (event.data.before.data() as ItemData) : undefined;
  const after = event.data?.after?.exists ? (event.data.after.data() as ItemData) : undefined;
  const action = decideAction(before, after);
  if (action === 'process') {
    await processOne(uid, itemId);
  } else if (action === 'reindex' && after) {
    const ref = itemRef(uid, itemId);
    await writeIndex(uid, itemId, after, await existingText(ref, after));
  }
});

export const cleanupItem = onDocumentDeleted({ document: ITEM_PATH, region: REGION, timeoutSeconds: 120 }, async (event) => {
  const { uid, itemId } = event.params as { uid: string; itemId: string };
  await purgeItemData(uid, itemId, { highlights: true, uploads: true });
});
