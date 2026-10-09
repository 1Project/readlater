/**
 * Shared setup for the security-rules tests. Run through `npm run test:rules`,
 * which starts the Firestore + Storage emulators (ports from firebase.json) and
 * exports their hosts in FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

export const PROJECT_ID = 'demo-readlater';

export function readRules(file: 'firestore.rules' | 'storage.rules'): string {
  return readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
}

export const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();
export const deleteField = () => firebase.firestore.FieldValue.delete();
export const now = () => firebase.firestore.Timestamp.now();

export const ALICE = 'alice';
export const BOB = 'bob';

/** The exact document web/src/lib/data.ts newItemData() writes for a new link. */
export function newItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://example.com/post',
    type: 'article',
    location: 'library',
    status: 'unread',
    favorite: false,
    title: 'example.com/post',
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
    ...overrides,
  };
}

export function uploadFileField(uid: string, itemId: string, name = 'paper.pdf', extra: Record<string, unknown> = {}) {
  return {
    path: `users/${uid}/uploads/${itemId}/${name}`,
    name,
    contentType: name.endsWith('.epub') ? 'application/epub+zip' : 'application/pdf',
    size: 123456,
    ...extra,
  };
}

/** An item after the server has processed it (as written by processItem). */
export function processedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...newItem(),
    title: 'A very long server-extracted title '.repeat(20), // > 500 chars: must not block client updates
    author: 'Jane Doe',
    siteName: 'Example',
    excerpt: 'An excerpt.',
    wordCount: 1200,
    readingMinutes: 6,
    fetchStatus: 'done',
    contentChunks: 2,
    paper: { doi: '10.1000/xyz', authors: ['Jane Doe'], year: 2024 },
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function str(n: number, ch = 'a'): string {
  return ch.repeat(n);
}

/** A fixed timestamp in the past, guaranteed to differ from any seeded `now()`. */
export const past = () => firebase.firestore.Timestamp.fromMillis(1_000_000_000);
