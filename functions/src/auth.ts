/**
 * Device-linking login codes: a signed-in device creates a short code, another device redeems it for a custom token.
 *
 * Native sign-in hand-off (PKCE-style): the app keeps a random verifier and sends only its challenge
 * (base64url(sha256(verifier))) to `/app-login`, which passes it to `createLoginCode({ challenge })`. Such a code
 * can be redeemed only together with the verifier (`redeemLoginCode({ code, verifier })`), so a code that another
 * app intercepts from the `readlater://` redirect is useless; a wrong verifier burns the code.
 */
import './options';
import { createHash, randomInt } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { adminAuth, db, REGION } from './admin';
import { enforce, HOUR, MINUTE } from './rateLimit';
import { clientIp, randomString, sha256 } from './util';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * MINUTE;
const INVALID = 'Invalid or expired code';

export const generateLoginCode = (): string => randomString(CODE_LENGTH, CODE_ALPHABET);

/** A PKCE challenge: base64url (no padding) of a SHA-256 digest. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** Verifiers: 43–128 characters of base64url / RFC 7636 unreserved characters. */
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Shards of the global redemption limit (one hot document would serialise every redemption). */
export const REDEEM_GLOBAL_SHARDS = 10;

export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** The challenge sent to createLoginCode: undefined when absent, null when malformed. */
export function parseChallenge(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return typeof v === 'string' && CHALLENGE_RE.test(v) ? v : null;
}

/** Whether a stored code may be redeemed with this verifier (codes without a challenge need none). */
export function verifierMatches(stored: unknown, verifier: unknown): boolean {
  if (typeof stored !== 'string' || !stored) return true;
  return typeof verifier === 'string' && VERIFIER_RE.test(verifier) && challengeOf(verifier) === stored;
}

/** Normalise a code as typed by a human: case-insensitive, spaces/dashes (any non-alphanumerics) ignored. */
export function normalizeLoginCode(code: unknown): string {
  return typeof code === 'string' ? code.slice(0, 64).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

/** True when the normalised code could have been issued by us. */
export function isWellFormedCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export const createLoginCode = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const challenge = parseChallenge((request.data as { challenge?: unknown } | null)?.challenge);
  if (challenge === null) throw new HttpsError('invalid-argument', 'Invalid sign-in request');
  await enforce(`logincode:${uid}`, 20, HOUR, 'Too many codes requested, please try again later');
  const now = Date.now();
  const expiresAt = now + CODE_TTL_MS;
  // Collisions are astronomically unlikely (31^8), but never overwrite a live code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateLoginCode();
    const ref = db.collection('loginCodes').doc(sha256(code));
    try {
      await ref.create({
        uid,
        expiresAt: Timestamp.fromMillis(expiresAt),
        used: false,
        createdAt: FieldValue.serverTimestamp(),
        ...(challenge ? { challenge } : {}),
      });
      return { code, expiresAt };
    } catch (e) {
      if ((e as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw e;
    }
  }
  throw new HttpsError('internal', 'Could not create a code, please try again');
});

export const redeemLoginCode = onCall({ region: REGION }, async (request) => {
  const ip = clientIp(request.rawRequest);
  await enforce(`redeem:${ip}`, 20, 15 * MINUTE, 'Too many attempts, please try again later');
  await enforce(`redeem-global:${randomInt(REDEEM_GLOBAL_SHARDS)}`, 2000, 15 * MINUTE, 'Too many attempts, please try again later');
  const data = (request.data ?? {}) as { code?: unknown; verifier?: unknown };
  const code = normalizeLoginCode(data.code);
  if (!isWellFormedCode(code)) throw new HttpsError('invalid-argument', INVALID);
  const ref = db.collection('loginCodes').doc(sha256(code));
  const uid = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const exp = snap.get('expiresAt') as Timestamp | undefined;
    if (snap.get('used') === true || !exp || exp.toMillis() < Date.now()) return null;
    tx.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() });
    // A code bound to a verifier is burnt by a wrong one, so an intercepted code cannot be retried.
    return verifierMatches(snap.get('challenge'), data.verifier) ? String(snap.get('uid')) : null;
  });
  if (!uid) throw new HttpsError('invalid-argument', INVALID);
  try {
    const token = await adminAuth().createCustomToken(uid, { via: 'code' });
    return { token };
  } catch (e) {
    logger.error('createCustomToken failed', e);
    throw new HttpsError('internal', 'Could not sign in, please try again');
  }
});
