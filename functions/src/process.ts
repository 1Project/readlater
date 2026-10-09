/**
 * processItem: extract content for pending items; cleanupItem: remove derived data when an item is deleted
 * (and remember deleted feed entries, so a refresh does not bring them back); sweepItems: every 10 minutes,
 * queue again items whose run died (stuck in 'processing') and rate-limited items whose wait is over.
 */
import './options';
import { randomUUID } from 'node:crypto';
import type { DocumentReference } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { bucket, db, REGION } from './admin';
import { readContent, writeContent } from './content';
import { extractEpub, extractHtml, extractPdf, extractUrl } from './extract';
import type { Extracted, UploadImage } from './extract/types';
import { feedSeenRef, seenDoc } from './feeds/seen';
import {
  decideAction,
  donePatch,
  endRunFields,
  errorMessage,
  fileKind,
  itemKeywords,
  merged,
  PROCESS_PER_HOUR,
  PROCESSING_STALE_MS,
  RATE_LIMITED_MESSAGE,
  retryPatch,
  stalePatch,
  type ItemData,
  type StoredFile,
} from './processLogic';
import { HOUR, hit } from './rateLimit';
import { loadRules, ruleContext, rulesPatch, wantsRules, type Rule, type RuleContext } from './rules';
import { htmlToPlainText } from './searchIndex';
import { safeFileName, storageDownloadUrl, withTimeout } from './util';

const ITEM_PATH = 'users/{uid}/items/{itemId}';
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Rendered page HTML captured by the browser extension (POST /api/save `html`, ≤ 5 MB; some slack here). */
const MAX_PAGE_HTML_BYTES = 10 * 1024 * 1024;
/** Leaves time (of the 300 s timeout) to store a large PDF and write the content after extraction. */
const EXTRACT_DEADLINE_MS = 240_000;

const itemRef = (uid: string, itemId: string) => db.collection('users').doc(uid).collection('items').doc(itemId);
const searchRef = (uid: string, itemId: string) => db.collection('users').doc(uid).collection('search').doc(itemId);
const filesPrefix = (uid: string, itemId: string) => `users/${uid}/files/${itemId}/`;

/**
 * Atomically move pending → processing, stamped with this run's id and start time. Returns the item data, or
 * null if someone else got it first.
 */
async function claim(ref: DocumentReference, run: string): Promise<ItemData | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('fetchStatus') !== 'pending') return null;
    tx.update(ref, {
      fetchStatus: 'processing',
      fetchError: null,
      processingAt: FieldValue.serverTimestamp(),
      processingRun: run,
      retryAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return snap.data() as ItemData;
  });
}

/** Over the per-user processing limit: park the item as a soft error that sweepItems queues again later. */
async function defer(ref: DocumentReference, retryAfterMs: number): Promise<void> {
  // Spread the retries over a few minutes after the window resets.
  const retryAt = Timestamp.fromMillis(Date.now() + retryAfterMs + Math.floor(Math.random() * 10 * 60_000));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('fetchStatus') !== 'pending') return;
    tx.update(ref, { fetchStatus: 'error', fetchError: RATE_LIMITED_MESSAGE, retryAt, updatedAt: FieldValue.serverTimestamp() });
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

/** The stored file is a captured web page (text/html), not a PDF/EPUB. */
function isPageHtml(file: StoredFile): boolean {
  return /^text\/html\b/i.test(file.contentType || '') || /\.html?$/i.test(file.name || '');
}

async function extractItem(uid: string, itemId: string, item: ItemData): Promise<Extracted> {
  const uploadImage = imageUploader(uid, itemId);
  const file = item.file as StoredFile | null | undefined;
  if (file?.path) {
    const f = bucket().file(file.path);
    const [exists] = await f.exists();
    if (!exists) throw new Error('The uploaded file could not be found. Please upload it again.');
    const [meta] = await f.getMetadata();
    if (isPageHtml(file)) {
      // A page captured in the user's browser: extract it with the page URL as base, without fetching the page.
      if (Number(meta.size ?? 0) > MAX_PAGE_HTML_BYTES) throw new Error('The saved page is larger than 10 MB');
      if (typeof item.url !== 'string' || !item.url) throw new Error('The saved page has no URL');
      const [buf] = await f.download();
      return extractHtml(buf.toString('utf8'), item.url, { uploadImage });
    }
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

/**
 * Write the search doc from the item as it is now (read in the same transaction), so concurrent edits cannot
 * leave an older index behind, and a deleted item never gets its search doc back.
 */
async function writeIndex(uid: string, itemId: string, bodyText: string): Promise<void> {
  const ref = itemRef(uid, itemId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.set(searchRef(uid, itemId), { kw: itemKeywords(snap.data() as ItemData, bodyText) });
  });
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

/** Rules to apply after this first processing of a new item (null: not new, or the rules could not be read). */
async function rulesFor(uid: string, item: ItemData): Promise<{ rules: Rule[]; ctx: RuleContext } | null> {
  if (!wantsRules(item)) return null;
  try {
    const rules = await loadRules(uid);
    return { rules, ctx: await ruleContext(uid, rules, item) };
  } catch (e) {
    logger.warn('loading rules failed', { uid, error: (e as Error).message });
    return null;
  }
}

/** Patch + the rules' changes (evaluated on the item as it will be) and the rulesApplied flag. */
function withRulesPatch(cur: ItemData, patch: ItemData, r: { rules: Rule[]; ctx: RuleContext } | null): ItemData {
  if (!r || cur.rulesApplied === true) return patch;
  return { ...patch, ...rulesPatch(r.rules, merged(cur, patch), r.ctx), rulesApplied: true };
}

async function processOne(uid: string, itemId: string): Promise<void> {
  const ref = itemRef(uid, itemId);
  const limit = await hit(`process:${uid}`, PROCESS_PER_HOUR, HOUR);
  if (!limit.allowed) {
    await defer(ref, limit.retryAfterMs);
    return;
  }
  const run = randomUUID();
  const item = await claim(ref, run);
  if (!item) return;
  /** Final writes happen only while this run still owns the item (it may have been queued again meanwhile). */
  const owns = (cur: ItemData) => cur.fetchStatus === 'processing' && cur.processingRun === run;
  const rules = await rulesFor(uid, item);
  try {
    const ex = await withTimeout(extractItem(uid, itemId, item), EXTRACT_DEADLINE_MS, 'Timed out while extracting this item');
    // A captured page that turned out to be a PDF/EPUB viewer: the downloaded original replaces page.html.
    const stored = item.file as StoredFile | null | undefined;
    const file = ex.file && (!stored || isPageHtml(stored)) ? await storeOriginal(uid, itemId, ex.file) : null;
    const chunks = await writeContent(ref, ex.html);
    const final = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return 'deleted' as const;
      const cur = snap.data() as ItemData;
      if (!owns(cur)) return 'superseded' as const;
      const patch = withRulesPatch(cur, donePatch(cur, ex, chunks, file), rules);
      tx.update(ref, patch);
      return merged(cur, patch);
    });
    if (final === 'deleted') {
      // Deleted while we were working (cleanupItem may already have run): remove what we just wrote.
      await purgeItemData(uid, itemId, { highlights: false, uploads: false });
      return;
    }
    if (final === 'superseded') {
      logger.warn('run superseded, result dropped', { uid, itemId });
      return;
    }
    await writeIndex(uid, itemId, ex.text);
    logger.info('processed', { uid, itemId, type: ex.type, words: ex.wordCount, chunks });
  } catch (e) {
    const message = errorMessage(e);
    logger.warn('processing failed', { uid, itemId, error: message });
    const final = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = snap.data() as ItemData;
      if (!owns(cur)) return null;
      const patch = withRulesPatch(
        cur,
        { fetchStatus: 'error', fetchError: message, processAttempts: FieldValue.delete(), ...endRunFields(), updatedAt: FieldValue.serverTimestamp() },
        rules,
      );
      tx.update(ref, patch);
      return merged(cur, patch);
    });
    if (final) await writeIndex(uid, itemId, await existingText(ref, final).catch(() => ''));
  }
}

/**
 * Extraction is memory hungry (jsdom, PDFs): a few runs per instance, more instances than the global default,
 * so one user's import cannot occupy every slot (processOne also limits each user to PROCESS_PER_HOUR).
 */
export const processItem = onDocumentWritten({ document: ITEM_PATH, region: REGION, timeoutSeconds: 300, memory: '2GiB', cpu: 1, concurrency: 4, maxInstances: 20 }, async (event) => {
  const { uid, itemId } = event.params as { uid: string; itemId: string };
  const before = event.data?.before?.exists ? (event.data.before.data() as ItemData) : undefined;
  const after = event.data?.after?.exists ? (event.data.after.data() as ItemData) : undefined;
  const action = decideAction(before, after);
  if (action === 'process') {
    await processOne(uid, itemId);
  } else if (action === 'reindex' && after) {
    // writeIndex reads the item again, so the latest of several quick edits wins.
    await writeIndex(uid, itemId, await existingText(itemRef(uid, itemId), after));
  }
});

export const cleanupItem = onDocumentDeleted({ document: ITEM_PATH, region: REGION, timeoutSeconds: 120 }, async (event) => {
  const { uid, itemId } = event.params as { uid: string; itemId: string };
  const feedId = event.data?.get('feedId');
  if (typeof feedId === 'string' && feedId) {
    // A deleted feed entry must not come back with the next refresh while it is still in the feed.
    await feedSeenRef(uid, itemId)
      .set(seenDoc(feedId))
      .catch((e: unknown) => logger.warn('feedSeen write failed', { uid, itemId, error: String(e) }));
  }
  await purgeItemData(uid, itemId, { highlights: true, uploads: true });
});

/** Items handled per sweep and kind (the sweep runs every 10 minutes). */
const SWEEP_LIMIT = 300;

export const sweepItems = onSchedule({ schedule: 'every 10 minutes', region: REGION, timeoutSeconds: 300, memory: '512MiB' }, async () => {
  const now = Date.now();
  const stale = await db
    .collectionGroup('items')
    .where('processingAt', '<', Timestamp.fromMillis(now - PROCESSING_STALE_MS))
    .limit(SWEEP_LIMIT)
    .get();
  const due = await db.collectionGroup('items').where('retryAt', '<=', Timestamp.fromMillis(now)).limit(SWEEP_LIMIT).get();
  let requeued = 0;
  let failed = 0;
  const apply = async (ref: DocumentReference, decide: (cur: ItemData) => ItemData | null) => {
    try {
      const patch = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const p = snap.exists ? decide(snap.data() as ItemData) : null;
        if (p) tx.update(ref, p);
        return p;
      });
      if (patch?.fetchStatus === 'pending') requeued++;
      else if (patch) failed++;
    } catch (e) {
      logger.warn('sweep failed for an item', { path: ref.path, error: (e as Error).message });
    }
  };
  for (const d of stale.docs) await apply(d.ref, (cur) => stalePatch(cur, Date.now()));
  for (const d of due.docs) await apply(d.ref, (cur) => retryPatch(cur, Date.now()));
  if (stale.size || due.size) logger.info('sweepItems', { stale: stale.size, due: due.size, requeued, failed });
});
