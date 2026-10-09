import { beforeEach, describe, expect, it } from 'vitest';
import { applyHighlights, buildTextIndex, clearHighlights, findQuote, getSelectionQuote } from './highlights';

function mount(html: string): HTMLElement {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** Range from the n-th occurrence of `startText` (start) to the end of `endText` searched after it. */
function rangeOf(root: HTMLElement, startText: string, endText = startText): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  const range = document.createRange();
  let started = false;
  for (const t of texts) {
    if (!started) {
      const i = t.data.indexOf(startText);
      if (i >= 0) {
        range.setStart(t, i);
        started = true;
        const j = t.data.indexOf(endText, i);
        if (j >= 0) {
          range.setEnd(t, j + endText.length);
          return range;
        }
      }
    } else {
      const j = t.data.indexOf(endText);
      if (j >= 0) {
        range.setEnd(t, j + endText.length);
        return range;
      }
    }
  }
  throw new Error(`text not found: ${startText}…${endText}`);
}

describe('buildTextIndex', () => {
  it('collapses whitespace and separates blocks', () => {
    const root = mount('<p>Hello   <em>big</em>\n world</p><p>Second</p><ul><li>a</li><li>b</li></ul>x<br>y');
    expect(buildTextIndex(root).text).toBe('Hello big world Second a b x y');
  });

  it('does not add spaces inside inline elements', () => {
    const root = mount('<p>un<strong>believ</strong>able</p>');
    expect(buildTextIndex(root).text).toBe('unbelievable');
  });

  it('ignores leading and trailing whitespace', () => {
    const root = mount('\n  <p>  text  </p>\n ');
    expect(buildTextIndex(root).text).toBe('text');
  });
});

describe('getSelectionQuote', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns text with prefix and suffix', () => {
    const root = mount('<p>The quick brown fox jumps over the lazy dog.</p>');
    const q = getSelectionQuote(root, rangeOf(root, 'brown', 'fox'));
    expect(q).toMatchObject({ text: 'brown fox', prefix: 'The quick ', suffix: ' jumps over the lazy dog.' });
  });

  it('spans elements and blocks', () => {
    const root = mount('<p>Alpha <b>beta</b> gamma.</p>\n<p>Delta epsilon.</p>');
    const q = getSelectionQuote(root, rangeOf(root, 'beta', 'Delta'));
    expect(q?.text).toBe('beta gamma. Delta');
    expect(q?.prefix).toBe('Alpha ');
    expect(q?.suffix).toBe(' epsilon.');
  });

  it('trims surrounding whitespace of the selection', () => {
    const root = mount('<p>one two three</p>');
    const q = getSelectionQuote(root, rangeOf(root, ' two ', ' two '));
    expect(q?.text).toBe('two');
  });

  it('limits context to 32 chars', () => {
    const long = 'x'.repeat(50);
    const root = mount(`<p>${long} target ${long}</p>`);
    const q = getSelectionQuote(root, rangeOf(root, 'target'))!;
    expect(q.prefix.length).toBe(32);
    expect(q.suffix.length).toBe(32);
  });

  it('clamps a range that starts outside the root', () => {
    document.body.innerHTML = '<h1 id="t">Title</h1><div id="r"><p>Body text here</p></div>';
    const root = document.getElementById('r')!;
    const range = document.createRange();
    range.setStart(document.getElementById('t')!.firstChild!, 0);
    const text = root.querySelector('p')!.firstChild as Text;
    range.setEnd(text, 4);
    expect(getSelectionQuote(root, range)?.text).toBe('Body');
  });

  it('returns null for a range outside the root or collapsed', () => {
    document.body.innerHTML = '<h1 id="t">Title</h1><div id="r"><p>Body</p></div>';
    const root = document.getElementById('r')!;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('t')!);
    expect(getSelectionQuote(root, range)).toBeNull();
    const c = document.createRange();
    c.setStart(root.querySelector('p')!.firstChild!, 1);
    expect(getSelectionQuote(root, c)).toBeNull();
  });

  it('works for element-based boundaries', () => {
    const root = mount('<p>first</p><p>second</p><p>third</p>');
    const range = document.createRange();
    range.setStart(root, 1);
    range.setEnd(root, 2);
    expect(getSelectionQuote(root, range)?.text).toBe('second');
  });
});

describe('findQuote', () => {
  it('finds a unique match', () => {
    expect(findQuote('abc def ghi', { text: 'def', prefix: '', suffix: '' })).toEqual({ start: 4, end: 7 });
  });

  it('uses prefix/suffix to disambiguate repeated text', () => {
    const text = 'the cat sat. the cat ran. the cat ate.';
    const r = findQuote(text, { text: 'the cat', prefix: 'sat. ', suffix: ' ran' });
    expect(r).toEqual({ start: 13, end: 20 });
    const r2 = findQuote(text, { text: 'the cat', prefix: 'ran. ', suffix: ' ate.' });
    expect(r2).toEqual({ start: 26, end: 33 });
  });

  it('falls back to the first exact match when context does not help', () => {
    expect(findQuote('a x b x c', { text: 'x', prefix: 'zzz', suffix: 'qqq' })).toEqual({ start: 2, end: 3 });
  });

  it('is whitespace-insensitive and maps back to raw offsets', () => {
    const raw = 'Hello,\n\n   wide   world!';
    const r = findQuote(raw, { text: 'wide world', prefix: 'Hello, ', suffix: '!' });
    expect(r).not.toBeNull();
    expect(raw.slice(r!.start, r!.end)).toBe('wide   world');
  });

  it('returns null when missing or empty', () => {
    expect(findQuote('abc', { text: 'zzz', prefix: '', suffix: '' })).toBeNull();
    expect(findQuote('abc', { text: '   ', prefix: '', suffix: '' })).toBeNull();
  });
});

describe('applyHighlights', () => {
  it('wraps a simple match', () => {
    const root = mount('<p>The quick brown fox.</p>');
    const res = applyHighlights(root, [{ id: 'h1', text: 'quick brown', prefix: 'The ', suffix: ' fox.' }]);
    expect(res).toEqual({ applied: ['h1'], missing: [] });
    const marks = root.querySelectorAll('mark.hl');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('quick brown');
    expect(marks[0].getAttribute('data-hid')).toBe('h1');
    expect(root.textContent).toBe('The quick brown fox.');
  });

  it('wraps across nodes and blocks', () => {
    const root = mount('<p>Alpha <b>beta</b> gamma.</p>\n<p>Delta epsilon.</p>');
    applyHighlights(root, [{ id: 'x', text: 'beta gamma. Delta', prefix: 'Alpha ', suffix: '' }]);
    const marks = [...root.querySelectorAll('mark[data-hid="x"]')];
    expect(marks.map((m) => m.textContent).join('|')).toBe('beta| gamma.|Delta');
    // no mark directly between the paragraphs
    expect([...root.childNodes].some((n) => n.nodeName === 'MARK')).toBe(false);
  });

  it('round-trips with getSelectionQuote', () => {
    const html = '<h2>Intro</h2><p>Repeat me. Something else. Repeat me. End.</p>';
    const root = mount(html);
    const walker = root.querySelector('p')!.firstChild as Text;
    const second = walker.data.lastIndexOf('Repeat me');
    const range = document.createRange();
    range.setStart(walker, second);
    range.setEnd(walker, second + 'Repeat me'.length);
    const q = getSelectionQuote(root, range)!;
    applyHighlights(root, [{ id: 'r', ...q }]);
    const mark = root.querySelector('mark')!;
    expect(mark.textContent).toBe('Repeat me');
    expect(mark.previousSibling?.textContent).toBe('Repeat me. Something else. ');
  });

  it('reports missing highlights and keeps document order', () => {
    const root = mount('<p>one two three four</p>');
    const res = applyHighlights(root, [
      { id: 'b', text: 'four', prefix: '', suffix: '' },
      { id: 'gone', text: 'five', prefix: '', suffix: '' },
      { id: 'a', text: 'two', prefix: '', suffix: '' },
    ]);
    expect(res.applied).toEqual(['a', 'b']);
    expect(res.missing).toEqual(['gone']);
  });

  it('handles overlapping highlights (later wins on overlap)', () => {
    const root = mount('<p>abcdefgh</p>');
    applyHighlights(root, [
      { id: '1', text: 'abcde', prefix: '', suffix: '' },
      { id: '2', text: 'defg', prefix: '', suffix: '' },
    ]);
    const marks = [...root.querySelectorAll('mark')].map((m) => `${m.getAttribute('data-hid')}:${m.textContent}`);
    expect(marks).toEqual(['1:abc', '2:defg']);
    expect(root.textContent).toBe('abcdefgh');
  });

  it('marks highlights with notes', () => {
    const root = mount('<p>noted text</p>');
    applyHighlights(root, [{ id: 'n', text: 'noted', prefix: '', suffix: '', note: 'why' }]);
    expect(root.querySelector('mark')!.classList.contains('has-note')).toBe(true);
  });

  it('is idempotent and clearHighlights restores the DOM', () => {
    const html = '<p>Hello <i>there</i> world</p>';
    const root = mount(html);
    const hl = [{ id: 'h', text: 'there world', prefix: '', suffix: '' }];
    applyHighlights(root, hl);
    applyHighlights(root, hl);
    expect(root.querySelectorAll('mark')).toHaveLength(2);
    clearHighlights(root);
    expect(root.innerHTML).toBe(html);
  });

  it('leaves server-provided <mark> elements alone', () => {
    const root = mount('<p><mark>server</mark> text</p>');
    applyHighlights(root, [{ id: 'h', text: 'text', prefix: '', suffix: '' }]);
    clearHighlights(root);
    expect(root.innerHTML).toBe('<p><mark>server</mark> text</p>');
  });

  it('does not wrap text inside math', () => {
    const root = mount('<p>Value <math><mi>x</mi></math> here</p>');
    applyHighlights(root, [{ id: 'm', text: 'Value x here', prefix: '', suffix: '' }]);
    expect(root.querySelector('math mark')).toBeNull();
    expect(root.querySelectorAll('mark').length).toBeGreaterThan(0);
  });

  it('sets data-color on the marks of coloured highlights', () => {
    const root = mount('<p>Alpha <em>beta</em> gamma delta</p>');
    applyHighlights(root, [
      { id: 'g', text: 'Alpha beta', prefix: '', suffix: '', color: 'green' },
      { id: 'n', text: 'delta', prefix: '', suffix: '' },
    ]);
    const green = [...root.querySelectorAll('mark[data-hid="g"]')];
    expect(green).toHaveLength(2);
    green.forEach((m) => expect(m.getAttribute('data-color')).toBe('green'));
    expect(root.querySelector('mark[data-hid="n"]')?.hasAttribute('data-color')).toBe(false);
  });
});
