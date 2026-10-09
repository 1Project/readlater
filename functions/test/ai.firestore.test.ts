/**
 * The `ai` callable against the Firestore emulator, with a local stand-in for the Messages API:
 *   firebase emulators:exec --only firestore --project demo-readlater 'npx vitest run test/ai.firestore.test.ts'
 * Skipped without FIRESTORE_EMULATOR_HOST.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
if (EMU) process.env.GCLOUD_PROJECT ??= 'demo-readlater';

type Mods = { admin: typeof import('../src/admin'); ai: typeof import('../src/ai'); rl: typeof import('../src/rateLimit') };
let m: Mods;

let server: Server;
let baseURL = '';
let bodies: Record<string, any>[] = [];
let nextText: string[] = [];

describe.skipIf(!EMU)('ai callable against the Firestore emulator', () => {
  const uid = `ai_${Date.now()}`;
  const user = () => m.admin.db.collection('users').doc(uid);
  const client = () => new Anthropic({ apiKey: 'sk-test', baseURL, maxRetries: 0 });

  beforeAll(async () => {
    m = { admin: await import('../src/admin'), ai: await import('../src/ai'), rl: await import('../src/rateLimit') };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: nextText.shift() ?? 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const items = user().collection('items');
    await items.doc('doc1').set({
      title: 'Gardens',
      author: 'Ann',
      siteName: 'Example',
      url: 'https://example.com/g',
      tags: ['plants'],
      excerpt: 'About gardens',
      contentChunks: 1,
      createdAt: new Date(),
    });
    await items.doc('doc1').collection('content').doc('0').set({ index: 0, html: '<p>Gardens need water &amp; light.</p><p>Second paragraph.</p>' });
    await items.doc('empty').set({ title: 'Nothing yet', url: 'https://example.com/e', tags: [], contentChunks: 0, createdAt: new Date() });
    for (let i = 0; i < 5; i++) await items.doc(`t${i}`).set({ title: `t${i}`, tags: i < 3 ? ['gardening', 'water'] : ['cooking'], createdAt: new Date(Date.now() - i * 1000) });
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  beforeEach(() => {
    bodies = [];
    nextText = [];
  });

  it('summarize stores aiSummary and returns the cached copy until forced', async () => {
    nextText.push('TL;DR: Water and light.\n\n- Water\n- Light');
    const first = await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'doc1', action: 'summarize' }), client());
    expect(first).toMatchObject({ summary: 'TL;DR: Water and light.\n\n- Water\n- Light', cached: false, model: 'claude-opus-5-5' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages[0].content[0].text).toContain('Gardens need water & light.\n\nSecond paragraph.');

    const stored = (await user().collection('items').doc('doc1').get()).get('aiSummary');
    expect(stored.text).toBe('TL;DR: Water and light.\n\n- Water\n- Light');
    expect(stored.model).toBe('claude-opus-5-5');
    expect(stored.createdAt.toMillis()).toBeGreaterThan(0);

    const again = await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'doc1', action: 'summarize' }), client());
    expect(again).toMatchObject({ summary: stored.text, cached: true });
    expect(bodies).toHaveLength(1);

    nextText.push('TL;DR: New.');
    const forced = await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'doc1', action: 'summarize', force: true }), client());
    expect(forced).toMatchObject({ summary: 'TL;DR: New.', cached: false });
    expect(bodies).toHaveLength(2);
  });

  it('ask answers from the document', async () => {
    nextText.push('They need water.\n\n> Gardens need water & light.');
    const r = await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'doc1', action: 'ask', question: 'What do gardens need?' }), client());
    expect(r).toEqual({ answer: 'They need water.\n\n> Gardens need water & light.', model: 'claude-opus-5-5' });
    expect(bodies[0].messages[0].content[1].text).toContain('What do gardens need?');
  });

  it("suggestTags offers the user's tags (most used first) and skips the document's own", async () => {
    nextText.push('{"tags":["gardening","plants","Water","outdoors"]}');
    const r = await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'doc1', action: 'suggestTags' }), client());
    expect(r).toEqual({ tags: ['gardening', 'water', 'outdoors'], model: 'claude-opus-5-5' });
    const instr: string = bodies[0].messages[0].content[1].text;
    expect(instr).toContain('<existing_tags>\ngardening, water, cooking, plants\n</existing_tags>');
    expect(instr).toContain('do not suggest them again: plants');
    expect(bodies[0].output_config.format.type).toBe('json_schema');
  });

  it('suggestTags works from metadata when there is no content; other actions need content', async () => {
    nextText.push('{"tags":["misc"]}');
    expect(await m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'empty', action: 'suggestTags' }), client())).toMatchObject({ tags: ['misc'] });
    expect(bodies[0].messages[0].content[0].text).toContain('Nothing yet\n\nhttps://example.com/e');
    await expect(m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'empty', action: 'summarize' }), client())).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(m.ai.aiForUser(uid, m.ai.parseAiInput({ itemId: 'nope', action: 'summarize' }), client())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('enforces 100 calls per day per user', async () => {
    const other = `${uid}_rl`;
    await m.admin.db.collection('users').doc(other).collection('items').doc('d').set({ title: 'x', tags: [], createdAt: new Date() });
    await m.admin.db.collection('users').doc(other).collection('items').doc('d').collection('content').doc('0').set({ index: 0, html: '<p>x</p>' });
    await m.admin.db
      .collection('rateLimits')
      .doc(m.rl.bucketDocId(`ai:${other}`))
      .set({ count: m.ai.AI_DAILY_LIMIT, windowStart: Date.now() });
    await expect(m.ai.aiForUser(other, m.ai.parseAiInput({ itemId: 'd', action: 'ask', question: 'q' }), client())).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(bodies).toHaveLength(0);
  });

  it('the callable requires auth and a configured key', async () => {
    const run = (m.ai.ai as unknown as { run: (req: unknown) => Promise<unknown> }).run;
    await expect(run({ auth: null, data: { itemId: 'doc1', action: 'summarize' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    delete process.env.ANTHROPIC_API_KEY;
    await expect(run({ auth: { uid }, data: { itemId: 'doc1', action: 'summarize' } })).rejects.toMatchObject({ code: 'failed-precondition', message: 'AI is not configured' });
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    process.env.ANTHROPIC_BASE_URL = baseURL;
    try {
      nextText.push('Yes.');
      await expect(run({ auth: { uid }, data: { itemId: 'doc1', action: 'ask', question: 'Water?' } })).resolves.toMatchObject({ answer: 'Yes.' });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });
});
