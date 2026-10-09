import { describe, expect, it } from 'vitest';
import type { Item } from '../lib/types';
import { nextUnread } from './nextUnread';

function item(id: string, created: number | null, extra: Partial<Item> = {}): Item {
  return {
    id,
    location: 'library',
    status: 'unread',
    createdAt: created == null ? null : ({ toMillis: () => created } as Item['createdAt']),
    ...extra,
  } as Item;
}

describe('nextUnread', () => {
  const items = [item('a', 500), item('b', 400), item('c', 300), item('d', 200, { status: 'archived' }), item('f', 450, { location: 'feed' })];

  it('returns the next older unread item in the same location', () => {
    expect(nextUnread(items, items[0])?.id).toBe('b');
    expect(nextUnread(items, items[1])?.id).toBe('c');
  });

  it('wraps to the newest and never returns the current item', () => {
    expect(nextUnread(items, items[2])?.id).toBe('a');
    expect(nextUnread([items[0]], items[0])).toBeNull();
  });

  it('works for an item that is no longer unread (archived while reading)', () => {
    const current = item('x', 350, { status: 'archived' });
    expect(nextUnread([...items, current], current)?.id).toBe('c');
  });

  it('stays in the feed for feed items', () => {
    const feedItems = [item('f1', 300, { location: 'feed' }), item('f2', 200, { location: 'feed' }), item('lib', 100)];
    expect(nextUnread(feedItems, feedItems[0])?.id).toBe('f2');
    expect(nextUnread(feedItems, feedItems[1])?.id).toBe('f1');
  });

  it('treats items still being saved (no createdAt) as the newest', () => {
    const list = [item('new', null), item('old', 100)];
    expect(nextUnread(list, list[1])?.id).toBe('new');
    expect(nextUnread(list, list[0])?.id).toBe('old');
  });
});
