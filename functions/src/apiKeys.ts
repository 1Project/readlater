/**
 * Personal API keys for the HTTP `api` endpoint (bookmarklets, iOS Shortcuts, scripts).
 * Scopes: 'all' (save and read: the extension, scripts) or 'save' (only POST/GET /api/save: the bookmarklet,
 * whose code runs inside the pages it is clicked on, so those pages can read the key).
 */
import './options';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { BASE62, randomString, sha256 } from './util';

export const MAX_KEYS = 20;
export const generateApiKey = (): string => `rl_${randomString(40, BASE62)}`;
export const API_KEY_RE = /^rl_[A-Za-z0-9]{40}$/;
export const isApiKeyFormat = (k: string): boolean => API_KEY_RE.test(k);
export const KEY_ID_RE = /^[0-9a-f]{64}$/;

export type KeyScope = 'all' | 'save';
export const isKeyScope = (v: unknown): v is KeyScope => v === 'all' || v === 'save';

/** Scope of a stored key. Keys made before scopes existed are full keys, except the bookmarklet's. */
export function keyScope(doc: { scope?: unknown; name?: unknown }): KeyScope {
  if (isKeyScope(doc.scope)) return doc.scope;
  return doc.name === 'Bookmarklet' ? 'save' : 'all';
}

export function cleanKeyName(name: unknown): string {
  const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return n || 'API key';
}

export const createApiKey = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const data = (request.data ?? {}) as { name?: unknown; scope?: unknown };
  const name = cleanKeyName(data.name);
  if (data.scope !== undefined && !isKeyScope(data.scope)) throw new HttpsError('invalid-argument', 'Invalid key scope');
  const scope: KeyScope = data.scope === 'save' ? 'save' : 'all';
  const mirror = db.collection('users').doc(uid).collection('apiKeys');
  const count = (await mirror.count().get()).data().count;
  if (count >= MAX_KEYS) throw new HttpsError('failed-precondition', `You can have at most ${MAX_KEYS} API keys. Revoke one first.`);
  const key = generateApiKey();
  const id = sha256(key);
  const batch = db.batch();
  batch.create(db.collection('apiKeys').doc(id), { uid, name, scope, createdAt: FieldValue.serverTimestamp() });
  batch.set(mirror.doc(id), { name, scope, prefix: key.slice(0, 6), createdAt: FieldValue.serverTimestamp(), lastUsedAt: null });
  await batch.commit();
  return { id, key };
});

export const revokeApiKey = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const id = (request.data as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !KEY_ID_RE.test(id)) throw new HttpsError('invalid-argument', 'Invalid key id');
  const topRef = db.collection('apiKeys').doc(id);
  const mirrorRef = db.collection('users').doc(uid).collection('apiKeys').doc(id);
  await db.runTransaction(async (tx) => {
    const [top, mine] = await Promise.all([tx.get(topRef), tx.get(mirrorRef)]);
    if (top.exists && top.get('uid') !== uid) throw new HttpsError('not-found', 'Key not found');
    if (!top.exists && !mine.exists) throw new HttpsError('not-found', 'Key not found');
    if (top.exists) tx.delete(topRef);
    if (mine.exists) tx.delete(mirrorRef);
  });
  return { ok: true as const };
});
