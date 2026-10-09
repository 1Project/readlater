import { describe, expect, it } from 'vitest';
import {
  BASE62,
  cleanSaveUrl,
  clientIp,
  guessType,
  intersectIds,
  normalizeTags,
  placeholderTitle,
  randomString,
  readingMinutes,
  safeFileName,
  sha256,
  storageDownloadUrl,
  urlFromText,
  withTimeout,
} from '../src/util';
import { bucketDocId, stepWindow } from '../src/rateLimit';
import { clampLimit } from '../src/search';

describe('util', () => {
  it('sha256 hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('randomString uses only the alphabet and is not constant', () => {
    const a = randomString(200, 'AB');
    expect(a).toMatch(/^[AB]{200}$/);
    expect(a).toContain('A');
    expect(a).toContain('B');
    expect(randomString(40, BASE62)).toMatch(/^[A-Za-z0-9]{40}$/);
  });

  it('normalizeTags: array or comma string, lowercase, no #, unique, max 30/32 chars', () => {
    expect(normalizeTags(['#Foo', 'foo', ' Bar Baz ', '', 3])).toEqual(['foo', 'bar-baz']);
    expect(normalizeTags('a, b ,#C')).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(30);
    expect(normalizeTags(['x'.repeat(50)])[0]).toHaveLength(32);
  });

  it('urlFromText / cleanSaveUrl', () => {
    expect(urlFromText('look at https://example.com/a?b=1). nice')).toBe('https://example.com/a?b=1');
    expect(urlFromText('10.1145/3290605.3300234')).toBe('https://doi.org/10.1145/3290605.3300234');
    expect(urlFromText('example.com/x')).toBe('https://example.com/x');
    expect(urlFromText('just words')).toBeNull();
    expect(cleanSaveUrl('javascript:alert(1)')).toBeNull();
    expect(cleanSaveUrl('ftp://example.com/file')).toBeNull();
    expect(cleanSaveUrl(42)).toBeNull();
    expect(cleanSaveUrl('  https://news.ycombinator.com/item?id=1  ')).toBe('https://news.ycombinator.com/item?id=1');
  });

  it('guessType and placeholderTitle match the web client', () => {
    expect(guessType('https://x.com/jack/status/20')).toBe('tweet');
    expect(guessType('https://arxiv.org/abs/1706.03762')).toBe('paper');
    expect(guessType('https://example.com/a.PDF')).toBe('pdf');
    expect(guessType('https://www.youtube.com/watch?v=1')).toBe('video');
    expect(guessType('https://example.com/post')).toBe('article');
    expect(placeholderTitle('https://www.example.com/post/1')).toBe('example.com/post/1');
    expect(placeholderTitle('https://example.com/')).toBe('example.com');
  });

  it('readingMinutes = ceil(words/230)', () => {
    expect(readingMinutes(1)).toBe(1);
    expect(readingMinutes(230)).toBe(1);
    expect(readingMinutes(231)).toBe(2);
  });

  it('clientIp trusts only the hop appended by the front end (the last x-forwarded-for entry)', () => {
    // A client can send its own x-forwarded-for; Google's front end appends the real address after it.
    expect(clientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } })).toBe('203.0.113.9');
    expect(clientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': ['1.2.3.4', '198.51.100.7 '] } })).toBe('198.51.100.7');
    expect(clientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } })).toBe('203.0.113.9');
    expect(clientIp({ ip: '5.6.7.8', headers: {} })).toBe('5.6.7.8');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });

  it('storageDownloadUrl for prod and emulator', () => {
    expect(storageDownloadUrl('b.appspot.com', 'users/u/files/i/img/a b.png', 'tok', '')).toBe(
      'https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/users%2Fu%2Ffiles%2Fi%2Fimg%2Fa%20b.png?alt=media&token=tok',
    );
    expect(storageDownloadUrl('bk', 'p/q', 't', '127.0.0.1:9199')).toBe('http://127.0.0.1:9199/v0/b/bk/o/p%2Fq?alt=media&token=t');
    expect(storageDownloadUrl('bk', 'p', 't', 'http://localhost:9199/')).toBe('http://localhost:9199/v0/b/bk/o/p?alt=media&token=t');
  });

  it('safeFileName flattens paths and strips traversal', () => {
    expect(safeFileName('OEBPS/images/cover image.jpg')).toBe('OEBPS_images_cover_image.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('...', 'x')).toBe('x');
  });

  it('intersectIds keeps ids present in all lists, ordered by the shortest list', () => {
    expect(intersectIds([])).toEqual([]);
    expect(intersectIds([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
    expect(intersectIds([['a', 'b', 'c', 'd'], ['d', 'b'], ['b', 'd', 'x']])).toEqual(['d', 'b']);
    expect(intersectIds([['a'], []])).toEqual([]);
    expect(intersectIds([['a', 'a'], ['a']])).toEqual(['a']);
  });

  it('withTimeout rejects after the deadline', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'too slow')).rejects.toThrow('too slow');
    await expect(withTimeout(Promise.resolve(3), 1000, 'x')).resolves.toBe(3);
  });
});

describe('rate limit window', () => {
  const W = 1000;
  it('counts within a window and blocks at max', () => {
    let d = stepWindow(null, 0, W, 2);
    expect(d).toMatchObject({ allowed: true, next: { count: 1, windowStart: 0 } });
    d = stepWindow(d.next, 100, W, 2);
    expect(d).toMatchObject({ allowed: true, next: { count: 2, windowStart: 0 } });
    d = stepWindow(d.next, 200, W, 2);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(800);
  });
  it('resets when the window has passed (or clock went backwards)', () => {
    expect(stepWindow({ count: 5, windowStart: 0 }, 1000, W, 2)).toMatchObject({ allowed: true, next: { count: 1, windowStart: 1000 } });
    expect(stepWindow({ count: 5, windowStart: 5000 }, 1000, W, 2)).toMatchObject({ allowed: true, next: { count: 1, windowStart: 1000 } });
  });
  it('bucket ids are Firestore-safe and stable', () => {
    const id = bucketDocId('redeem:2001:db8::1/64');
    expect(id).toMatch(/^redeem_[0-9a-f]{40}$/);
    expect(bucketDocId('redeem:2001:db8::1/64')).toBe(id);
    expect(bucketDocId('redeem:1.2.3.4')).not.toBe(id);
  });
});

describe('search limit', () => {
  it('clamps', () => {
    expect(clampLimit(undefined)).toBe(200);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(9999)).toBe(500);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit('5')).toBe(200);
  });
});
