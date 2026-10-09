/**
 * "Listen" (text-to-speech) player bar, fixed at the bottom of the reader: previous / play-pause / next
 * paragraph, position, speed (0.75–2×), voice (when the engine lists any) and close.
 *
 * export default ListenBar
 * export ttsAvailable(): boolean        an engine exists (native plugin in the apps, else speechSynthesis)
 * export interface ListenHandle { toggle(): void; close(): void }
 *   toggle() opens the bar and starts reading at the first paragraph visible on screen (call it straight
 *   from the click handler: browsers only allow speech that starts from a user gesture), or closes it.
 * Props (ListenBarProps): see below.
 *
 * The current block gets class "tts-current" and is kept on screen (scroll mode: scrolled to the centre
 * when it leaves the view; pages mode: the reader turns to its page). Speed and voice are remembered per
 * device. While open, <html> has class "tts-open" and --tts-bar-h (the bar height) so the reader and the
 * toast can make room for it.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Close } from '../components/Icons';
import { toast } from '../components/Toast';
import { nativeTtsEngine } from '../native';
import { Pause, Play, SkipBack, SkipForward } from './icons';
import { firstVisibleBlock, splitBlocks, TTS_RATES, TtsPlayer, webSpeechEngine, type TtsEngine, type TtsState, type TtsVoice, type ViewRect } from './tts';

export interface ListenHandle {
  toggle(): void;
  close(): void;
}

export interface ListenBarProps {
  /** The content root (.reader-content). */
  getRoot: () => HTMLElement | null;
  /** Changes when the content HTML is replaced, so the blocks are collected again. */
  contentKey: string;
  paged: boolean;
  /** Bring an element into view (ArticleHandle.goTo). */
  goTo: (el: Element, align: 'start' | 'center') => void;
  onOpenChange?: (open: boolean) => void;
  ref?: Ref<ListenHandle>;
}

const RATE_KEY = 'rl.reader.ttsRate';
const VOICE_KEY = 'rl.reader.ttsVoice';
const CURRENT = 'tts-current';
const MAX_VOICES = 80;

function getEngine(): TtsEngine | null {
  return nativeTtsEngine() ?? webSpeechEngine();
}

export function ttsAvailable(): boolean {
  return !!getEngine();
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function savedRate(): number {
  const r = Number(load(RATE_KEY));
  return TTS_RATES.includes(r) ? r : 1;
}

function uiLanguage(): string {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

function formatRate(r: number): string {
  return `${r}×`;
}

/** Voices for the picker: those of the UI language (all when none match), default first, then by name. */
function pickVoices(all: TtsVoice[], selected: string | null): TtsVoice[] {
  const base = uiLanguage().slice(0, 2).toLowerCase();
  const seen = new Set<string>();
  const unique = all.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
  let list = unique.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
  if (!list.length) list = unique;
  list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  list = list.slice(0, MAX_VOICES);
  const sel = selected ? unique.find((v) => v.id === selected) : undefined;
  if (sel && !list.includes(sel)) list.unshift(sel);
  return list;
}

export default function ListenBar({ getRoot, contentKey, paged, goTo, onOpenChange, ref }: ListenBarProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TtsState | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TtsPlayer | null>(null);
  const engineRef = useRef<TtsEngine | null>(null);
  const currentEl = useRef<HTMLElement | null>(null);

  const cb = useRef({ getRoot, paged, goTo, onOpenChange });
  cb.current = { getRoot, paged, goTo, onOpenChange };

  const voiceKey = () => `${VOICE_KEY}.${engineRef.current?.kind ?? 'web'}`;

  /** The part of the screen where the article text is visible. */
  const viewRect = (root: HTMLElement): ViewRect => {
    const clip = (root.closest('.article-clip') ?? root).getBoundingClientRect();
    let top = Math.max(0, clip.top);
    if (!cb.current.paged) {
      const tb = document.querySelector('.reader-toolbar:not([hidden])');
      if (tb) top = Math.max(top, tb.getBoundingClientRect().bottom);
    }
    const barH = barRef.current?.offsetHeight ?? 0;
    return {
      top,
      bottom: Math.min(clip.bottom, window.innerHeight - barH),
      left: Math.max(0, clip.left),
      right: Math.min(window.innerWidth, clip.right),
    };
  };

  const keepVisible = (el: HTMLElement) => {
    const root = cb.current.getRoot();
    if (!root || !el.isConnected) return;
    const view = viewRect(root);
    if (cb.current.paged) {
      const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
      // Turn when the block does not start on the page shown.
      if (r.left < view.left - 1 || r.left >= view.right - 1) cb.current.goTo(el, 'start');
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.top >= view.top + 4 && r.bottom <= view.bottom - 16) return;
    cb.current.goTo(el, r.height > view.bottom - view.top ? 'start' : 'center');
  };

  const markBlock = (el: HTMLElement | null) => {
    if (currentEl.current && currentEl.current !== el) currentEl.current.classList.remove(CURRENT);
    currentEl.current = el;
    if (!el) return;
    el.classList.add(CURRENT);
    keepVisible(el);
  };

  const ensurePlayer = (engine: TtsEngine): TtsPlayer => {
    if (playerRef.current && engineRef.current === engine) return playerRef.current;
    playerRef.current?.destroy();
    engineRef.current = engine;
    const player = new TtsPlayer(engine, {
      rate: savedRate(),
      voiceId: load(voiceKey()),
      lang: uiLanguage(),
      onChange: setState,
      onBlock: (_i, block) => markBlock(block?.el ?? null),
      onError: (msg) => toast(msg, { error: true }),
    });
    playerRef.current = player;
    return player;
  };

  const close = () => {
    playerRef.current?.destroy();
    markBlock(null);
    setOpen(false);
    setState(null);
    cb.current.onOpenChange?.(false);
  };

  const start = () => {
    const engine = getEngine();
    if (!engine) {
      toast('Reading aloud is not available on this device', { error: true });
      return;
    }
    const root = cb.current.getRoot();
    const blocks = root ? splitBlocks(root) : [];
    if (!root || !blocks.length) {
      toast('There is no text to read aloud');
      return;
    }
    const from = Math.max(0, firstVisibleBlock(blocks, viewRect(root)));
    const player = ensurePlayer(engine);
    player.setBlocks(blocks);
    player.play(from);
    setOpen(true);
    cb.current.onOpenChange?.(true);
  };

  const openRef = useRef(open);
  openRef.current = open;
  useImperativeHandle(ref, () => ({
    toggle: () => (openRef.current ? close() : start()),
    close,
  }));

  // Content re-rendered (e.g. a fresh copy was fetched): collect the blocks again, keeping the position.
  useEffect(() => {
    const player = playerRef.current;
    const root = cb.current.getRoot();
    if (!openRef.current || !player || !root) return;
    player.setBlocks(splitBlocks(root));
  }, [contentKey]);

  // Voices (may arrive late on the web).
  useEffect(() => {
    if (!open) return;
    const engine = engineRef.current;
    if (!engine) return;
    let alive = true;
    const refresh = () => {
      engine
        .getVoices()
        .then((v) => alive && setVoices(v))
        .catch(() => {});
    };
    refresh();
    const off = engine.onVoicesChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [open]);

  // Make room for the bar.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const bar = barRef.current;
    html.classList.add('tts-open');
    const setH = () => html.style.setProperty('--tts-bar-h', `${bar?.offsetHeight ?? 0}px`);
    setH();
    const ro = bar ? new ResizeObserver(setH) : null;
    if (bar) ro?.observe(bar);
    return () => {
      ro?.disconnect();
      html.classList.remove('tts-open');
      html.style.removeProperty('--tts-bar-h');
    };
  }, [open]);

  // Keep the screen on while reading aloud (the app's WebView pauses when the screen turns off).
  const playing = state?.status === 'playing';
  useEffect(() => {
    if (!playing) return;
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl) return;
    let lock: { release(): Promise<void> } | null = null;
    let alive = true;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      wl.request('screen')
        .then((l) => {
          if (alive) lock = l;
          else void l.release().catch(() => {});
        })
        .catch(() => {});
    };
    acquire();
    // The lock is dropped whenever the page is hidden; take it again on return.
    document.addEventListener('visibilitychange', acquire);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, [playing]);

  // Stop when the reader (or the article view) goes away.
  useEffect(
    () => () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      currentEl.current?.classList.remove(CURRENT);
      if (openRef.current) cb.current.onOpenChange?.(false);
    },
    [],
  );

  const voiceId = state?.voiceId ?? null;
  const voiceList = useMemo(() => pickVoices(voices, voiceId), [voices, voiceId]);

  if (!open || !state) return null;
  const player = playerRef.current;
  const count = state.count;
  const pos = Math.max(0, state.index) + 1;

  return (
    <div className="tts-bar" role="region" aria-label="Read aloud" ref={barRef}>
      <div className="tts-controls">
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous paragraph" title="Previous paragraph" disabled={state.index <= 0} onClick={() => player?.prev()}>
          <SkipBack />
        </button>
        <button type="button" className="btn btn-icon tts-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} onClick={() => player?.toggle()}>
          {playing ? <Pause /> : <Play />}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Next paragraph"
          title="Next paragraph"
          disabled={state.index >= count - 1}
          onClick={() => player?.next()}
        >
          <SkipForward />
        </button>
        <span className="tts-pos" aria-label={`Paragraph ${pos} of ${count}`}>
          {pos} / {count}
        </span>
      </div>
      <div className="tts-settings">
        <select
          className="select tts-rate"
          aria-label="Speed"
          value={String(state.rate)}
          onChange={(e) => {
            const r = Number(e.target.value);
            save(RATE_KEY, String(r));
            player?.setRate(r);
          }}
        >
          {TTS_RATES.map((r) => (
            <option key={r} value={String(r)}>
              {formatRate(r)}
            </option>
          ))}
        </select>
        {voiceList.length > 1 ? (
          <select
            className="select tts-voice"
            aria-label="Voice"
            value={voiceId ?? ''}
            onChange={(e) => {
              const v = e.target.value || null;
              save(voiceKey(), v);
              player?.setVoice(v);
            }}
          >
            <option value="">Default voice</option>
            {voiceList.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.lang ? ` (${v.lang})` : ''}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Stop and close" title="Stop and close" onClick={close}>
          <Close />
        </button>
      </div>
    </div>
  );
}
