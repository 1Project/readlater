import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';

vi.mock('../../native', () => ({ openExternal: vi.fn() }));
vi.mock('../../lib/data', async (orig) => {
  const real = await orig<typeof import('../../lib/data')>();
  return {
    ...real,
    updateItem: vi.fn(() => Promise.resolve()),
    deleteItem: vi.fn(() => Promise.resolve()),
    refetchItem: vi.fn(() => Promise.resolve()),
    useItems: () => [],
    useCategories: () => [],
  };
});

import Dialog from '../Dialog';
import ItemList from '../ItemList';
import Menu from '../Menu';
import TagInput from '../TagInput';
import { ToastProvider, toast } from '../Toast';
import { ConfirmProvider, confirmDialog } from '../useConfirm';
import ProgressBar from '../ProgressBar';
import * as data from '../../lib/data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(node: ReactNode) {
  act(() => root.render(node));
}
function key(el: Element | Document, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}
const byText = (sel: string, text: string) => [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(text)) as HTMLElement | undefined;

describe('TagInput', () => {
  function Harness({ initial = [] as string[], suggestions = [] as string[], spy }: { initial?: string[]; suggestions?: string[]; spy?: (t: string[]) => void }) {
    const [tags, setTags] = useState(initial);
    return (
      <TagInput
        value={tags}
        onChange={(t) => {
          spy?.(t);
          setTags(t);
        }}
        suggestions={suggestions}
      />
    );
  }
  const chips = () => [...document.querySelectorAll('.tag-chip-label')].map((e) => e.textContent);

  it('adds on Enter, comma typing and blur; normalizes; removes with Backspace', () => {
    render(<Harness />);
    const input = document.querySelector('input')!;
    act(() => input.focus());
    typeInto(input, '#Machine Learning');
    key(input, 'Enter');
    expect(chips()).toEqual(['machine-learning']);
    typeInto(input, 'a, b,');
    expect(chips()).toEqual(['machine-learning', 'a', 'b']);
    expect(input.value).toBe('');
    typeInto(input, 'A'); // duplicate of 'a'
    key(input, 'Enter');
    expect(chips()).toEqual(['machine-learning', 'a', 'b']);
    key(input, 'Backspace');
    expect(chips()).toEqual(['machine-learning', 'a']);
    typeInto(input, 'pending');
    act(() => input.blur());
    expect(chips()).toEqual(['machine-learning', 'a', 'pending']);
  });

  it('removes a tag with its × button', () => {
    render(<Harness initial={['x', 'y']} />);
    click(document.querySelector('[aria-label="Remove tag x"]')!);
    expect(chips()).toEqual(['y']);
  });

  it('shows prefix suggestions and picks with tap or arrows', () => {
    render(<Harness suggestions={['react', 'reading', 'rust', 'go']} />);
    const input = document.querySelector('input')!;
    act(() => input.focus());
    typeInto(input, 're');
    const options = [...document.querySelectorAll('[role="option"]')].map((e) => e.textContent);
    expect(options).toEqual(['+ react', '+ reading']);
    click(byText('[role="option"]', 'reading')!);
    expect(chips()).toEqual(['reading']);
    typeInto(input, 'r');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(chips()).toEqual(['reading', 'react']);
  });

  it('lets Enter through when the field is empty (form submit)', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const input = document.querySelector('input')!;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  it('focuses the first field, closes on Esc and backdrop click, not on inner click', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Hello" footer={<button type="button">OK</button>}>
        <input id="first" />
      </Dialog>,
    );
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement?.id).toBe('first');
    key(document.activeElement!, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = document.querySelector('.dialog-backdrop')!;
    act(() => {
      document.querySelector('.dialog-body')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      (document.querySelector('.dialog-body') as HTMLElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      (backdrop as HTMLElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('only the topmost dialog reacts to Esc', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Dialog open onClose={outer} title="Outer">
          <p>a</p>
        </Dialog>
        <Dialog open onClose={inner} title="Inner">
          <p>b</p>
        </Dialog>
      </>,
    );
    key(document, 'Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="X">
        <p>hidden</p>
      </Dialog>,
    );
    expect(document.querySelector('.dialog')).toBeNull();
  });
});

describe('Menu', () => {
  it('opens on click, runs an item, closes on outside tap and Esc', () => {
    const onEdit = vi.fn();
    render(
      <div>
        <span id="outside">x</span>
        <Menu label="More" items={[{ label: 'Edit', onSelect: onEdit }, false, 'separator', { label: 'Delete', onSelect: () => {}, danger: true }]} />
      </div>,
    );
    const trigger = document.querySelector('[aria-haspopup="menu"]')!;
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(2);
    click(byText('[role="menuitem"]', 'Edit')!);
    expect(onEdit).toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    click(trigger);
    act(() => {
      document.getElementById('outside')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    click(trigger);
    key(document.activeElement ?? document, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('an open menu inside a dialog swallows Esc', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="D">
        <Menu label="More" items={[{ label: 'A', onSelect: () => {} }]} />
      </Dialog>,
    );
    click(document.querySelector('[aria-haspopup="menu"]')!);
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toast and confirm', () => {
  it('shows one toast at a time with an action', () => {
    render(<ToastProvider />);
    const undo = vi.fn();
    act(() => toast('First'));
    act(() => toast('Archived', { action: { label: 'Undo', onClick: undo } }));
    expect(document.querySelectorAll('.toast').length).toBe(1);
    expect(document.querySelector('.toast')!.textContent).toContain('Archived');
    click(byText('.toast-action', 'Undo')!);
    expect(undo).toHaveBeenCalled();
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('auto-dismisses after 3.5 s', () => {
    vi.useFakeTimers();
    try {
      render(<ToastProvider />);
      act(() => toast('Bye'));
      act(() => vi.advanceTimersByTime(3400));
      expect(document.querySelector('.toast')).not.toBeNull();
      act(() => vi.advanceTimersByTime(200));
      expect(document.querySelector('.toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirm resolves with the choice', async () => {
    render(<ConfirmProvider />);
    let p!: Promise<boolean>;
    act(() => {
      p = confirmDialog('Delete it?', { confirmLabel: 'Delete', danger: true });
    });
    expect(document.querySelector('.confirm-message')!.textContent).toBe('Delete it?');
    expect(document.activeElement?.textContent).toBe('Cancel'); // danger: Cancel focused
    click(byText('.dialog-footer button', 'Delete')!);
    await expect(p).resolves.toBe(true);
    act(() => {
      p = confirmDialog('Again?');
    });
    key(document, 'Escape');
    await expect(p).resolves.toBe(false);
  });
});

describe('ProgressBar', () => {
  it('clamps and exposes aria values', () => {
    render(<ProgressBar value={1.7} />);
    expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('100');
  });
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
    siteName: 'Example',
    excerpt: null,
    imageUrl: null,
    publishedAt: null,
    wordCount: 1000,
    readingMinutes: 5,
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

describe('ItemList / ItemRow', () => {
  it('pages 50 at a time', () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem(i));
    render(
      <MemoryRouter>
        <ItemList items={items} categories={[]} emptyText="Nothing" onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(document.querySelectorAll('.item-row').length).toBe(50);
    click(byText('button', 'Show more (70 left)')!);
    expect(document.querySelectorAll('.item-row').length).toBe(100);
    click(byText('button', 'Show more (20 left)')!);
    expect(document.querySelectorAll('.item-row').length).toBe(120);
    expect(byText('button', 'Show more')).toBeUndefined();
  });

  it('shows empty and loading states', () => {
    render(
      <MemoryRouter>
        <ItemList items={[]} categories={[]} emptyText="Nothing here" onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain('Nothing here');
    render(
      <MemoryRouter>
        <ItemList items={undefined} categories={[]} emptyText="Nothing here" onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain('Loading');
  });

  it('keyboard: j/k select, o opens, e archives, s favorites; ignored in inputs', () => {
    const onOpen = vi.fn();
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    render(
      <MemoryRouter>
        <input id="search" />
        <ItemList items={items} categories={[]} emptyText="" onOpen={onOpen} />
      </MemoryRouter>,
    );
    key(document.body, 'j');
    key(document.body, 'j');
    expect(document.querySelector('.item-row.selected')?.getAttribute('data-item-id')).toBe('id2');
    key(document.body, 'k');
    expect(document.querySelector('.item-row.selected')?.getAttribute('data-item-id')).toBe('id1');
    key(document.body, 'o');
    expect(onOpen).toHaveBeenCalledWith(items[0]);
    key(document.body, 's');
    expect(data.updateItem).toHaveBeenLastCalledWith('id1', { favorite: true });
    key(document.body, 'e');
    expect(data.updateItem).toHaveBeenLastCalledWith('id1', { status: 'archived' });
    key(document.getElementById('search')!, 'j');
    expect(document.querySelector('.item-row.selected')?.getAttribute('data-item-id')).toBe('id1');
  });

  it('row shows meta, chips, progress, error + retry and feed actions', () => {
    const onOpen = vi.fn();
    const items = [
      makeItem(1, { tags: ['ai'], categoryId: 'c1', progress: 0.4 }),
      makeItem(2, { fetchStatus: 'error', fetchError: 'Page not found (404)' }),
      makeItem(3, { location: 'feed' }),
    ];
    render(
      <MemoryRouter>
        <ItemList items={items} categories={[{ id: 'c1', name: 'Work', order: 0, createdAt: null }]} emptyText="" onOpen={onOpen} />
      </MemoryRouter>,
    );
    const rows = document.querySelectorAll('.item-row');
    expect(rows[0].querySelector('.item-meta')!.textContent).toBe('Example · Article · 5 min');
    expect(rows[0].textContent).toContain('#ai');
    expect(rows[0].textContent).toContain('Work');
    expect(rows[0].querySelector('[role="progressbar"]')).not.toBeNull();
    expect(rows[1].textContent).toContain('Page not found (404)');
    click(byText('.item-row button', 'Retry')!);
    expect(data.refetchItem).toHaveBeenCalledWith('id2');
    expect(rows[2].textContent).toContain('Save');
    expect(rows[2].textContent).toContain('Seen');
    click([...rows[2].querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!);
    expect(data.updateItem).toHaveBeenLastCalledWith('id3', { location: 'library', status: 'unread' });
    click(rows[0].querySelector('.item-title a')!);
    expect(onOpen).toHaveBeenCalledWith(items[0]);
  });
});
