import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, generateLoginCode, isWellFormedCode, normalizeLoginCode } from '../src/auth';
import { cleanKeyName, generateApiKey, isApiKeyFormat } from '../src/apiKeys';
import { bodyFields, parseSaveRequest, routeOf, savedPage, wantsHtml } from '../src/api';
import { decideAction, donePatch, errorMessage, fileKind, itemKeywords } from '../src/processLogic';
import type { Extracted } from '../src/extract/types';

describe('login codes', () => {
  it('generates 8 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateLoginCode();
      expect(c).toHaveLength(8);
      expect([...c].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
      expect(isWellFormedCode(c)).toBe(true);
    }
    expect(CODE_ALPHABET).not.toMatch(/[IOL01]/);
  });
  it('normalises case, spaces and dashes', () => {
    expect(normalizeLoginCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeLoginCode('ab cd ef gh')).toBe('ABCDEFGH');
    expect(normalizeLoginCode(12345678)).toBe('');
    expect(isWellFormedCode('ABCDEFG')).toBe(false);
    expect(isWellFormedCode('ABCDEFGI')).toBe(false); // I is not in the alphabet
  });
});

describe('api keys', () => {
  it('format rl_ + 40 base62', () => {
    const k = generateApiKey();
    expect(k).toMatch(/^rl_[A-Za-z0-9]{40}$/);
    expect(isApiKeyFormat(k)).toBe(true);
    expect(isApiKeyFormat('rl_short')).toBe(false);
    expect(generateApiKey()).not.toBe(k);
  });
  it('cleans names', () => {
    expect(cleanKeyName('  My   phone ')).toBe('My phone');
    expect(cleanKeyName('')).toBe('API key');
    expect(cleanKeyName(undefined)).toBe('API key');
    expect(cleanKeyName('x'.repeat(100))).toHaveLength(60);
  });
});

describe('api request parsing', () => {
  const KEY = 'rl_' + 'a'.repeat(40);
  it('routes with and without the /api prefix', () => {
    expect(routeOf('/api/save')).toBe('/save');
    expect(routeOf('/save')).toBe('/save');
    expect(routeOf('/api/save/')).toBe('/save');
    expect(routeOf('/api/health')).toBe('/health');
    expect(routeOf('/api')).toBe('/');
    expect(routeOf('')).toBe('/');
  });
  it('JSON body with bearer auth, tags array and category name', () => {
    const p = parseSaveRequest({
      method: 'POST',
      query: {},
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: { url: 'https://example.com/a', title: 'Hello', tags: ['One', '#two'], category: 'Work' },
    });
    expect(p).toEqual({ key: KEY, url: 'https://example.com/a', title: 'Hello', tags: ['one', 'two'], category: 'Work' });
  });
  it('GET query parameters with comma tags', () => {
    const p = parseSaveRequest({ method: 'GET', query: { url: 'https://example.com/b', key: KEY, tags: 'a,b' }, headers: {} });
    expect(p).toMatchObject({ key: KEY, url: 'https://example.com/b', tags: ['a', 'b'], title: null, category: null });
  });
  it('text/plain body containing a URL (raw body fallback)', () => {
    const p = parseSaveRequest({
      method: 'POST',
      query: { key: KEY },
      headers: { 'content-type': 'text/plain' },
      body: {},
      rawBody: Buffer.from('Check this out https://example.com/c!'),
    });
    expect(p.url).toBe('https://example.com/c');
    expect(p.key).toBe(KEY);
  });
  it('form-encoded body (string or parsed)', () => {
    const raw = `url=${encodeURIComponent('https://example.com/d?x=1&y=2')}&title=T&key=${KEY}&tags=x%2Cy`;
    const p1 = parseSaveRequest({ method: 'POST', query: {}, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: raw });
    expect(p1).toMatchObject({ url: 'https://example.com/d?x=1&y=2', title: 'T', key: KEY, tags: ['x', 'y'] });
    const p2 = parseSaveRequest({ method: 'POST', query: {}, headers: {}, body: { url: 'https://example.com/e', key: KEY } });
    expect(p2.url).toBe('https://example.com/e');
  });
  it('body wins over query; text field used as fallback', () => {
    const p = parseSaveRequest({ method: 'POST', query: { url: 'https://q.example.com/' }, headers: {}, body: { text: 'shared: https://b.example.com/x' } });
    expect(p.url).toBe('https://q.example.com/');
    const p2 = parseSaveRequest({ method: 'POST', query: {}, headers: {}, body: { text: 'shared: https://b.example.com/x' } });
    expect(p2.url).toBe('https://b.example.com/x');
  });
  it('invalid JSON falls back to text', () => {
    expect(bodyFields('{nope https://example.com/z', undefined, 'application/json')).toEqual({ text: '{nope https://example.com/z' });
    expect(bodyFields(undefined, undefined, '')).toEqual({});
  });
  it('html only for browser GETs; escapes titles', () => {
    expect(wantsHtml('GET', 'text/html,application/xhtml+xml')).toBe(true);
    expect(wantsHtml('POST', 'text/html')).toBe(false);
    expect(wantsHtml('GET', '*/*')).toBe(false);
    const html = savedPage('<script>alert(1)</script>', true, '/item/abc');
    expect(html).toContain('Saved ✓');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('window.close()');
    expect(savedPage('Missing API key', false)).not.toContain('window.close');
  });
});

describe('processItem logic', () => {
  it('processes on transition into pending only', () => {
    expect(decideAction(undefined, { fetchStatus: 'pending' })).toBe('process');
    expect(decideAction({ fetchStatus: 'done' }, { fetchStatus: 'pending' })).toBe('process');
    expect(decideAction({ fetchStatus: 'uploading' }, { fetchStatus: 'pending' })).toBe('process');
    expect(decideAction({ fetchStatus: 'pending' }, { fetchStatus: 'pending', tags: ['x'] })).toBe('none');
    expect(decideAction(undefined, { fetchStatus: 'uploading' })).toBe('none');
    expect(decideAction({ fetchStatus: 'pending' }, undefined)).toBe('none');
  });
  it('never reacts to its own writes', () => {
    expect(decideAction({ fetchStatus: 'pending' }, { fetchStatus: 'processing' })).toBe('none');
    expect(decideAction({ fetchStatus: 'processing', title: 'a' }, { fetchStatus: 'done', title: 'b' })).toBe('none');
    expect(decideAction({ fetchStatus: 'processing' }, { fetchStatus: 'error' })).toBe('none');
    expect(decideAction(undefined, { fetchStatus: 'done' })).toBe('none');
  });
  it('re-indexes when indexed metadata changes on a finished item', () => {
    expect(decideAction({ fetchStatus: 'done', title: 'a' }, { fetchStatus: 'done', title: 'b' })).toBe('reindex');
    expect(decideAction({ fetchStatus: 'done', tags: ['a'] }, { fetchStatus: 'done', tags: ['a', 'b'] })).toBe('reindex');
    expect(decideAction({ fetchStatus: 'error', note: '' }, { fetchStatus: 'error', note: 'n' })).toBe('reindex');
    expect(decideAction({ fetchStatus: 'done', progress: 0.1 }, { fetchStatus: 'done', progress: 0.5 })).toBe('none');
    expect(decideAction({ fetchStatus: 'done', note: undefined }, { fetchStatus: 'done', note: null })).toBe('none');
  });

  const ex = (over: Partial<Extracted> = {}): Extracted => ({
    type: 'article',
    title: 'Extracted title',
    author: 'Ann',
    siteName: null,
    excerpt: 'An excerpt',
    imageUrl: null,
    publishedAt: new Date('2024-01-02T00:00:00Z'),
    html: '<p>hi</p>',
    text: 'hi',
    wordCount: 461,
    ...over,
  });

  it('donePatch respects titleLocked and keeps existing metadata as fallback', () => {
    const p = donePatch({ title: 'Mine', titleLocked: true, siteName: 'Feed site', tags: ['keep'] }, ex(), 2, null);
    expect(p.title).toBeUndefined();
    expect(p.siteName).toBe('Feed site');
    expect(p.author).toBe('Ann');
    expect(p.wordCount).toBe(461);
    expect(p.readingMinutes).toBe(3);
    expect(p.contentChunks).toBe(2);
    expect(p.fetchStatus).toBe('done');
    expect(p.fetchError).toBeNull();
    expect(p).not.toHaveProperty('tags');
    expect(p).not.toHaveProperty('categoryId');
    expect(p).not.toHaveProperty('file');
    expect((p.publishedAt as { toMillis(): number }).toMillis()).toBe(Date.parse('2024-01-02T00:00:00Z'));
  });
  it('donePatch sets title, type, file; null reading time for empty text', () => {
    const file = { path: 'users/u/files/i/original.pdf', name: 'a.pdf', contentType: 'application/pdf', size: 3 };
    const p = donePatch({ title: 'example.com/a.pdf', titleLocked: false, type: 'article' }, ex({ type: 'paper', wordCount: 0, publishedAt: null }), 0, file);
    expect(p.title).toBe('Extracted title');
    expect(p.type).toBe('paper');
    expect(p.file).toEqual(file);
    expect(p.wordCount).toBeNull();
    expect(p.readingMinutes).toBeNull();
    expect(p.publishedAt).toBeNull();
  });
  it('keywords include metadata, host, tags and body', () => {
    const kw = itemKeywords({ title: 'Café Society', author: 'Zoë', tags: ['deep-work'], note: 'remember', url: 'https://www.nytimes.com/x', paper: { authors: ['Vaswani'] } }, 'attention body');
    expect(kw).toEqual(expect.arrayContaining(['cafe', 'society', 'zoe', 'deep', 'work', 'remember', 'nytimes', 'com', 'vaswani', 'attention', 'body']));
  });
  it('error messages are trimmed to 300 chars', () => {
    expect(errorMessage(new Error('HTTP 404 fetching example.com'))).toBe('HTTP 404 fetching example.com');
    expect(errorMessage(new Error('x'.repeat(500))).length).toBe(300);
    expect(errorMessage(null)).toBe('Could not extract this item');
  });
  it('fileKind', () => {
    expect(fileKind({ contentType: 'application/pdf' })).toBe('pdf');
    expect(fileKind({ name: 'Book.EPUB' })).toBe('epub');
    expect(fileKind({ name: 'x' }, Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(fileKind({ name: 'x' }, Buffer.from('PK\u0003\u0004'))).toBe('epub');
    expect(fileKind({ name: 'x' })).toBeNull();
  });
});
