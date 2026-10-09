import { describe, expect, it } from 'vitest';
import {
  cleanTag,
  dedupeEntries,
  detectFormat,
  highlightsToMarkdown,
  parseBookmarksHtml,
  parseCsv,
  parseImport,
  parsePocketHtml,
  parseUrlList,
  urlKey,
  type ImportEntry,
} from './importers';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n\r\n1,,3\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'multi\nline'],
      ['1', '', '3'],
    ]);
  });
  it('keeps a last row without trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseUrlList', () => {
  it('extracts links per line, bare domains and strips trailing punctuation', () => {
    const list = parseUrlList(
      ['https://a.com/x', '  see https://b.org/post). and http://c.net/', 'example.com/path', '# comment', 'not a link', 'javascript:alert(1)'].join('\n'),
    );
    expect(list.map((e) => e.url)).toEqual(['https://a.com/x', 'https://b.org/post', 'http://c.net/', 'https://example.com/path']);
    expect(list[0]).toEqual({ url: 'https://a.com/x', tags: [], archived: false, favorite: false });
  });
});

describe('Pocket', () => {
  it('parses the CSV export with tags, status and time', () => {
    const csv = [
      'title,url,time_added,cursor,tags,status',
      '"Hello, world",https://example.com/a,1700000000,abc,Tech|Long Reads,unread',
      'Old one,https://example.com/b,1600000000,abd,,archive',
      'Broken,notaurl,1600000000,abe,,unread',
    ].join('\n');
    expect(detectFormat('part_000000.csv', csv)).toBe('pocket-csv');
    const res = parseImport('part_000000.csv', csv);
    expect(res.format).toBe('pocket-csv');
    expect(res.skipped).toBe(1);
    expect(res.entries).toEqual([
      { url: 'https://example.com/a', title: 'Hello, world', tags: ['tech', 'long-reads'], archived: false, favorite: false, addedAt: 1700000000000 },
      { url: 'https://example.com/b', title: 'Old one', tags: [], archived: true, favorite: false, addedAt: 1600000000000 },
    ]);
  });

  it('parses the legacy HTML export (Unread / Read Archive)', () => {
    const html = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
      <h1>Unread</h1><ul>
        <li><a href="https://a.com/1" time_added="1528742225" tags="news,science">First</a></li>
      </ul>
      <h1>Read Archive</h1><ul>
        <li><a href="https://a.com/2" time_added="1428742225" tags="">Second</a></li>
      </ul></body></html>`;
    expect(detectFormat('ril_export.html', html)).toBe('pocket-html');
    const res = parsePocketHtml(html);
    expect(res.entries).toEqual([
      { url: 'https://a.com/1', title: 'First', tags: ['news', 'science'], archived: false, favorite: false, addedAt: 1528742225000 },
      { url: 'https://a.com/2', title: 'Second', tags: [], archived: true, favorite: false, addedAt: 1428742225000 },
    ]);
  });
});

describe('Instapaper CSV', () => {
  it('maps folders to archive / favorite / tags', () => {
    const csv = [
      'URL,Title,Selection,Folder,Timestamp',
      'https://i.com/1,One,,Unread,1700000000',
      'https://i.com/2,Two,some text,Archive,1700000001',
      'https://i.com/3,Three,,Starred,1700000002',
      'https://i.com/4,Four,,Machine Learning,1700000003',
    ].join('\r\n');
    expect(detectFormat('instapaper-export.csv', csv)).toBe('instapaper-csv');
    const { entries } = parseImport('instapaper-export.csv', csv);
    expect(entries.map((e) => [e.url, e.archived, e.favorite, e.tags])).toEqual([
      ['https://i.com/1', false, false, []],
      ['https://i.com/2', true, false, []],
      ['https://i.com/3', false, true, []],
      ['https://i.com/4', false, false, ['machine-learning']],
    ]);
    expect(entries[3].addedAt).toBe(1700000003000);
  });
});

describe('Readwise Reader CSV', () => {
  it('maps location and python-style tag lists, skips feed items', () => {
    const csv = [
      'Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen',
      `A,https://r.com/a,1,"['ai', 'Deep Work']",2024-03-01 10:00:00+00:00,0.5,later,True`,
      'B,https://r.com/b,2,[],2024-03-02 10:00:00+00:00,1,archive,True',
      'C,https://r.com/c,3,,2024-03-03 10:00:00+00:00,0,shortlist,False',
      'D,https://r.com/d,4,,2024-03-04 10:00:00+00:00,0,feed,False',
    ].join('\n');
    expect(detectFormat('Readwise-Reader-export.csv', csv)).toBe('readwise-csv');
    const res = parseImport('Readwise-Reader-export.csv', csv);
    expect(res.skipped).toBe(1);
    expect(res.entries.map((e) => [e.title, e.tags, e.archived, e.favorite])).toEqual([
      ['A', ['ai', 'deep-work'], false, false],
      ['B', [], true, false],
      ['C', [], false, true],
    ]);
    expect(res.entries[0].addedAt).toBe(Date.parse('2024-03-01 10:00:00+00:00'));
  });
});

describe('bookmarks HTML', () => {
  it('reads Netscape bookmark files and ignores non-web links', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3>Folder</H3>
  <DL><p>
    <DT><A HREF="https://b.com/1" ADD_DATE="1600000000" TAGS="x,y">One &amp; only</A>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
  </DL><p>
  <DT><A HREF="https://b.com/2" TOREAD="1">Two</A>
</DL>`;
    expect(detectFormat('bookmarks.html', html)).toBe('bookmarks-html');
    const res = parseBookmarksHtml(html);
    expect(res.skipped).toBe(1);
    expect(res.entries).toEqual([
      { url: 'https://b.com/1', title: 'One & only', tags: ['x', 'y'], archived: false, favorite: false, addedAt: 1600000000000 },
      { url: 'https://b.com/2', title: 'Two', tags: [], archived: false, favorite: false, addedAt: undefined },
    ]);
  });
});

describe('detectFormat', () => {
  it('recognises OPML, plain lists and generic CSV', () => {
    expect(detectFormat('feeds.xml', '<?xml version="1.0"?><opml version="2.0"><body/></opml>')).toBe('opml');
    expect(detectFormat('subs.opml', '')).toBe('opml');
    expect(detectFormat('links.txt', 'https://a.com\nhttps://b.com')).toBe('urls');
    const generic = 'Name,Link,Tags\nThing,https://g.com/1,"a, b"';
    expect(detectFormat('raindrop.csv', generic)).toBe('csv');
    const res = parseImport('raindrop.csv', generic);
    expect(res.entries).toEqual([{ url: 'https://g.com/1', title: 'Thing', tags: ['a', 'b'], archived: false, favorite: false, addedAt: undefined }]);
  });
  it('returns no entries for OPML (handled by importOpml)', () => {
    expect(parseImport('x.opml', '<opml/>')).toEqual({ format: 'opml', entries: [], skipped: 0 });
  });
});

describe('dedupe', () => {
  const e = (url: string, extra: Partial<ImportEntry> = {}): ImportEntry => ({ url, tags: [], archived: false, favorite: false, ...extra });

  it('urlKey ignores www, fragments, tracking params and trailing slashes', () => {
    expect(urlKey('https://WWW.Example.com/a/?utm_source=x#top')).toBe(urlKey('http://example.com/a'));
    expect(urlKey('https://example.com/a?id=1')).not.toBe(urlKey('https://example.com/a?id=2'));
  });

  it('drops existing links and merges repeats, oldest first', () => {
    const { fresh, duplicates } = dedupeEntries(
      [
        e('https://x.com/new', { addedAt: 3000, tags: ['a'] }),
        e('https://x.com/saved'),
        e('https://x.com/old', { addedAt: 1000 }),
        e('https://www.x.com/new/', { addedAt: 2000, tags: ['B'], archived: true }),
      ],
      ['https://x.com/saved', null],
    );
    expect(duplicates).toBe(2);
    expect(fresh.map((x) => x.url)).toEqual(['https://x.com/old', 'https://x.com/new']);
    expect(fresh[1]).toMatchObject({ tags: ['a', 'b'], archived: true, addedAt: 2000 });
  });
});

describe('cleanTag', () => {
  it('normalises like lib/data', () => {
    expect(cleanTag('  #Long Reads ')).toBe('long-reads');
  });
});

describe('highlightsToMarkdown', () => {
  it('groups highlights under item headings with notes', () => {
    const md = highlightsToMarkdown(
      [
        {
          title: 'A [great] post',
          url: 'https://a.com/p',
          author: 'Ann',
          highlights: [
            { text: 'First line\nsecond line', note: '' },
            { text: 'Another', note: 'my note' },
          ],
        },
        { title: 'Empty', url: null, highlights: [] },
      ],
      new Date('2026-10-09T00:00:00Z'),
    );
    expect(md).toBe(
      [
        '# Readlater highlights',
        '',
        'Exported 2026-10-09',
        '',
        '## A \\[great\\] post',
        '',
        'Author: Ann  ',
        'Source: <https://a.com/p>',
        '',
        '> First line',
        '> second line',
        '',
        '> Another',
        '',
        '**Note:** my note',
        '',
      ].join('\n'),
    );
  });
});
