/**
 * EPUB export against the Firestore + Storage emulators:
 *   firebase emulators:exec --only firestore,storage --project demo-readlater 'npx vitest run test/exportEpub.storage.test.ts'
 * Skipped unless both FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST are set.
 */
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
if (EMU) {
  process.env.GCLOUD_PROJECT ??= 'demo-readlater';
  process.env.FIREBASE_CONFIG ??= JSON.stringify({ projectId: process.env.GCLOUD_PROJECT, storageBucket: `${process.env.GCLOUD_PROJECT}.appspot.com` });
}

type Mods = {
  admin: typeof import('../src/admin');
  epub: typeof import('../src/exportEpub');
  extract: typeof import('../src/extract');
  util: typeof import('../src/util');
};
let m: Mods;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!EMU)('exportEpub against the emulators', () => {
  const uid = `ep_${Date.now()}`;
  const user = () => m.admin.db.collection('users').doc(uid);

  beforeAll(async () => {
    m = { admin: await import('../src/admin'), epub: await import('../src/exportEpub'), extract: await import('../src/extract'), util: await import('../src/util') };
    const bucket = m.admin.bucket();
    // An image the user owns in Storage (as written for EPUB uploads), referenced by its download URL.
    const imgPath = `users/${uid}/files/b1/cover.png`;
    await bucket.file(imgPath).save(PNG, { contentType: 'image/png', metadata: { metadata: { firebaseStorageDownloadTokens: 'tok' } } });
    const ownUrl = m.util.storageDownloadUrl(bucket.name, imgPath, 'tok');
    // Someone else's object: must not be embedded even though the URL is well-formed.
    const foreignPath = `users/other/files/x/secret.png`;
    await bucket.file(foreignPath).save(PNG, { contentType: 'image/png', metadata: { metadata: { firebaseStorageDownloadTokens: 'tok2' } } });
    const foreignUrl = m.util.storageDownloadUrl(bucket.name, foreignPath, 'tok2');

    const items = user().collection('items');
    await items.doc('a').set({ title: 'Article A', author: 'Ann', siteName: 'Example', url: 'https://example.com/a', contentChunks: 1 });
    await items
      .doc('a')
      .collection('content')
      .doc('0')
      .set({ index: 0, html: `<p>Alpha text.</p><p><img src="${ownUrl}" alt="own"></p><p><img src="${foreignUrl}"></p><p><img src="http://127.0.0.1:1/x.png"></p>` });
    await items.doc('b').set({ title: 'Note B', author: null, siteName: null, url: null, contentChunks: 0 });
    await user().collection('highlights').doc('h1').set({ itemId: 'a', text: 'Alpha text.', note: 'remember', createdAt: new Date() });
  });

  it('builds, uploads and serves a book of the requested items', async () => {
    const res = await m.epub.exportEpubForUser(uid, ['b', 'missing', 'a']);
    expect(res.name).toMatch(/^readlater-\d{4}-\d{2}-\d{2}\.epub$/);
    const u = new URL(res.url);
    const path = decodeURIComponent(u.pathname.split('/o/')[1]);
    expect(path).toMatch(new RegExp(`^users/${uid}/exports/[A-Za-z0-9]{20}\\.epub$`));
    expect(u.searchParams.get('token')).toMatch(/^[0-9a-f-]{36}$/);

    const file = m.admin.bucket().file(path);
    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe('application/epub+zip');
    expect(meta.contentDisposition).toBe(`attachment; filename="${res.name}"`);
    const [buf] = await file.download();

    const zip = await JSZip.loadAsync(buf);
    const images = Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/images/') && !zip.files[n].dir);
    expect(images).toEqual(['OEBPS/images/img-001.png']);
    const chap1 = await zip.file('OEBPS/chap-001.xhtml')!.async('string');
    const chap2 = await zip.file('OEBPS/chap-002.xhtml')!.async('string');
    expect(chap1).toContain('<h1>Note B</h1>');
    expect(chap1).toContain('This document has no saved text.');
    expect(chap2).toContain('<img src="images/img-001.png" alt="own" />');
    expect(chap2.match(/<img /g)).toHaveLength(1);
    expect(chap2).toContain('<p class="note">remember</p>');

    const ex = await m.extract.extractEpub(buf, { uploadImage: async (name) => `https://x/${name}` });
    expect(ex.title).toBe('Readlater — 2 documents (' + res.name.slice(10, 20) + ')');
    expect(ex.text).toContain('Alpha text.');
    expect(ex.html.match(/<section data-chapter=/g)).toHaveLength(2);
  });

  it('a single item is named after its title', async () => {
    const res = await m.epub.exportEpubForUser(uid, ['a']);
    expect(res.name).toBe('Article_A.epub');
  });

  it('errors when none of the items exist; the callable validates input and auth', async () => {
    await expect(m.epub.exportEpubForUser(uid, ['nope'])).rejects.toMatchObject({ code: 'not-found' });
    const run = (m.epub.exportEpub as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    await expect(run({ auth: null, data: { itemIds: ['a'] } })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(run({ auth: { uid }, data: { itemIds: [] } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ auth: { uid }, data: { itemIds: ['a'] } })).resolves.toMatchObject({ name: 'Article_A.epub' });
  });
});
