import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { HttpsError } from 'firebase-functions/v2/https';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  MAX_DOC_CHARS,
  SYSTEM_PROMPT,
  aiClient,
  buildParams,
  documentBlock,
  documentText,
  parseAiInput,
  parseTags,
  runAi,
  topTags,
  truncateText,
  type DocInfo,
} from '../src/ai';

// ---------------------------------------------------------------------------- a local stand-in for the Messages API

interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let captured: Captured[] = [];
let server: Server;
let baseURL = '';

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: DEFAULT_MODEL,
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      const r = replies.shift() ?? { status: 200, body: message('ok') };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

afterEach(() => {
  replies = [];
  captured = [];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_FALLBACKS;
});

const client = () => new Anthropic({ apiKey: 'sk-test', baseURL, maxRetries: 0 });

const doc = (o: Partial<DocInfo> = {}): DocInfo => ({
  title: 'On Gardens',
  author: 'Ann Writer',
  siteName: 'Example',
  url: 'https://example.com/gardens',
  text: 'Gardens need water.\n\nThey also need light.',
  truncated: false,
  ...o,
});

// ---------------------------------------------------------------------------- document text

describe('document text', () => {
  it('keeps paragraphs and decodes entities', () => {
    const html = '<h2>Title</h2><p>First &amp; <em>best</em> line.</p><p>It&#8217;s &#x2014; fine<br>next</p><ul><li>one</li><li>two</li></ul>';
    expect(documentText(html)).toBe('Title\n\nFirst & best line.\n\nIt’s — fine\n\nnext\n\none\n\ntwo');
  });

  it('drops scripts and empty blocks', () => {
    expect(documentText('<p> </p><div><script>alert(1)</script>Body</div>')).toBe('Body');
    expect(documentText('')).toBe('');
  });

  it('truncates at a paragraph boundary', () => {
    const para = 'word '.repeat(199) + 'end';
    const text = Array.from({ length: 200 }, () => para).join('\n\n');
    const r = truncateText(text);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
    expect(r.text.endsWith('end')).toBe(true);
    expect(truncateText('short')).toEqual({ text: 'short', truncated: false });
  });

  it('falls back to a word boundary when there are no paragraphs', () => {
    const r = truncateText('abc '.repeat(100), 50);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/abc$/);
    expect(r.text.length).toBeLessThanOrEqual(50);
  });

  it('wraps the document with escaped metadata and a truncation note', () => {
    const block = documentBlock(doc({ title: 'A "quoted" <title>', truncated: true }));
    expect(block).toContain('<document title="A quoted title" author="Ann Writer" site="Example" url="https://example.com/gardens">');
    expect(block).toContain('Gardens need water.');
    expect(block).toMatch(/<\/document>\n\n\[The document is longer/);
    expect(documentBlock(doc({ author: null, siteName: null, url: null }))).toMatch(/^<document title="On Gardens">\n/);
  });
});

// ---------------------------------------------------------------------------- request shape

describe('request parameters', () => {
  it('summarize: default model, stable system prompt, cached document block, medium effort, fallbacks', () => {
    const p = buildParams({ action: 'summarize', doc: doc() });
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.system).toBe(SYSTEM_PROMPT);
    expect(p.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p.fallbacks).toBe('default');
    expect('thinking' in p).toBe(false);
    const content = p.messages[0].content as { type: string; text: string; cache_control?: unknown }[];
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(content[0].text).toMatch(/^<document /);
    expect(content[1].text).toMatch(/TL;DR/);
    expect(content[1].text).toMatch(/5 to 8 bullet points/);
  });

  it('the document prefix is identical across actions (prompt cache reuse)', () => {
    const a = buildParams({ action: 'summarize', doc: doc() });
    const b = buildParams({ action: 'ask', doc: doc(), question: 'Why?' });
    expect((a.messages[0].content as { text: string }[])[0]).toEqual((b.messages[0].content as { text: string }[])[0]);
    expect(a.system).toBe(b.system);
  });

  it('ask: includes the question and asks for quotes', () => {
    const p = buildParams({ action: 'ask', doc: doc(), question: 'What do gardens need?' });
    const instr = (p.messages[0].content as { text: string }[])[1].text;
    expect(instr).toContain('<question>\nWhat do gardens need?\n</question>');
    expect(instr).toMatch(/quote/i);
  });

  it('suggestTags: JSON schema output at low effort with existing and current tags', () => {
    const p = buildParams({ action: 'suggestTags', doc: doc(), existingTags: ['gardening', 'water'], currentTags: ['plants'] });
    expect(p.output_config).toEqual({
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'], additionalProperties: false },
      },
    });
    const instr = (p.messages[0].content as { text: string }[])[1].text;
    expect(instr).toContain('<existing_tags>\ngardening, water\n</existing_tags>');
    expect(instr).toContain('do not suggest them again: plants');
    expect(buildParams({ action: 'suggestTags', doc: doc() }).messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('no tags yet') })]),
    );
  });

  it('ANTHROPIC_MODEL overrides the model; fallbacks only for models that support them, and can be switched off', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-5-5';
    const p = buildParams({ action: 'summarize', doc: doc() });
    expect(p.model).toBe('claude-haiku-5-5');
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
    delete process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_FALLBACKS = 'off';
    expect(buildParams({ action: 'summarize', doc: doc() }).fallbacks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- API calls (mock server)

describe('runAi against a mock Messages API', () => {
  it('sends the request and returns the text blocks', async () => {
    replies.push({ status: 200, body: message('TL;DR: Gardens need care.\n\n- Water\n- Light') });
    const r = await runAi(client(), { action: 'summarize', doc: doc() });
    expect(r).toEqual({ text: 'TL;DR: Gardens need care.\n\n- Water\n- Light', model: DEFAULT_MODEL });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toMatch(/^\/v1\/messages/);
    expect(captured[0].headers['x-api-key']).toBe('sk-test');
    expect(String(captured[0].headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(captured[0].body).toMatchObject({ model: DEFAULT_MODEL, fallbacks: 'default', system: SYSTEM_PROMPT });
    expect(captured[0].body).not.toHaveProperty('betas');
  });

  it('reports the model that actually answered (after a fallback)', async () => {
    replies.push({ status: 200, body: message('answer', { model: 'claude-opus-4-8' }) });
    expect((await runAi(client(), { action: 'ask', doc: doc(), question: 'q' })).model).toBe('claude-opus-4-8');
  });

  it('a refusal becomes failed-precondition', async () => {
    replies.push({ status: 200, body: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) });
    await expect(runAi(client(), { action: 'summarize', doc: doc() })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('an empty answer is an error', async () => {
    replies.push({ status: 200, body: message('   ') });
    await expect(runAi(client(), { action: 'summarize', doc: doc() })).rejects.toMatchObject({ code: 'internal' });
  });

  const errorBody = (type: string) => ({ type: 'error', error: { type, message: 'nope' } });
  const cases: [number, string, string][] = [
    [401, 'authentication_error', 'failed-precondition'],
    [403, 'permission_error', 'failed-precondition'],
    [429, 'rate_limit_error', 'resource-exhausted'],
    [400, 'invalid_request_error', 'internal'],
    [500, 'api_error', 'unavailable'],
    [529, 'overloaded_error', 'unavailable'],
  ];
  for (const [status, type, code] of cases) {
    it(`HTTP ${status} maps to ${code}`, async () => {
      replies.push({ status, body: errorBody(type) });
      const err = await runAi(client(), { action: 'ask', doc: doc(), question: 'q' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpsError);
      expect((err as HttpsError).code).toBe(code);
    });
  }

  it('connection failures map to unavailable', async () => {
    const dead = new Anthropic({ apiKey: 'k', baseURL: 'http://127.0.0.1:9', maxRetries: 0 });
    await expect(runAi(dead, { action: 'ask', doc: doc(), question: 'q' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('aiClient reads the key and base URL from the environment', async () => {
    expect(() => aiClient()).toThrow('AI is not configured');
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    process.env.ANTHROPIC_BASE_URL = baseURL;
    replies.push({ status: 200, body: message('{"tags":["Gardening","#Water","plants"]}') });
    const r = await runAi(aiClient(), { action: 'suggestTags', doc: doc(), currentTags: ['plants'] });
    expect(captured[0].headers['x-api-key']).toBe('sk-env');
    expect(parseTags(r.text, ['plants'])).toEqual(['gardening', 'water']);
  });
});

// ---------------------------------------------------------------------------- parsing helpers

describe('parsing', () => {
  it('parseTags: strict JSON, embedded JSON, bare arrays, normalisation, limit', () => {
    expect(parseTags('{"tags":["AI","Machine Learning","ai"]}')).toEqual(['ai', 'machine-learning']);
    expect(parseTags('Sure: {"tags": ["x", "y"]} done')).toEqual(['x', 'y']);
    expect(parseTags('["a","b"]')).toEqual(['a', 'b']);
    expect(parseTags('{"tags":["a","b","c","d","e","f","g"]}')).toHaveLength(5);
    expect(parseTags('{"tags":["a", 3, null, "b"]}', ['B'])).toEqual(['a']);
    expect(() => parseTags('no json here')).toThrow(HttpsError);
    expect(() => parseTags('{"labels":[]}')).toThrow(HttpsError);
  });

  it('topTags ranks by frequency, then name, capped', () => {
    expect(topTags([['b', 'a'], ['a'], null, 'x', ['c', 'b'], ['a']])).toEqual(['a', 'b', 'c']);
    expect(topTags([['a', 'b', 'c']], 2)).toEqual(['a', 'b']);
  });

  it('parseAiInput validates the request', () => {
    expect(parseAiInput({ itemId: 'i1', action: 'summarize' })).toEqual({ itemId: 'i1', action: 'summarize', question: '', force: false });
    expect(parseAiInput({ itemId: 'i1', action: 'summarize', force: true }).force).toBe(true);
    expect(parseAiInput({ itemId: 'i1', action: 'ask', question: '  Why?  ' }).question).toBe('Why?');
    const bad = [
      null,
      { action: 'summarize' },
      { itemId: 'a/b', action: 'summarize' },
      { itemId: 'i1', action: 'translate' },
      { itemId: 'i1', action: 'ask' },
      { itemId: 'i1', action: 'ask', question: '   ' },
      { itemId: 'i1', action: 'ask', question: 'x'.repeat(2001) },
    ];
    for (const b of bad) expect(() => parseAiInput(b)).toThrow(HttpsError);
  });
});
