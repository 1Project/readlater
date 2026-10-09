import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanEmailHtml,
  emailContent,
  emailItemFields,
  fromMime,
  messageIdFromHeaders,
  parseAddress,
  parseInbound,
  singleLinkOf,
  splitAddresses,
  tokenFromRecipients,
} from '../src/inboundEmail';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', 'ingest', name));
const NEWSLETTER_HTML = fx('newsletter.html').toString('utf8');

/** A multipart/form-data body as a provider would send it (FormData encodes as UTF-8). */
async function multipart(fields: Record<string, string>, withFile = false): Promise<{ ct: string; buf: Buffer }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (withFile) fd.append('attachment-1', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'a.pdf');
  const res = new Response(fd);
  return { ct: res.headers.get('content-type')!, buf: Buffer.from(await res.arrayBuffer()) };
}

/** A hand-built multipart body whose parts carry raw bytes (for charset tests). */
function rawMultipart(parts: [string, Buffer][]): { ct: string; buf: Buffer } {
  const b = 'XyZboundary42';
  const chunks: Buffer[] = [];
  for (const [name, value] of parts) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), value, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { ct: `multipart/form-data; boundary=${b}`, buf: Buffer.concat(chunks) };
}

describe('addresses and tokens', () => {
  it('splits address lists and parses display names', () => {
    expect(splitAddresses('"Doe, Jane" <jane@x.com>, bob@y.org; <c@z.io>')).toEqual(['"Doe, Jane" <jane@x.com>', 'bob@y.org', '<c@z.io>']);
    expect(parseAddress('"Doe, Jane" <Jane@X.com>')).toEqual({ name: 'Doe, Jane', address: 'jane@x.com' });
    expect(parseAddress('news@dispatch.example.com')).toEqual({ name: '', address: 'news@dispatch.example.com' });
    expect(parseAddress('The Dispatch <news@d.example.com>')).toEqual({ name: 'The Dispatch', address: 'news@d.example.com' });
  });
  it('finds the inbox token on our domain (with +suffix), ignoring other recipients', () => {
    const d = 'in.example.com';
    expect(tokenFromRecipients(['me@gmail.com', 'Reader <ABCDEFGHIJ@In.Example.com>'], d)).toBe('abcdefghij');
    expect(tokenFromRecipients(['abcdefghij+news@in.example.com'], d)).toBe('abcdefghij');
    expect(tokenFromRecipients(['abcdefghij@other.com'], d)).toBeNull();
    expect(tokenFromRecipients(['abcdefghij@other.com'], null)).toBe('abcdefghij');
    expect(tokenFromRecipients(['short@in.example.com', 'has1digit0@in.example.com'], d)).toBeNull(); // 0/1 are not base32
    expect(tokenFromRecipients(['a@x.com, abcdefghij@in.example.com'], d)).toBe('abcdefghij');
  });
  it('reads Message-ID from a raw header block', () => {
    expect(messageIdFromHeaders('Subject: x\r\nMessage-ID: <abc@x>\r\nDate: y')).toBe('<abc@x>');
    expect(messageIdFromHeaders('Message-Id:\r\n <folded@x>\r\nX: y')).toBe('<folded@x>');
    expect(messageIdFromHeaders('Subject: none')).toBeNull();
  });
});

describe('provider formats', () => {
  it('Mailgun route (multipart, with an attachment part)', async () => {
    const { ct, buf } = await multipart(
      {
        recipient: 'abcdefghij@in.example.com',
        sender: 'bounce+123@dispatch.example.com',
        from: 'The Dispatch <news@dispatch.example.com>',
        subject: 'Café culture — issue 42',
        'body-plain': 'Hello reader',
        'body-html': NEWSLETTER_HTML,
        'stripped-html': '<p>stripped</p>',
        'Message-Id': '<mg-1@dispatch.example.com>',
        timestamp: '1791275400',
        'message-headers': JSON.stringify([['Date', 'Tue, 06 Oct 2026 08:30:00 +0000']]),
      },
      true,
    );
    const e = await parseInbound(ct, buf, buf);
    expect(e).toMatchObject({
      provider: 'mailgun',
      from: 'The Dispatch <news@dispatch.example.com>',
      subject: 'Café culture — issue 42',
      text: 'Hello reader',
      messageId: '<mg-1@dispatch.example.com>',
    });
    expect(e!.recipients[0]).toBe('abcdefghij@in.example.com');
    expect(e!.html).toContain('The Weekly Dispatch');
    expect(e!.date?.toISOString()).toBe('2026-10-06T08:30:00.000Z');
  });

  it('Mailgun urlencoded body', async () => {
    const body = { recipient: 'abcdefghij@in.example.com', from: 'a@b.com', subject: 'S', 'body-plain': 'Hi' };
    const e = await parseInbound('application/x-www-form-urlencoded', undefined, body);
    expect(e).toMatchObject({ provider: 'mailgun', subject: 'S', text: 'Hi', recipients: ['abcdefghij@in.example.com'] });
  });

  it('SendGrid Inbound Parse (parsed mode) prefers the envelope recipients', async () => {
    const { ct, buf } = await multipart({
      to: 'Someone Else <list@lists.example.org>',
      from: 'The Dispatch <news@dispatch.example.com>',
      subject: 'Issue 42',
      html: NEWSLETTER_HTML,
      text: 'Hello reader',
      envelope: JSON.stringify({ to: ['abcdefghij@in.example.com'], from: 'bounce@dispatch.example.com' }),
      headers: 'Message-ID: <sg-1@dispatch.example.com>\nDate: Tue, 06 Oct 2026 08:30:00 +0000\nSubject: Issue 42',
      charsets: JSON.stringify({ to: 'UTF-8', html: 'UTF-8', text: 'UTF-8', subject: 'UTF-8', from: 'UTF-8' }),
    });
    const e = await parseInbound(ct, buf, buf);
    expect(e).toMatchObject({ provider: 'sendgrid', subject: 'Issue 42', messageId: '<sg-1@dispatch.example.com>' });
    expect(e!.recipients[0]).toBe('abcdefghij@in.example.com');
    expect(tokenFromRecipients(e!.recipients, 'in.example.com')).toBe('abcdefghij');
    expect(e!.date?.toISOString()).toBe('2026-10-06T08:30:00.000Z');
  });

  it('SendGrid charsets: fields in ISO-8859-1 are decoded', async () => {
    const { ct, buf } = rawMultipart([
      ['to', Buffer.from('abcdefghij@in.example.com')],
      ['from', Buffer.from('a@b.com')],
      ['subject', Buffer.from('Caf\xe9', 'latin1')],
      ['text', Buffer.from('Cr\xe8me br\xfbl\xe9e', 'latin1')],
      ['envelope', Buffer.from('{"to":["abcdefghij@in.example.com"],"from":"a@b.com"}')],
      ['charsets', Buffer.from('{"subject":"iso-8859-1","text":"iso-8859-1"}')],
    ]);
    const e = await parseInbound(ct, buf, buf);
    expect(e).toMatchObject({ provider: 'sendgrid', subject: 'Café', text: 'Crème brûlée' });
  });

  it('SendGrid raw mode (full MIME in `email`)', async () => {
    const { ct, buf } = await multipart({
      email: fx('newsletter.eml').toString('utf8'),
      envelope: JSON.stringify({ to: ['abcdefghij@in.example.com'], from: 'news@dispatch.example.com' }),
      to: 'Reader <abcdefghij@in.example.com>',
    });
    const e = await parseInbound(ct, buf, buf);
    expect(e).toMatchObject({ provider: 'sendgrid', subject: 'Café culture — issue 42', messageId: '<issue42.1234@dispatch.example.com>' });
    expect(e!.html).toContain('café culture');
  });

  it('Cloudflare worker JSON with a base64 MIME message', async () => {
    const raw = fx('newsletter.eml');
    const e = await parseInbound('application/json', undefined, { to: 'abcdefghij@in.example.com', from: 'news@dispatch.example.com', raw: raw.toString('base64') });
    expect(e).toMatchObject({ provider: 'json', from: '"The Dispatch" <news@dispatch.example.com>', subject: 'Café culture — issue 42' });
    expect(e!.recipients[0]).toBe('abcdefghij@in.example.com');
    expect(e!.messageId).toBe('<issue42.1234@dispatch.example.com>');
    expect(e!.text).toContain('café culture');
    expect(e!.date?.toISOString()).toBe('2026-10-06T08:30:00.000Z');
  });

  it('plain JSON {to, from, subject, html, text} (also as an unparsed raw body)', async () => {
    const json = { to: 'abcdefghij@in.example.com', from: 'X <x@y.com>', subject: 'Hi', html: '<p>Body</p>', text: 'Body', messageId: '<j@y>' };
    const e = await parseInbound('application/json', undefined, json);
    expect(e).toMatchObject({ provider: 'json', subject: 'Hi', html: '<p>Body</p>', messageId: '<j@y>', recipients: ['abcdefghij@in.example.com'] });
    const e2 = await parseInbound('text/plain', Buffer.from(JSON.stringify(json)), undefined);
    expect(e2?.subject).toBe('Hi');
  });

  it('message/rfc822 body and unrecognised bodies', async () => {
    const e = await parseInbound('message/rfc822', fx('newsletter.eml'), undefined);
    expect(e?.provider).toBe('mime');
    expect(await parseInbound('text/plain', Buffer.from('not json'), undefined)).toBeNull();
    const { ct, buf } = await multipart({ unrelated: 'x' });
    expect(await parseInbound(ct, buf, buf)).toBeNull();
  });
});

describe('email content', () => {
  it('removes preheaders, hidden blocks, tracking pixels and scripts; keeps content and links', () => {
    expect(cleanEmailHtml(NEWSLETTER_HTML)).not.toContain('Preheader');
    const html = emailContent({ html: NEWSLETTER_HTML, text: null });
    expect(html).toContain('The Weekly Dispatch');
    expect(html).toContain('href="https://example.com/story"');
    expect(html).toContain('src="https://example.com/hero.jpg"');
    expect(html).not.toMatch(/Preheader|Hidden Outlook|tracker\.example\.net|<script|<style|alert/);
  });
  it('falls back to the text body as paragraphs', () => {
    expect(emailContent({ html: null, text: 'Line one\nline two\n\nPara https://example.com/x' })).toBe(
      '<p>Line one<br>line two</p><p>Para <a href="https://example.com/x">https://example.com/x</a></p>',
    );
    expect(emailContent({ html: '<div style="display:none">x</div>', text: 'Plain' })).toBe('<p>Plain</p>');
    expect(emailContent({ html: '', text: '  ' })).toBe('');
  });
  it('detects a link-only (forwarded) email', async () => {
    const e = await fromMime(fx('link-only.eml'));
    expect(singleLinkOf(e.text, e.html)).toBe('https://www.paulgraham.com/greatwork.html');
    expect(singleLinkOf(null, '<p><a href="https://example.com/a">https://example.com/a</a></p>')).toBe('https://example.com/a');
    expect(singleLinkOf('Have a look: https://example.com/a', null)).toBe('https://example.com/a');
  });
  it('does not treat newsletters or multi-link mails as a single link', () => {
    expect(singleLinkOf('Hello reader', NEWSLETTER_HTML)).toBeNull();
    expect(singleLinkOf('https://a.example.com/1 https://b.example.com/2', null)).toBeNull();
    expect(singleLinkOf('View in browser: https://example.com/v', `<p>${'word '.repeat(60)}</p>`)).toBeNull();
    expect(singleLinkOf('no links here', null)).toBeNull();
  });
  it('builds feed item fields from the sender and subject', () => {
    const f = emailItemFields({
      provider: 'json',
      recipients: [],
      from: '"The Dispatch" <news@dispatch.example.com>',
      subject: '  Issue\n42 ',
      html: null,
      text: null,
      messageId: null,
      date: new Date('2026-10-06T08:30:00Z'),
    });
    expect(f).toMatchObject({ url: null, type: 'article', location: 'feed', title: 'Issue 42', author: 'The Dispatch', siteName: 'The Dispatch', source: 'email' });
    expect((f.publishedAt as { toDate(): Date }).toDate().toISOString()).toBe('2026-10-06T08:30:00.000Z');
    const g = emailItemFields({ provider: 'json', recipients: [], from: 'news@dispatch.example.com', subject: '', html: null, text: null, messageId: null, date: null });
    expect(g).toMatchObject({ title: '(no subject)', author: 'news@dispatch.example.com', siteName: 'dispatch.example.com', publishedAt: null });
  });
});

describe('cloudflare worker', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fakeMessage(raw: Buffer, rawSize = raw.length) {
    const calls: { reject?: string; forward?: string } = {};
    return {
      calls,
      message: {
        from: 'news@dispatch.example.com',
        to: 'abcdefghij@in.example.com',
        raw: new Blob([raw]).stream(),
        rawSize,
        setReject: (r: string) => (calls.reject = r),
        forward: async (to: string) => {
          calls.forward = to;
        },
      },
    };
  }
  const env = { READLATER_INBOUND_URL: 'https://fn.example.com/inboundEmail', READLATER_SECRET: 's3cret' };

  it('posts the raw message as base64 JSON with the secret header', async () => {
    const worker = (await import('../../integrations/cloudflare-email-worker/worker.js')) as any;
    let sent: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200 });
    }) as typeof fetch;
    const raw = fx('newsletter.eml');
    const { message, calls } = fakeMessage(raw);
    await worker.default.email(message, { ...env, FORWARD_TO: 'me@example.com' });
    expect(sent!.url).toBe(env.READLATER_INBOUND_URL);
    expect((sent!.init.headers as Record<string, string>)['x-readlater-secret']).toBe('s3cret');
    const body = JSON.parse(String(sent!.init.body));
    expect(body.to).toBe('abcdefghij@in.example.com');
    expect(Buffer.from(body.raw, 'base64').equals(raw)).toBe(true);
    expect(calls).toEqual({ forward: 'me@example.com' });
    // The function can parse what the worker sends.
    const parsed = await parseInbound('application/json', undefined, body);
    expect(parsed?.subject).toBe('Café culture — issue 42');
  });

  it('rejects unknown addresses, throws on server errors, refuses huge mail', async () => {
    const worker = (await import('../../integrations/cloudflare-email-worker/worker.js')) as any;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'Unknown address' }), { status: 200 })) as unknown as typeof fetch;
    const a = fakeMessage(Buffer.from('x'));
    await worker.default.email(a.message, env);
    expect(a.calls.reject).toBe('Unknown address');

    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'Internal error' }), { status: 500 })) as unknown as typeof fetch;
    await expect(worker.default.email(fakeMessage(Buffer.from('x')).message, env)).rejects.toThrow(/500: Internal error/);

    const big = fakeMessage(Buffer.from('x'), 50 * 1024 * 1024);
    await worker.default.email(big.message, env);
    expect(big.calls.reject).toMatch(/too large/);
    await expect(worker.default.email(fakeMessage(Buffer.from('x')).message, {})).rejects.toThrow(/must be set/);
    expect(worker.toBase64(new Uint8Array(70_000).fill(65))).toBe(Buffer.alloc(70_000, 65).toString('base64'));
  });
});
