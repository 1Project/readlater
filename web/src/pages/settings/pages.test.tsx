import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Feed, Highlight, Item } from '../../lib/types';

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const NOW = Date.now();

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    url: `https://example.com/${id}`,
    type: 'article',
    location: 'library',
    status: 'unread',
    favorite: false,
    title: `Title ${id}`,
    titleLocked: false,
    author: null,
    siteName: null,
    excerpt: null,
    imageUrl: null,
    publishedAt: null,
    wordCount: null,
    readingMinutes: null,
    categoryId: null,
    tags: [],
    note: '',
    progress: 0,
    fetchStatus: 'done',
    fetchError: null,
    contentChunks: 0,
    file: null,
    feedId: null,
    paper: null,
    createdAt: null,
    updatedAt: null,
    lastOpenedAt: null,
    archivedAt: null,
    ...extra,
  } as Item;
}

const items: Item[] = [
  item('a', { tags: ['ai', 'long'], categoryId: 'c1' }),
  item('b', { tags: ['ai'] }),
  item('f1', { location: 'feed', feedId: 'feed1' }),
];
const categories = [{ id: 'c1', name: 'Work', order: 0, createdAt: null }] as Category[];
const feeds = [
  {
    id: 'feed1',
    url: 'https://blog.example.com/feed.xml',
    title: 'Example Blog',
    siteUrl: 'https://blog.example.com',
    categoryId: 'c1',
    tags: ['news'],
    fullText: false,
    lastFetchedAt: ts(NOW - 3 * 3600_000),
    lastError: null,
    createdAt: null,
  },
] as unknown as Feed[];
const highlights = [
  { id: 'h1', itemId: 'a', text: 'A wise sentence.', note: 'my note', prefix: '', suffix: '', createdAt: ts(NOW - 1000), updatedAt: null },
  { id: 'h2', itemId: 'b', text: 'Another quote', note: '', prefix: '', suffix: '', createdAt: ts(NOW - 5000), updatedAt: null },
] as unknown as Highlight[];

vi.mock('../../native', () => ({ openExternal: vi.fn(), isNative: () => false }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,AAAA')) } }));
vi.mock('../../lib/firebase', () => ({ publicUrl: () => 'https://readlater.test', getServices: () => ({}) }));
vi.mock('../../lib/data', async (orig) => {
  const real = await orig<typeof import('../../lib/data')>();
  return {
    ...real,
    useItems: () => items,
    useCategories: () => categories,
    useFeeds: () => feeds,
    useHighlights: () => highlights,
    useApiKeys: () => [{ id: 'k1', name: 'Phone', prefix: 'rl_abc', createdAt: ts(NOW), lastUsedAt: null }],
    useUser: () => ({ email: 'me@example.com', displayName: null, providerData: [{ providerId: 'google.com' }] }),
    createLoginCode: vi.fn(() => Promise.resolve({ code: 'ABCDEFGH', expiresAt: Date.now() + 600_000 })),
    addUrl: vi.fn((url: string) => Promise.resolve(`id-${url}`)),
    updateItemLater: vi.fn(),
    createApiKey: vi.fn(() => Promise.resolve({ id: 'k2', key: 'rl_secretkey' })),
  };
});

import * as data from '../../lib/data';
import Feeds from '../Feeds';
import Highlights from '../Highlights';
import Settings from '../Settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(el: React.ReactNode) {
  act(() => root.render(<MemoryRouter>{el}</MemoryRouter>));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

describe('Settings page', () => {
  it('renders every section with the index', () => {
    render(<Settings />);
    const ids = [...container.querySelectorAll('.set-index a')].map((a) => a.getAttribute('href'));
    expect(ids).toEqual(['#appearance', '#reader', '#categories', '#tags', '#link', '#saving', '#import', '#export', '#account']);
    for (const id of ids) expect(container.querySelector(id!)).not.toBeNull();
    expect(container.textContent).toContain('Work');
    expect(container.textContent).toContain('#ai');
    expect(container.textContent).toContain('2 items');
    expect(container.textContent).toContain('me@example.com');
    expect(container.querySelector('.set-bookmarklet')?.getAttribute('href')).toMatch(/^javascript:.*readlater\.test\/add\?url=/);
  });

  it('switches the theme', () => {
    render(<Settings />);
    act(() => button('E-ink').click());
    expect(document.documentElement.dataset.theme).toBe('eink');
    expect(button('E-ink').getAttribute('aria-pressed')).toBe('true');
    act(() => button('System').click());
  });

  it('generates a link code with QR', async () => {
    render(<Settings />);
    act(() => button('Generate code').click());
    await flush();
    expect(container.querySelector('.set-code')?.textContent).toBe('ABCD-EFGH');
    expect(container.querySelector('.set-qr')?.getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('imports pasted links, skipping saved ones', async () => {
    render(<Settings />);
    const ta = container.querySelector('#import-urls') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'https://example.com/a\nhttps://new.example.org/x\nhttps://new.example.org/y');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Import links').click());
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(vi.mocked(data.addUrl).mock.calls.map((c) => c[0])).toEqual(['https://new.example.org/x', 'https://new.example.org/y']);
    expect(container.querySelector('.set-progress')?.textContent).toContain('2 added');
    expect(container.querySelector('.set-progress')?.textContent).toContain('1 already saved');
  });

  it('creates an API key and shows it once', async () => {
    render(<Settings />);
    act(() => button('Create key').click());
    await flush();
    expect(container.querySelector('.set-key')?.textContent).toBe('rl_secretkey');
    expect(container.querySelector('.set-pre')?.textContent).toContain('Bearer rl_secretkey');
  });
});

describe('Feeds page', () => {
  it('lists feeds with meta and opens the edit dialog', () => {
    render(<Feeds />);
    expect(container.textContent).toContain('Example Blog');
    expect(container.textContent).toContain('updated 3h ago');
    expect(container.textContent).toContain('1 new');
    act(() => button('Edit').click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Fetch full text');
  });
});

describe('Highlights page', () => {
  it('groups by item, newest first, and filters', () => {
    render(<Highlights />);
    const titles = [...container.querySelectorAll('.hls-title')].map((t) => t.textContent);
    expect(titles).toEqual(['Title a', 'Title b']);
    expect(container.querySelector('.hls-title a')?.getAttribute('href')).toBe('/item/a');
    expect(container.textContent).toContain('my note');
    const input = container.querySelector('.hls-filter') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'another');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...container.querySelectorAll('.hls-title')].map((t) => t.textContent)).toEqual(['Title b']);
  });
});
