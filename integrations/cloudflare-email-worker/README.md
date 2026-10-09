# Readlater — email newsletters via Cloudflare Email Routing

Every Readlater user can get a personal address such as `k3m9q2xv7a@in.example.com` (shown in Settings).
Mail sent to it — newsletter subscriptions, or links you mail or forward to yourself — shows up in the
**Feed**. An email that is just a link saves that link to the Library instead.

This folder holds a [Cloudflare Email Worker](https://developers.cloudflare.com/email-routing/email-workers/)
that receives the mail for your domain and hands it to the `inboundEmail` Cloud Function. It has no
dependencies: it sends the raw message (base64) and the function parses the MIME server-side.
Cloudflare Email Routing is free; you need a domain (or subdomain) whose DNS is on Cloudflare.

## Setup

1. **Functions.** Set the domain and a shared secret for your Firebase project (`scripts/setup.sh` asks
   for both), then deploy the functions:
   ```sh
   echo "INBOUND_EMAIL_DOMAIN=in.example.com" >> functions/.env.<project>
   openssl rand -hex 24 | firebase functions:secrets:set INBOUND_EMAIL_SECRET --data-file=-
   scripts/deploy.sh --project <project> --only functions
   ```
   Instead of Secret Manager you can put `INBOUND_EMAIL_SECRET=…` in `functions/.env.<project>` (git-ignored),
   but deploys from GitHub Actions don't have that file's secret lines, so Secret Manager is the better place.
   Print the secret with `firebase functions:secrets:access INBOUND_EMAIL_SECRET`.

2. **Email Routing.** In the Cloudflare dashboard open the domain → *Email* → *Email Routing* and enable it
   (Cloudflare adds the MX and SPF records). A subdomain such as `in.example.com` keeps your normal mail
   separate: add it under *Settings → Subdomains*.

3. **Worker.** From this folder:
   ```sh
   # edit wrangler.toml: READLATER_INBOUND_URL = https://us-central1-<project>.cloudfunctions.net/inboundEmail
   npx wrangler deploy
   npx wrangler secret put READLATER_SECRET        # paste the INBOUND_EMAIL_SECRET value
   ```
   Or create a Worker in the dashboard, paste `worker.js`, and add the two variables (the secret as
   *Secret*) under *Settings → Variables and Secrets*.

4. **Route the mail.** *Email Routing → Routing rules → Catch-all address*: action **Send to a Worker**,
   destination **readlater-email**, and enable it.

5. **Try it.** Copy your address from Readlater’s Settings and send it a message. It appears
   in the Feed within a few seconds. Subscribe to newsletters with that address.

## How it behaves

- The worker POSTs `{ to, from, raw }` (raw = the MIME message, base64) with the header
  `X-Readlater-Secret`. Messages over 18 MB are rejected.
- If the function answers with an error (wrong secret, not configured, temporary failure) the worker
  throws, so the delivery fails and the reason shows in the worker logs (`npx wrangler tail`) instead of
  the message being bounced as if the address were unknown.
- Mail to an address that belongs to nobody, or with no content, is rejected with that reason.
- The same message (same Message-ID) delivered twice is saved once.
- Optional `FORWARD_TO` (an address verified in Email Routing) also forwards every message there.

## Other providers

The same function accepts Mailgun and SendGrid webhooks directly (no worker needed):

- **Mailgun** → *Receiving → Create route*: expression `match_recipient(".*@in.example.com")`, action
  *Forward* to `https://us-central1-<project>.cloudfunctions.net/inboundEmail?secret=<INBOUND_EMAIL_SECRET>`.
- **SendGrid** → *Settings → Inbound Parse → Add host & URL*: your domain, and the same URL with
  `?secret=…`. Either the default (parsed) mode or “POST the raw, full MIME message” works.

Any other sender can POST JSON `{ "to": "…", "from": "…", "subject": "…", "html": "…", "text": "…" }` (or
`raw`: a base64 MIME message) with the `X-Readlater-Secret` header.
