import { describe, expect, it } from 'vitest';
import { documentMarkdown, yamlString } from './markdown';

describe('documentMarkdown', () => {
  it('writes front matter, a heading, quotes and notes', () => {
    const md = documentMarkdown(
      {
        title: 'How to Do Great Work',
        url: 'https://paulgraham.com/greatwork.html',
        author: 'Paul Graham',
        siteName: 'paulgraham.com',
        tags: ['essays', 'career advice'],
        savedAt: new Date(2026, 2, 5, 12),
        publishedAt: new Date(2023, 6, 1, 12),
      },
      [
        { text: 'The way to figure out\nwhat to work on is by working.', note: 'Key idea' },
        { text: 'Curiosity.', note: '' },
        { text: '   ', note: 'ignored' },
      ],
    );
    expect(md).toBe(
      [
        '---',
        'title: "How to Do Great Work"',
        'url: "https://paulgraham.com/greatwork.html"',
        'author: "Paul Graham"',
        'site: "paulgraham.com"',
        'tags:',
        '  - "essays"',
        '  - "career-advice"',
        'date: 2026-03-05',
        'published: 2023-07-01',
        '---',
        '',
        '# How to Do Great Work',
        '',
        'Source: <https://paulgraham.com/greatwork.html>',
        '',
        '> The way to figure out',
        '> what to work on is by working.',
        '',
        'Key idea',
        '',
        '> Curiosity.',
        '',
      ].join('\n'),
    );
  });

  it('omits missing fields and escapes YAML and Markdown', () => {
    const md = documentMarkdown({ title: 'A "quoted": #title *', url: null, author: null, tags: [], savedAt: null }, []);
    expect(md).toBe(['---', 'title: "A \\"quoted\\": #title *"', '---', '', '# A "quoted": \\#title \\*', ''].join('\n'));
  });

  it('falls back to the URL for an empty title', () => {
    const md = documentMarkdown({ title: '  ', url: 'https://x.test/a', author: null, tags: [], savedAt: null }, []);
    expect(md).toContain('title: "https://x.test/a"');
  });

  it('quotes YAML strings safely', () => {
    expect(yamlString('a: b\nc')).toBe('"a: b c"');
    expect(yamlString('back\\slash')).toBe('"back\\\\slash"');
  });
});
