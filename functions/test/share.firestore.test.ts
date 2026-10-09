/**
 * Share links against the Firestore emulator:
 *   firebase emulators:exec --only firestore --project demo-readlater 'npx vitest run test/share.firestore.test.ts'
 * Skipped without FIRESTORE_EMULATOR_HOST.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
if (EMU) process.env.GCLOUD_PROJECT ??= 'demo-readlater';

type Mods = { admin: typeof import('../src/admin'); shares: typeof import('../src/shares') };
let m: Mods;

describe.skipIf(!EMU)('shares against the Firestore emulator', () => {
  const uid = `sh_${Date.now()}`;
  const user = () => m.admin.db.collection('users').doc(uid);
  const item = (id: string) => user().collection('items').doc(id);

  beforeAll(async () => {
    process.env.PUBLIC_URL = 'https://read.example.org';
    m = { admin: await import('../src/admin'), shares: await import('../src/shares') };
    await item('a').set({ title: 'Shared article', author: 'Ann', siteName: 'Example', url: 'https://example.com/a', contentChunks: 2, note: 'private note' });
    await item('a').collection('content').doc('0').set({ index: 0, html: '<p>First part. ' });
    await item('a').collection('content').doc('1').set({ index: 1, html: 'Second part.</p><p>Closing words.</p>' });
    await user().collection('highlights').doc('h2').set({ itemId: 'a', text: 'Closing words.', note: '', createdAt: new Date(2000) });
    await user().collection('highlights').doc('h1').set({ itemId: 'a', text: 'First part.', note: 'my note', createdAt: new Date(3000) });
    await user().collection('highlights').doc('hx').set({ itemId: 'other', text: 'Elsewhere', note: '', createdAt: new Date(1000) });
    await item('blank').set({ title: 'No content', contentChunks: 0 });
  });

  it('creates a snapshot with concatenated content and ordered highlights, and marks the item', async () => {
    const { token, url } = await m.shares.createShareForUser(uid, 'a', true);
    expect(token).toMatch(m.shares.SHARE_TOKEN_RE);
    expect(url).toBe(`https://read.example.org/s/${token}`);
    const share = (await m.admin.db.collection('shares').doc(token).get()).data()!;
    expect(share).toMatchObject({
      owner: m.shares.shareOwner(uid, 'a'),
      title: 'Shared article',
      author: 'Ann',
      siteName: 'Example',
      url: 'https://example.com/a',
      html: '<p>First part. Second part.</p><p>Closing words.</p>',
      highlights: [
        { text: 'First part.', note: 'my note' },
        { text: 'Closing words.', note: '' },
      ],
    });
    expect(share.createdAt.toMillis()).toBeGreaterThan(0);
    expect(share).not.toHaveProperty('note');
    // Public readers learn nothing about the owner's account or item ids.
    expect(share).not.toHaveProperty('uid');
    expect(share).not.toHaveProperty('itemId');
    expect(JSON.stringify(share)).not.toContain(uid);
    expect((await item('a').get()).get('shareToken')).toBe(token);
  });

  it('sharing again keeps the token and refreshes the snapshot', async () => {
    const token = (await item('a').get()).get('shareToken') as string;
    const before = (await m.admin.db.collection('shares').doc(token).get()).get('createdAt');
    await item('a').update({ title: 'Renamed' });
    const again = await m.shares.createShareForUser(uid, 'a', false);
    expect(again.token).toBe(token);
    const share = (await m.admin.db.collection('shares').doc(token).get()).data()!;
    expect(share.title).toBe('Renamed');
    expect(share.highlights).toEqual([]);
    expect(share.createdAt.isEqual(before)).toBe(true);
  });

  it('a stale shareToken (snapshot gone) gets a new token', async () => {
    const token = (await item('a').get()).get('shareToken') as string;
    await m.admin.db.collection('shares').doc(token).delete();
    const fresh = await m.shares.createShareForUser(uid, 'a', false);
    expect(fresh.token).not.toBe(token);
    expect((await item('a').get()).get('shareToken')).toBe(fresh.token);
  });

  it('refuses items without content and missing items', async () => {
    await expect(m.shares.createShareForUser(uid, 'blank', false)).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(m.shares.createShareForUser(uid, 'missing', false)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('only the owner can revoke; revoking deletes the snapshot and clears shareToken', async () => {
    const token = (await item('a').get()).get('shareToken') as string;
    await expect(m.shares.revokeShareForUser('someone-else', token)).rejects.toMatchObject({ code: 'not-found' });
    expect((await m.admin.db.collection('shares').doc(token).get()).exists).toBe(true);
    await m.shares.revokeShareForUser(uid, token);
    expect((await m.admin.db.collection('shares').doc(token).get()).exists).toBe(false);
    expect((await item('a').get()).data()).not.toHaveProperty('shareToken');
    await expect(m.shares.revokeShareForUser(uid, token)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('snapshots made before owner hashing (plain uid / itemId) can still be revoked and are migrated on refresh', async () => {
    const { token } = await m.shares.createShareForUser(uid, 'a', false);
    const ref = m.admin.db.collection('shares').doc(token);
    await ref.update({ owner: FieldValue.delete(), uid, itemId: 'a' });
    expect((await m.shares.createShareForUser(uid, 'a', false)).token).toBe(token);
    expect((await ref.get()).data()).toMatchObject({ owner: m.shares.shareOwner(uid, 'a') });
    expect((await ref.get()).data()).not.toHaveProperty('uid');
    await ref.update({ owner: FieldValue.delete(), uid, itemId: 'a' });
    await expect(m.shares.revokeShareForUser('someone-else', token)).rejects.toMatchObject({ code: 'not-found' });
    await m.shares.revokeShareForUser(uid, token);
    expect((await ref.get()).exists).toBe(false);
    expect((await item('a').get()).data()).not.toHaveProperty('shareToken');
  });

  it('callables validate auth and input', async () => {
    const create = (m.shares.createShare as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    const revoke = (m.shares.revokeShare as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    await expect(create({ auth: null, data: { itemId: 'a' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(create({ auth: { uid }, data: { itemId: 'a/b' } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(revoke({ auth: { uid }, data: { token: 'bad' } })).rejects.toMatchObject({ code: 'invalid-argument' });
    const res = (await create({ auth: { uid }, data: { itemId: 'a', includeHighlights: true } })) as { token: string; url: string };
    expect(res.url).toBe(`https://read.example.org/s/${res.token}`);
    await expect(revoke({ auth: { uid }, data: { token: res.token } })).resolves.toEqual({ ok: true });
  });

  it('deleting the item removes its share', async () => {
    const { token } = await m.shares.createShareForUser(uid, 'a', false);
    const snap = await item('a').get();
    const run = (m.shares.cleanupShare as unknown as { run: (e: unknown) => Promise<unknown> }).run;
    // A share of another user with the same token is left alone.
    await run({ data: { get: (k: string) => (k === 'shareToken' ? token : undefined) }, params: { uid: 'other', itemId: 'a' } });
    expect((await m.admin.db.collection('shares').doc(token).get()).exists).toBe(true);
    await run({ data: snap, params: { uid, itemId: 'a' } });
    expect((await m.admin.db.collection('shares').doc(token).get()).exists).toBe(false);
  });
});
