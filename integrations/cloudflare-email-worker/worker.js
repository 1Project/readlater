/**
 * Readlater — Cloudflare Email Worker.
 *
 * Receives mail for your inbound domain (Email Routing catch-all → this worker) and POSTs it to the
 * Readlater `inboundEmail` function as JSON:
 *   { to: <envelope recipient>, from: <envelope sender>, raw: <the whole MIME message, base64> }
 * The function parses the MIME message (HTML/text body, subject, Message-ID) and saves it for the user
 * whose address it is. No dependencies and no build step: wrangler deploys this file as is, and it can
 * also be pasted into the Cloudflare dashboard editor.
 *
 * Settings (wrangler.toml [vars] / dashboard → Settings → Variables):
 *   READLATER_INBOUND_URL  https://us-central1-<project>.cloudfunctions.net/inboundEmail
 *   READLATER_SECRET       the INBOUND_EMAIL_SECRET of your functions (store it as a secret)
 *   FORWARD_TO             optional: also forward every message to this verified address
 */

/** Larger messages are refused (the function accepts 25 MB; base64 adds a third). */
export const MAX_RAW_BYTES = 18 * 1024 * 1024;

/** Base64 of bytes, in chunks (String.fromCharCode has an argument limit). */
export function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export default {
  async email(message, env) {
    if (!env.READLATER_INBOUND_URL || !env.READLATER_SECRET) {
      // Misconfigured: fail loudly (shows up in the Email Routing activity log) instead of dropping mail.
      throw new Error('READLATER_INBOUND_URL and READLATER_SECRET must be set');
    }
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject('Message too large for Readlater');
      return;
    }
    if (env.FORWARD_TO) await message.forward(env.FORWARD_TO);

    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const res = await fetch(env.READLATER_INBOUND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-readlater-secret': env.READLATER_SECRET },
      body: JSON.stringify({ to: message.to, from: message.from, raw: toBase64(raw) }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      // A temporary problem (5xx, 429) or a setup problem (401 wrong secret, 404 email not configured): fail the
      // delivery rather than bounce it as if the address were wrong; the reason shows in the worker logs.
      throw new Error('Readlater inboundEmail answered ' + res.status + (data.error ? ': ' + data.error : ''));
    }
    // Delivered but not saved on purpose (unknown address, empty message): bounce with the reason.
    if (!data.ok && !data.duplicate) message.setReject(data.error || 'Not accepted by Readlater');
  },
};
