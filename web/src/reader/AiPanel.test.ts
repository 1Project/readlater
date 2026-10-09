import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/data', () => ({ aiCall: vi.fn() }));

const { errorMessage, summaryBlocks } = await import('./AiPanel');

describe('errorMessage', () => {
  it('drops the Firebase prefix and trailing status codes', () => {
    expect(errorMessage(new Error('The AI service is temporarily unavailable, please try again [503]'))).toBe(
      'The AI service is temporarily unavailable, please try again',
    );
    expect(errorMessage(new Error('Firebase: The AI request failed (functions/internal).'))).toBe('The AI request failed');
    expect(errorMessage(null)).toBe('Something went wrong');
  });
});

describe('summaryBlocks', () => {
  it('turns bullets, a TL;DR line and paragraphs into plain-text blocks', () => {
    const text = [
      '**TL;DR:** Work on what you are curious about.',
      '',
      '## Key points',
      '- Pick a field by **interest**',
      '* Learn enough to reach the frontier',
      '1. Notice gaps',
      '• Keep going',
      'A closing remark.',
    ].join('\n');
    expect(summaryBlocks(text)).toEqual([
      { kind: 'tldr', text: 'Work on what you are curious about.' },
      { kind: 'p', text: 'Key points' },
      { kind: 'li', text: 'Pick a field by interest' },
      { kind: 'li', text: 'Learn enough to reach the frontier' },
      { kind: 'li', text: 'Notice gaps' },
      { kind: 'li', text: 'Keep going' },
      { kind: 'p', text: 'A closing remark.' },
    ]);
  });

  it('accepts "TLDR -" variants and ignores blank lines', () => {
    expect(summaryBlocks('\n\nTLDR - short\n\n')).toEqual([{ kind: 'tldr', text: 'short' }]);
  });
});
