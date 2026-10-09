/**
 * Capacitor integration (Android / iOS app). Every native call is guarded, so on the web these are
 * harmless no-ops (except openExternal, which opens a new tab).
 *
 * Exports:
 *   isNative(): boolean                         true inside the Android / iOS app
 *   initNative(navigate: (path) => void): void  call once after Firebase is initialised (App.tsx). Handles
 *       - deep link readlater://login?code=… → redeemLoginCode(code, verifier) → navigate('/') (or stays on
 *         /login, which continues to its `next`). Only while a sign-in started by nativeGoogleSignIn() is
 *         pending (its verifier is stored, 15 min); any other login link is ignored, so a web page or another
 *         app cannot sign the app into a different account
 *       - Android share sheet / "Open with": text → navigate('/add?url=…' | '/add?text=…') (marked as a
 *         trusted share, see takeTrustedShare), PDF/EPUB → uploadFile() (waits for sign-in if needed) →
 *         navigate('/item/<id>')
 *       - mirrors window.__readerActive to the app (volume / page keys → window `hwpage` events)
 *       - keeps the status bar icons readable for the current light/dark scheme
 *   setReaderActive(active: boolean): void      same as assigning window.__readerActive
 *   openExternal(url: string): Promise<void>    in-app browser tab on native, new tab on the web
 *   nativeGoogleSignIn(): Promise<void>         opens `${publicUrl()}/app-login?return=readlater://login&challenge=…`
 *                                               in the system browser (PKCE S256: the code it returns can only be
 *                                               redeemed with the verifier kept here); the app is re-opened via
 *                                               the deep link
 *   takeTrustedShare(url): boolean              true when `/add?url=` was opened by the app's own share handler
 *                                               for this URL (within 30 s); /add then saves without asking
 *   finishShare(navigate): void                 after saving a share: back to the app it came from (Android), else '/'
 *   nativeTtsEngine(): TtsEngine | null         text-to-speech through @capacitor-community/text-to-speech
 *                                               (Android TextToSpeech / iOS AVSpeechSynthesizer) inside the
 *                                               apps; null on the web (the reader then uses speechSynthesis)
 */
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, WebPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { QueueStrategy, TextToSpeech } from '@capacitor-community/text-to-speech';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { dismissToast, toast } from './components/Toast';
import { extractUrl, redeemLoginCode, uploadFile } from './lib/data';
import { getServices, publicUrl } from './lib/firebase';
import type { SpeakOptions, TtsEngine, TtsVoice } from './reader/tts';

declare global {
  interface Window {
    /** Set by the reader while it is mounted; while true, hardware volume / page keys turn pages. */
    __readerActive?: boolean;
  }
}

export const APP_SCHEME = 'readlater';
export const LOGIN_RETURN_URL = `${APP_SCHEME}://login`;

// ---------------------------------------------------------------------------
// ShareIntent plugin (android/app/src/main/java/app/readlater/reader/ShareIntentPlugin.java)

export type SharedPayload =
  | { type: 'text'; text: string; subject?: string }
  | { type: 'file'; name: string; mimeType: string; path: string; size: number }
  | { type?: undefined };

interface ShareIntentPlugin {
  getPending(): Promise<SharedPayload>;
  setReaderActive(options: { active: boolean }): Promise<void>;
  addListener(event: 'shared', listener: (payload: SharedPayload) => void): Promise<PluginListenerHandle>;
}

class ShareIntentWeb extends WebPlugin implements ShareIntentPlugin {
  async getPending(): Promise<SharedPayload> {
    return {};
  }
  async setReaderActive(): Promise<void> {}
}

const ShareIntent = registerPlugin<ShareIntentPlugin>('ShareIntent', { web: () => new ShareIntentWeb() });

// ---------------------------------------------------------------------------

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function hasShareIntent(): boolean {
  return isNative() && Capacitor.isPluginAvailable('ShareIntent');
}

let initialized = false;
let navigateTo: (path: string) => void = () => {};

export function initNative(navigate: (path: string) => void): void {
  navigateTo = navigate;
  if (initialized || !isNative()) return;
  initialized = true;

  installReaderActiveBridge();
  syncSystemBars();
  removeServiceWorkers();

  // Deep links. appUrlOpen events are retained until a listener exists, so a cold-start link arrives here too.
  void CapApp.addListener('appUrlOpen', ({ url }) => void handleAppUrl(url)).catch((e: unknown) =>
    console.error('appUrlOpen listener failed', e),
  );

  if (hasShareIntent()) {
    void (async () => {
      try {
        // Listen first, then collect whatever arrived before the web app was ready.
        await ShareIntent.addListener('shared', (p) => void handleShared(p));
        const pending = await ShareIntent.getPending();
        await handleShared(pending);
      } catch (e) {
        console.error('ShareIntent init failed', e);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Deep links

const redeemedCodes = new Set<string>();

const VERIFIER_KEY = 'rl.nativeSignIn';
/** A sign-in started in the system browser stays redeemable this long (codes live 10 minutes). */
const VERIFIER_TTL_MS = 15 * 60_000;

function base64url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Start a sign-in: a fresh verifier, kept (also across an app restart) until the deep link comes back. */
async function beginSignIn(): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, at: Date.now() }));
  } catch {
    /* private mode: the sign-in still works while the app stays in memory */
  }
  pendingVerifier = { verifier, at: Date.now() };
  return pkceChallenge(verifier);
}

let pendingVerifier: { verifier: string; at: number } | null = null;

/** The verifier of a sign-in started by this app (and not yet finished), or null. Consumed once. */
function takeVerifier(): string | null {
  let v = pendingVerifier;
  try {
    const raw = localStorage.getItem(VERIFIER_KEY);
    if (raw) v = JSON.parse(raw) as { verifier: string; at: number };
    localStorage.removeItem(VERIFIER_KEY);
  } catch {
    /* ignore */
  }
  pendingVerifier = null;
  if (!v || typeof v.verifier !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > VERIFIER_TTL_MS) return null;
  return v.verifier;
}

async function handleAppUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== `${APP_SCHEME}:`) return; // e.g. content:// files are handled by ShareIntent
  const target = (url.host || url.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
  if (target !== 'login') return;

  const code = url.searchParams.get('code');
  if (!code || redeemedCodes.has(code)) return;
  redeemedCodes.add(code);
  // iOS keeps the sign-in sheet open after the redirect; Android's custom tab is closed by singleTask.
  if (Capacitor.getPlatform() === 'ios') void Browser.close().catch(() => {});
  // Only finish a sign-in this app started; never switch accounts because some link was opened.
  const verifier = takeVerifier();
  if (!verifier) {
    console.warn('Ignoring a login link: no sign-in was started in this app');
    toast('Sign-in link ignored. To sign in, use “Continue with Google” in the app.', { error: true });
    return;
  }
  try {
    toast('Signing in…', { duration: 20_000 });
    await redeemLoginCode(code, verifier);
    dismissToast();
    // The login page continues to its `next` (e.g. a shared link waiting to be saved) by itself.
    if (window.location.pathname !== '/login') navigateTo('/');
  } catch (e) {
    console.error('redeemLoginCode failed', e);
    toast(`Sign-in failed: ${errorText(e, 'the code is invalid or expired')}`, { error: true });
    navigateTo('/login');
  }
}

// ---------------------------------------------------------------------------
// Shared content

let trustedShare: { url: string; at: number } | null = null;
/** How long after the share handler opened /add it counts as the app's own share. */
const TRUSTED_SHARE_MS = 30_000;

export function takeTrustedShare(url: string): boolean {
  // Not consumed: React may run the caller twice (StrictMode); only this module ever sets it.
  return !!trustedShare && trustedShare.url === url && Date.now() - trustedShare.at < TRUSTED_SHARE_MS;
}

export function finishShare(navigate: (path: string) => void): void {
  navigate('/');
  if (isNative() && Capacitor.getPlatform() === 'android') void CapApp.minimizeApp().catch(() => {});
}

async function handleShared(p: SharedPayload): Promise<void> {
  if (p.type === 'text') {
    const url = extractUrl(p.text) ?? extractUrl(p.subject);
    if (url) {
      const title = p.subject && !extractUrl(p.subject) ? `&title=${encodeURIComponent(p.subject)}` : '';
      trustedShare = { url, at: Date.now() };
      navigateTo(`/add?url=${encodeURIComponent(url)}${title}`);
    } else {
      navigateTo(`/add?text=${encodeURIComponent(p.text)}`);
    }
    return;
  }
  if (p.type === 'file') await saveSharedFile(p);
}

async function saveSharedFile(p: { name: string; mimeType: string; path: string }): Promise<void> {
  try {
    await waitForSignIn();
    toast(`Uploading ${p.name}…`, { duration: 600_000 });
    const res = await fetch(Capacitor.convertFileSrc(p.path));
    if (!res.ok) throw new Error(`Could not read the shared file (${res.status})`);
    const blob = await res.blob();
    // The sender only declares a type: check the bytes before uploading anything.
    if (!(await looksLike(blob, p.mimeType))) throw new Error('this is not a PDF or EPUB file');
    const file = blob.type === p.mimeType ? blob : new Blob([blob], { type: p.mimeType });
    let lastStep = 0;
    const id = await uploadFile(file, p.name, {
      onProgress: (f) => {
        const step = Math.floor(f * 10);
        if (step > lastStep && step < 10) {
          lastStep = step;
          toast(`Uploading ${p.name}… ${step * 10}%`, { duration: 600_000 });
        }
      },
    });
    toast('Saved to Library');
    navigateTo(`/item/${encodeURIComponent(id)}`);
  } catch (e) {
    console.error('Saving shared file failed', e);
    toast(`Could not save ${p.name}: ${errorText(e, 'upload failed')}`, { error: true });
  }
}

/** True when the file starts like the type it claims: `%PDF-` (PDF) or a ZIP whose first entry is the EPUB mimetype. */
export async function looksLike(blob: Blob, mimeType: string): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  const text = String.fromCharCode(...head);
  if (mimeType === 'application/pdf') return text.includes('%PDF-');
  if (mimeType === 'application/epub+zip') return text.startsWith('PK\x03\x04') && text.slice(30, 58) === 'mimetypeapplication/epub+zip';
  return false;
}

/** Resolve once a user is signed in; sends a signed-out user to the login page first. */
async function waitForSignIn(): Promise<User> {
  const { auth } = getServices();
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  toast('Sign in to save the shared file. It will upload right after.', { duration: 8_000 });
  navigateTo('/login');
  return new Promise<User>((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        unsubscribe();
        resolve(u);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Reader state → native volume-key handling

let bridgeInstalled = false;
let nativeReaderActive: boolean | null = null;

function pushReaderActive(active: boolean): void {
  if (active === nativeReaderActive) return;
  nativeReaderActive = active;
  if (!hasShareIntent()) return;
  void ShareIntent.setReaderActive({ active }).catch((e: unknown) => console.warn('setReaderActive failed', e));
}

/** Turn plain assignments to window.__readerActive (done by the reader) into native calls. */
function installReaderActiveBridge(): void {
  if (bridgeInstalled) return;
  let value = window.__readerActive === true;
  try {
    Object.defineProperty(window, '__readerActive', {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v: unknown) => {
        value = v === true;
        pushReaderActive(value);
      },
    });
    bridgeInstalled = true;
  } catch (e) {
    console.warn('Could not observe window.__readerActive', e);
  }
  pushReaderActive(value);
}

export function setReaderActive(active: boolean): void {
  window.__readerActive = active;
  if (!bridgeInstalled) pushReaderActive(active);
}

// ---------------------------------------------------------------------------
// Status bar: dark icons on light themes (incl. e-ink), light icons on dark.

function syncSystemBars(): void {
  const root = document.documentElement;
  let current: string | null = null;
  const apply = () => {
    const scheme = root.dataset.scheme === 'dark' ? 'dark' : 'light';
    if (scheme === current) return;
    current = scheme;
    void SystemBars.setStyle({ style: scheme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-scheme', 'data-theme'] });
}

/**
 * The apps load their bundled files from disk; a PWA service worker would only serve stale caches after an
 * app update. The build strips it (scripts/cap-strip-sw.mjs); this also drops any registration left over.
 */
function removeServiceWorkers(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}

// ---------------------------------------------------------------------------

export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function nativeGoogleSignIn(): Promise<void> {
  const challenge = await beginSignIn();
  const url = `${publicUrl()}/app-login?return=${encodeURIComponent(LOGIN_RETURN_URL)}&challenge=${encodeURIComponent(challenge)}`;
  if (isNative()) {
    await Browser.open({ url });
    return;
  }
  window.location.href = url;
}

// ---------------------------------------------------------------------------
// Text-to-speech (reader "Listen")

const TTS_UNSUPPORTED_LANGUAGE = 'This language is not supported.';

class NativeTtsEngine implements TtsEngine {
  readonly kind = 'native' as const;
  private voices: TtsVoice[] | null = null;
  private pending: (() => void) | null = null;
  private seq = 0;

  async getVoices(): Promise<TtsVoice[]> {
    if (this.voices) return this.voices;
    try {
      const { voices } = await TextToSpeech.getSupportedVoices();
      // The plugin addresses voices by their index in this list.
      this.voices = voices.map((v, i) => ({ id: String(i), name: v.name, lang: v.lang, isDefault: !!v.default }));
    } catch (e) {
      console.warn('getSupportedVoices failed', e);
      this.voices = [];
    }
    return this.voices;
  }

  onVoicesChanged(): () => void {
    return () => {};
  }

  async speak(text: string, opts: SpeakOptions): Promise<void> {
    // QueueStrategy.Flush interrupts whatever the engine is saying; only the pending promise needs settling.
    this.cancelPending();
    const seq = this.seq;
    const voices = opts.voiceId ? await this.getVoices() : [];
    if (seq !== this.seq) return;
    const voice = opts.voiceId ? voices.find((v) => v.id === opts.voiceId) : undefined;
    const lang = voice?.lang || opts.lang || 'en-US';
    const say = async (language: string, attempt = 0): Promise<void> => {
      try {
        await TextToSpeech.speak({
          text,
          lang: language,
          rate: opts.rate,
          voice: voice ? Number(voice.id) : undefined,
          category: 'playback',
          queueStrategy: QueueStrategy.Flush,
        });
      } catch (e) {
        if (seq !== this.seq) return;
        const msg = errorText(e, '');
        // The phone has no voice for the guessed language: use English instead.
        if (msg === TTS_UNSUPPORTED_LANGUAGE && language !== 'en-US') return say('en-US', attempt);
        // Android's engine initialises asynchronously after the app starts.
        if (/not yet initialized/i.test(msg) && attempt < 4) {
          await new Promise((r) => setTimeout(r, 400));
          if (seq !== this.seq) return;
          return say(language, attempt + 1);
        }
        throw e;
      }
    };
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const settle = (err?: unknown) => {
        if (done) return;
        done = true;
        if (this.pending === settleNow) this.pending = null;
        if (err) reject(err instanceof Error ? err : new Error(errorText(err, 'Speech failed')));
        else resolve();
      };
      // The plugin drops its pending request on stop() without settling it, so settle it here.
      const settleNow = () => settle();
      this.pending = settleNow;
      say(lang).then(
        () => settle(),
        (e: unknown) => settle(seq === this.seq ? e : undefined),
      );
    });
  }

  private cancelPending(): void {
    this.seq++;
    const p = this.pending;
    this.pending = null;
    p?.();
  }

  stop(): void {
    this.cancelPending();
    void TextToSpeech.stop().catch(() => {});
  }
}

let ttsEngine: NativeTtsEngine | null = null;

export function nativeTtsEngine(): TtsEngine | null {
  if (!isNative() || !Capacitor.isPluginAvailable('TextToSpeech')) return null;
  ttsEngine ??= new NativeTtsEngine();
  return ttsEngine;
}

// ---------------------------------------------------------------------------

function errorText(e: unknown, fallback: string): string {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^Firebase:\s*/, '') : fallback;
}
