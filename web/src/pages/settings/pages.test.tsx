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

const config = { ai: false, telegramBot: null as string | null, inboundEmailDomain: null as string | null, loaded: true };
const integrations: Record<string, unknown> = { telegram: null, email: null };
const views = [{ id: 'v1', name: 'AI reading', params: 'tag=ai', order: 0, createdAt: null }];
const rules = [
  {
    id: 'r1',
    name: '',
    enabled: true,
    match: { field: 'domain', op: 'is', value: 'example.com' },
    actions: { addTags: ['ex'], categoryId: 'c1' },
    createdAt: null,
  },
];

vi.mock('../../native', () => ({ openExternal: vi.fn(), isNative: () => false }));
vi.mock('../../lib/config', () => ({ useConfig: () => config, REPO_URL: 'https://github.com/example/readlater' }));
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
    useViews: () => views,
    useRules: () => rules,
    useIntegration: (name: string) => integrations[name],
    updateView: vi.fn(() => Promise.resolve()),
    reorderViews: vi.fn(() => Promise.resolve()),
    deleteView: vi.fn(() => Promise.resolve()),
    createRule: vi.fn(() => Promise.resolve('r2')),
    updateRule: vi.fn(() => Promise.resolve()),
    deleteRule: vi.fn(() => Promise.resolve()),
    createTelegramLink: vi.fn(() => Promise.resolve({ url: 'https://t.me/rl_bot?start=tok' })),
    unlinkTelegram: vi.fn(() => Promise.resolve({ ok: true })),
    getInboundEmail: vi.fn(() => Promise.resolve({ address: 'abc123@in.example.com' })),
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
    expect(ids).toEqual([
      '#appearance',
      '#reader',
      '#categories',
      '#tags',
      '#views',
      '#rules',
      '#link',
      '#saving',
      '#extension',
      '#bookmarklets',
      '#telegram',
      '#email',
      '#insights',
      '#import',
      '#export',
      '#account',
    ]);
    for (const id of ids) expect(container.querySelector(id!)).not.toBeNull();
    expect(container.textContent).toContain('Work');
    expect(container.textContent).toContain('#ai');
    expect(container.textContent).toContain('2 items');
    expect(container.textContent).toContain('me@example.com');
    const open = [...container.querySelectorAll('.set-bookmarklet')].find((a) => a.textContent === 'Open in Readlater');
    expect(decodeURIComponent(open!.getAttribute('href')!.slice('javascript:'.length))).toContain('"https://readlater.test/add?url="+encodeURIComponent(location.href)');
    expect(container.querySelector('#views')?.textContent).toContain('AI reading');
    expect(container.querySelector('#views')?.textContent).toContain('#ai');
    expect(container.querySelector('#rules')?.textContent).toContain('When site is “example.com” → add #ex, category Work');
    expect(container.querySelector('#telegram')?.textContent).toContain('not set up on this server');
    expect(container.querySelector('#email')?.textContent).toContain('not set up on this server');
    expect(container.querySelector('#insights a[href="/stats"]')).not.toBeNull();
  });

  it('switches to sepia and picks a bundled font', () => {
    render(<Settings />);
    act(() => button('Sepia').click());
    expect(document.documentElement.dataset.theme).toBe('sepia');
    expect(document.documentElement.dataset.scheme).toBe('light');
    act(() => button('Literata').click());
    expect(JSON.parse(localStorage.getItem('rl.fontFamily')!)).toBe('literata');
    expect((container.querySelector('.set-preview p') as HTMLElement).style.fontFamily).toBe('var(--font-literata)');
    const auto = [...container.querySelectorAll('[role="switch"]')].find((b) => b.getAttribute('aria-labelledby') && container.querySelector(`#${CSS.escape(b.getAttribute('aria-labelledby')!)}`)?.textContent === 'Archive automatically when I reach the end') as HTMLButtonElement;
    expect(auto.getAttribute('aria-checked')).toBe('false');
    act(() => auto.click());
    expect(JSON.parse(localStorage.getItem('rl.autoArchive')!)).toBe(true);
    act(() => button('System').click());
    act(() => button('Serif').click());
    act(() => auto.click());
  });

  it('creates a key for the browser extension and shows server URL + key', async () => {
    render(<Settings />);
    act(() => button('Create key for extension').click());
    await flush();
    expect(data.createApiKey).toHaveBeenLastCalledWith('Browser extension');
    const keys = [...container.querySelectorAll('#extension .set-key')].map((k) => k.textContent);
    expect(keys).toEqual(['https://readlater.test', 'rl_secretkey']);
  });

  it('generates the key-based bookmarklet', async () => {
    render(<Settings />);
    act(() => button('Generate').click());
    await flush();
    expect(data.createApiKey).toHaveBeenLastCalledWith('Bookmarklet', 'save');
    const save = [...container.querySelectorAll('.set-bookmarklet')].find((a) => a.textContent === 'Save to Readlater')!;
    const href = save.getAttribute('href')!;
    expect(href).toMatch(/^javascript:/);
    expect(href).not.toMatch(/[\s"#%](?![0-9A-F]{2})/);
    const opened: unknown[][] = [];
    const fn = new Function('window', 'location', 'document', 'encodeURIComponent', decodeURIComponent(href.slice('javascript:'.length)));
    fn({ open: (...a: unknown[]) => opened.push(a) }, { href: 'https://site.test/a b?x=1#y' }, { title: 'Hi & bye' }, encodeURIComponent);
    expect(opened).toEqual([
      [
        'https://readlater.test/api/save?key=rl_secretkey&source=bookmarklet&url=https%3A%2F%2Fsite.test%2Fa%20b%3Fx%3D1%23y&title=Hi%20%26%20bye',
        'rl',
        'width=420,height=260',
      ],
    ]);
  });

  it('connects Telegram when the bot is configured', async () => {
    config.telegramBot = 'rl_bot';
    try {
      render(<Settings />);
      act(() => button('Connect Telegram').click());
      await flush();
      const link = [...container.querySelectorAll('#telegram a')].find((a) => a.textContent === 'Open @rl_bot in Telegram');
      expect(link?.getAttribute('href')).toBe('https://t.me/rl_bot?start=tok');
      integrations.telegram = { chatId: 1, username: '@alice', linkedAt: null };
      render(<Settings />);
      expect(container.querySelector('#telegram')?.textContent).toContain('Connected as @alice');
      integrations.telegram = { chatId: 2, username: 'Alice Liddell', linkedAt: null };
      render(<Settings />);
      expect(container.querySelector('#telegram')?.textContent).toContain('Connected as Alice Liddell');
    } finally {
      config.telegramBot = null;
      integrations.telegram = null;
    }
  });

  it('shows the newsletter address when email is configured', async () => {
    config.inboundEmailDomain = 'in.example.com';
    try {
      render(<Settings />);
      act(() => button('Create my address').click());
      await flush();
      expect(container.querySelector('#email .set-key')?.textContent).toBe('abc123@in.example.com');
    } finally {
      config.inboundEmailDomain = null;
    }
  });

  it('adds an auto rule', async () => {
    render(<Settings />);
    act(() => button('New rule').click());
    const form = container.querySelector('.set-rule-form') as HTMLFormElement;
    act(() => (form.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(form.textContent).toContain('Enter a value to match');
    const value = form.querySelector('input[aria-label="Value"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(value, 'news.example.org');
      value.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => (form.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(form.textContent).toContain('Choose at least one action');
    const fav = [...form.querySelectorAll('label.set-check')].find((l) => l.textContent?.includes('favorites'))!.querySelector('input')!;
    act(() => fav.click());
    act(() => (form.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(data.createRule).toHaveBeenCalledWith({
      name: '',
      enabled: true,
      match: { field: 'domain', op: 'is', value: 'news.example.org' },
      actions: { favorite: true },
    });
    expect(container.querySelector('.set-rule-form')).toBeNull();
    // Toggle the existing rule off.
    act(() => (container.querySelector('#rules [role="switch"]') as HTMLButtonElement).click());
    expect(data.updateRule).toHaveBeenCalledWith('r1', { enabled: false });
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
