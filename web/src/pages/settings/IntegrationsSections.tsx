/**
 * Settings › Telegram (#telegram) and Email newsletters (#email). Both are optional server features
 * (useConfig); when one is not set up the section says how to enable it.
 */
import { useState, type MouseEvent, type ReactNode } from 'react';
import Spinner from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/useConfirm';
import { useConfig } from '../../lib/config';
import { createTelegramLink, getInboundEmail, unlinkTelegram, useIntegration } from '../../lib/data';
import { relativeTime } from '../../lib/format';
import { isNative, openExternal } from '../../native';
import { CopyButton, errorMessage, Section } from './ui';

function NotSetUp({ children }: { children: ReactNode }) {
  return <p className="small muted set-note">{children}</p>;
}

export function TelegramSection() {
  const config = useConfig();
  const bot = config.telegramBot;
  return (
    <Section id="telegram" title="Telegram" intro="Send or forward links, PDFs and EPUBs to a Telegram bot to save them.">
      {!config.loaded ? <Spinner /> : bot ? <TelegramLink bot={bot} /> : (
        <NotSetUp>
          The Telegram bot is not set up on this server. To enable it, create a bot with @BotFather, then run <code>scripts/setup.sh</code> again
          and paste the bot token when asked (it stores <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_BOT_USERNAME</code>) and redeploy.
        </NotSetUp>
      )}
    </Section>
  );
}

function TelegramLink({ bot }: { bot: string }) {
  const link = useIntegration('telegram');
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    try {
      const res = await createTelegramLink();
      setUrl(res.url);
      if (isNative()) await openExternal(res.url);
    } catch (e) {
      toast(`Could not create a link: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await confirm('Messages to the bot will no longer be saved to your library.', { title: 'Disconnect Telegram', confirmLabel: 'Disconnect', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await unlinkTelegram();
      setUrl(null);
      toast('Telegram disconnected');
    } catch (e) {
      toast(`Could not disconnect: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  const openLink = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!isNative() || !url) return;
    e.preventDefault();
    void openExternal(url);
  };

  if (link === undefined) return <Spinner />;

  return (
    <>
      {link ? (
        <div className="set-account">
          <p>
            Connected{link.username ? (
              <>
                {' '}
                as <strong>{link.username}</strong>
              </>
            ) : null}
            {link.linkedAt ? <span className="small muted"> · {relativeTime(link.linkedAt)}</span> : null}
          </p>
          <button type="button" className="btn btn-small btn-danger" onClick={() => void disconnect()} disabled={busy}>
            Disconnect
          </button>
        </div>
      ) : url ? (
        <div className="set-sub">
          <div className="row">
            <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer" onClick={openLink}>
              Open @{bot} in Telegram
            </a>
          </div>
          <p className="small muted">Then tap Start in Telegram. The link works once, for 15 minutes; this page updates when you are connected.</p>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void connect()} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect Telegram'}
          </button>
        </div>
      )}
      <div className="set-sub">
        <h3 className="set-sub-title">How to use it</h3>
        <ul className="set-steps small">
          <li>
            Send or forward any message with a link to <strong>@{bot}</strong> — every link in it is saved.
          </li>
          <li>
            <strong>#hashtags</strong> in the message become tags.
          </li>
          <li>Send a PDF or EPUB file to save the document.</li>
          <li>Text without a link is saved as a note.</li>
          <li>
            <code>/latest</code> lists your 5 newest unread items, <code>/help</code> shows the commands, <code>/unlink</code> disconnects.
          </li>
        </ul>
      </div>
    </>
  );
}

export function EmailSection() {
  const config = useConfig();
  const domain = config.inboundEmailDomain;
  return (
    <Section id="email" title="Email newsletters" intro="Read newsletters in your Feed instead of your inbox.">
      {!config.loaded ? <Spinner /> : domain ? <EmailAddress /> : (
        <NotSetUp>
          Email saving is not set up on this server. To enable it, run <code>scripts/setup.sh</code> again and enter a domain for incoming mail
          (<code>INBOUND_EMAIL_DOMAIN</code>), then route that domain’s mail to the <code>inboundEmail</code> function with Mailgun, SendGrid Inbound
          Parse or the Cloudflare Email Worker in <code>integrations/cloudflare-email-worker</code>.
        </NotSetUp>
      )}
    </Section>
  );
}

function EmailAddress() {
  const mirror = useIntegration('email');
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const address = fresh ?? mirror?.address ?? null;

  async function create(reset: boolean) {
    if (reset) {
      const ok = await confirm('Mail sent to your current address will no longer arrive. Update your newsletter subscriptions afterwards.', {
        title: 'New address',
        confirmLabel: 'Create new address',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await getInboundEmail(reset);
      setFresh(res.address);
    } catch (e) {
      toast(`Could not get an address: ${errorMessage(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  if (mirror === undefined && !fresh) return <Spinner />;

  return (
    <>
      {address ? (
        <div className="set-sub">
          <span className="set-label">Your address</span>
          <code className="set-key">{address}</code>
          <div className="row">
            <CopyButton text={address} label="Copy address" what="Address" />
            <button type="button" className="btn btn-small" onClick={() => void create(true)} disabled={busy}>
              New address…
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void create(false)} disabled={busy}>
            {busy ? 'Creating…' : 'Create my address'}
          </button>
        </div>
      )}
      <ul className="set-steps small">
        <li>Subscribe to newsletters with this address. New issues appear in your Feed, ready to read or save to the Library.</li>
        <li>
          Or keep your subscriptions and add a forwarding rule in your mail app (for example, forward mail from a newsletter’s sender to this
          address).
        </li>
        <li>Forwarding an email that contains just a link saves that link instead.</li>
        <li>Keep the address private: anything sent to it lands in your Feed.</li>
      </ul>
    </>
  );
}
