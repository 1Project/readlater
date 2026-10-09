import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Highlight, Item, SavedView } from '../lib/types';

const DAY = 24 * 3600_000;
const now = Date.now();
const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Item['createdAt'];

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
    contentChunks: 1,
    file: null,
    feedId: null,
    paper: null,
    createdAt: ts(now - DAY),
    updatedAt: null,
    lastOpenedAt: null,
    archivedAt: null,
    ...extra,
  } as Item;
}

const items: Item[] = [
  item('a', { tags: ['ai'], status: 'archived', archivedAt: ts(now), wordCount: 2300 }),
  item('b', { tags: ['ai', 'go'] }),
  item('c', { status: 'archived', archivedAt: ts(now - DAY), wordCount: 700, siteName: 'The Blog' }),
];
const highlights = Array.from({ length: 8 }, (_, i) => ({
  id: `h${i}`,
  itemId: i % 2 ? 'a' : 'b',
  text: `Quote number ${i}`,
  note: i === 0 ? 'a note' : '',
  prefix: '',
  suffix: '',
  color: 'yellow',
  createdAt: ts(now - i * 1000),
  updatedAt: null,
})) as unknown as Highlight[];
let views: SavedView[] = [];

vi.mock('../native', () => ({ openExternal: vi.fn(), isNative: () => false }));
vi.mock('../lib/data', async (orig) => {
  const real = await orig<typeof import('../lib/data')>();
  return {
    ...real,
    useItems: () => items,
    useCategories: () => [],
    useHighlights: () => highlights,
    useViews: () => views,
    createView: vi.fn(() => Promise.resolve('v-new')),
  };
});

import * as data from '../lib/data';
import Library from './Library';
import Review from './Review';
import Stats from './Stats';
import { ToastProvider } from '../components/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let location = '';

function LocationProbe() {
  const l = useLocation();
  location = l.pathname + l.search;
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  views = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(el: React.ReactNode, path = '/') {
  act(() =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={el} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
}
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const key = (k: string) => act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

describe('Library saved views and select', () => {
  it('offers "Save view" for a filtered list and saves the canonical query', () => {
    render(<Library />, '/?tag=ai&sort=new');
    act(() => button('Save view')!.click());
    const input = document.querySelector('.dialog input') as HTMLInputElement;
    expect(input.value).toBe('#ai');
    act(() => button('Save', document.querySelector('.dialog-footer')!)!.click());
    expect(data.createView).toHaveBeenCalledWith('#ai', 'tag=ai');
  });

  it('shows saved views as chips and hides "Save view" when the view exists', () => {
    views = [{ id: 'v1', name: 'AI reading', params: 'tag=ai', order: 0, createdAt: null }];
    render(<Library />, '/?tag=ai');
    const nav = container.querySelector('nav[aria-label="Saved views"]')!;
    const chip = nav.querySelector('a')!;
    expect(chip.textContent).toBe('AI reading');
    expect(chip.getAttribute('href')).toBe('/?tag=ai');
    expect(chip.getAttribute('aria-current')).toBe('page');
    expect(button('Save view')).toBeUndefined();
  });

  it('has a Select mode and links to stats and review', () => {
    render(<Library />, '/?view=all');
    act(() => button('Select')!.click());
    expect(container.querySelectorAll('.item-check').length).toBe(3);
    expect(container.querySelector('.bulk-bar')).not.toBeNull();
    expect(container.querySelector('.library-footer a[href="/stats"]')).not.toBeNull();
    expect(container.querySelector('.library-footer a[href="/review"]')).not.toBeNull();
  });
});

describe('Stats page', () => {
  it('renders totals, weekly bars and rankings', () => {
    render(<Stats />, '/stats');
    const text = container.textContent ?? '';
    expect(text).toContain('Current streak');
    expect(text).toContain('2 days');
    expect(text).toContain('3,000');
    expect(text).toContain('about 13 min');
    expect(container.querySelectorAll('.stats-table tbody tr').length).toBe(12);
    expect(container.querySelector('.stats-table tbody tr th')?.textContent).toBe('This week');
    expect(container.querySelector('.stats-rank a')?.textContent).toBe('#ai');
    expect(text).toContain('The Blog');
    expect(text).toContain('Highlights8');
  });
});

describe('Review page', () => {
  it('walks through five highlights with buttons, keys and taps, then shuffles', () => {
    render(<Review />, '/review');
    const quote = () => container.querySelector('.review-quote')?.textContent;
    const seen = [quote()];
    expect(container.querySelector('.review-count')?.textContent).toBe('1 / 5');
    expect(container.querySelector('.review-source a')?.getAttribute('href')).toMatch(/^\/item\/[ab]$/);
    act(() => button('Next →')!.click());
    seen.push(quote());
    key('ArrowRight');
    seen.push(quote());
    key('ArrowLeft');
    expect(quote()).toBe(seen[1]);
    key('j');
    act(() => (container.querySelector('.review-card') as HTMLElement).click());
    seen.push(quote());
    expect(container.querySelector('.review-count')?.textContent).toBe('4 / 5');
    key('j');
    seen.push(quote());
    expect(new Set(seen).size).toBe(5);
    act(() => button('Finish')!.click());
    expect(container.textContent).toContain('Done for today');

    act(() => button('Review 5 more')!.click());
    expect(container.querySelector('.review-count')?.textContent).toBe('1 / 5');
    expect(container.textContent).toContain('shuffled');
  });

  it('is the same pick on every render of the day', () => {
    render(<Review />, '/review');
    const first = container.querySelector('.review-quote')?.textContent;
    act(() => root.unmount());
    root = createRoot(container);
    render(<Review />, '/review');
    expect(container.querySelector('.review-quote')?.textContent).toBe(first);
    expect(location).toBe('/review');
  });
});
