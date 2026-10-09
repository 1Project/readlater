import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchBuffer, isPrivateAddress, isPrivateHost, parseIPv6, safeLookup } from '../src/http';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPrivateHost / isPrivateAddress', () => {
  it.each([
    'localhost',
    'localhost.',
    'foo.localhost',
    'metadata',
    'metadata.google.internal',
    'printer.local',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.8',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '[::1]',
    '[::]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::ffff:169.254.169.254]',
    '[::ffff:a9fe:a9fe]',
    '[64:ff9b::a9fe:a9fe]',
    '[64:ff9b::10.0.0.1]',
    '[::127.0.0.1]',
    '[fc00::1]',
    '[fd12:3456::1]',
    '[fe80::1]',
    '[fec0::1]',
    '[ff02::1]',
    '[2002:7f00:1::]',
  ])('blocks %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['example.com', 'www.paulgraham.com', '93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '[2606:4700::1111]', '[::ffff:93.184.216.34]', '[64:ff9b::808:808]'])(
    'allows %s',
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );

  it('normalises hosts the way URL parsing does (decimal / hex / octal IPv4, mapped IPv6)', () => {
    for (const raw of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/']) {
      expect(isPrivateHost(new URL(raw).hostname)).toBe(true);
    }
  });

  it('parses IPv6 forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
    expect(isPrivateAddress('not an ip')).toBe(true);
  });
});

describe('safeLookup', () => {
  it('refuses names that resolve to a private address', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', { all: true }, (e) => resolve(e)));
    expect(err?.message).toBe('Refusing to fetch a private address');
  });
});

describe('fetchBuffer redirects', () => {
  it('checks every redirect target and refuses private ones', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      calls.push(String(input));
      expect(init?.redirect).toBe('manual');
      return new Response('moved', { status: 302, headers: { location: 'http://127.0.0.1:18081/computeMetadata' } });
    });
    await expect(fetchBuffer('https://attacker.example/')).rejects.toThrow('Refusing to fetch a private address');
    expect(calls).toEqual(['https://attacker.example/']);
  });

  it('refuses redirects to other schemes and to IPv6-mapped loopback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 301, headers: { location: 'file:///etc/passwd' } }));
    await expect(fetchBuffer('https://a.example/')).rejects.toThrow('Only http(s) URLs are supported');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 307, headers: { location: 'http://[::ffff:127.0.0.1]/' } }));
    await expect(fetchBuffer('https://a.example/')).rejects.toThrow('Refusing to fetch a private address');
  });

  it('follows public redirects (relative too) and reports the final URL', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://a.example/start') return new Response('', { status: 302, headers: { location: 'https://b.example/next' } });
      if (url === 'https://b.example/next') return new Response('', { status: 303, headers: { location: '/final?x=1' } });
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const r = await fetchBuffer('https://a.example/start');
    expect(r.body.toString()).toBe('done');
    expect(r.url).toBe('https://b.example/final?x=1');
    expect(calls).toEqual(['https://a.example/start', 'https://b.example/next', 'https://b.example/final?x=1']);
  });

  it('stops after too many redirects', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 302, headers: { location: `https://a.example/${++n}` } }));
    await expect(fetchBuffer('https://a.example/0')).rejects.toThrow(/Too many redirects/);
    expect(n).toBe(11);
  });

  it('refuses a private literal before fetching anything', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchBuffer('http://169.254.169.254/computeMetadata/v1/')).rejects.toThrow('Refusing to fetch a private address');
    await expect(fetchBuffer('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow('Refusing to fetch a private address');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchBuffer retries', () => {
  const connectError = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

  it('tries once more after a connection failure before any response', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++n === 1) throw connectError('UND_ERR_CONNECT_TIMEOUT');
      return new Response('ok', { status: 200 });
    });
    expect((await fetchBuffer('https://slow.example/')).body.toString()).toBe('ok');
    expect(n).toBe(2);
  });

  it('gives up after the second failure, and does not retry other errors', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n++;
      throw connectError('ECONNRESET');
    });
    await expect(fetchBuffer('https://down.example/')).rejects.toThrow('Could not fetch down.example: fetch failed');
    expect(n).toBe(2);

    n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n++;
      throw new TypeError('fetch failed', { cause: new Error('certificate has expired') });
    });
    await expect(fetchBuffer('https://bad-tls.example/')).rejects.toThrow(/Could not fetch bad-tls\.example/);
    expect(n).toBe(1);
  });

  it('does not retry an HTTP error response', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n++;
      return new Response('busy', { status: 503 });
    });
    await expect(fetchBuffer('https://busy.example/')).rejects.toThrow('HTTP 503 fetching busy.example');
    expect(n).toBe(1);
  });
});

describe('fetchBuffer connections (real sockets)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('INTERNAL-SECRET'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('refuses the connection when the name resolves to a private address (DNS checked at connect time)', async () => {
    const guarded = new Agent({ connect: { lookup: safeLookup } });
    const err = await undiciFetch(`http://localhost:${port}/`, { dispatcher: guarded }).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    expect(err?.cause?.message).toBe('Refusing to fetch a private address');
    // Sanity check: the same request with a plain lookup reaches the server.
    const open = new Agent();
    expect(await (await undiciFetch(`http://localhost:${port}/`, { dispatcher: open })).text()).toBe('INTERNAL-SECRET');
    await Promise.all([guarded.close(), open.close()]);
  });
});
