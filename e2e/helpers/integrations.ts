/**
 * Test settings for the optional integrations (docs/SPEC-2.md §8) on the emulators, plus the local fakes the
 * functions talk to instead of the real services.
 *
 * global-setup.ts writes FUNCTIONS_TEST_ENV into functions/.env.local before it starts the emulators, so the
 * functions see a configured Telegram bot, inbound email domain and Anthropic key. The Telegram Bot API and the
 * Anthropic Messages API point at small HTTP servers that specs/integrations.spec.ts starts on fixed ports.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const TELEGRAM_BOT = 'readlater_e2e_bot';
export const TELEGRAM_TOKEN = '123456:e2e-telegram-token';
export const TELEGRAM_SECRET = 'e2e-telegram-webhook-secret';
export const TELEGRAM_API_PORT = 9311;
export const EMAIL_DOMAIN = 'in.e2e.test';
export const EMAIL_SECRET = 'e2e-inbound-email-secret';
export const ANTHROPIC_PORT = 9312;
export const ANTHROPIC_MODEL = 'claude-e2e-mock';

/** functions/.env.local lines (besides the proxy settings) for the emulator run. */
export const FUNCTIONS_TEST_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
  TELEGRAM_BOT_USERNAME: TELEGRAM_BOT,
  TELEGRAM_API_BASE: `http://127.0.0.1:${TELEGRAM_API_PORT}`,
  INBOUND_EMAIL_DOMAIN: EMAIL_DOMAIN,
  INBOUND_EMAIL_SECRET: EMAIL_SECRET,
  ANTHROPIC_API_KEY: 'sk-ant-e2e-mock',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${ANTHROPIC_PORT}`,
  ANTHROPIC_MODEL,
  // The bot edits its "✓ Saved" reply once the page is processed; on the emulators that can queue behind the
  // feed entries of earlier tests, so the webhook waits longer than in production (15 s), within its 60 s timeout.
  TELEGRAM_TITLE_WAIT_MS: '40000',
};

export interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

/** A tiny JSON HTTP server that records every request and answers with `reply(call)`. */
export class FakeApi {
  readonly calls: RecordedCall[] = [];
  private server: Server | null = null;

  constructor(
    private port: number,
    private reply: (call: RecordedCall, index: number) => { status?: number; body: unknown },
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void readBody(req).then((raw) => {
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          body = { raw };
        }
        const call = { path: (req.url ?? '/').split('?')[0], body };
        this.calls.push(call);
        const out = this.reply(call, this.calls.length - 1);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Recorded calls whose path ends with `/<method>`. */
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.path.endsWith(`/${method}`));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** Fake Telegram Bot API: every method succeeds; sendMessage returns increasing message ids. */
export function fakeTelegram(): FakeApi {
  return new FakeApi(TELEGRAM_API_PORT, (call, i) => {
    const method = call.path.split('/').pop() ?? '';
    if (method === 'sendMessage' || method === 'editMessageText') {
      return {
        body: {
          ok: true,
          result: { message_id: 1000 + i, date: Math.floor(Date.now() / 1000), chat: { id: call.body.chat_id, type: 'private' }, text: call.body.text },
        },
      };
    }
    return { body: { ok: true, result: true } };
  });
}

export const FAKE_SUMMARY = 'TL;DR: The e2e lighthouse report explains why keepers log every storm.\n- Keepers record storms\n- Logs help ships';

/** Fake Anthropic Messages API (POST /v1/messages): answers every request with FAKE_SUMMARY. */
export function fakeAnthropic(): FakeApi {
  return new FakeApi(ANTHROPIC_PORT, (call) => {
    if (!call.path.endsWith('/v1/messages')) return { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'not found' } } };
    return {
      body: {
        id: `msg_e2e_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: String(call.body.model ?? ANTHROPIC_MODEL),
        content: [{ type: 'text', text: FAKE_SUMMARY }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
  });
}
