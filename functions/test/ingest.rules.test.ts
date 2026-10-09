import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { matchRule, needsFeedTitle, ruleOf, rulesPatch, wantsRules, withRules, type Rule } from '../src/rules';

const rule = (field: Rule['match']['field'], op: Rule['match']['op'], value: string, actions: Rule['actions'] = {}, enabled = true): Rule => ({
  id: `${field}-${op}-${value}`,
  name: 'r',
  enabled,
  match: { field, op, value },
  actions,
});

const item = {
  url: 'https://news.Example.com/2026/ai-and-you?ref=rss',
  title: 'AI and You: A Field Guide',
  type: 'article',
  source: 'extension',
  feedId: 'feed123',
  tags: ['reading'],
};

describe('rule documents', () => {
  it('validates and normalises stored rules', () => {
    const r = ruleOf('x', {
      name: 'News',
      enabled: true,
      match: { field: 'domain', op: 'is', value: ' example.com ' },
      actions: { addTags: ['#News', 'AI'], categoryId: 'cat1', location: 'library', favorite: true, archive: false, bogus: 1 },
    });
    expect(r).toEqual({
      id: 'x',
      name: 'News',
      enabled: true,
      match: { field: 'domain', op: 'is', value: 'example.com' },
      actions: { addTags: ['news', 'ai'], categoryId: 'cat1', location: 'library', favorite: true, archive: false },
    });
    expect(ruleOf('y', { match: { field: 'domain', op: 'is', value: '' }, actions: {} })).toBeNull();
    expect(ruleOf('y', { match: { field: 'body', op: 'is', value: 'x' }, actions: {} })).toBeNull();
    expect(ruleOf('y', { match: { field: 'url', op: 'regex', value: 'x' }, actions: {} })).toBeNull();
    expect(ruleOf('y', undefined)).toBeNull();
    expect(ruleOf('z', { match: { field: 'url', op: 'contains', value: 'x' }, actions: { categoryId: null, location: 'trash' } })?.actions).toEqual({ categoryId: null });
    expect(ruleOf('z', { enabled: false, match: { field: 'url', op: 'contains', value: 'x' } })?.enabled).toBe(false);
  });
});

describe('matching', () => {
  it('domain: is (incl. subdomains, www-insensitive), contains, endsWith', () => {
    expect(matchRule(rule('domain', 'is', 'example.com'), item)).toBe(true);
    expect(matchRule(rule('domain', 'is', 'www.news.example.com'), item)).toBe(true);
    expect(matchRule(rule('domain', 'is', 'ample.com'), item)).toBe(false);
    expect(matchRule(rule('domain', 'contains', 'EXAMPLE'), item)).toBe(true);
    expect(matchRule(rule('domain', 'endsWith', '.com'), item)).toBe(true);
    expect(matchRule(rule('domain', 'is', 'example.com'), { ...item, url: null })).toBe(false);
  });
  it('url, title, type, source (case-insensitive)', () => {
    expect(matchRule(rule('url', 'contains', '/2026/'), item)).toBe(true);
    expect(matchRule(rule('url', 'endsWith', 'ref=rss'), item)).toBe(true);
    expect(matchRule(rule('url', 'is', 'https://news.example.com/2026/ai-and-you?ref=rss'), item)).toBe(true);
    expect(matchRule(rule('title', 'contains', 'field guide'), item)).toBe(true);
    expect(matchRule(rule('title', 'is', 'AI'), item)).toBe(false);
    expect(matchRule(rule('type', 'is', 'Article'), item)).toBe(true);
    expect(matchRule(rule('source', 'is', 'extension'), item)).toBe(true);
    expect(matchRule(rule('source', 'is', 'email'), { ...item, source: undefined })).toBe(false);
  });
  it('feed matches the feed id or the feed title', () => {
    expect(matchRule(rule('feed', 'is', 'feed123'), item)).toBe(true);
    expect(matchRule(rule('feed', 'is', 'Hacker News'), item, { feedTitle: 'hacker news' })).toBe(true);
    expect(matchRule(rule('feed', 'contains', 'hacker'), item, { feedTitle: 'Hacker News' })).toBe(true);
    expect(matchRule(rule('feed', 'contains', 'hacker'), item)).toBe(false);
    expect(matchRule(rule('feed', 'is', 'feed123'), { ...item, feedId: null })).toBe(false);
    expect(needsFeedTitle([rule('feed', 'is', 'x')])).toBe(true);
    expect(needsFeedTitle([rule('url', 'is', 'x'), rule('feed', 'is', 'x', {}, false)])).toBe(false);
  });
  it('disabled rules never match', () => {
    expect(matchRule(rule('domain', 'is', 'example.com', {}, false), item)).toBe(false);
  });
});

describe('patches', () => {
  it('merges tags, later rules win for single-valued actions', () => {
    const rules = [
      rule('domain', 'is', 'example.com', { addTags: ['news', 'reading'], categoryId: 'a', favorite: true }),
      rule('title', 'contains', 'guide', { addTags: ['guides'], categoryId: 'b', location: 'library' }),
      rule('title', 'contains', 'nomatch', { categoryId: 'c', archive: true }),
    ];
    expect(rulesPatch(rules, item)).toEqual({ tags: ['reading', 'news', 'guides'], categoryId: 'b', favorite: true, location: 'library' });
  });
  it('archive sets status and archivedAt; categoryId null clears', () => {
    const p = rulesPatch([rule('url', 'contains', 'example', { archive: true, categoryId: null })], item);
    expect(p.status).toBe('archived');
    expect(p.archivedAt).toBeInstanceOf(FieldValue);
    expect(p.categoryId).toBeNull();
    expect(rulesPatch([rule('url', 'contains', 'example', { archive: false })], item)).toEqual({ status: 'unread', archivedAt: null });
  });
  it('no match → empty patch; tags not rewritten when unchanged', () => {
    expect(rulesPatch([rule('url', 'contains', 'zzz', { favorite: true })], item)).toEqual({});
    expect(rulesPatch([rule('url', 'contains', 'example', { addTags: ['reading'] })], item)).toEqual({});
  });
  it('withRules marks new item data as processed by rules', () => {
    const out = withRules([rule('source', 'is', 'email', { addTags: ['newsletter'], location: 'library' })], { ...item, source: 'email', tags: [] });
    expect(out).toMatchObject({ tags: ['newsletter'], location: 'library', rulesApplied: true });
    expect(withRules([], { ...item })).toMatchObject({ rulesApplied: true, tags: ['reading'] });
  });
  it('only new items without rulesApplied get rules in processItem', () => {
    const now = Date.now();
    expect(wantsRules({ createdAt: Timestamp.fromMillis(now - 60_000) }, now)).toBe(true);
    expect(wantsRules({ createdAt: Timestamp.fromMillis(now - 3 * 86_400_000) }, now)).toBe(false);
    expect(wantsRules({ createdAt: Timestamp.fromMillis(now), rulesApplied: true }, now)).toBe(false);
    expect(wantsRules({}, now)).toBe(true);
  });
});
