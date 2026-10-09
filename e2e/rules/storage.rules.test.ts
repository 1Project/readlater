import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type firebase from 'firebase/compat/app';
import { ALICE, BOB, PROJECT_ID, readRules } from './helpers';

type Storage = firebase.storage.Storage;

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, storage: { rules: readRules('storage.rules') } });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearStorage();
});

const st = (uid: string): Storage => env.authenticatedContext(uid).storage();
const anon = (): Storage => env.unauthenticatedContext().storage();

const MB = 1024 * 1024;
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%test\n');

/** Upload and resolve to the snapshot (UploadTask is only thenable). */
function put(s: Storage, path: string, data: Uint8Array, contentType?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    s.ref(path).put(data, contentType ? { contentType } : {}).then(resolve, reject);
  });
}

async function seed(path: string, contentType = 'application/pdf'): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await put(ctx.storage(), path, PDF_BYTES, contentType);
  });
}

const UPLOAD = `users/${ALICE}/uploads/item1/paper.pdf`;

describe('uploads', () => {
  it('owner can upload a PDF', async () => {
    await assertSucceeds(put(st(ALICE), UPLOAD, PDF_BYTES, 'application/pdf'));
  });

  it('owner can upload an EPUB', async () => {
    await assertSucceeds(put(st(ALICE), `users/${ALICE}/uploads/item1/Book Name.epub`, PDF_BYTES, 'application/epub+zip'));
  });

  it('application/octet-stream is allowed only with a .pdf/.epub name', async () => {
    await assertSucceeds(put(st(ALICE), `users/${ALICE}/uploads/item1/scan.PDF`, PDF_BYTES, 'application/octet-stream'));
    await assertSucceeds(put(st(ALICE), `users/${ALICE}/uploads/item2/book.epub`, PDF_BYTES, 'application/octet-stream'));
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/item3/notes.txt`, PDF_BYTES, 'application/octet-stream'));
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/item3/pdf`, PDF_BYTES, 'application/octet-stream'));
  });

  it('rejects other content types, even with a .pdf name', async () => {
    await assertFails(put(st(ALICE), UPLOAD, PDF_BYTES, 'text/html'));
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/item1/img.png`, PDF_BYTES, 'image/png'));
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/item1/app.js`, PDF_BYTES, 'application/javascript'));
  });

  it('rejects empty files', async () => {
    await assertFails(put(st(ALICE), UPLOAD, new Uint8Array(0), 'application/pdf'));
  });

  it('accepts a multi-megabyte file', async () => {
    await assertSucceeds(put(st(ALICE), UPLOAD, new Uint8Array(5 * MB), 'application/pdf'));
  });

  it('rejects files larger than 100 MB', async () => {
    await assertFails(put(st(ALICE), UPLOAD, new Uint8Array(100 * MB + 1), 'application/pdf'));
  }, 120_000);

  it('rejects uploads into another user’s folder and unauthenticated uploads', async () => {
    await assertFails(put(st(BOB), UPLOAD, PDF_BYTES, 'application/pdf'));
    await assertFails(put(anon(), UPLOAD, PDF_BYTES, 'application/pdf'));
  });

  it('rejects nested paths below the item folder and other folders', async () => {
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/item1/sub/paper.pdf`, PDF_BYTES, 'application/pdf'));
    await assertFails(put(st(ALICE), `users/${ALICE}/uploads/paper.pdf`, PDF_BYTES, 'application/pdf'));
    await assertFails(put(st(ALICE), `users/${ALICE}/other/paper.pdf`, PDF_BYTES, 'application/pdf'));
    await assertFails(put(st(ALICE), `public/paper.pdf`, PDF_BYTES, 'application/pdf'));
  });

  it('owner can read and delete own uploads; others cannot', async () => {
    await seed(UPLOAD);
    await assertSucceeds(st(ALICE).ref(UPLOAD).getDownloadURL());
    await assertSucceeds(st(ALICE).ref(UPLOAD).getMetadata());
    await assertFails(st(BOB).ref(UPLOAD).getDownloadURL());
    await assertFails(anon().ref(UPLOAD).getDownloadURL());
    await assertFails(st(BOB).ref(UPLOAD).delete());
    await assertSucceeds(st(ALICE).ref(UPLOAD).delete());
  });

  it('owner can overwrite an upload with a valid file only', async () => {
    await seed(UPLOAD);
    await assertSucceeds(put(st(ALICE), UPLOAD, PDF_BYTES, 'application/pdf'));
    await assertFails(put(st(ALICE), UPLOAD, PDF_BYTES, 'text/plain'));
  });
});

describe('server-written files', () => {
  const FILE = `users/${ALICE}/files/item1/original.pdf`;
  const IMAGE = `users/${ALICE}/files/item1/images/cover.jpg`;

  it('owner can read derived files at any depth', async () => {
    await seed(FILE);
    await seed(IMAGE, 'image/jpeg');
    await assertSucceeds(st(ALICE).ref(FILE).getDownloadURL());
    await assertSucceeds(st(ALICE).ref(IMAGE).getDownloadURL());
  });

  it('other users and unauthenticated cannot read derived files', async () => {
    await seed(FILE);
    await assertFails(st(BOB).ref(FILE).getDownloadURL());
    await assertFails(anon().ref(FILE).getDownloadURL());
  });

  it('nobody can write or delete derived files from the client', async () => {
    await seed(FILE);
    await assertFails(put(st(ALICE), FILE, PDF_BYTES, 'application/pdf'));
    await assertFails(put(st(ALICE), `users/${ALICE}/files/item2/original.pdf`, PDF_BYTES, 'application/pdf'));
    await assertFails(st(ALICE).ref(FILE).delete());
    await assertFails(st(BOB).ref(FILE).delete());
  });

  it('listing a user folder is denied to everyone but follows read rules', async () => {
    await seed(FILE);
    await assertFails(st(BOB).ref(`users/${ALICE}/files/item1`).listAll());
    await assertFails(st(ALICE).ref(`users/${ALICE}`).listAll());
  });
});
