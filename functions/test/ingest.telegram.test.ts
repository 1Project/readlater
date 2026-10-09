import { describe, expect, it } from 'vitest';
import {
  extractHashtags,
  extractUrls,
  forwardAuthor,
  noteItemId,
  noteTextOf,
  noteTitle,
  parseCommand,
  parseMessage,
  savedText,
  chatName,
  type TgMessage,
} from '../src/telegram';

const chat = { id: 4242, type: 'private', username: 'alice', first_name: 'Alice' };
const msg = (m: Partial<TgMessage>): TgMessage => ({ message_id: 7, chat, from: { id: 4242, first_name: 'Alice', username: 'alice' }, ...m });

describe('telegram commands', () => {
  it('parses commands with arguments and bot suffixes', () => {
    expect(parseCommand('/start AbC123')).toEqual({ name: 'start', arg: 'AbC123' });
    expect(parseCommand('/help')).toEqual({ name: 'help', arg: '' });
    expect(parseCommand('/LATEST@ReadlaterBot', 'readlaterbot')).toEqual({ name: 'latest', arg: '' });
    expect(parseCommand('  /unlink  ')).toEqual({ name: 'unlink', arg: '' });
  });
  it('ignores commands for other bots and non-commands', () => {
    expect(parseCommand('/help@OtherBot', 'ReadlaterBot')).toBeNull();
    expect(parseCommand('hello /help')).toBeNull();
    expect(parseCommand('https://example.com/a')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
  it('only text messages carry commands (not captions)', () => {
    expect(parseMessage(msg({ text: '/start tok' })).command).toEqual({ name: 'start', arg: 'tok' });
    expect(parseMessage(msg({ caption: '/start tok', document: { file_id: 'f' } })).command).toBeNull();
    // A command's URL-looking argument is not saved as a link.
    expect(parseMessage(msg({ text: '/help https://example.com' })).urls).toEqual([]);
  });
});

describe('telegram links', () => {
  it('takes url and text_link entities in order, plus plain URLs', () => {
    const text = 'Read this and example.org/x then https://b.example.com/post?id=1.';
    const entities = [
      { type: 'text_link', offset: 5, length: 4, url: 'https://hidden.example.com/a' },
      { type: 'url', offset: 14, length: 13 },
    ];
    expect(extractUrls(text, entities)).toEqual(['https://hidden.example.com/a', 'https://example.org/x', 'https://b.example.com/post?id=1']);
  });
  it('handles UTF-16 offsets (emoji before the link)', () => {
    const text = '🔥🔥 https://example.com/fire';
    expect(extractUrls(text, [{ type: 'url', offset: 5, length: 24 }])).toEqual(['https://example.com/fire']);
  });
  it('dedupes, strips trailing punctuation and caps the count', () => {
    expect(extractUrls('(https://example.com/a), https://example.com/a!')).toEqual(['https://example.com/a']);
    const many = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(extractUrls(many)).toHaveLength(10);
  });
  it('ignores non-http links', () => {
    expect(extractUrls('mailto:a@b.c ftp://x.y/z tg://resolve?domain=x')).toEqual([]);
  });
});

describe('telegram hashtags and notes', () => {
  it('turns hashtags into normalised tags, not URL fragments', () => {
    expect(extractHashtags('Great read #AI #long_read https://example.com/#section (#ml)')).toEqual(['ai', 'long_read', 'ml']);
    expect(extractHashtags('#Café #café')).toEqual(['café']);
    expect(extractHashtags('x', [{ type: 'hashtag', offset: 0, length: 1 }])).toEqual(['x']);
  });
  it('drops hashtag-only lines and trailing hashtags from note text, keeps inline ones', () => {
    expect(noteTextOf('Remember to #call mum\n\n#todo #family')).toBe('Remember to #call mum');
    expect(noteTextOf('Idea: a better kettle #ideas #home')).toBe('Idea: a better kettle');
    expect(noteTextOf('#only #tags')).toBe('');
    expect(noteTextOf('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('titles a note with its first line, at most 80 chars', () => {
    expect(noteTitle('\n  First line here \nsecond')).toBe('First line here');
    const t = noteTitle('x'.repeat(200));
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
    expect(noteTitle('')).toBe('Note');
  });
  it('parses a full message: caption + document, forwarded authors', () => {
    const p = parseMessage(msg({ caption: 'Paper #ml', document: { file_id: 'F1', file_name: 'paper.pdf', mime_type: 'application/pdf', file_size: 1000 } }));
    expect(p).toMatchObject({ command: null, urls: [], tags: ['ml'], document: { file_id: 'F1' } });
    expect(forwardAuthor(msg({ forward_origin: { type: 'channel', chat: { id: -1, type: 'channel', title: 'Tech News' } } }))).toBe('Tech News');
    expect(forwardAuthor(msg({ forward_origin: { type: 'user', sender_user: { id: 1, first_name: 'Bob', last_name: 'Ray' } } }))).toBe('Bob Ray');
    expect(forwardAuthor(msg({ forward_origin: { type: 'hidden_user', sender_user_name: 'Anon' } }))).toBe('Anon');
    expect(forwardAuthor(msg({}))).toBeNull();
  });
  it('names chats and derives stable note ids', () => {
    expect(chatName(msg({}))).toBe('@alice');
    expect(chatName(msg({ chat: { id: -100, type: 'channel', title: 'My channel' }, from: undefined }))).toBe('My channel');
    expect(noteItemId(1, 2)).toMatch(/^t_[0-9a-f]{24}$/);
    expect(noteItemId(1, 2)).toBe(noteItemId(1, 2));
    expect(noteItemId(1, 2)).not.toBe(noteItemId(1, 3));
  });
});

describe('telegram replies', () => {
  it('formats saved replies', () => {
    expect(savedText([null])).toBe('✓ Saved');
    expect(savedText(['Great essay'])).toBe('✓ Saved: Great essay');
    expect(savedText([null, null])).toBe('✓ Saved 2 links');
    expect(savedText(['A', null])).toBe('✓ Saved 2 links:\n• A\n• link 2');
  });
});
