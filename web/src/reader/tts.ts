/**
 * Text-to-speech ("Listen") core: no React, no Capacitor. The reader's ListenBar picks an engine (the
 * native plugin in the apps via native.ts, else the Web Speech API) and drives a TtsPlayer.
 *
 * Exports:
 *   type TtsBlock = { el: HTMLElement; text: string }
 *   splitBlocks(root): TtsBlock[]            speakable blocks in document order: p, li, h1–h6, blockquote, and
 *                                            div/td/dd/figcaption/… that hold text directly. Each block's text
 *                                            excludes nested blocks (they are blocks of their own); pre, math,
 *                                            PDF page markers (h2[data-page]), [hidden] and closed <details>
 *                                            bodies are skipped.
 *   splitUtterances(text, max = 160): string[]
 *                                            sentence-sized pieces (Chrome cuts utterances off after ~15 s)
 *   firstVisibleBlock(blocks, view): number  index of the first block with a client rect inside `view`, or -1
 *   type TtsVoice = { id, name, lang, isDefault }
 *   type SpeakOptions = { rate: number; voiceId: string | null; lang?: string }
 *   interface TtsEngine                      speak one utterance / stop / list voices
 *   webSpeechEngine(): TtsEngine | null      window.speechSynthesis, or null when unavailable
 *   TTS_RATES                                0.75 … 2
 *   class TtsPlayer                          plays blocks one after another (see below)
 */

export interface TtsBlock {
  el: HTMLElement;
  text: string;
}

/** Elements that form a block when they contain text of their own. */
const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'DD', 'DT', 'TD',
  'TH', 'FIGCAPTION', 'SUMMARY', 'CAPTION',
]);

/** Never read aloud. */
const SKIP_TAGS = new Set(['PRE', 'MATH', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'IMG', 'VIDEO', 'AUDIO']);

/** Inline-level separators: text on either side must not run together. */
const SPACED_TAGS = new Set(['BR', 'HR', 'TR', 'UL', 'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'FIGURE']);

function skipped(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (tag === 'H2' && el.hasAttribute('data-page')) return true;
  // Body of a closed <details>: only its <summary> is on screen.
  const parent = el.parentElement;
  if (parent && parent.tagName.toUpperCase() === 'DETAILS' && !parent.hasAttribute('open') && tag !== 'SUMMARY') return true;
  return false;
}

/** Text reachable from `el` without entering another block element or a skipped one. */
function ownText(el: Element): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        parts.push((c as Text).data);
      } else if (c.nodeType === 1) {
        const child = c as Element;
        const tag = child.tagName.toUpperCase();
        if (skipped(child)) continue;
        if (BLOCK_TAGS.has(tag)) {
          parts.push(' ');
          continue;
        }
        const spaced = SPACED_TAGS.has(tag);
        if (spaced) parts.push(' ');
        visit(child);
        if (spaced) parts.push(' ');
      }
    }
  };
  visit(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function splitBlocks(root: Element): TtsBlock[] {
  const out: TtsBlock[] = [];
  const walk = (el: Element) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (skipped(c)) continue;
      if (BLOCK_TAGS.has(c.tagName.toUpperCase())) {
        const text = ownText(c);
        if (/[\p{L}\p{N}]/u.test(text)) out.push({ el: c as HTMLElement, text });
      }
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** A sentence ends at . ! ? … followed by a space (so "3.14" and "e.g." inside words stay whole), or at 。！？. */
const SENTENCE = /\S[^]*?(?:[.!?…]+["'”’»)\]]*(?=\s|$)|[。！？]+["'”’»)\]」』]*|$)\s*/gu;

/** Split a long piece at clause punctuation, then at spaces, so that no part exceeds `max`. */
function splitLong(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' – '), window.lastIndexOf(' — '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    else cut += 1; // keep the punctuation / space with the left part
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitUtterances(text: string, max = 160): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = (clean.match(SENTENCE) ?? [clean]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    const pieces = s.length > max ? splitLong(s, max) : [s];
    for (const p of pieces) {
      if (!cur) cur = p;
      else if (cur.length + 1 + p.length <= max) cur += ` ${p}`;
      else {
        out.push(cur);
        cur = p;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface ViewRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function firstVisibleBlock(blocks: TtsBlock[], view: ViewRect): number {
  for (let i = 0; i < blocks.length; i++) {
    const rects = blocks[i].el.getClientRects();
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      if (!r.width && !r.height) continue;
      if (r.bottom > view.top + 1 && r.top < view.bottom - 1 && r.right > view.left + 1 && r.left < view.right - 1) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Engines

export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
  isDefault: boolean;
}

export interface SpeakOptions {
  rate: number;
  voiceId: string | null;
  /** BCP 47 language used when no voice is chosen. */
  lang?: string;
}

export interface TtsEngine {
  readonly kind: 'web' | 'native';
  getVoices(): Promise<TtsVoice[]>;
  /** Voice lists can arrive late (Chrome loads them asynchronously). Returns an unsubscribe function. */
  onVoicesChanged(cb: () => void): () => void;
  /** Speak one utterance. Resolves when it ends or is stopped; rejects on an engine error. */
  speak(text: string, opts: SpeakOptions): Promise<void>;
  /** Stop speaking now; a pending speak() resolves. */
  stop(): void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class WebSpeechEngine implements TtsEngine {
  readonly kind = 'web' as const;
  private current: { settle: () => void } | null = null;
  /** Incremented by stop(); a speak() that was waiting when stop() ran gives up. */
  private seq = 0;
  /** Keeps the utterance referenced: Chrome drops `end` events of garbage-collected utterances. */
  private utterance: SpeechSynthesisUtterance | null = null;

  constructor(private synth: SpeechSynthesis) {}

  private voiceId(v: SpeechSynthesisVoice): string {
    return v.voiceURI || v.name;
  }

  async getVoices(): Promise<TtsVoice[]> {
    return this.synth.getVoices().map((v) => ({ id: this.voiceId(v), name: v.name, lang: v.lang, isDefault: v.default }));
  }

  onVoicesChanged(cb: () => void): () => void {
    const s = this.synth as SpeechSynthesis & { addEventListener?: SpeechSynthesis['addEventListener'] };
    if (typeof s.addEventListener === 'function') {
      s.addEventListener('voiceschanged', cb);
      return () => s.removeEventListener('voiceschanged', cb);
    }
    (s as { onvoiceschanged: unknown }).onvoiceschanged = cb;
    return () => {
      (s as { onvoiceschanged: unknown }).onvoiceschanged = null;
    };
  }

  async speak(text: string, opts: SpeakOptions): Promise<void> {
    const busy = this.synth.speaking || this.synth.pending;
    this.stop();
    const seq = this.seq;
    // Chrome sometimes swallows an utterance queued in the same tick as cancel().
    if (busy) await delay(50);
    if (seq !== this.seq) return;
    const synth = this.synth;
    return new Promise<void>((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = opts.rate;
      const voice = opts.voiceId ? synth.getVoices().find((v) => this.voiceId(v) === opts.voiceId) : undefined;
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else if (opts.lang) {
        u.lang = opts.lang;
      }
      let done = false;
      let idleTicks = 0;
      const settle = (err?: Error) => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        if (this.current === entry) this.current = null;
        if (this.utterance === u) this.utterance = null;
        if (err) reject(err);
        else resolve();
      };
      // Some engines never fire `end`: settle once the synthesizer has been idle for two checks.
      const watchdog = setInterval(() => {
        if (!synth.speaking && !synth.pending) {
          idleTicks++;
          if (idleTicks >= 2) settle();
        } else idleTicks = 0;
      }, 1000);
      const entry = { settle: () => settle() };
      u.onend = () => settle();
      u.onerror = (e: SpeechSynthesisErrorEvent) => {
        if (e.error === 'interrupted' || e.error === 'canceled') settle();
        else settle(new Error(speechErrorText(e.error)));
      };
      this.current = entry;
      this.utterance = u;
      synth.speak(u);
    });
  }

  stop(): void {
    this.seq++;
    const c = this.current;
    this.current = null;
    if (this.synth.speaking || this.synth.pending) this.synth.cancel();
    c?.settle();
  }
}

let webEngine: WebSpeechEngine | null = null;

export function webSpeechEngine(): TtsEngine | null {
  if (webEngine) return webEngine;
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return null;
  webEngine = new WebSpeechEngine(window.speechSynthesis);
  return webEngine;
}

// ---------------------------------------------------------------------------
// Player

export const TTS_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export type TtsStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface TtsState {
  status: TtsStatus;
  /** Current block, -1 before the first play. */
  index: number;
  count: number;
  rate: number;
  voiceId: string | null;
}

export interface TtsPlayerOptions {
  rate?: number;
  voiceId?: string | null;
  lang?: string;
  onChange?: (s: TtsState) => void;
  /** The current block changed (-1: none). */
  onBlock?: (index: number, block: TtsBlock | null) => void;
  onError?: (message: string) => void;
}

/**
 * Speaks blocks one after another, each split into sentence-sized utterances. Pausing stops the engine
 * and remembers the utterance, so play resumes at the start of that sentence. Changing speed or voice
 * while playing restarts the current sentence with the new setting.
 */
/** User-facing text for a SpeechSynthesisErrorEvent code. */
export function speechErrorText(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
      return 'Speech was blocked by the browser. Tap play to start it.';
    case 'synthesis-failed':
    case 'synthesis-unavailable':
    case 'voice-unavailable':
    case 'language-unavailable':
      return 'No text-to-speech voice is available on this device. Install one in the system settings.';
    case 'audio-busy':
    case 'audio-hardware':
      return 'The audio output is busy or unavailable. Try again in a moment.';
    case 'network':
      return 'The voice needs a network connection. Check the connection or choose another voice.';
    default:
      return 'Speech stopped unexpectedly. Tap play to try again.';
  }
}

export class TtsPlayer {
  private blocks: TtsBlock[] = [];
  private index = -1;
  private part = 0;
  private status: TtsStatus = 'idle';
  private rate: number;
  private voiceId: string | null;
  private gen = 0;

  constructor(
    private engine: TtsEngine,
    private opts: TtsPlayerOptions = {},
  ) {
    this.rate = opts.rate ?? 1;
    this.voiceId = opts.voiceId ?? null;
  }

  get state(): TtsState {
    return { status: this.status, index: this.index, count: this.blocks.length, rate: this.rate, voiceId: this.voiceId };
  }

  /** Replace the blocks (e.g. the content was re-rendered), keeping the position. */
  setBlocks(blocks: TtsBlock[]): void {
    this.blocks = blocks;
    if (this.index >= blocks.length) {
      this.index = blocks.length - 1;
      this.part = 0;
    }
    this.emitBlock();
    this.emit();
  }

  play(from?: number): void {
    if (!this.blocks.length) return;
    if (from != null) {
      this.index = Math.max(0, Math.min(this.blocks.length - 1, from));
      this.part = 0;
    } else if (this.index < 0 || this.status === 'ended') {
      this.index = 0;
      this.part = 0;
    }
    this.start();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.gen++;
    this.status = 'paused';
    this.engine.stop();
    this.emit();
  }

  toggle(): void {
    if (this.status === 'playing') this.pause();
    else this.play();
  }

  next(): void {
    this.jump(this.index + 1);
  }

  prev(): void {
    this.jump(this.index - 1);
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.restartIfPlaying();
    this.emit();
  }

  setVoice(voiceId: string | null): void {
    this.voiceId = voiceId;
    this.restartIfPlaying();
    this.emit();
  }

  /** Stop for good and clear the current block. */
  destroy(): void {
    this.gen++;
    this.engine.stop();
    this.status = 'idle';
    this.index = -1;
    this.emitBlock();
  }

  // ------------------------------------------------------------------ internals

  private jump(to: number): void {
    if (!this.blocks.length) return;
    const i = Math.max(0, Math.min(this.blocks.length - 1, to));
    this.index = i;
    this.part = 0;
    if (this.status === 'playing') this.start();
    else {
      if (this.status === 'ended') this.status = 'paused';
      this.emitBlock();
      this.emit();
    }
  }

  private restartIfPlaying(): void {
    if (this.status === 'playing') this.start();
  }

  private start(): void {
    const gen = ++this.gen;
    this.engine.stop();
    this.status = 'playing';
    this.emitBlock();
    this.emit();
    void this.run(gen);
  }

  private async run(gen: number): Promise<void> {
    while (gen === this.gen && this.index < this.blocks.length) {
      const block = this.blocks[this.index];
      const parts = splitUtterances(block.text);
      while (gen === this.gen && this.part < parts.length) {
        try {
          await this.engine.speak(parts[this.part], { rate: this.rate, voiceId: this.voiceId, lang: this.opts.lang });
        } catch (e) {
          if (gen !== this.gen) return;
          this.gen++;
          this.status = 'paused';
          this.emit();
          this.opts.onError?.((e as Error)?.message || 'Speech failed');
          return;
        }
        if (gen !== this.gen) return;
        this.part++;
      }
      if (gen !== this.gen) return;
      if (this.index + 1 >= this.blocks.length) break;
      this.index++;
      this.part = 0;
      this.emitBlock();
      this.emit();
    }
    if (gen !== this.gen) return;
    this.status = 'ended';
    this.part = 0;
    this.emit();
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }

  private lastBlock: TtsBlock | null = null;

  private emitBlock(): void {
    const b = this.index >= 0 ? (this.blocks[this.index] ?? null) : null;
    if (b === this.lastBlock) return;
    this.lastBlock = b;
    this.opts.onBlock?.(b ? this.index : -1, b);
  }
}
