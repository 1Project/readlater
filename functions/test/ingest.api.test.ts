import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyFields, lookupVariants, parseItemsQuery, parseSaveExtras, parseSaveRequest, rankTags } from '../src/api';
import { appConfig, generateInboundToken, parseDotenv, generateTelegramLinkToken, INBOUND_TOKEN_RE, optionalSecrets, publicUrl, safeEqual, TELEGRAM_LINK_TOKEN_RE } from '../src/integrations';

const KEY = 'rl_' + 'b'.repeat(40);
const json = (body: Record<string, unknown>, query: Record<string, unknown> = {}) => ({
  method: 'POST',
  query,
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body,
});

describe('save request extras', () => {
  it('extension body: html, note, source, category id in both fields', () => {
    const r = json({ url: 'https://example.com/a', source: 'extension', html: '<html><body>x</body></html>', note: '  my note ', category: 'cat_1', categoryId: 'cat_1', tags: ['A'] });
    expect(parseSaveRequest(r)).toMatchObject({ key: KEY, url: 'https://example.com/a', tags: ['a'], category: 'cat_1' });
    expect(parseSaveExtras(r)).toEqual({
      html: '<html><body>x</body></html>',
      note: 'my note',
      location: undefined,
      source: 'extension',
      categoryId: 'cat_1',
      category: 'cat_1',
    });
  });
  it('null clears the category; absent leaves it; empty string clears', () => {
    expect(parseSaveExtras(json({ url: 'https://e.com', category: null, categoryId: null }))).toMatchObject({ category: null, categoryId: null });
    expect(parseSaveExtras(json({ url: 'https://e.com' }))).toMatchObject({ category: undefined, categoryId: undefined, note: undefined });
    expect(parseSaveExtras(json({ url: 'https://e.com', category: '  ' }))).toMatchObject({ category: null });
    expect(parseSaveExtras(json({ url: 'https://e.com', category: '  Long   reads ' }))).toMatchObject({ category: 'Long reads' });
    // An explicitly empty note clears it (the extension's popup sends '' after deleting the note).
    expect(parseSaveExtras(json({ url: 'https://e.com', note: '' })).note).toBe('');
  });
  it('validates source and location; defaults to api', () => {
    expect(parseSaveExtras(json({ url: 'https://e.com', source: 'telegram', location: 'feed' }))).toMatchObject({ source: 'api', location: 'feed' });
    expect(parseSaveExtras(json({ url: 'https://e.com', source: 'Bookmarklet', location: 'trash' }))).toMatchObject({ source: 'bookmarklet', location: undefined });
  });
  it('GET query parameters (bookmarklet)', () => {
    const r = { method: 'GET', query: { url: 'https://e.com/x', key: KEY, source: 'bookmarklet', category: 'Work', note: 'n' }, headers: {} };
    expect(parseSaveExtras(r)).toMatchObject({ source: 'bookmarklet', category: 'Work', note: 'n', html: null });
  });
  it('accepts large JSON bodies that arrive unparsed (no 100 kB text cap)', () => {
    const html = `<p>${'word '.repeat(300_000)}</p>`;
    const raw = Buffer.from(JSON.stringify({ url: 'https://e.com/big', html }));
    expect(raw.length).toBeGreaterThan(1_000_000);
    const f = bodyFields(undefined, raw, 'text/plain');
    expect(f.url).toBe('https://e.com/big');
    expect(f.html).toBe(html);
    expect(parseSaveExtras({ method: 'POST', query: {}, headers: { 'content-type': 'text/plain' }, rawBody: raw }).html).toBe(html);
  });
});

describe('read endpoints helpers', () => {
  it('lookup variants toggle the trailing slash only without query/hash', () => {
    expect(lookupVariants('https://e.com/a')).toEqual(['https://e.com/a', 'https://e.com/a/']);
    expect(lookupVariants('https://e.com/a/')).toEqual(['https://e.com/a/', 'https://e.com/a']);
    expect(lookupVariants('https://e.com/a?x=1')).toEqual(['https://e.com/a?x=1']);
  });
  it('ranks tags by use, then name', () => {
    expect(rankTags([['b', 'a'], ['a'], ['c', 'b', 'a'], null, 'x', [1, 'c']])).toEqual(['a', 'b', 'c']);
  });
  it('parses the items query with bounds', () => {
    expect(parseItemsQuery({})).toEqual({ status: 'unread', location: 'library', limit: 20 });
    expect(parseItemsQuery({ status: 'archived', limit: '500', location: 'feed' })).toEqual({ status: 'archived', location: 'feed', limit: 100 });
    expect(parseItemsQuery({ status: 'all', limit: '0' })).toEqual({ status: 'all', location: 'library', limit: 1 });
    expect(parseItemsQuery({ status: 'weird', limit: 'abc' })).toEqual({ status: 'unread', location: 'library', limit: 20 });
  });
});

describe('integration config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('binds optional secrets only when the feature is on and no plain value exists', () => {
    for (const k of ['TELEGRAM_BOT_USERNAME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'INBOUND_EMAIL_DOMAIN', 'INBOUND_EMAIL_SECRET', 'AI_ENABLED', 'ANTHROPIC_API_KEY', 'READLATER_SECRETS']) delete process.env[k];
    expect(optionalSecrets('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'INBOUND_EMAIL_SECRET', 'ANTHROPIC_API_KEY')).toEqual([]);
    process.env.TELEGRAM_BOT_USERNAME = 'MyBot';
    process.env.INBOUND_EMAIL_DOMAIN = 'in.example.com';
    expect(optionalSecrets('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'INBOUND_EMAIL_SECRET', 'ANTHROPIC_API_KEY')).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'INBOUND_EMAIL_SECRET',
    ]);
    process.env.TELEGRAM_BOT_TOKEN = '123:abc'; // provided as plain env → not a secret
    process.env.READLATER_SECRETS = 'ANTHROPIC_API_KEY';
    expect(optionalSecrets('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY')).toEqual(['TELEGRAM_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY']);
    process.env.AI_ENABLED = '0';
    delete process.env.READLATER_SECRETS;
    expect(optionalSecrets('ANTHROPIC_API_KEY')).toEqual([]);
  });

  it('parses dotenv files', () => {
    expect(parseDotenv('# c\nA=1\nexport B = "two words"\nC=\'x=y\'\n\nbad line\nD=')).toEqual({ A: '1', B: 'two words', C: 'x=y', D: '' });
  });

  it('reads the switches from functions/.env.<project> during deploy-time analysis', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rl-env-'));
    writeFileSync(join(dir, '.env.demo-x'), 'TELEGRAM_BOT_USERNAME=my_bot\nAI_ENABLED=1\n');
    for (const k of ['TELEGRAM_BOT_USERNAME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'AI_ENABLED', 'ANTHROPIC_API_KEY', 'READLATER_SECRETS', 'FUNCTIONS_CONTROL_API']) delete process.env[k];
    process.env.GCLOUD_PROJECT = 'demo-x';
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      vi.resetModules();
      const outside = await import('../src/integrations');
      expect(outside.optionalSecrets('TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY')).toEqual([]); // not analysing: env only
      process.env.FUNCTIONS_CONTROL_API = 'true';
      vi.resetModules();
      const analysing = await import('../src/integrations');
      expect(analysing.optionalSecrets('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY')).toEqual([
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_WEBHOOK_SECRET',
        'ANTHROPIC_API_KEY',
      ]);
    } finally {
      process.chdir(cwd);
      vi.resetModules();
    }
  });

  it('reports features from the environment', () => {
    for (const k of ['TELEGRAM_BOT_USERNAME', 'TELEGRAM_BOT_TOKEN', 'INBOUND_EMAIL_DOMAIN', 'ANTHROPIC_API_KEY']) delete process.env[k];
    expect(appConfig()).toEqual({ ai: false, telegramBot: null, inboundEmailDomain: null });
    process.env.TELEGRAM_BOT_USERNAME = '@ReadBot';
    expect(appConfig().telegramBot).toBeNull(); // no token → bot not usable
    process.env.TELEGRAM_BOT_TOKEN = '1:x';
    process.env.INBOUND_EMAIL_DOMAIN = 'In.Example.com';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    expect(appConfig()).toEqual({ ai: true, telegramBot: 'ReadBot', inboundEmailDomain: 'in.example.com' });
  });

  it('public URL from PUBLIC_URL or the project', () => {
    process.env.PUBLIC_URL = 'https://read.example.com/';
    expect(publicUrl()).toBe('https://read.example.com');
    delete process.env.PUBLIC_URL;
    process.env.GCLOUD_PROJECT = 'my-proj';
    expect(publicUrl()).toBe('https://my-proj.web.app');
  });

  it('tokens and constant-time comparison', () => {
    const t = generateInboundToken();
    expect(t).toMatch(INBOUND_TOKEN_RE);
    expect(t).toHaveLength(10);
    expect(generateTelegramLinkToken()).toMatch(TELEGRAM_LINK_TOKEN_RE);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
