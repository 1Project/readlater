import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

export const fixture = (name: string): string => readFileSync(join(__dirname, name), 'utf8');
export const fixtureJson = <T = any>(name: string): T => JSON.parse(fixture(name)) as T;

type Reply = { status?: number; body?: string | Uint8Array; type?: string; headers?: Record<string, string> };
type Route = [RegExp | string, Reply | ((url: string) => Reply)];

/** Replace global fetch with a router; unmatched URLs return 404. Returns the spy (calls are recorded). */
export function mockFetch(routes: Route[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, reply] of routes) {
      const hit = typeof pattern === 'string' ? url === pattern || url.startsWith(pattern) : pattern.test(url);
      if (hit) {
        const r = typeof reply === 'function' ? reply(url) : reply;
        const body = r.body instanceof Uint8Array ? Buffer.from(r.body) : r.body ?? '';
        return new Response(body as any, {
          status: r.status ?? 200,
          headers: { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.headers ?? {}) },
        });
      }
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
}
