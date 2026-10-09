/**
 * Inbound email webhook (`inboundEmail` HTTP function), docs/SPEC-2.md §1 "Email newsletters".
 *
 * Every user can get an address `<token>@<INBOUND_EMAIL_DOMAIN>` (callable getInboundEmail). Mail to it is
 * POSTed here by one of:
 *   - Mailgun routes ("forward" action, multipart/form-data: recipient, sender, from, subject, body-html,
 *     body-plain, stripped-html, Message-Id, message-headers, …),
 *   - SendGrid Inbound Parse (multipart/form-data: to, from, subject, html, text, envelope, headers, charsets;
 *     or with "POST the raw, full MIME message": email),
 *   - the Cloudflare Email Worker in integrations/cloudflare-email-worker (JSON: to, from, raw = base64 MIME),
 *     or any JSON `{ to, from, subject, html, text, messageId? }`.
 * Auth: the shared secret INBOUND_EMAIL_SECRET as `?secret=` or the `X-Readlater-Secret` header.
 *
 * An email becomes a Feed item (`location:'feed'`, `source:'email'`, siteName = sender name, content = the
 * sanitized HTML body). An email that is essentially one link (e.g. a link mailed or forwarded to yourself)
 * saves that link instead. Duplicates (same Message-ID) are ignored for 30 days (emailDedupe/{hash}).
 *
 * Responses: 200 `{ ok: true, id }` when saved (or `duplicate: true`); 200 `{ ok: false, error }` for mail
 * that is dropped on purpose (unknown address, empty) so providers don't retry; 401 bad secret; 400/413 bad
 * request; 500 on internal errors (providers retry).
 */
import './options';
import busboy from 'busboy';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { JSDOM, VirtualConsole } from 'jsdom';
import { simpleParser } from 'mailparser';
import { db, REGION } from './admin';
import { saveContentItem, saveIncomingLink } from './api';
import { htmlToText, sanitizeHtml } from './extract';
import { textToHtml } from './extract/html';
import { EMAIL_SECRETS, INBOUND_TOKEN_RE, inboundAddressesCol, inboundEmailDomain, inboundEmailSecret, safeEqual } from './integrations';
import { hit } from './rateLimit';
import { cleanSaveUrl, sha256 } from './util';

export type InboundProvider = 'mailgun' | 'sendgrid' | 'json' | 'mime';

/** An inbound email, normalised across providers. */
export interface InboundEmail {
  provider: InboundProvider;
  /** Envelope recipients first, then To/Cc header addresses (raw strings, may include display names). */
  recipients: string[];
  /** Sender as in the From header ("Name <addr>" or "addr"). */
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string | null;
  date: Date | null;
}

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------- parsing (pure)

/** Split an address list header ("A <a@x>, b@y") into entries, respecting quotes and angle brackets. */
export function splitAddresses(list: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "Jane Doe <jane@x.com>" → { name: 'Jane Doe', address: 'jane@x.com' }. */
export function parseAddress(s: string): { name: string; address: string } {
  const t = s.trim();
  const m = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(t);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim();
    return { name, address: m[2].toLowerCase() };
  }
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(t);
  return { name: '', address: (bare?.[1] ?? '').toLowerCase() };
}

/**
 * The inbox token of the first recipient on our domain ("abcdefghij@in.example.com", also with a
 * "+anything" suffix). Without a configured domain any recipient's local part is considered.
 */
export function tokenFromRecipients(recipients: string[], domain: string | null): string | null {
  for (const r of recipients.flatMap(splitAddresses)) {
    const { address } = parseAddress(r);
    const at = address.lastIndexOf('@');
    if (at <= 0) continue;
    if (domain && address.slice(at + 1) !== domain.toLowerCase()) continue;
    const local = address.slice(0, at).split('+')[0];
    if (INBOUND_TOKEN_RE.test(local)) return local;
  }
  return null;
}

/** Message-ID from a raw header block (SendGrid `headers`). */
export function messageIdFromHeaders(headers: string | null | undefined): string | null {
  if (!headers) return null;
  const m = /^message-id:\s*(.+(?:\r?\n[ \t].+)*)/im.exec(headers);
  return m ? cleanMessageId(m[1]) : null;
}

/** Date from a raw header block. */
function dateFromHeaders(headers: string | null | undefined): Date | null {
  const m = headers ? /^date:\s*(.+)$/im.exec(headers) : null;
  return m ? validDate(m[1]) : null;
}

export function cleanMessageId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, '').trim();
  return s ? s.slice(0, 500) : null;
}

function validDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v) : new Date(String(v));
  const t = d.getTime();
  return Number.isFinite(t) && t > 0 && t < Date.now() + 2 * 86_400_000 ? d : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');

/** Mailgun route ("forward") fields → InboundEmail. */
export function fromMailgun(f: Record<string, string>): InboundEmail {
  let messageId = cleanMessageId(f['Message-Id'] ?? f['message-id'] ?? f['Message-ID']);
  let date: Date | null = validDate(f.Date ?? f.date) ?? (f.timestamp ? validDate(Number(f.timestamp) * 1000) : null);
  if (f['message-headers']) {
    try {
      const headers = JSON.parse(f['message-headers']) as [string, string][];
      for (const [k, v] of headers) {
        if (!messageId && /^message-id$/i.test(k)) messageId = cleanMessageId(v);
        if (!date && /^date$/i.test(k)) date = validDate(v);
      }
    } catch {
      /* ignore malformed header JSON */
    }
  }
  return {
    provider: 'mailgun',
    recipients: [f.recipient, f.To, f.to].filter(Boolean),
    from: f.from || f.From || f.sender || '',
    subject: f.subject || f.Subject || '',
    html: f['body-html'] || f['stripped-html'] || null,
    text: f['body-plain'] || f['stripped-text'] || null,
    messageId,
    date,
  };
}

/** SendGrid Inbound Parse (default, parsed mode) fields → InboundEmail. */
export function fromSendgrid(f: Record<string, string>): InboundEmail {
  let envelopeTo: string[] = [];
  let envelopeFrom = '';
  if (f.envelope) {
    try {
      const env = JSON.parse(f.envelope) as { to?: unknown; from?: unknown };
      envelopeTo = Array.isArray(env.to) ? env.to.filter((x): x is string => typeof x === 'string') : typeof env.to === 'string' ? [env.to] : [];
      envelopeFrom = typeof env.from === 'string' ? env.from : '';
    } catch {
      /* ignore */
    }
  }
  return {
    provider: 'sendgrid',
    recipients: [...envelopeTo, f.to, f.cc].filter(Boolean),
    from: f.from || envelopeFrom,
    subject: f.subject || '',
    html: f.html || null,
    text: f.text || null,
    messageId: messageIdFromHeaders(f.headers),
    date: dateFromHeaders(f.headers),
  };
}

/** Parse a raw MIME message. `envelope` recipients/sender (from the transport) take precedence. */
export async function fromMime(raw: Buffer, envelope: { to?: string[]; from?: string } = {}): Promise<InboundEmail> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true });
  const addrText = (a: unknown): string[] => {
    const list = Array.isArray(a) ? a : a ? [a] : [];
    return list.map((x) => String((x as { text?: unknown }).text ?? '')).filter(Boolean);
  };
  return {
    provider: 'mime',
    recipients: [...(envelope.to ?? []), ...addrText(mail.to), ...addrText(mail.cc)],
    from: addrText(mail.from)[0] || envelope.from || '',
    subject: mail.subject ?? '',
    html: typeof mail.html === 'string' ? mail.html : null,
    text: mail.text ?? null,
    messageId: cleanMessageId(mail.messageId),
    date: validDate(mail.date),
  };
}

/** JSON body (Cloudflare worker or custom) → InboundEmail. `raw` (base64 MIME) is parsed when present. */
export async function fromJson(b: Record<string, unknown>): Promise<InboundEmail> {
  const to = Array.isArray(b.to) ? b.to.map(String) : str(b.to) ? splitAddresses(str(b.to)) : [];
  if (str(b.raw)) {
    const raw = Buffer.from(str(b.raw), 'base64');
    const parsed = await fromMime(raw, { to, from: str(b.from) });
    return { ...parsed, provider: 'json' };
  }
  return {
    provider: 'json',
    recipients: to,
    from: str(b.from),
    subject: str(b.subject),
    html: str(b.html) || null,
    text: str(b.text) || null,
    messageId: cleanMessageId(b.messageId ?? b.messageID ?? b['message-id']),
    date: validDate(b.date),
  };
}

/**
 * Multipart/form-data fields (file parts are skipped). `fields` are decoded (UTF-8, or per SendGrid's
 * `charsets`); `raw` keeps each value's bytes as a latin1 string (for a raw MIME message).
 */
export function parseMultipart(raw: Buffer, contentType: string): Promise<{ fields: Record<string, string>; raw: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let bb: busboy.Busboy;
    try {
      // latin1 keeps the bytes as they are; values are decoded below with the right charset.
      bb = busboy({ headers: { 'content-type': contentType }, defCharset: 'latin1', limits: { fieldSize: MAX_EMAIL_BYTES, fields: 200 } });
    } catch (e) {
      reject(e);
      return;
    }
    bb.on('field', (name, value) => {
      if (!(name in fields)) fields[name] = value;
    });
    bb.on('file', (_name, stream) => stream.resume());
    bb.on('error', reject);
    bb.on('close', () => resolve({ fields: decodeFields(fields), raw: fields }));
    bb.end(raw);
  });
}

/** Decode latin1-preserved field bytes: SendGrid's `charsets` map names each field's charset; default UTF-8. */
function decodeFields(fields: Record<string, string>): Record<string, string> {
  const bytes = (v: string) => Buffer.from(v, 'latin1');
  let charsets: Record<string, string> = {};
  if (fields.charsets) {
    try {
      charsets = JSON.parse(bytes(fields.charsets).toString('utf8')) as Record<string, string>;
    } catch {
      /* ignore */
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const cs = (charsets[k] || 'utf-8').toLowerCase();
    try {
      out[k] = new TextDecoder(cs).decode(bytes(v));
    } catch {
      out[k] = bytes(v).toString('utf8');
    }
  }
  return out;
}

/** Normalise any supported request into an InboundEmail (null when the body is not recognised). */
export async function parseInbound(contentType: string, rawBody: Buffer | undefined, body: unknown): Promise<InboundEmail | null> {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    if (!rawBody?.length) return null;
    const { fields: f, raw } = await parseMultipart(rawBody, contentType);
    if (raw.email) {
      // SendGrid "raw" mode: the full MIME message.
      let envelope: { to?: string[]; from?: string } = {};
      try {
        envelope = f.envelope ? (JSON.parse(f.envelope) as typeof envelope) : {};
      } catch {
        /* ignore */
      }
      return { ...(await fromMime(Buffer.from(raw.email, 'latin1'), envelope)), provider: 'sendgrid' };
    }
    if ('body-html' in f || 'body-plain' in f || 'recipient' in f || 'stripped-html' in f) return fromMailgun(f);
    if ('envelope' in f || 'html' in f || 'text' in f || 'to' in f) return fromSendgrid(f);
    return null;
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    // Mailgun can also post urlencoded forms.
    const f: Record<string, string> =
      body && typeof body === 'object' && !Buffer.isBuffer(body)
        ? Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
        : Object.fromEntries(new URLSearchParams(rawBody?.toString('utf8') ?? ''));
    return 'envelope' in f ? fromSendgrid(f) : fromMailgun(f);
  }
  if (ct.startsWith('message/rfc822')) {
    return rawBody?.length ? fromMime(rawBody) : null;
  }
  let json: unknown = body;
  if ((!json || typeof json !== 'object' || Buffer.isBuffer(json)) && rawBody?.length) {
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return fromJson(json as Record<string, unknown>);
}

// ---------------------------------------------------------------------------- content

const FORWARD_LINE = /^(-{2,}\s*(forwarded message|original message)\s*-{2,}|begin forwarded message:?|(from|date|sent|subject|to|cc):\s.*)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;
const SINGLE_LINK_MAX_WORDS = 15;

/** Lines of an email body that count as content (forwarding headers and mail-app signatures removed). */
function contentLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !FORWARD_LINE.test(l) && !/^(sent from my|get outlook for)/i.test(l) && l !== '--')
    .join('\n');
}

const wordCount = (text: string): number => text.replace(URL_RE, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * The one link an email consists of (a link mailed or forwarded to yourself), or null when it has real
 * content: both the text and the HTML body (when present) must hold one distinct link and only a few words.
 */
export function singleLinkOf(text: string | null, html: string | null): string | null {
  const bodies = [text && text.trim() ? contentLines(text) : null, html && html.trim() ? contentLines(htmlToText(html)) : null].filter(
    (b): b is string => b !== null,
  );
  if (!bodies.length || bodies.some((b) => wordCount(b) > SINGLE_LINK_MAX_WORDS)) return null;
  const urls: string[] = [];
  for (const b of bodies) for (const m of b.matchAll(URL_RE)) urls.push(m[0]);
  if (html) for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']?(https?:[^"'\s>]+)/gi)) urls.push(m[1].replace(/&amp;/g, '&'));
  const links = urls.map((u) => cleanSaveUrl(u)).filter((u): u is string => !!u);
  const unique = new Set(links.map((u) => u.replace(/\/$/, '')));
  return unique.size === 1 ? links[0] : null;
}

const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0(px)?\s*(;|$)|mso-hide\s*:\s*all|opacity\s*:\s*0(\.0+)?\s*(;|$)|font-size\s*:\s*0(px)?\s*(;|$))/i;

/** Remove things an email client would not show (preheaders, hidden blocks, head/style) before sanitising. */
export function cleanEmailHtml(html: string): string {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    doc.querySelectorAll('head, style, script, title, meta, link').forEach((el) => el.remove());
    for (const el of Array.from(doc.querySelectorAll('[style], [hidden], [aria-hidden="true"]'))) {
      if (el.hasAttribute('hidden') || HIDDEN_STYLE.test(el.getAttribute('style') ?? '')) el.remove();
    }
    return doc.body?.innerHTML ?? '';
  } finally {
    dom.window.close();
  }
}

/** Sanitized HTML content of an email (HTML body, else the text body as paragraphs). */
export function emailContent(email: Pick<InboundEmail, 'html' | 'text'>): string {
  if (email.html && email.html.trim()) {
    const html = sanitizeHtml(cleanEmailHtml(email.html));
    if (htmlToText(html).trim() || /<img\b/i.test(html)) return html;
  }
  return email.text && email.text.trim() ? sanitizeHtml(textToHtml(email.text.replace(/\r\n?/g, '\n'))) : '';
}

/** Item fields for an email (newsletter) item. */
export function emailItemFields(email: InboundEmail): Record<string, unknown> {
  const sender = parseAddress(email.from);
  const domain = sender.address.split('@')[1] ?? '';
  return {
    url: null,
    type: 'article',
    location: 'feed',
    status: 'unread',
    title: (email.subject.replace(/\s+/g, ' ').trim() || '(no subject)').slice(0, 300),
    author: (sender.name || sender.address || null)?.slice(0, 200) ?? null,
    siteName: (sender.name || domain || null)?.slice(0, 200) ?? null,
    publishedAt: email.date ? Timestamp.fromDate(email.date) : null,
    source: 'email',
  };
}

// ---------------------------------------------------------------------------- saving

export interface InboundResult {
  ok: boolean;
  id?: string;
  duplicate?: boolean;
  link?: boolean;
  error?: string;
}

const DEDUPE_TTL_MS = 30 * 86_400_000;
const PER_ADDRESS_PER_DAY = 300;

/** Save a parsed email for the owner of its address. */
export async function ingestEmail(email: InboundEmail): Promise<InboundResult> {
  const token = tokenFromRecipients(email.recipients, inboundEmailDomain());
  if (!token) return { ok: false, error: 'No Readlater address among the recipients' };
  const addr = await inboundAddressesCol().doc(token).get();
  const uid = addr.exists ? String(addr.get('uid') ?? '') : '';
  if (!uid) return { ok: false, error: 'Unknown address' };
  const rl = await hit(`inbound:${token}`, PER_ADDRESS_PER_DAY, 86_400_000);
  if (!rl.allowed) return { ok: false, error: 'Too many emails to this address today' };

  const dedupeRef = email.messageId ? db.collection('emailDedupe').doc(sha256(`${uid}|${email.messageId}`)) : null;
  if (dedupeRef) {
    try {
      await dedupeRef.create({ uid, expiresAt: Timestamp.fromMillis(Date.now() + DEDUPE_TTL_MS) });
    } catch (e) {
      if ((e as { code?: number }).code === 6) return { ok: true, duplicate: true };
      throw e;
    }
  }
  try {
    const link = singleLinkOf(email.text, email.html);
    if (link) {
      const saved = await saveIncomingLink(uid, { url: link, source: 'email' });
      return { ok: true, id: saved.id, link: true };
    }
    const html = emailContent(email);
    if (!html) {
      await dedupeRef?.delete().catch(() => undefined);
      return { ok: false, error: 'The email has no content' };
    }
    const saved = await saveContentItem(uid, { fields: emailItemFields(email), html });
    return { ok: true, id: saved.id };
  } catch (e) {
    // Let the provider's retry go through.
    await dedupeRef?.delete().catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------- HTTP function

const headerOf = (h: Record<string, string | string[] | undefined>, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

export const inboundEmail = onRequest({ region: REGION, secrets: EMAIL_SECRETS, timeoutSeconds: 120, memory: '1GiB' }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = inboundEmailSecret();
  if (!expected) {
    res.status(404).json({ ok: false, error: 'Inbound email is not configured' });
    return;
  }
  const given = headerOf(req.headers, 'x-readlater-secret') || (typeof req.query.secret === 'string' ? req.query.secret : '');
  if (!given || !safeEqual(given, expected)) {
    res.status(401).json({ ok: false, error: 'Invalid secret' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  if ((req.rawBody?.length ?? 0) > MAX_EMAIL_BYTES * 1.4) {
    res.status(413).json({ ok: false, error: 'Email too large' });
    return;
  }
  let email: InboundEmail | null;
  try {
    email = await parseInbound(headerOf(req.headers, 'content-type'), req.rawBody, req.body);
  } catch (e) {
    logger.warn('inbound email parse failed', { error: (e as Error).message });
    res.status(400).json({ ok: false, error: 'Could not parse the email' });
    return;
  }
  if (!email) {
    res.status(400).json({ ok: false, error: 'Unrecognised request body' });
    return;
  }
  try {
    const result = await ingestEmail(email);
    logger.info('inbound email', { provider: email.provider, ok: result.ok, id: result.id, duplicate: result.duplicate, error: result.error });
    res.status(200).json(result);
  } catch (e) {
    logger.error('inbound email failed', e);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});
