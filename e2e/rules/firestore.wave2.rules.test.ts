/** Security rules for the wave-2 data (docs/SPEC-2.md): item source & server fields, views, rules, integrations, shares. */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type firebase from 'firebase/compat/app';
import { ALICE, BOB, PROJECT_ID, deleteField, newItem, now, past, processedItem, readRules, serverTimestamp, str } from './helpers';

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
const SOURCES = ['web', 'app', 'extension', 'bookmarklet', 'api', 'telegram', 'email', 'feed', 'import'];

// ---------------------------------------------------------------------------

describe('items: wave-2 fields', () => {
  it('accepts every source on create, and items without one', async () => {
    let i = 0;
    for (const source of SOURCES) {
      await assertSucceeds(alice().doc(`users/${ALICE}/items/s${i++}`).set(newItem({ source })));
    }
    await assertSucceeds(alice().doc(ITEM).set(newItem()));
  });

  const badCreate: [string, Record<string, unknown>][] = [
    ['unknown source', { source: 'carrier-pigeon' }],
    ['source null', { source: null }],
    ['source not a string', { source: 1 }],
    ['rulesApplied', { rulesApplied: true }],
    ['rulesApplied false', { rulesApplied: false }],
    ['aiSummary', { aiSummary: { text: 'x', createdAt: now(), model: 'm' } }],
    ['shareToken', { shareToken: 'a'.repeat(22) }],
  ];
  for (const [name, o] of badCreate) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(ITEM).set(newItem(o)));
    });
  }

  describe('updates', () => {
    beforeEach(async () => {
      await seed(
        ITEM,
        processedItem({
          source: 'telegram',
          rulesApplied: true,
          aiSummary: { text: 'TL;DR: something', createdAt: now(), model: 'claude-opus-5-5' },
          shareToken: 'Abcdefghijklmnopqrstuv',
        }),
      );
    });

    it('server-written wave-2 fields never block ordinary client updates', async () => {
      await assertSucceeds(alice().doc(ITEM).update({ progress: 0.5, updatedAt: serverTimestamp() }));
      await assertSucceeds(alice().doc(ITEM).update({ status: 'archived', archivedAt: serverTimestamp(), tags: ['x'], favorite: true }));
      await assertSucceeds(alice().doc(ITEM).update({ fetchStatus: 'pending', fetchError: null }));
    });

    const forbidden: [string, Record<string, unknown>][] = [
      ['source', { source: 'web' }],
      ['removing source', { source: deleteField() }],
      ['rulesApplied', { rulesApplied: false }],
      ['removing rulesApplied', { rulesApplied: deleteField() }],
      ['aiSummary', { aiSummary: { text: 'fake', createdAt: now(), model: 'x' } }],
      ['removing aiSummary', { aiSummary: deleteField() }],
      ['shareToken', { shareToken: 'Zbcdefghijklmnopqrstuv' }],
      ['removing shareToken', { shareToken: deleteField() }],
    ];
    for (const [name, data] of forbidden) {
      it(`rejects update: ${name}`, async () => {
        await assertFails(alice().doc(ITEM).update(data));
      });
    }

    it('a client-created item cannot gain server fields later', async () => {
      await assertSucceeds(alice().doc(`users/${ALICE}/items/fresh`).set(newItem({ source: 'web' })));
      await assertFails(alice().doc(`users/${ALICE}/items/fresh`).update({ rulesApplied: true }));
      await assertFails(alice().doc(`users/${ALICE}/items/fresh`).update({ shareToken: 'x' }));
    });
  });
});

// ---------------------------------------------------------------------------

describe('saved views', () => {
  const V = `users/${ALICE}/views/v1`;
  const view = (o: Record<string, unknown> = {}) => ({ name: 'Unread papers', params: 'view=unread&type=paper', order: 1, createdAt: serverTimestamp(), ...o });

  it('owner can create, read, rename, reorder, change params and delete', async () => {
    await assertSucceeds(alice().doc(V).set(view()));
    await assertSucceeds(alice().doc(V).get());
    await assertSucceeds(alice().collection(`users/${ALICE}/views`).orderBy('order').get());
    await assertSucceeds(alice().doc(V).update({ name: str(60) }));
    await assertSucceeds(alice().doc(V).update({ order: 2.5 }));
    await assertSucceeds(alice().doc(V).update({ params: '' }));
    await assertSucceeds(alice().doc(V).delete());
    await assertSucceeds(alice().collection(`users/${ALICE}/views`).add(view({ params: str(1000) })));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['empty name', { name: '' }],
    ['name too long', { name: str(61) }],
    ['name not a string', { name: 5 }],
    ['params too long', { params: str(1001) }],
    ['params null', { params: null }],
    ['order not a number', { order: '1' }],
    ['createdAt not a timestamp', { createdAt: 'today' }],
    ['extra field', { icon: 'star' }],
  ];
  for (const [name, o] of bad) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(V).set(view(o)));
    });
  }

  it('rejects a missing field, createdAt changes, and foreign access', async () => {
    const d: Record<string, unknown> = view();
    delete d.order;
    await assertFails(alice().doc(V).set(d));
    await seed(V, { ...view(), createdAt: now() });
    await assertFails(alice().doc(V).update({ createdAt: past() }));
    await assertFails(alice().doc(V).update({ params: deleteField() }));
    await assertFails(bob().doc(V).get());
    await assertFails(bob().doc(V).update({ name: 'Mine' }));
    await assertFails(bob().doc(V).delete());
    await assertFails(bob().doc(`users/${ALICE}/views/v2`).set(view()));
    await assertFails(anon().doc(V).get());
    await assertFails(anon().doc(V).delete());
  });
});

// ---------------------------------------------------------------------------

describe('auto rules', () => {
  const R = `users/${ALICE}/rules/r1`;
  const rule = (o: Record<string, unknown> = {}) => ({
    name: 'Newsletters',
    enabled: true,
    match: { field: 'domain', op: 'is', value: 'substack.com' },
    actions: { addTags: ['newsletter'], categoryId: 'c1', location: 'feed', favorite: false, archive: false },
    createdAt: serverTimestamp(),
    ...o,
  });

  it('owner can create, toggle, edit and delete', async () => {
    await assertSucceeds(alice().doc(R).set(rule()));
    await assertSucceeds(alice().doc(R).update({ enabled: false }));
    await assertSucceeds(alice().doc(R).update({ match: { field: 'title', op: 'contains', value: 'weekly' }, actions: { archive: true } }));
    await assertSucceeds(alice().doc(R).update({ name: '' }));
    await assertSucceeds(alice().collection(`users/${ALICE}/rules`).orderBy('createdAt').get());
    await assertSucceeds(alice().doc(R).delete());
  });

  it('accepts every match field and op, empty or partial actions, and a null category', async () => {
    let i = 0;
    for (const field of ['domain', 'url', 'title', 'feed', 'type', 'source']) {
      for (const op of ['is', 'contains', 'endsWith']) {
        await assertSucceeds(alice().doc(`users/${ALICE}/rules/m${i++}`).set(rule({ match: { field, op, value: 'x' } })));
      }
    }
    await assertSucceeds(alice().doc(`users/${ALICE}/rules/a1`).set(rule({ actions: {} })));
    await assertSucceeds(alice().doc(`users/${ALICE}/rules/a2`).set(rule({ actions: { categoryId: null } })));
    await assertSucceeds(alice().doc(`users/${ALICE}/rules/a3`).set(rule({ actions: { location: 'library', favorite: true } })));
    await assertSucceeds(alice().doc(`users/${ALICE}/rules/a4`).set(rule({ actions: { addTags: Array.from({ length: 30 }, (_, k) => `t${k}`) } })));
  });

  const bad: [string, Record<string, unknown>][] = [
    ['name too long', { name: str(101) }],
    ['enabled not bool', { enabled: 'yes' }],
    ['unknown match field', { match: { field: 'author', op: 'is', value: 'x' } }],
    ['unknown op', { match: { field: 'url', op: 'startsWith', value: 'x' } }],
    ['empty match value', { match: { field: 'url', op: 'is', value: '' } }],
    ['match value too long', { match: { field: 'url', op: 'is', value: str(501) } }],
    ['match missing op', { match: { field: 'url', value: 'x' } }],
    ['match extra key', { match: { field: 'url', op: 'is', value: 'x', caseSensitive: true } }],
    ['match not a map', { match: 'domain is x' }],
    ['unknown action', { actions: { delete: true } }],
    ['addTags not a list', { actions: { addTags: 'a,b' } }],
    ['addTags > 30', { actions: { addTags: Array.from({ length: 31 }, (_, k) => `t${k}`) } }],
    ['categoryId not a string', { actions: { categoryId: 3 } }],
    ['categoryId with slash', { actions: { categoryId: 'a/b' } }],
    ['location enum', { actions: { location: 'inbox' } }],
    ['favorite not bool', { actions: { favorite: 1 } }],
    ['archive not bool', { actions: { archive: 'true' } }],
    ['actions not a map', { actions: ['archive'] }],
    ['extra field', { priority: 1 }],
    ['createdAt not a timestamp', { createdAt: 0 }],
  ];
  for (const [name, o] of bad) {
    it(`rejects create: ${name}`, async () => {
      await assertFails(alice().doc(R).set(rule(o)));
    });
  }

  it('rejects missing fields, createdAt changes, and foreign access', async () => {
    for (const k of ['name', 'enabled', 'match', 'actions', 'createdAt']) {
      const d: Record<string, unknown> = rule();
      delete d[k];
      await assertFails(alice().doc(R).set(d));
    }
    await seed(R, { ...rule(), createdAt: now() });
    await assertFails(alice().doc(R).update({ createdAt: past() }));
    await assertFails(alice().doc(R).update({ enabled: deleteField() }));
    await assertFails(bob().doc(R).get());
    await assertFails(bob().doc(R).update({ enabled: false }));
    await assertFails(bob().doc(R).delete());
    await assertFails(anon().doc(R).get());
  });
});

// ---------------------------------------------------------------------------

describe('integrations (server-written mirrors)', () => {
  const T = `users/${ALICE}/integrations/telegram`;
  const E = `users/${ALICE}/integrations/email`;

  beforeEach(async () => {
    await seed(T, { chatId: 42, username: 'alice', linkedAt: now() });
    await seed(E, { token: 'abcdefghij', address: 'abcdefghij@in.example.com', createdAt: now() });
  });

  it('owner can read and list; others cannot', async () => {
    await assertSucceeds(alice().doc(T).get());
    await assertSucceeds(alice().doc(E).get());
    await assertSucceeds(alice().collection(`users/${ALICE}/integrations`).get());
    await assertFails(bob().doc(T).get());
    await assertFails(bob().collection(`users/${ALICE}/integrations`).get());
    await assertFails(anon().doc(E).get());
  });

  it('nobody can write them from the client', async () => {
    await assertFails(alice().doc(T).set({ chatId: 1, username: 'x', linkedAt: serverTimestamp() }));
    await assertFails(alice().doc(T).update({ chatId: 7 }));
    await assertFails(alice().doc(T).delete());
    await assertFails(alice().doc(E).update({ address: 'mine@evil.example' }));
    await assertFails(alice().doc(`users/${ALICE}/integrations/other`).set({ a: 1 }));
    await assertFails(bob().doc(T).delete());
  });
});

// ---------------------------------------------------------------------------

describe('public shares', () => {
  const TOKEN = 'Abcdefghijklmnopqrstuv';
  const S = `shares/${TOKEN}`;
  const share = () => ({
    owner: 'a'.repeat(64),
    title: 'Shared',
    author: null,
    siteName: null,
    url: 'https://example.com/a',
    html: '<p>Hello</p>',
    highlights: [{ text: 'Hello', note: '' }],
    createdAt: now(),
  });

  beforeEach(async () => {
    await seed(S, share());
  });

  it('anyone can get a share by token (signed in or not)', async () => {
    await assertSucceeds(anon().doc(S).get());
    await assertSucceeds(bob().doc(S).get());
    await assertSucceeds(alice().doc(S).get());
    // A missing token reads as "not found", not as an error.
    await assertSucceeds(anon().doc('shares/Zzzzzzzzzzzzzzzzzzzzzz').get());
  });

  it('shares cannot be listed or queried', async () => {
    await assertFails(anon().collection('shares').get());
    await assertFails(alice().collection('shares').where('owner', '==', 'a'.repeat(64)).get());
    await assertFails(alice().collection('shares').limit(1).get());
  });

  it('no client writes, not even by the owner', async () => {
    await assertFails(alice().doc(S).update({ title: 'Changed' }));
    await assertFails(alice().doc(S).delete());
    await assertFails(alice().doc('shares/Newnewnewnewnewnewnewn').set(share()));
    await assertFails(anon().doc('shares/Newnewnewnewnewnewnewn').set(share()));
    await assertFails(bob().doc(S).delete());
  });
});

// ---------------------------------------------------------------------------

describe('wave-2 server-only collections', () => {
  for (const col of ['telegramLinks', 'telegramChats', 'inboundAddresses', 'emailDedupe']) {
    it(`top-level ${col} is inaccessible to clients`, async () => {
      await seed(`${col}/abc`, { uid: ALICE, createdAt: now() });
      await assertFails(alice().doc(`${col}/abc`).get());
      await assertFails(anon().doc(`${col}/abc`).get());
      await assertFails(alice().collection(col).get());
      await assertFails(alice().collection(col).where('uid', '==', ALICE).get());
      await assertFails(alice().doc(`${col}/abc`).set({ uid: ALICE }));
      await assertFails(alice().doc(`${col}/abc`).update({ uid: BOB }));
      await assertFails(alice().doc(`${col}/new`).set({ uid: ALICE }));
      await assertFails(anon().doc(`${col}/new`).set({ uid: ALICE }));
      await assertFails(alice().doc(`${col}/abc`).delete());
    });
  }
});
