/**
 * Capacitor integration (Android / iOS app). Every native call is guarded, so on the web these are
 * harmless no-ops (except openExternal, which opens a new tab).
 *
 * Exports:
 *   isNative(): boolean                         true inside the Android / iOS app
 *   initNative(navigate: (path) => void): void  call once after Firebase is initialised (App.tsx). Handles
 *       - deep link readlater://login?code=… → redeemLoginCode → navigate('/')
 *       - Android share sheet / "Open with": text → navigate('/add?url=…' | '/add?text=…'),
 *         PDF/EPUB → uploadFile() (waits for sign-in if needed) → navigate('/item/<id>')
 *       - mirrors window.__readerActive to the app (volume / page keys → window `hwpage` events)
 *       - keeps the status bar icons readable for the current light/dark scheme
 *   setReaderActive(active: boolean): void      same as assigning window.__readerActive
 *   openExternal(url: string): Promise<void>    in-app browser tab on native, new tab on the web
 *   nativeGoogleSignIn(): Promise<void>         opens `${publicUrl()}/app-login?return=readlater://login`
 *                                               in the system browser; the app is re-opened via the deep link
 */
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, WebPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { dismissToast, toast } from './components/Toast';
import { extractUrl, redeemLoginCode, uploadFile } from './lib/data';
import { getServices, publicUrl } from './lib/firebase';

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
  try {
    toast('Signing in…', { duration: 20_000 });
    await redeemLoginCode(code);
    dismissToast();
    navigateTo('/');
  } catch (e) {
    console.error('redeemLoginCode failed', e);
    toast(`Sign-in failed: ${errorText(e, 'the code is invalid or expired')}`, { error: true });
    navigateTo('/login');
  }
}

// ---------------------------------------------------------------------------
// Shared content

async function handleShared(p: SharedPayload): Promise<void> {
  if (p.type === 'text') {
    const url = extractUrl(p.text) ?? extractUrl(p.subject);
    if (url) {
      const title = p.subject && !extractUrl(p.subject) ? `&title=${encodeURIComponent(p.subject)}` : '';
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
  const url = `${publicUrl()}/app-login?return=${encodeURIComponent(LOGIN_RETURN_URL)}`;
  if (isNative()) {
    await Browser.open({ url });
    return;
  }
  window.location.href = url;
}

function errorText(e: unknown, fallback: string): string {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^Firebase:\s*/, '') : fallback;
}
