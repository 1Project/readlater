import { describe, expect, it } from 'vitest';
import { firstVisibleBlock, speechErrorText, splitBlocks, splitUtterances, TtsPlayer, type SpeakOptions, type TtsBlock, type TtsEngine, type TtsState } from './tts';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const texts = (blocks: TtsBlock[]) => blocks.map((b) => b.text);
const tags = (blocks: TtsBlock[]) => blocks.map((b) => b.el.tagName.toLowerCase());

describe('splitBlocks', () => {
  it('returns paragraphs, list items, headings and quotes in document order', () => {
    const r = root(`
      <h1>Title</h1>
      <p>First <em>para</em>graph.</p>
      <ul><li>One</li><li>Two</li></ul>
      <h4>Small heading</h4>
      <blockquote>Quoted words</blockquote>`);
    const blocks = splitBlocks(r);
    expect(texts(blocks)).toEqual(['Title', 'First paragraph.', 'One', 'Two', 'Small heading', 'Quoted words']);
    expect(tags(blocks)).toEqual(['h1', 'p', 'li', 'li', 'h4', 'blockquote']);
  });

  it('gives nested blocks their own entry and keeps the parent text without them', () => {
    const r = root(`
      <blockquote><p>Inside a quote.</p><p>Second.</p></blockquote>
      <ul><li>Outer item<ul><li>Inner item</li></ul></li></ul>
      <li><p>Paragraph in item</p></li>`);
    const blocks = splitBlocks(r);
    expect(texts(blocks)).toEqual(['Inside a quote.', 'Second.', 'Outer item', 'Inner item', 'Paragraph in item']);
    expect(tags(blocks)).toEqual(['p', 'p', 'li', 'li', 'p']);
  });

  it('reads text held directly by divs and table cells', () => {
    const r = root(`<div>Loose <strong>text</strong></div><table><tr><td>Cell A</td><td>Cell B</td></tr></table><figure><img src="x.png" alt="pic"><figcaption>A caption</figcaption></figure>`);
    expect(texts(splitBlocks(r))).toEqual(['Loose text', 'Cell A', 'Cell B', 'A caption']);
  });

  it('skips code blocks, maths, PDF page markers, hidden parts and empty blocks', () => {
    const r = root(`
      <h2 data-page="1">Page 1</h2>
      <p>Visible</p>
      <pre><code>const x = 1;</code></pre>
      <p><math><mi>x</mi></math></p>
      <p hidden>Hidden</p>
      <p>   </p>
      <p>—</p>
      <details><summary>More</summary><p>Collapsed body</p></details>
      <details open><summary>Open</summary><p>Open body</p></details>`);
    expect(texts(splitBlocks(r))).toEqual(['Visible', 'More', 'Open', 'Open body']);
  });

  it('separates words across line breaks and inline elements', () => {
    const r = root(`<p>Line one<br>line two <a href="#">link</a>.</p>`);
    expect(texts(splitBlocks(r))).toEqual(['Line one line two link.']);
  });
});

describe('splitUtterances', () => {
  it('keeps short text whole and merges short sentences up to the limit', () => {
    expect(splitUtterances('Hello world.')).toEqual(['Hello world.']);
    expect(splitUtterances('One. Two. Three.', 9)).toEqual(['One. Two.', 'Three.']);
  });

  it('does not split inside numbers or abbreviations without a following space', () => {
    expect(splitUtterances('Pi is 3.14 roughly. See e.g.this one.', 20)).toEqual(['Pi is 3.14 roughly.', 'See e.g.this one.']);
  });

  it('splits long sentences at commas, then at spaces, never above the limit', () => {
    const long = 'alpha beta gamma, delta epsilon zeta, eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
    const parts = splitUtterances(long, 40);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(40);
    expect(parts.join(' ')).toBe(long);
    expect(parts[0]).toBe('alpha beta gamma, delta epsilon zeta,');
  });

  it('cuts a single huge word', () => {
    const parts = splitUtterances('x'.repeat(25), 10);
    expect(parts).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('handles CJK sentence ends and empty input', () => {
    expect(splitUtterances('今日は。明日も！', 4)).toEqual(['今日は。', '明日も！']);
    expect(splitUtterances('   ')).toEqual([]);
  });
});

describe('firstVisibleBlock', () => {
  const block = (rects: Partial<DOMRect>[]): TtsBlock => {
    const el = document.createElement('p');
    el.getClientRects = () => {
      const list = rects.map((r) => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...r }) as DOMRect);
      return Object.assign(list, { item: (i: number) => list[i] }) as unknown as DOMRectList;
    };
    return { el, text: 'x' };
  };
  const view = { top: 50, bottom: 600, left: 0, right: 400 };

  it('finds the first block intersecting the view', () => {
    const blocks = [
      block([{ top: -200, bottom: 40, left: 10, right: 390, width: 380, height: 240 }]),
      block([{ top: 40, bottom: 120, left: 10, right: 390, width: 380, height: 80 }]),
      block([{ top: 130, bottom: 200, left: 10, right: 390, width: 380, height: 70 }]),
    ];
    expect(firstVisibleBlock(blocks, view)).toBe(1);
  });

  it('uses every rect (blocks split across columns) and ignores empty ones', () => {
    const blocks = [
      block([{ top: 300, bottom: 600, left: -420, right: -20, width: 400, height: 300 }]),
      block([
        { top: 500, bottom: 600, left: -420, right: -20, width: 400, height: 100 },
        { top: 60, bottom: 120, left: 10, right: 390, width: 380, height: 60 },
      ]),
      block([{ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }]),
    ];
    expect(firstVisibleBlock(blocks, view)).toBe(1);
    expect(firstVisibleBlock([blocks[0], blocks[2]], view)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------

class FakeEngine implements TtsEngine {
  readonly kind = 'web' as const;
  spoken: { text: string; opts: SpeakOptions }[] = [];
  stops = 0;
  failNext: Error | null = null;
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;

  async getVoices() {
    return [];
  }
  onVoicesChanged() {
    return () => {};
  }
  speak(text: string, opts: SpeakOptions): Promise<void> {
    this.spoken.push({ text, opts });
    return new Promise((resolve, reject) => {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = null;
        reject(e);
        return;
      }
      this.pending = { resolve, reject };
    });
  }
  stop(): void {
    this.stops++;
    const p = this.pending;
    this.pending = null;
    p?.resolve();
  }
  /** Finish the current utterance. */
  async finish(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    p?.resolve();
    await flush();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeBlocks(...t: string[]): TtsBlock[] {
  return t.map((text) => ({ el: document.createElement('p'), text }));
}

describe('TtsPlayer', () => {
  it('speaks the blocks in order from the given start, reports the current block and ends', async () => {
    const engine = new FakeEngine();
    const seen: number[] = [];
    const states: TtsState[] = [];
    const player = new TtsPlayer(engine, { rate: 1.25, onBlock: (i) => seen.push(i), onChange: (s) => states.push(s) });
    player.setBlocks(makeBlocks('Zero.', 'One.', 'Two.'));
    player.play(1);
    await flush();
    expect(engine.spoken.map((s) => s.text)).toEqual(['One.']);
    expect(engine.spoken[0].opts.rate).toBe(1.25);
    expect(player.state).toMatchObject({ status: 'playing', index: 1, count: 3 });
    await engine.finish();
    expect(engine.spoken.map((s) => s.text)).toEqual(['One.', 'Two.']);
    await engine.finish();
    expect(player.state.status).toBe('ended');
    expect(seen).toEqual([1, 2]);
    expect(states.at(-1)?.status).toBe('ended');
  });

  it('speaks a long block in several utterances', async () => {
    const engine = new FakeEngine();
    const player = new TtsPlayer(engine);
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    player.setBlocks(makeBlocks(long, 'Next.'));
    player.play(0);
    await flush();
    let guard = 0;
    while (player.state.index === 0 && guard++ < 50) await engine.finish();
    const parts = engine.spoken.slice(0, -1).map((s) => s.text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(long);
    expect(engine.spoken.at(-1)?.text).toBe('Next.');
  });

  it('pauses and resumes at the same utterance; next/prev move while paused', async () => {
    const engine = new FakeEngine();
    const player = new TtsPlayer(engine);
    player.setBlocks(makeBlocks('A.', 'B.', 'C.'));
    player.play();
    await flush();
    player.pause();
    expect(player.state.status).toBe('paused');
    await flush();
    expect(engine.spoken.map((s) => s.text)).toEqual(['A.']);
    player.next();
    expect(player.state).toMatchObject({ status: 'paused', index: 1 });
    expect(engine.spoken).toHaveLength(1);
    player.toggle();
    await flush();
    expect(engine.spoken.map((s) => s.text)).toEqual(['A.', 'B.']);
    player.prev();
    await flush();
    expect(player.state).toMatchObject({ status: 'playing', index: 0 });
    expect(engine.spoken.map((s) => s.text)).toEqual(['A.', 'B.', 'A.']);
  });

  it('restarts the current utterance with a new rate or voice', async () => {
    const engine = new FakeEngine();
    const player = new TtsPlayer(engine);
    player.setBlocks(makeBlocks('A.', 'B.'));
    player.play();
    await flush();
    player.setRate(2);
    await flush();
    player.setVoice('v1');
    await flush();
    expect(engine.spoken.map((s) => [s.text, s.opts.rate, s.opts.voiceId])).toEqual([
      ['A.', 1, null],
      ['A.', 2, null],
      ['A.', 2, 'v1'],
    ]);
    expect(player.state.index).toBe(0);
  });

  it('stops with an error message when the engine fails', async () => {
    const engine = new FakeEngine();
    const errors: string[] = [];
    const player = new TtsPlayer(engine, { onError: (m) => errors.push(m) });
    player.setBlocks(makeBlocks('A.', 'B.'));
    engine.failNext = new Error('Speech failed (synthesis-failed)');
    player.play();
    await flush();
    expect(player.state.status).toBe('paused');
    expect(errors).toEqual(['Speech failed (synthesis-failed)']);
  });

  it('keeps its position when the blocks are replaced and clears the block on destroy', async () => {
    const engine = new FakeEngine();
    const seen: (string | null)[] = [];
    const player = new TtsPlayer(engine, { onBlock: (_i, b) => seen.push(b?.text ?? null) });
    player.setBlocks(makeBlocks('A.', 'B.', 'C.'));
    player.play(2);
    await flush();
    player.setBlocks(makeBlocks('A.', 'B2.'));
    expect(player.state.index).toBe(1);
    player.destroy();
    expect(player.state.status).toBe('idle');
    expect(seen).toEqual(['C.', 'B2.', null]);
    expect(engine.stops).toBeGreaterThan(0);
  });

  it('plays again from the start after the end', async () => {
    const engine = new FakeEngine();
    const player = new TtsPlayer(engine);
    player.setBlocks(makeBlocks('A.'));
    player.play();
    await flush();
    await engine.finish();
    expect(player.state.status).toBe('ended');
    player.toggle();
    await flush();
    expect(player.state).toMatchObject({ status: 'playing', index: 0 });
  });
});

describe('speechErrorText', () => {
  it('explains missing voices instead of showing the raw error code', () => {
    expect(speechErrorText('synthesis-failed')).toBe('No text-to-speech voice is available on this device. Install one in the system settings.');
    expect(speechErrorText('voice-unavailable')).toMatch(/No text-to-speech voice/);
    expect(speechErrorText('not-allowed')).toMatch(/blocked by the browser/);
    expect(speechErrorText(undefined)).not.toMatch(/undefined|\(/);
  });
});
