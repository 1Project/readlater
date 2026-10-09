import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feed as FeedDoc, Item } from '../lib/types';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    url: null,
    type: 'article',
    location: 'feed',
    status: 'unread',
    favorite: false,
    title: `Title ${id}`,
    titleLocked: false,
    author: null,
    siteName: 'Lighthouse Weekly',
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
    createdAt: null,
    updatedAt: null,
    lastOpenedAt: null,
    archivedAt: null,
    ...extra,
  } as Item;
}

const state = { items: [] as Item[], feeds: [] as FeedDoc[] };
const config = { ai: false, telegramBot: null as string | null, inboundEmailDomain: null as string | null, loaded: true };

vi.mock('../native', () => ({ openExternal: vi.fn(), isNative: () => false }));
vi.mock('../lib/config', () => ({ useConfig: () => config }));
vi.mock('../lib/firebase', () => ({ publicUrl: () => 'https://readlater.test', getServices: () => ({}) }));
vi.mock('../lib/data', async (orig) => {
  const real = await orig<typeof import('../lib/data')>();
  return {
    ...real,
    useItems: () => state.items,
    useFeeds: () => state.feeds,
    useCategories: () => [],
    prefetchContent: vi.fn(() => Promise.resolve()),
  };
});

import Feed from './Feed';

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
  state.items = [];
  state.feeds = [];
  config.inboundEmailDomain = null;
});

function render() {
  act(() => root.render(<MemoryRouter initialEntries={['/feed']}>{<Feed />}</MemoryRouter>));
}

describe('Feed page', () => {
  it('shows the start screen while there are no feeds and no feed items', () => {
    config.inboundEmailDomain = 'in.example.com';
    render();
    expect(container.textContent).toContain('No feeds yet');
    expect(container.querySelector('a[href="/settings#email"]')).not.toBeNull();
    expect(container.querySelectorAll('article.item-row')).toHaveLength(0);
  });

  it('lists newsletter items even without any RSS feed, without the feed filter', () => {
    state.items = [item('n1', { title: 'Issue 12: Storm season', source: 'email' }), item('lib', { location: 'library' })];
    render();
    expect(container.textContent).not.toContain('No feeds yet');
    const rows = [...container.querySelectorAll('article.item-row .item-title')].map((e) => e.textContent);
    expect(rows).toEqual(['Issue 12: Storm season']);
    expect(container.querySelector('select[aria-label="Filter by feed"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Filter by category"]')).not.toBeNull();
  });
});
