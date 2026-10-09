/**
 * Telegram bot webhook (`telegram` HTTP function), docs/SPEC-2.md §1.
 *
 * Send or forward a message with links (or a PDF/EPUB file) to the bot and it is saved; #hashtags become tags;
 * plain text without a link is saved as a note (type 'other'). Commands: /start <token> (links the chat to an
 * account, token from the createTelegramLink callable), /help, /latest, /unlink.
 *
 * Configuration (all optional, see integrations.ts): TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (Telegram sends
 * it in X-Telegram-Bot-Api-Secret-Token), TELEGRAM_BOT_USERNAME, TELEGRAM_API_BASE (tests).
 * Register the webhook once after deploying:
 *   GET https://us-central1-<project>.cloudfunctions.net/telegram?action=setWebhook  (header X-Telegram-Bot-Api-Secret-Token: <secret>)
 *
 * The function always answers Telegram with 200 (errors are logged), so Telegram never re-delivers an update
 * into a failing loop; re-deliveries after a timeout are ignored by update_id.
 */
import './options';
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { adminAuth, bucket, db, REGION } from './admin';
import { listItems, saveContentItem, saveIncomingLink, type SavedLink } from './api';
import { sanitizeHtml } from './extract';
import { textToHtml, titleFromFileName } from './extract/html';
import {
  integrationDoc,
  publicUrl,
  safeEqual,
  TELEGRAM_LINK_TOKEN_RE,
  TELEGRAM_SECRETS,
  telegramApi,
  telegramApiBase,
  telegramBotUsername,
  telegramChatsCol,
  telegramLinksCol,
  telegramToken,
  telegramWebhookSecret,
} from './integrations';
import { fileKind } from './processLogic';
import { newItemData } from './saveUrl';
import { cleanSaveUrl, normalizeTags, safeFileName, truncate } from './util';

// ---------------------------------------------------------------------------- Bot API types (the parts we use)

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  date?: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  document?: TgDocument;
  forward_origin?: {
    type: 'user' | 'hidden_user' | 'chat' | 'channel';
    sender_user?: TgUser;
    sender_user_name?: string;
    sender_chat?: TgChat;
    chat?: TgChat;
    author_signature?: string;
  };
  forward_from?: TgUser;
  forward_from_chat?: TgChat;
  forward_sender_name?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
}

// ---------------------------------------------------------------------------- parsing (pure)

export const MAX_URLS_PER_MESSAGE = 10;
/** Bot API limit for getFile downloads. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export interface ParsedCommand {
  name: string;
  arg: string;
}

export interface ParsedMessage {
  command: ParsedCommand | null;
  urls: string[];
  tags: string[];
  /** Message text or caption, as sent. */
  text: string;
  /** Text for a note: hashtag-only lines and trailing hashtags removed. */
  noteText: string;
  document: TgDocument | null;
}

/**
 * A bot command at the start of a text message ("/start abc", "/help@MyBot"). Commands addressed to another
 * bot (/cmd@OtherBot) are ignored (null).
 */
export function parseCommand(text: string, botUsername?: string | null): ParsedCommand | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), arg: (m[3] ?? '').trim() };
}

/** Slice of a message by an entity (offsets are in UTF-16 code units, like JS strings). */
const entityText = (text: string, e: TgEntity): string => text.slice(e.offset, e.offset + e.length);

const URL_RE = /\bhttps?:\/\/[^\s<>"'«»“”]+/gi;

/** Links of a message in order of appearance: url / text_link entities first, then any other http(s) URL. */
export function extractUrls(text: string, entities: TgEntity[] = []): string[] {
  const found: { at: number; url: string }[] = [];
  for (const e of entities) {
    if (e.type === 'url') found.push({ at: e.offset, url: entityText(text, e) });
    else if (e.type === 'text_link' && e.url) found.push({ at: e.offset, url: e.url });
  }
  for (const m of text.matchAll(URL_RE)) found.push({ at: m.index ?? 0, url: m[0] });
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) {
    const url = cleanSaveUrl(f.url.replace(/[).,;:!?\]}>'"]+$/, ''));
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return out;
}

const HASHTAG_RE = /(^|[\s(\[{,;])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;

/** #hashtags of a message as normalised tags (hashtag entities and #words; not URL fragments). */
export function extractHashtags(text: string, entities: TgEntity[] = []): string[] {
  const raw: string[] = [];
  for (const e of entities) if (e.type === 'hashtag') raw.push(entityText(text, e).replace(/^#/, ''));
  for (const m of text.matchAll(HASHTAG_RE)) raw.push(m[2]);
  return normalizeTags(raw);
}

/** Text of a note: lines that are only hashtags and hashtags at the very end are dropped. */
export function noteTextOf(text: string): string {
  const onlyTags = /^(?:\s*#[\p{L}\p{N}_][\p{L}\p{N}_-]*)+\s*$/u;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => !onlyTags.test(l));
  let out = lines.join('\n').trim();
  out = out.replace(/(?:\s+#[\p{L}\p{N}_][\p{L}\p{N}_-]*)+\s*$/u, '').trim();
  return out.replace(/\n{3,}/g, '\n\n');
}

/** Title of a note: its first non-empty line, at most 80 characters. */
export function noteTitle(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return truncate(line, 80) || 'Note';
}

export function parseMessage(msg: TgMessage, botUsername?: string | null): ParsedMessage {
  const text = msg.text ?? msg.caption ?? '';
  const entities = (msg.text !== undefined ? msg.entities : msg.caption_entities) ?? [];
  const command = msg.text !== undefined ? parseCommand(msg.text, botUsername) : null;
  return {
    command,
    urls: command ? [] : extractUrls(text, entities),
    tags: extractHashtags(text, entities),
    text,
    noteText: noteTextOf(text),
    document: msg.document ?? null,
  };
}

/** Who wrote a forwarded message (for a note's author), or null. */
export function forwardAuthor(msg: TgMessage): string | null {
  const name = (u?: TgUser) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : '') : '');
  const o = msg.forward_origin;
  const v =
    (o?.type === 'user' && name(o.sender_user)) ||
    (o?.type === 'hidden_user' && o.sender_user_name) ||
    ((o?.type === 'chat' || o?.type === 'channel') && (o.chat?.title || o.sender_chat?.title)) ||
    name(msg.forward_from) ||
    msg.forward_from_chat?.title ||
    msg.forward_sender_name ||
    '';
  return v ? v.slice(0, 200) : null;
}

/** Display name stored with a linked chat. */
export function chatName(msg: TgMessage): string {
  const c = msg.chat;
  const u = msg.from;
  return (
    (c.username && `@${c.username}`) ||
    c.title ||
    (u?.username && `@${u.username}`) ||
    [c.first_name ?? u?.first_name, c.last_name ?? u?.last_name].filter(Boolean).join(' ') ||
    String(c.id)
  ).slice(0, 100);
}

/** Item id of the note made from a message (edits of the message update the same note). */
export const noteItemId = (chatId: number, messageId: number): string =>
  `t_${createHash('sha1').update(`${chatId}|${messageId}`, 'utf8').digest('hex').slice(0, 24)}`;

/** Reply text after saving links. `titles[i]` is null while item i has no real title yet. */
export function savedText(titles: (string | null)[]): string {
  if (titles.length === 1) return titles[0] ? `✓ Saved: ${titles[0]}` : '✓ Saved';
  const known = titles.filter((t): t is string => !!t);
  if (!known.length) return `✓ Saved ${titles.length} links`;
  return [`✓ Saved ${titles.length} links:`, ...titles.map((t, i) => `• ${t ?? `link ${i + 1}`}`)].join('\n');
}

export const HELP_TEXT = [
  'Send or forward me a link and I save it to Readlater. You can also send a PDF or EPUB file (up to 20 MB), or plain text to save it as a note.',
  '#hashtags in your message become tags.',
  '',
  '/latest – your 5 newest unread items',
  '/unlink – disconnect this chat',
  '/help – this message',
].join('\n');

export const NOT_LINKED_TEXT = 'Open Readlater → Settings → Telegram to connect this chat.';

// ---------------------------------------------------------------------------- Telegram calls

const MAX_MESSAGE_CHARS = 4000;

async function reply(msg: TgMessage, text: string): Promise<number | null> {
  try {
    const sent = await telegramApi<{ message_id: number }>('sendMessage', {
      chat_id: msg.chat.id,
      text: truncate(text, MAX_MESSAGE_CHARS),
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
      link_preview_options: { is_disabled: true },
    });
    return sent?.message_id ?? null;
  } catch (e) {
    logger.warn('telegram sendMessage failed', { chatId: msg.chat.id, error: (e as Error).message });
    return null;
  }
}

async function edit(chatId: number, messageId: number, text: string): Promise<void> {
  try {
    await telegramApi('editMessageText', { chat_id: chatId, message_id: messageId, text: truncate(text, MAX_MESSAGE_CHARS), link_preview_options: { is_disabled: true } });
  } catch (e) {
    logger.info('telegram editMessageText failed', { chatId, error: (e as Error).message });
  }
}

/** Download a file the bot received (getFile → file URL). */
async function downloadFile(fileId: string): Promise<Buffer> {
  const info = await telegramApi<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
  if (!info?.file_path) throw new Error('Telegram did not return the file');
  if (Number(info.file_size ?? 0) > MAX_DOCUMENT_BYTES) throw new Error('The file is larger than 20 MB');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const path = info.file_path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${telegramApiBase()}/file/bot${telegramToken()}/${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Could not download the file from Telegram (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOCUMENT_BYTES) throw new Error('The file is larger than 20 MB');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------- handling

const usersCol = () => db.collection('users');
const updatesCol = () => db.collection('telegramUpdates');

/** Wait this long for saved links to get their real title before giving up on editing the reply. */
const TITLE_WAIT_MS = Number(process.env.TELEGRAM_TITLE_WAIT_MS ?? 15_000);
const TITLE_POLL_MS = 1500;

/** Poll items until each has finished processing (or the time is up); returns their titles (null = not yet). */
async function waitForTitles(uid: string, ids: string[], deadline: number): Promise<(string | null)[]> {
  const refs = ids.map((id) => usersCol().doc(uid).collection('items').doc(id));
  let titles: (string | null)[] = ids.map(() => null);
  for (;;) {
    const snaps = await db.getAll(...refs, { fieldMask: ['title', 'fetchStatus'] });
    let settled = true;
    titles = snaps.map((s) => {
      const st = s.get('fetchStatus');
      if (st !== 'done' && st !== 'error') settled = settled && !s.exists;
      return st === 'done' && s.get('title') ? String(s.get('title')) : null;
    });
    if (settled || Date.now() + TITLE_POLL_MS > deadline) return titles;
    await new Promise((r) => setTimeout(r, TITLE_POLL_MS));
  }
}

/** Reply "✓ Saved", then edit it with the real titles once the items are processed (within ~15 s). */
async function confirmSaved(msg: TgMessage, uid: string, saved: (SavedLink | { id: string; title: string; existing: boolean; fetchStatus: string })[]): Promise<void> {
  const ready = saved.map((s) => (s.fetchStatus === 'done' && s.title ? s.title : null));
  const replyId = await reply(msg, savedText(ready));
  const waiting = saved.filter((s, i) => !ready[i] && (s.fetchStatus === 'pending' || s.fetchStatus === 'processing'));
  if (replyId === null || !waiting.length) return;
  const titles = await waitForTitles(uid, saved.map((s) => s.id), Date.now() + TITLE_WAIT_MS);
  const final = titles.map((t, i) => t ?? ready[i]);
  const text = savedText(final);
  if (text !== savedText(ready)) await edit(msg.chat.id, replyId, text);
}

async function saveLinks(msg: TgMessage, uid: string, p: ParsedMessage): Promise<void> {
  const saved: SavedLink[] = [];
  const failed: string[] = [];
  for (const url of p.urls) {
    try {
      saved.push(await saveIncomingLink(uid, { url, tags: p.tags, source: 'telegram' }));
    } catch (e) {
      logger.warn('telegram save failed', { uid, url, error: (e as Error).message });
      failed.push(url);
    }
  }
  if (!saved.length) {
    await reply(msg, 'Could not save that link. Please try again.');
    return;
  }
  await confirmSaved(msg, uid, saved);
  if (failed.length) await reply(msg, `Could not save:\n${failed.join('\n')}`);
}

async function saveDocument(msg: TgMessage, uid: string, doc: TgDocument, tags: string[]): Promise<void> {
  const name = doc.file_name || 'document';
  const kind = fileKind({ name, contentType: doc.mime_type });
  if (!kind) {
    await reply(msg, 'Only PDF and EPUB files can be saved.');
    return;
  }
  if (Number(doc.file_size ?? 0) > MAX_DOCUMENT_BYTES) {
    await reply(msg, 'Telegram bots can only receive files up to 20 MB. Upload larger files in the Readlater app.');
    return;
  }
  let buf: Buffer;
  try {
    buf = await downloadFile(doc.file_id);
  } catch (e) {
    logger.warn('telegram file download failed', { uid, error: (e as Error).message });
    await reply(msg, `Could not get the file from Telegram: ${(e as Error).message}`);
    return;
  }
  const contentType = kind === 'pdf' ? 'application/pdf' : 'application/epub+zip';
  const ref = usersCol().doc(uid).collection('items').doc();
  const fileName = safeFileName(name, `document.${kind}`);
  const path = `users/${uid}/uploads/${ref.id}/${fileName}`;
  await bucket().file(path).save(buf, { resumable: false, contentType });
  const title = (titleFromFileName(name) ?? name).slice(0, 300);
  await ref.set(
    newItemData({
      url: null,
      type: kind,
      title,
      tags,
      source: 'telegram',
      file: { path, name: fileName, contentType, size: buf.length },
      fetchStatus: 'pending',
    }),
  );
  await confirmSaved(msg, uid, [{ id: ref.id, title, existing: false, fetchStatus: 'pending' }]);
}

async function saveNote(msg: TgMessage, uid: string, p: ParsedMessage, edited: boolean): Promise<void> {
  const id = noteItemId(msg.chat.id, msg.message_id);
  if (edited) {
    const snap = await usersCol().doc(uid).collection('items').doc(id).get();
    if (!snap.exists) return; // the original was not a note (or was deleted): nothing to update
  }
  const title = noteTitle(p.noteText);
  const html = sanitizeHtml(textToHtml(p.noteText));
  const res = await saveContentItem(uid, {
    id,
    fields: { url: null, type: 'other', title, author: forwardAuthor(msg), siteName: 'Telegram', tags: p.tags, source: 'telegram' },
    html,
  });
  await reply(msg, res.existing ? `✓ Updated: ${res.title}` : `✓ Saved note: ${res.title}`);
}

/** /start <token>: connect this chat to the account that created the token. */
async function linkChat(msg: TgMessage, token: string): Promise<void> {
  if (!TELEGRAM_LINK_TOKEN_RE.test(token)) {
    await reply(msg, 'This link is not valid. Open Readlater → Settings → Telegram and tap “Connect” again.');
    return;
  }
  const chatId = msg.chat.id;
  const username = chatName(msg);
  const linkRef = telegramLinksCol().doc(token);
  const chatRef = telegramChatsCol().doc(String(chatId));
  const uid = await db.runTransaction(async (tx) => {
    const link = await tx.get(linkRef);
    const exp = link.get('expiresAt') as Timestamp | undefined;
    const owner = link.exists ? String(link.get('uid') ?? '') : '';
    if (!owner || !exp || exp.toMillis() < Date.now()) return null;
    const mirrorRef = integrationDoc(owner, 'telegram');
    const [chat, mirror] = await Promise.all([tx.get(chatRef), tx.get(mirrorRef)]);
    // The chat was linked to another account: remove that account's Settings mirror.
    const prevUid = chat.exists ? String(chat.get('uid') ?? '') : '';
    const prevMirrorRef = prevUid && prevUid !== owner ? integrationDoc(prevUid, 'telegram') : null;
    const prevMirror = prevMirrorRef ? await tx.get(prevMirrorRef) : null;
    // The account had another chat linked: one chat per account.
    const oldChatId = mirror.exists ? Number(mirror.get('chatId')) : NaN;
    const oldChatRef = Number.isFinite(oldChatId) && oldChatId !== chatId ? telegramChatsCol().doc(String(oldChatId)) : null;
    const oldChat = oldChatRef ? await tx.get(oldChatRef) : null;

    const linkedAt = FieldValue.serverTimestamp();
    tx.delete(linkRef);
    tx.set(chatRef, { uid: owner, username, linkedAt });
    tx.set(mirrorRef, { chatId, username, linkedAt });
    if (prevMirrorRef && prevMirror?.exists && Number(prevMirror.get('chatId')) === chatId) tx.delete(prevMirrorRef);
    if (oldChatRef && oldChat?.exists && oldChat.get('uid') === owner) tx.delete(oldChatRef);
    return owner;
  });
  if (!uid) {
    await reply(msg, 'This link has expired. Open Readlater → Settings → Telegram and tap “Connect” again.');
    return;
  }
  logger.info('telegram chat linked', { uid, chatId });
  // Name the account, so a link someone else sent cannot quietly connect this chat to their library.
  const who = await accountLabel(uid);
  await reply(msg, `✓ Connected to Readlater${who ? ` as ${who}` : ''}. Links you send here are saved to that account; /unlink disconnects.\n\n${HELP_TEXT}`);
}

/** The account's email (or display name) for messages; '' when unknown. */
async function accountLabel(uid: string): Promise<string> {
  try {
    const u = await adminAuth().getUser(uid);
    return u.email || u.displayName || '';
  } catch (e) {
    logger.warn('getUser failed', { uid, error: (e as Error).message });
    return '';
  }
}

async function unlinkChat(msg: TgMessage, uid: string | null): Promise<void> {
  const chatRef = telegramChatsCol().doc(String(msg.chat.id));
  if (uid) {
    const mirrorRef = integrationDoc(uid, 'telegram');
    await db.runTransaction(async (tx) => {
      const mirror = await tx.get(mirrorRef);
      tx.delete(chatRef);
      if (mirror.exists && Number(mirror.get('chatId')) === msg.chat.id) tx.delete(mirrorRef);
    });
  }
  await reply(msg, uid ? 'Disconnected. This chat no longer saves to Readlater.' : 'This chat is not connected.');
}

async function latest(msg: TgMessage, uid: string): Promise<void> {
  const items = await listItems(uid, { status: 'unread', location: 'library', limit: 5 });
  if (!items.length) {
    await reply(msg, 'Nothing unread right now.');
    return;
  }
  const base = publicUrl();
  const lines = items.map((it, i) => {
    const link = it.url ?? (base ? `${base}/item/${encodeURIComponent(it.id)}` : '');
    return `${i + 1}. ${truncate(it.title || it.url || 'Untitled', 120)}${link ? `\n${link}` : ''}`;
  });
  await reply(msg, lines.join('\n\n'));
}

async function linkedUid(chatId: number): Promise<string | null> {
  const snap = await telegramChatsCol().doc(String(chatId)).get();
  const uid = snap.exists ? String(snap.get('uid') ?? '') : '';
  return uid || null;
}

/** Record an update id; false when it was seen before (Telegram re-delivery). */
async function firstDelivery(updateId: number): Promise<boolean> {
  if (!Number.isFinite(updateId)) return true;
  try {
    await updatesCol()
      .doc(String(updateId))
      .create({ expiresAt: Timestamp.fromMillis(Date.now() + 2 * 86_400_000) });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

/** Handle one update. Exported for tests; errors propagate (the HTTP handler logs them). */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (!msg || !msg.chat || typeof msg.chat.id !== 'number') return;
  if (msg.from?.is_bot && !update.channel_post && !update.edited_channel_post) return;
  if (!(await firstDelivery(update.update_id))) return;
  const edited = !!(update.edited_message || update.edited_channel_post);
  const p = parseMessage(msg, telegramBotUsername());
  const uid = await linkedUid(msg.chat.id);

  if (p.command) {
    if (edited) return;
    const { name, arg } = p.command;
    if (name === 'start') {
      if (arg) return linkChat(msg, arg);
      await reply(msg, uid ? `This chat is connected to Readlater.\n\n${HELP_TEXT}` : `Welcome to Readlater! ${NOT_LINKED_TEXT}`);
      return;
    }
    if (name === 'unlink') return unlinkChat(msg, uid);
    if (!uid) {
      await reply(msg, NOT_LINKED_TEXT);
      return;
    }
    if (name === 'latest') return latest(msg, uid);
    await reply(msg, HELP_TEXT);
    return;
  }

  if (!uid) {
    if (!edited) await reply(msg, NOT_LINKED_TEXT);
    return;
  }
  if (p.document) {
    if (!edited) await saveDocument(msg, uid, p.document, p.tags);
    return;
  }
  if (p.urls.length) {
    // Editing a message must not save its links again (that would also move archived items back to unread).
    if (!edited) await saveLinks(msg, uid, p);
    return;
  }
  if (p.noteText) return saveNote(msg, uid, p, edited);
  if (!edited) await reply(msg, HELP_TEXT);
}

// ---------------------------------------------------------------------------- HTTP function

export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post'];

/** The function's public URL (for setWebhook). */
function functionUrl(): string {
  const project =
    process.env.GCLOUD_PROJECT ||
    (() => {
      try {
        return String((JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { projectId?: string }).projectId ?? '');
      } catch {
        return '';
      }
    })();
  return `https://${REGION}-${project}.cloudfunctions.net/telegram`;
}

/** Register this function as the bot's webhook (with the secret token) and set the command list. */
async function setWebhook(url: string): Promise<void> {
  await telegramApi('setWebhook', { url, secret_token: telegramWebhookSecret(), allowed_updates: ALLOWED_UPDATES, max_connections: 20 });
  await telegramApi('setMyCommands', {
    commands: [
      { command: 'latest', description: 'Your 5 newest unread items' },
      { command: 'help', description: 'How to save things' },
      { command: 'unlink', description: 'Disconnect this chat' },
    ],
  });
}

const headerOf = (h: Record<string, string | string[] | undefined>, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

export const telegram = onRequest({ region: REGION, secrets: TELEGRAM_SECRETS, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  const expected = telegramWebhookSecret();
  if (!telegramToken() || !expected) {
    res.status(404).json({ ok: false, error: 'The Telegram bot is not configured' });
    return;
  }
  const given = headerOf(req.headers, 'x-telegram-bot-api-secret-token') || (typeof req.query.secret === 'string' ? req.query.secret : '');
  if (!given || !safeEqual(given, expected)) {
    res.status(401).json({ ok: false, error: 'Invalid secret token' });
    return;
  }
  if (req.method === 'GET' && req.query.action === 'setWebhook') {
    const custom = typeof req.query.url === 'string' && /^https:\/\//.test(req.query.url) ? req.query.url : null;
    const url = custom ?? functionUrl();
    try {
      await setWebhook(url);
      res.json({ ok: true, url });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  try {
    const update = (req.body ?? {}) as TgUpdate;
    if (update && typeof update === 'object') await handleUpdate(update);
  } catch (e) {
    logger.error('telegram update failed', e);
  }
  // Always 200: Telegram would otherwise keep re-sending the update.
  res.status(200).json({ ok: true });
});
