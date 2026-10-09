import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';

vi.mock('../../native', () => ({ openExternal: vi.fn(() => Promise.resolve()), isNative: () => false }));
vi.mock('../../lib/data', async (orig) => {
  const real = await orig<typeof import('../../lib/data')>();
  return {
    ...real,
    updateItem: vi.fn(() => Promise.resolve()),
    bulkUpdate: vi.fn(() => Promise.resolve()),
    bulkPatch: vi.fn(() => Promise.resolve()),
    bulkAddTags: vi.fn(() => Promise.resolve()),
    bulkDelete: vi.fn(() => Promise.resolve()),
    exportEpub: vi.fn(() => Promise.resolve({ url: 'https://storage.test/book.epub', name: 'book.epub' })),
    useItems: () => [],
    useCategories: () => [],
  };
});

import BulkBar, { SelectToggle, useSelection } from '../BulkActions';
import ItemList from '../ItemList';
import { ToastProvider } from '../Toast';
import { ConfirmProvider } from '../useConfirm';
import * as data from '../../lib/data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(data.bulkUpdate).mockClear();
  vi.mocked(data.bulkPatch).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(node: ReactNode) {
  act(() => root.render(<MemoryRouter>{node}</MemoryRouter>));
}
function click(el: Element | undefined | null) {
  if (!el) throw new Error('element not found');
  act(() => (el as HTMLElement).click());
}
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text) as HTMLButtonElement | undefined;
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function makeItem(i: number, over: Partial<Item> = {}): Item {
  return {
    id: `id${i}`,
    url: `https://example.com/${i}`,
    type: 'article',
    location: 'library',
    status: 'unread',
    favorite: false,
    title: `Item ${i}`,
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
    createdAt: null,
    updatedAt: null,
    lastOpenedAt: null,
    archivedAt: null,
    ...over,
  };
}

function Harness({ items, onOpen = () => {}, context }: { items: Item[]; onOpen?: (i: Item) => void; context?: 'library' | 'feed' }) {
  const selection = useSelection(items);
  const [, force] = useState(0);
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SelectToggle selection={selection} />
        <button type="button" onClick={() => force((n) => n + 1)}>
          rerender
        </button>
        <ItemList items={items} categories={[]} emptyText="" onOpen={onOpen} selectable={selection.active} checkedIds={selection.checkedIds} onCheck={selection.toggle} />
        {selection.active ? <BulkBar selection={selection} categories={[]} tagSuggestions={['ai']} context={context} /> : null}
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe('bulk select', () => {
  it('rows get checkboxes in select mode; tapping a row checks it instead of opening', () => {
    const onOpen = vi.fn();
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    render(<Harness items={items} onOpen={onOpen} />);
    expect(document.querySelector('.item-check')).toBeNull();
    expect(document.querySelector('.item-actions')?.hasAttribute('hidden')).toBe(false);

    click(button('Select'));
    expect(document.querySelectorAll('.item-check input').length).toBe(3);
    expect(document.querySelector('.item-actions')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.bulk-count')?.textContent).toBe('Tap items to select them');

    click(document.querySelector('[data-item-id="id1"] .item-title a'));
    click(document.querySelector('[data-item-id="id2"] .item-body'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.querySelector('.bulk-count')?.textContent).toBe('2 selected');
    expect(document.querySelectorAll('.item-row.checked').length).toBe(2);
    click(document.querySelector('[data-item-id="id2"] .item-check input'));
    expect(document.querySelector('.bulk-count')?.textContent).toBe('1 selected');

    click(button('Select all (3)'));
    expect(document.querySelector('.bulk-count')?.textContent).toBe('3 selected');
    expect(button('Select all (3)')).toBeUndefined();
    click(button('Clear'));
    expect(document.querySelector('.bulk-count')?.textContent).toBe('Tap items to select them');

    click(button('Done'));
    expect(document.querySelector('.bulk-bar')).toBeNull();
    expect(document.querySelector('.item-check')).toBeNull();
  });

  it('archives the selection with undo restoring each item', () => {
    const items = [makeItem(1), makeItem(2, { status: 'archived' }), makeItem(3)];
    render(<Harness items={items} />);
    click(button('Select'));
    click(button('Select all (3)'));
    click(button('Archive', document.querySelector('.bulk-bar-actions')!));
    expect(data.bulkUpdate).toHaveBeenCalledWith(['id1', 'id3'], { status: 'archived' });
    expect(document.body.textContent).toContain('Archived 2 items');
    click(button('Undo'));
    expect(data.bulkPatch).toHaveBeenCalledWith([
      { id: 'id1', patch: { status: 'unread' } },
      { id: 'id3', patch: { status: 'unread' } },
    ]);
    expect(document.querySelector('.bulk-count')?.textContent).toBe('Tap items to select them');
  });

  it('favorites, tags and deletes', async () => {
    const items = [makeItem(1, { tags: ['x'] }), makeItem(2)];
    render(<Harness items={items} />);
    click(button('Select'));
    click(button('Select all (2)'));
    click(button('Favorite', document.querySelector('.bulk-bar-actions')!));
    expect(data.bulkUpdate).toHaveBeenLastCalledWith(['id1', 'id2'], { favorite: true });

    click(button('Select all (2)'));
    click(button('Add tags…'));
    const input = document.querySelector('.dialog .tag-input-field') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reading');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    click(button('Add tags', document.querySelector('.dialog-footer')!));
    expect(data.bulkAddTags).toHaveBeenCalledWith(items, ['reading']);

    click(button('Select all (2)'));
    click(button('Other bulk actions'));
    click([...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes('Delete')));
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete 2 items?');
    click(button('Delete', document.querySelector('.dialog-footer')!));
    await flush();
    expect(data.bulkDelete).toHaveBeenCalledWith(['id1', 'id2']);
  });

  it('exports an EPUB and offers feed actions in the feed', async () => {
    const items = [makeItem(1, { location: 'feed' }), makeItem(2, { location: 'feed' })];
    render(<Harness items={items} context="feed" />);
    click(button('Select'));
    click(button('Select all (2)'));
    const bar = document.querySelector('.bulk-bar-actions')!;
    expect(button('Move to Library', bar)).toBeDefined();
    expect(button('Mark seen', bar)).toBeDefined();
    click(button('Move to Library', bar));
    expect(data.bulkUpdate).toHaveBeenLastCalledWith(['id1', 'id2'], { location: 'library', status: 'unread' });

    click(button('Select all (2)'));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    click(button('Other bulk actions'));
    click([...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes('Export EPUB')));
    await flush();
    expect(data.exportEpub).toHaveBeenCalledWith(['id1', 'id2']);
    expect(clickSpy).toHaveBeenCalled();
    expect(document.body.textContent).toContain('EPUB ready: book.epub');
    clickSpy.mockRestore();
  });

  it('x toggles the keyboard-selected row; Esc leaves select mode', () => {
    const items = [makeItem(1), makeItem(2)];
    render(<Harness items={items} />);
    click(button('Select'));
    const key = (k: string) => act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    key('j');
    key('x');
    expect(document.querySelector('.bulk-count')?.textContent).toBe('1 selected');
    key('x');
    expect(document.querySelector('.bulk-count')?.textContent).toBe('Tap items to select them');
    key('Escape');
    expect(document.querySelector('.bulk-bar')).toBeNull();
  });
});
