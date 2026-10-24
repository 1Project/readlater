/**
 * Optional integrations (docs/SPEC-2.md §8): feature flags, Telegram linking and the inbound email address.
 *
 * Callables: getConfig (no auth), createTelegramLink, unlinkTelegram, getInboundEmail.
 *
 * Configuration is read from process.env at runtime, so a deployment without any integration configured
 * deploys and runs normally (the features are just reported as unavailable). Values come from either
 *   - functions/.env / functions/.env.<project> (plain env, e.g. TELEGRAM_BOT_USERNAME, INBOUND_EMAIL_DOMAIN), or
 *   - Cloud Secret Manager (`firebase functions:secrets:set NAME`). A secret is bound to the functions that use
 *     it only when its feature is switched on at deploy time (see optionalSecrets), because `firebase deploy`
 *     refuses to deploy a function that references a secret which does not exist.
 */
import './options';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db, REGION } from './admin';
import { enforce, HOUR, MINUTE } from './rateLimit';
import { BASE62, randomString } from './util';

// ---------------------------------------------------------------------------- configuration

const env = (name: string): string => (process.env[name] ?? '').trim();

/** Parse dotenv text: KEY=VALUE lines; '#' comments; optional single or double quotes around the value. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * The functions' .env files (functions/.env, then .env.<project> overriding it), read only while the Firebase
 * CLI analyses the code at deploy time (FUNCTIONS_CONTROL_API=true; the working directory is functions/).
 * Newer CLIs pass these values in the environment, but older ones (e.g. firebase-tools 15.13) load them only
 * after the analysis, which would leave every optional secret unbound and the integrations switched off.
 */
let deployEnvCache: Record<string, string> | null = null;
function deployTimeEnv(): Record<string, string> {
  if (process.env.FUNCTIONS_CONTROL_API !== 'true') return {};
  if (deployEnvCache) return deployEnvCache;
  let project = env('GCLOUD_PROJECT');
  if (!project) {
    try {
      project = String((JSON.parse(env('FIREBASE_CONFIG') || '{}') as { projectId?: string }).projectId ?? '');
    } catch {
      project = '';
    }
  }
  const read = (file: string): Record<string, string> => {
    try {
      return parseDotenv(readFileSync(join(process.cwd(), file), 'utf8'));
    } catch {
      return {};
    }
  };
  deployEnvCache = { ...read('.env'), ...(project ? read(`.env.${project}`) : {}) };
  return deployEnvCache;
}

/** A setting from the environment, or (at deploy-time analysis only) from the functions' .env files. */
const setting = (name: string): string => env(name) || (deployTimeEnv()[name] ?? '').trim();

/**
 * Secret names a function should bind, decided when the code is loaded (at deploy time; the switches are read
 * from the environment or, during the CLI's analysis, straight from functions/.env and .env.<project>). A secret is bound when its feature is switched on —
 * TELEGRAM_BOT_USERNAME for the Telegram secrets, INBOUND_EMAIL_DOMAIN for INBOUND_EMAIL_SECRET, AI_ENABLED for
 * ANTHROPIC_API_KEY — or when it is listed in READLATER_SECRETS (comma separated), and it is not already
 * provided as a plain env value (a secret and an env var of the same name cannot coexist).
 */
export function optionalSecrets(...names: string[]): string[] {
  const listed = setting('READLATER_SECRETS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.filter((n) => {
    if (setting(n)) return false;
    if (listed.includes(n)) return true;
    const flag = SECRET_FEATURE_FLAG[n];
    const on = flag ? setting(flag) : '';
    return !!on && on !== '0' && on.toLowerCase() !== 'false';
  });
}

const SECRET_FEATURE_FLAG: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_USERNAME',
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_BOT_USERNAME',
  INBOUND_EMAIL_SECRET: 'INBOUND_EMAIL_DOMAIN',
  ANTHROPIC_API_KEY: 'AI_ENABLED',
};

export const TELEGRAM_SECRETS = optionalSecrets('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET');
export const EMAIL_SECRETS = optionalSecrets('INBOUND_EMAIL_SECRET');
const CONFIG_SECRETS = optionalSecrets('ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN');

export const telegramToken = (): string => env('TELEGRAM_BOT_TOKEN');
export const telegramWebhookSecret = (): string => env('TELEGRAM_WEBHOOK_SECRET');
/** Bot username without '@' (null when the bot is not configured: no username or no token). */
export function telegramBotUsername(): string | null {
  const name = env('TELEGRAM_BOT_USERNAME').replace(/^@/, '');
  return name && telegramToken() ? name : null;
}
/** Telegram Bot API origin (overridable for tests). */
export const telegramApiBase = (): string => (env('TELEGRAM_API_BASE') || 'https://api.telegram.org').replace(/\/+$/, '');
/** Domain of the inbound email addresses, lowercase, or null when email ingest is off. */
export function inboundEmailDomain(): string | null {
  const d = env('INBOUND_EMAIL_DOMAIN').replace(/^@/, '').toLowerCase();
  return d || null;
}
export const inboundEmailSecret = (): string => env('INBOUND_EMAIL_SECRET');

/** Public origin of the web app (PUBLIC_URL env, else the default Hosting domain). */
export function publicUrl(): string {
  const configured = env('PUBLIC_URL').replace(/\/+$/, '');
  if (configured) return configured;
  const project = env('GCLOUD_PROJECT') || env('GCP_PROJECT') || (() => {
    try {
      return String((JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { projectId?: string }).projectId ?? '');
    } catch {
      return '';
    }
  })();
  return project ? `https://${project}.web.app` : '';
}

export interface AppConfig {
  ai: boolean;
  telegramBot: string | null;
  inboundEmailDomain: string | null;
}

export function appConfig(): AppConfig {
  return { ai: !!env('ANTHROPIC_API_KEY'), telegramBot: telegramBotUsername(), inboundEmailDomain: inboundEmailDomain() };
}

/** Constant-time string comparison for shared secrets (hashing first, so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

// ---------------------------------------------------------------------------- Telegram Bot API

export class TelegramApiError extends Error {
  constructor(message: string, public status: number, public description: string) {
    super(message);
  }
}

/** Call a Bot API method. Throws TelegramApiError when Telegram answers ok:false. */
export async function telegramApi<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const token = telegramToken();
  if (!token) throw new TelegramApiError('The Telegram bot is not configured', 0, 'no token');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) {
      const description = String(json.description ?? `HTTP ${res.status}`);
      throw new TelegramApiError(`Telegram ${method} failed: ${description}`, res.status, description);
    }
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------- Firestore paths

export const telegramLinksCol = () => db.collection('telegramLinks');
export const telegramChatsCol = () => db.collection('telegramChats');
export const inboundAddressesCol = () => db.collection('inboundAddresses');
export const integrationDoc = (uid: string, name: 'telegram' | 'email') => db.collection('users').doc(uid).collection('integrations').doc(name);

export const TELEGRAM_LINK_TTL_MS = 15 * MINUTE;
/** Telegram deep-link start parameters allow [A-Za-z0-9_-], up to 64 characters. */
export const TELEGRAM_LINK_TOKEN_RE = /^[A-Za-z0-9]{24}$/;
export const generateTelegramLinkToken = (): string => randomString(24, BASE62);

export const INBOUND_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const INBOUND_TOKEN_RE = /^[a-z2-7]{10}$/;
export const generateInboundToken = (): string => randomString(10, INBOUND_TOKEN_ALPHABET);

function requireUid(request: { auth?: { uid: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  return uid;
}

// ---------------------------------------------------------------------------- callables

export const getConfig = onCall({ region: REGION, secrets: CONFIG_SECRETS }, () => appConfig());

export const createTelegramLink = onCall({ region: REGION, secrets: TELEGRAM_SECRETS }, async (request) => {
  const uid = requireUid(request);
  const bot = telegramBotUsername();
  if (!bot) throw new HttpsError('failed-precondition', 'The Telegram bot is not set up on this server');
  await enforce(`tglink:${uid}`, 20, HOUR, 'Too many links requested, please try again later');
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateTelegramLinkToken();
    try {
      await telegramLinksCol()
        .doc(token)
        .create({ uid, expiresAt: Timestamp.fromMillis(Date.now() + TELEGRAM_LINK_TTL_MS), createdAt: FieldValue.serverTimestamp() });
      return { url: `https://t.me/${bot}?start=${token}` };
    } catch (e) {
      if ((e as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw e;
    }
  }
  throw new HttpsError('internal', 'Could not create a link, please try again');
});

/** Disconnect a user's Telegram chat (both the chat mapping and the Settings mirror). Returns the chat id, if any. */
export async function unlinkTelegramChat(uid: string): Promise<number | null> {
  const mirror = integrationDoc(uid, 'telegram');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(mirror);
    const chatId = snap.exists ? Number(snap.get('chatId')) : NaN;
    if (Number.isFinite(chatId)) {
      const chatRef = telegramChatsCol().doc(String(chatId));
      const chat = await tx.get(chatRef);
      if (chat.exists && chat.get('uid') === uid) tx.delete(chatRef);
    }
    if (snap.exists) tx.delete(mirror);
    return Number.isFinite(chatId) ? chatId : null;
  });
}

export const unlinkTelegram = onCall({ region: REGION, secrets: TELEGRAM_SECRETS }, async (request) => {
  const uid = requireUid(request);
  const chatId = await unlinkTelegramChat(uid);
  if (chatId !== null && telegramToken()) {
    await telegramApi('sendMessage', { chat_id: chatId, text: 'This chat is no longer connected to Readlater.' }).catch((e: unknown) =>
      logger.info('telegram unlink notice failed', { error: (e as Error).message }),
    );
  }
  return { ok: true as const };
});

export const getInboundEmail = onCall({ region: REGION }, async (request) => {
  const uid = requireUid(request);
  const domain = inboundEmailDomain();
  if (!domain) throw new HttpsError('failed-precondition', 'Email saving is not set up on this server');
  const reset = (request.data as { reset?: unknown } | null)?.reset === true;
  if (reset) await enforce(`inboundreset:${uid}`, 10, HOUR, 'Too many new addresses requested, please try again later');
  const mirror = integrationDoc(uid, 'email');
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateInboundToken();
    const address = await db.runTransaction(async (tx) => {
      const snap = await tx.get(mirror);
      const current = snap.exists ? String(snap.get('token') ?? '') : '';
      const currentRef = current && INBOUND_TOKEN_RE.test(current) ? inboundAddressesCol().doc(current) : null;
      const owner = currentRef ? await tx.get(currentRef) : null;
      const mine = !!owner && (!owner.exists || owner.get('uid') === uid);
      if (currentRef && mine && !reset) {
        const addr = `${current}@${domain}`;
        // Repair a missing mapping; the address follows INBOUND_EMAIL_DOMAIN if it changed.
        if (!owner!.exists) tx.set(currentRef, { uid, createdAt: FieldValue.serverTimestamp() });
        if (snap.get('address') !== addr) tx.update(mirror, { address: addr });
        return addr;
      }
      const ref = inboundAddressesCol().doc(token);
      if ((await tx.get(ref)).exists) return null; // collision: try another token
      if (currentRef && owner?.exists && mine) tx.delete(currentRef);
      const addr = `${token}@${domain}`;
      tx.create(ref, { uid, createdAt: FieldValue.serverTimestamp() });
      tx.set(mirror, { token, address: addr, createdAt: FieldValue.serverTimestamp() });
      return addr;
    });
    if (address) return { address };
  }
  throw new HttpsError('internal', 'Could not create an address, please try again');
});
