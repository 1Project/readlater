import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type firebase from 'firebase/compat/app';
import {
  ALICE,
  BOB,
  PROJECT_ID,
  deleteField,
  newItem,
  now,
  past,
  processedItem,
  readRules,
  serverTimestamp,
  str,
  uploadFileField,
} from './helpers';

type Db = firebase.firestore.Firestore;

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readRules('firestore.rules') } });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

const db = (uid: string): Db => env.authenticatedContext(uid).firestore();
const anon = (): Db => env.unauthenticatedContext().firestore();
const alice = () => db(ALICE);
const bob = () => db(BOB);

async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(path).set(data);
  });
}

const ITEM = `users/${ALICE}/items/item1`;

// ---------------------------------------------------------------------------

describe('read access', () => {
  beforeEach(async () => {
    await seed(`users/${ALICE}`, { createdAt: now() });
    await seed(ITEM, processedItem());
    await seed(`${ITEM}/content/0`, { index: 0, html: '<p>Hello</p>' });
    await seed(`users/${ALICE}/search/item1`, { kw: ['hello'] });
    await seed(`users/${ALICE}/apiKeys/k1`, { name: 'Phone', prefix: 'rl_abc', createdAt: now(), lastUsedAt: null });
    await seed(`users/${ALICE}/highlights/h1`, { itemId: 'item1', text: 'Hello', note: '', prefix: '', suffix: '', createdAt: now(), updatedAt: now() });
    await seed(`users/${ALICE}/categories/c1`, { name: 'Work', order: 0, createdAt: now() });
    await seed(`users/${ALICE}/feeds/f1`, { url: 'https://example.com/feed.xml', title: 'Example', siteUrl: null, categoryId: null, tags: [], fullText: false, lastFetchedAt: null, lastError: null, createdAt: now() });
  });

  const paths = [
    `users/${ALICE}`,
    ITEM,
    `${ITEM}/content/0`,
    `users/${ALICE}/search/item1`,
    `users/${ALICE}/apiKeys/k1`,
    `users/${ALICE}/highlights/h1`,
    `users/${ALICE}/categories/c1`,
    `users/${ALICE}/feeds/f1`,
  ];

  for (const p of paths) {
    it(`owner can read ${p}`, async () => {
      await assertSucceeds(alice().doc(p).get());
    });
    it(`another user cannot read ${p}`, async () => {
      await assertFails(bob().doc(p).get());
    });
    it(`unauthenticated cannot read ${p}`, async () => {
      await assertFails(anon().doc(p).get());
    });
  }

  it('owner can list own collections (as data.ts subscribes)', async () => {
    for (const c of ['items', 'highlights', 'categories', 'feeds', 'apiKeys']) {
      await assertSucceeds(alice().collection(`users/${ALICE}/${c}`).orderBy('createdAt', 'desc').get());
    }
    await assertSucceeds(alice().collection(`users/${ALICE}/items`).where('url', '==', 'https://example.com/post').get());
  });

  it('another user cannot list or query someone else’s items', async () => {
    await assertFails(bob().collection(`users/${ALICE}/items`).get());
    await assertFails(bob().collection(`users/${ALICE}/items`).where('url', '==', 'https://example.com/post').get());
  });

  it('collection-group queries are denied', async () => {
    await assertFails(alice().collectionGroup('items').get());
    await assertFails(alice().collectionGroup('feeds').get());
  });

  it('the user doc itself is not client-writable', async () => {
    await assertFails(alice().doc(`users/${ALICE}`).set({ x: 1 }));
    await assertFails(alice().doc(`users/${ALICE}`).delete());
  });

  it('unknown subcollections are readable by the owner only and never writable', async () => {
    await seed(`users/${ALICE}/misc/x`, { a: 1 });
    await assertSucceeds(alice().doc(`users/${ALICE}/misc/x`).get());
    await assertFails(bob().doc(`users/${ALICE}/misc/x`).get());
    await assertFails(alice().doc(`users/${ALICE}/misc/y`).set({ a: 1 }));
  });
});

// ---------------------------------------------------------------------------

describe('items: create', () => {
  it('owner can create a link item (addUrl shape)', async () => {
    await assertSucceeds(alice().doc(ITEM).set(newItem({ tags: ['ai', 'reading'], categoryId: 'c1' })));
  });

  it('owner can create an upload item with its own upload path (uploadFile shape)', async () => {
    await assertSucceeds(
      alice().doc(ITEM).set(newItem({ url: null, type: 'pdf', title: 'paper', fetchStatus: 'uploading', file: uploadFileField(ALICE, 'item1') })),
    );
  });

  it('owner can create an EPUB upload item', async () => {
    await assertSucceeds(
      alice().doc(ITEM).set(newItem({ url: null, type: 'epub', title: 'Book', fetchStatus: 'uploading', file: uploadFileField(ALICE, 'item1', 'Book Name.epub') })),
    );
  });

  it('owner can create a feed-location item and a url-less item', async () => {
    await assertSucceeds(alice().doc(ITEM).set(newItem({ location: 'feed', feedId: 'f1' })));
    await assertSucceeds(alice().doc(`users/${ALICE}/items/item2`).set(newItem({ url: null })));
  });

  it('accepts every item type', async () => {
    let i = 0;
    for (const type of ['article', 'tweet', 'paper', 'pdf', 'epub', 'video', 'other']) {
      await assertSucceeds(alice().doc(`users/${ALICE}/items/t${i++}`).set(newItem({ type })));
    }
  });

  it('accepts boundary sizes', async () => {
    await assertSucceeds(
      alice()
        .doc(ITEM)
        .set(newItem({ url: 'https://e.com/' + str(2048 - 14), title: str(500), note: str(20000), tags: Array.from({ length: 30 }, (_, i) => `t${i}`), progress: 1 })),
    );
  });

  it('another user cannot create in my space; unauthenticated cannot create', async () => {
    await assertFails(bob().doc(ITEM).set(newItem()));
    await assertFails(anon().doc(ITEM).set(newItem()));
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['wrong type enum', { type: 'blog' }],
    ['wrong location enum', { location: 'inbox' }],
    ['wrong status enum', { status: 'read' }],
    ['fetchStatus done', { fetchStatus: 'done' }],
    ['fetchStatus processing', { fetchStatus: 'processing' }],
    ['fetchStatus error', { fetchStatus: 'error' }],
    ['contentChunks > 0', { contentChunks: 1 }],
    ['fetchError set', { fetchError: 'boom' }],
    ['paper set', { paper: { doi: '10.1/x' } }],
    ['url too long', { url: 'https://e.com/' + str(2048) }],
    ['url not a string', { url: 42 }],
    ['title too long', { title: str(501) }],
    ['title null', { title: null }],
    ['tags > 30', { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
    ['tags not a list', { tags: 'a,b' }],
    ['note too long', { note: str(20001) }],
    ['note null', { note: null }],
    ['progress > 1', { progress: 1.5 }],
    ['progress < 0', { progress: -0.1 }],
    ['favorite not bool', { favorite: 'yes' }],
    ['titleLocked not bool', { titleLocked: 1 }],
    ['createdAt not a timestamp', { createdAt: '2024-01-01' }],
    ['updatedAt missing value', { updatedAt: null }],
    ['archivedAt not a timestamp', { archivedAt: 5 }],
    ['wordCount negative', { wordCount: -1 }],
    ['categoryId not a string', { categoryId: 7 }],
    ['extra field', { owner: 'alice' }],
  ];

  for (const [name, overrides] of invalid) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(ITEM).set(newItem(overrides)));
    });
  }

  it('rejects create with a missing field', async () => {
    for (const k of ['note', 'contentChunks', 'fetchError', 'file', 'paper', 'createdAt', 'tags']) {
      const data = newItem();
      delete data[k];
      await assertFails(alice().doc(ITEM).set(data));
    }
  });

  const badFiles: [string, (uid: string) => unknown][] = [
    ['path of another item', () => uploadFileField(ALICE, 'otherItem')],
    ['path of another user', () => uploadFileField(BOB, 'item1')],
    ['server files/ path', () => ({ ...uploadFileField(ALICE, 'item1'), path: `users/${ALICE}/files/item1/original.pdf` })],
    ['nested path', () => ({ ...uploadFileField(ALICE, 'item1'), path: `users/${ALICE}/uploads/item1/sub/a.pdf` })],
    ['path with empty file name', () => ({ ...uploadFileField(ALICE, 'item1'), path: `users/${ALICE}/uploads/item1/` })],
    ['unsupported contentType', () => uploadFileField(ALICE, 'item1', 'a.pdf', { contentType: 'text/html' })],
    ['size over 100 MB', () => uploadFileField(ALICE, 'item1', 'a.pdf', { size: 100 * 1024 * 1024 + 1 })],
    ['size not a number', () => uploadFileField(ALICE, 'item1', 'a.pdf', { size: '10' })],
    ['extra key', () => uploadFileField(ALICE, 'item1', 'a.pdf', { url: 'https://x' })],
    ['missing name', () => {
      const f: Record<string, unknown> = uploadFileField(ALICE, 'item1');
      delete f.name;
      return f;
    }],
    ['not a map', () => `users/${ALICE}/uploads/item1/a.pdf`],
  ];

  for (const [name, make] of badFiles) {
    it(`rejects create with file: ${name}`, async () => {
      await assertFails(alice().doc(ITEM).set(newItem({ url: null, type: 'pdf', fetchStatus: 'uploading', file: make(ALICE) })));
    });
  }
});

// ---------------------------------------------------------------------------

describe('items: update', () => {
  beforeEach(async () => {
    await seed(ITEM, processedItem());
  });

  const upd = (data: Record<string, unknown>, d: Db = alice()) => d.doc(ITEM).update(data);

  it('saves progress on a server-processed item (long server title untouched)', async () => {
    await assertSucceeds(upd({ progress: 0.42, updatedAt: serverTimestamp() }));
    await assertSucceeds(upd({ progress: 1 }));
    await assertSucceeds(upd({ progress: 0 }));
  });

  it('allows the updateItem() fields', async () => {
    await assertSucceeds(upd({ status: 'archived', archivedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertSucceeds(upd({ status: 'unread', archivedAt: null, updatedAt: serverTimestamp() }));
    await assertSucceeds(upd({ title: 'My title', titleLocked: true }));
    await assertSucceeds(upd({ favorite: true }));
    await assertSucceeds(upd({ location: 'feed' }));
    await assertSucceeds(upd({ location: 'library' }));
    await assertSucceeds(upd({ categoryId: 'c1' }));
    await assertSucceeds(upd({ categoryId: null }));
    await assertSucceeds(upd({ tags: ['a', 'b'] }));
    await assertSucceeds(upd({ note: 'my note' }));
    await assertSucceeds(upd({ type: 'paper' }));
    await assertSucceeds(upd({ lastOpenedAt: serverTimestamp() }));
  });

  it('allows the addUrl() re-save patch', async () => {
    await assertSucceeds(upd({ location: 'library', status: 'unread', updatedAt: serverTimestamp(), tags: ['x'], categoryId: null }));
  });

  it('allows a batched bulk update and tag rename', async () => {
    await seed(`users/${ALICE}/items/item2`, processedItem());
    const d = alice();
    const b = d.batch();
    b.update(d.doc(ITEM), { status: 'archived', archivedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.update(d.doc(`users/${ALICE}/items/item2`), { tags: ['renamed'], updatedAt: serverTimestamp() });
    await assertSucceeds(b.commit());
  });

  it('allows other spec client-writable metadata', async () => {
    await assertSucceeds(upd({ author: 'Me', siteName: null, excerpt: 'x', imageUrl: null, publishedAt: now(), wordCount: 10, readingMinutes: 1 }));
    await assertSucceeds(upd({ url: 'https://example.com/other' }));
  });

  const forbidden: [string, Record<string, unknown>][] = [
    ['contentChunks', { contentChunks: 5 }],
    ['contentChunks reset', { contentChunks: 0 }],
    ['fetchError set', { fetchError: 'nope' }],
    ['paper', { paper: null }],
    ['file on a processed item', { file: uploadFileField(ALICE, 'item1') }],
    ['createdAt', { createdAt: past() }],
    ['unknown field', { hacked: true }],
    ['removing a field', { note: deleteField() }],
    ['progress > 1', { progress: 2 }],
    ['progress negative', { progress: -1 }],
    ['progress not a number', { progress: '0.5' }],
    ['status enum', { status: 'deleted' }],
    ['location enum', { location: 'trash' }],
    ['type enum', { type: 'podcast' }],
    ['tags > 30', { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
    ['title too long', { title: str(501) }],
    ['note too long', { note: str(20001) }],
    ['url too long', { url: 'https://e.com/' + str(2048) }],
    ['favorite not bool', { favorite: 1 }],
    ['updatedAt not a timestamp', { updatedAt: 'now' }],
  ];

  for (const [name, data] of forbidden) {
    it(`rejects update: ${name}`, async () => {
      await assertFails(upd(data));
    });
  }

  it('another user / unauthenticated cannot update', async () => {
    await assertFails(upd({ progress: 0.5 }, bob()));
    await assertFails(upd({ progress: 0.5 }, anon()));
  });

  it('owner can delete; others cannot', async () => {
    await assertFails(bob().doc(ITEM).delete());
    await assertFails(anon().doc(ITEM).delete());
    await assertSucceeds(alice().doc(ITEM).delete());
  });
});

describe('items: fetchStatus transitions', () => {
  for (const from of ['done', 'error', 'processing', 'uploading', 'pending']) {
    it(`${from} -> pending is allowed (refetchItem shape)`, async () => {
      await seed(ITEM, processedItem({ fetchStatus: from, fetchError: from === 'error' ? 'Timed out' : null }));
      await assertSucceeds(alice().doc(ITEM).update({ fetchStatus: 'pending', fetchError: null, updatedAt: serverTimestamp() }));
    });
  }

  for (const to of ['done', 'processing', 'error', 'uploading']) {
    it(`client cannot set fetchStatus to ${to}`, async () => {
      await seed(ITEM, processedItem({ fetchStatus: to === 'done' ? 'pending' : 'done' }));
      await assertFails(alice().doc(ITEM).update({ fetchStatus: to }));
    });
  }

  it('processing with a live run (processingAt < 10 min ago) cannot be queued again; a stale one can', async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await seed(ITEM, processedItem({ fetchStatus: 'processing', processingAt: minutesAgo(2), processingRun: 'r1' }));
    await assertFails(alice().doc(ITEM).update({ fetchStatus: 'pending', fetchError: null, updatedAt: serverTimestamp() }));
    // Other edits still work while it is processing.
    await assertSucceeds(alice().doc(ITEM).update({ favorite: true }));
    await seed(ITEM, processedItem({ fetchStatus: 'processing', processingAt: minutesAgo(11), processingRun: 'r1' }));
    await assertSucceeds(alice().doc(ITEM).update({ fetchStatus: 'pending', fetchError: null, updatedAt: serverTimestamp() }));
  });

  it('client cannot write the run bookkeeping fields', async () => {
    await seed(ITEM, processedItem({ fetchStatus: 'error', fetchError: 'Waiting', retryAt: new Date() }));
    for (const field of ['processingAt', 'processingRun', 'processAttempts', 'retryAt']) {
      await assertFails(alice().doc(ITEM).update({ [field]: field === 'processAttempts' ? 0 : field === 'processingRun' ? 'x' : new Date() }));
    }
    await assertFails(alice().doc(ITEM).update({ retryAt: deleteField() }));
  });

  it('client cannot replace an error message, only clear it', async () => {
    await seed(ITEM, processedItem({ fetchStatus: 'error', fetchError: 'Timed out' }));
    await assertFails(alice().doc(ITEM).update({ fetchError: 'Fine actually' }));
    await assertSucceeds(alice().doc(ITEM).update({ fetchError: null }));
  });

  it('upload flow: uploading -> pending; file may change only while uploading', async () => {
    const created = newItem({ url: null, type: 'pdf', fetchStatus: 'uploading', file: uploadFileField(ALICE, 'item1') });
    await assertSucceeds(alice().doc(ITEM).set(created));
    await assertSucceeds(alice().doc(ITEM).update({ file: uploadFileField(ALICE, 'item1', 'renamed.pdf') }));
    await assertFails(alice().doc(ITEM).update({ file: uploadFileField(ALICE, 'otherItem') }));
    await assertFails(alice().doc(ITEM).update({ file: uploadFileField(BOB, 'item1') }));
    await assertSucceeds(alice().doc(ITEM).update({ fetchStatus: 'pending', updatedAt: serverTimestamp() }));
    await assertFails(alice().doc(ITEM).update({ file: uploadFileField(ALICE, 'item1', 'again.pdf') }));
    await assertFails(alice().doc(ITEM).update({ file: null }));
  });
});

// ---------------------------------------------------------------------------

describe('highlights', () => {
  const H = `users/${ALICE}/highlights/h1`;
  const valid = (o: Record<string, unknown> = {}) => ({
    itemId: 'item1',
    text: 'Highlighted text',
    prefix: 'before ',
    suffix: ' after',
    note: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...o,
  });

  it('owner can create (addHighlight shape), update note, and delete', async () => {
    await assertSucceeds(alice().doc(H).set(valid()));
    await assertSucceeds(alice().doc(H).update({ note: 'my thought', updatedAt: serverTimestamp() }));
    await assertSucceeds(alice().doc(H).delete());
  });

  it('accepts boundary sizes', async () => {
    await assertSucceeds(alice().doc(H).set(valid({ text: str(5000), note: str(5000), prefix: str(64), suffix: str(64) })));
  });

  it('accepts every highlight colour on create and update (color is optional)', async () => {
    let i = 0;
    for (const color of ['yellow', 'green', 'blue', 'pink']) {
      await assertSucceeds(alice().doc(`users/${ALICE}/highlights/c${i++}`).set(valid({ color })));
    }
    await assertSucceeds(alice().doc(H).set(valid()));
    await assertSucceeds(alice().doc(H).update({ color: 'green', updatedAt: serverTimestamp() }));
    await assertSucceeds(alice().doc(H).update({ color: 'pink' }));
    await assertFails(alice().doc(H).update({ color: 'purple' }));
    await assertSucceeds(alice().doc(H).update({ color: deleteField() }));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['empty text', { text: '' }],
    ['text too long', { text: str(5001) }],
    ['note too long', { note: str(5001) }],
    ['prefix too long', { prefix: str(65) }],
    ['suffix too long', { suffix: str(65) }],
    ['itemId not a string', { itemId: 1 }],
    ['itemId empty', { itemId: '' }],
    ['extra field', { colour: 'yellow' }],
    ['color outside the palette', { color: 'red' }],
    ['color not a string', { color: 1 }],
    ['color null', { color: null }],
    ['createdAt not a timestamp', { createdAt: 1 }],
  ];
  for (const [name, o] of bad) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(H).set(valid(o)));
    });
  }

  it('rejects create with a missing field', async () => {
    const d: Record<string, unknown> = valid();
    delete d.note;
    await assertFails(alice().doc(H).set(d));
  });

  it('rejects updates to itemId / createdAt and invalid notes', async () => {
    await seed(H, { ...valid(), createdAt: now(), updatedAt: now() });
    await assertFails(alice().doc(H).update({ itemId: 'item2' }));
    await assertFails(alice().doc(H).update({ createdAt: past() }));
    await assertFails(alice().doc(H).update({ note: str(5001) }));
    await assertFails(alice().doc(H).update({ extra: true }));
  });

  it('other users / unauthenticated cannot create, update or delete', async () => {
    await assertFails(bob().doc(H).set(valid()));
    await assertFails(anon().doc(H).set(valid()));
    await seed(H, { ...valid(), createdAt: now(), updatedAt: now() });
    await assertFails(bob().doc(H).update({ note: 'x' }));
    await assertFails(bob().doc(H).delete());
    await assertFails(anon().doc(H).delete());
  });
});

// ---------------------------------------------------------------------------

describe('categories', () => {
  const C = `users/${ALICE}/categories/c1`;

  it('owner can create (createCategory shape), rename, reorder, delete', async () => {
    await assertSucceeds(alice().doc(C).set({ name: 'Work', order: Date.now(), createdAt: serverTimestamp() }));
    await assertSucceeds(alice().doc(C).update({ name: str(60) }));
    await assertSucceeds(alice().doc(C).update({ order: 3 }));
    await assertSucceeds(alice().doc(C).delete());
  });

  it('owner can create via addDoc', async () => {
    await assertSucceeds(alice().collection(`users/${ALICE}/categories`).add({ name: 'Reading', order: 1, createdAt: serverTimestamp() }));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['empty name', { name: '', order: 0, createdAt: serverTimestamp() }],
    ['name too long', { name: str(61), order: 0, createdAt: serverTimestamp() }],
    ['order not a number', { name: 'X', order: '1', createdAt: serverTimestamp() }],
    ['missing order', { name: 'X', createdAt: serverTimestamp() }],
    ['extra field', { name: 'X', order: 0, createdAt: serverTimestamp(), color: 'red' }],
  ];
  for (const [name, data] of bad) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(C).set(data));
    });
  }

  it('rejects invalid updates and foreign access', async () => {
    await seed(C, { name: 'Work', order: 0, createdAt: now() });
    await assertFails(alice().doc(C).update({ name: '' }));
    await assertFails(alice().doc(C).update({ createdAt: past() }));
    await assertFails(alice().doc(C).update({ order: deleteField() }));
    await assertFails(bob().doc(C).update({ name: 'Mine' }));
    await assertFails(bob().doc(C).delete());
    await assertFails(bob().doc(`users/${ALICE}/categories/c2`).set({ name: 'X', order: 0, createdAt: serverTimestamp() }));
    await assertFails(anon().doc(C).delete());
  });
});

// ---------------------------------------------------------------------------

describe('feeds', () => {
  const F = `users/${ALICE}/feeds/f1`;
  const feed = () => ({
    url: 'https://example.com/feed.xml',
    title: 'Example',
    siteUrl: 'https://example.com',
    categoryId: null,
    tags: [],
    fullText: false,
    lastFetchedAt: now(),
    lastError: null,
    createdAt: now(),
    etag: '"abc"',
  });

  it('clients cannot create feeds (addFeed callable does)', async () => {
    await assertFails(alice().doc(F).set(feed()));
    await assertFails(alice().collection(`users/${ALICE}/feeds`).add(feed()));
  });

  it('owner can update title, categoryId, tags, fullText (updateFeed shape)', async () => {
    await seed(F, feed());
    await assertSucceeds(alice().doc(F).update({ title: 'Renamed' }));
    await assertSucceeds(alice().doc(F).update({ categoryId: 'c1', tags: ['news'], fullText: true }));
    await assertSucceeds(alice().doc(F).update({ categoryId: null }));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['url', { url: 'https://evil.example/feed' }],
    ['lastError', { lastError: null, title: 'x' }],
    ['lastFetchedAt', { lastFetchedAt: now() }],
    ['etag', { etag: 'x' }],
    ['createdAt', { createdAt: past() }],
    ['fullText not bool', { fullText: 'yes' }],
    ['tags > 30', { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
    ['title too long', { title: str(501) }],
    ['categoryId not a string', { categoryId: 5 }],
  ];
  for (const [name, data] of bad) {
    it(`rejects update: ${name}`, async () => {
      await seed(F, { ...feed(), lastError: 'old error' });
      await assertFails(alice().doc(F).update(data));
    });
  }

  it('owner can delete; others cannot update or delete', async () => {
    await seed(F, feed());
    await assertFails(bob().doc(F).update({ title: 'x' }));
    await assertFails(bob().doc(F).delete());
    await assertFails(anon().doc(F).delete());
    await assertSucceeds(alice().doc(F).delete());
  });
});

// ---------------------------------------------------------------------------

describe('server-only data', () => {
  beforeEach(async () => {
    await seed(ITEM, processedItem());
    await seed(`${ITEM}/content/0`, { index: 0, html: '<p>Hi</p>' });
    await seed(`users/${ALICE}/search/item1`, { kw: ['hi'] });
    await seed(`users/${ALICE}/apiKeys/k1`, { name: 'Phone', prefix: 'rl_abc', createdAt: now(), lastUsedAt: null });
  });

  it('owner cannot write content chunks', async () => {
    await assertFails(alice().doc(`${ITEM}/content/0`).set({ index: 0, html: '<script>x</script>' }));
    await assertFails(alice().doc(`${ITEM}/content/1`).set({ index: 1, html: '<p>x</p>' }));
    await assertFails(alice().doc(`${ITEM}/content/0`).delete());
  });

  it('owner cannot write the search index', async () => {
    await assertFails(alice().doc(`users/${ALICE}/search/item1`).set({ kw: ['x'] }));
    await assertFails(alice().doc(`users/${ALICE}/search/item1`).delete());
  });

  it('owner cannot create or delete API key mirrors', async () => {
    await assertFails(alice().doc(`users/${ALICE}/apiKeys/k2`).set({ name: 'x', prefix: 'rl_xyz', createdAt: serverTimestamp(), lastUsedAt: null }));
    await assertFails(alice().doc(`users/${ALICE}/apiKeys/k1`).update({ name: 'renamed' }));
    await assertFails(alice().doc(`users/${ALICE}/apiKeys/k1`).delete());
  });

  for (const col of ['loginCodes', 'apiKeys', 'rateLimits']) {
    it(`top-level ${col} is inaccessible to clients`, async () => {
      await seed(`${col}/abc`, { uid: ALICE, createdAt: now() });
      await assertFails(alice().doc(`${col}/abc`).get());
      await assertFails(alice().collection(col).get());
      await assertFails(alice().doc(`${col}/abc`).set({ uid: ALICE }));
      await assertFails(alice().doc(`${col}/new`).set({ uid: ALICE }));
      await assertFails(alice().doc(`${col}/abc`).delete());
      await assertFails(anon().doc(`${col}/abc`).get());
    });
  }

  it('arbitrary top-level paths are denied', async () => {
    await assertFails(alice().doc('public/x').get());
    await assertFails(alice().doc('public/x').set({ a: 1 }));
  });
});
