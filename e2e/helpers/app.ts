/** Browser-side helpers: contexts, Google sign-in through the Auth emulator, common UI steps. */
import { devices, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { HOSTING } from './emulators';

export type Theme = 'system' | 'light' | 'dark' | 'eink';

/** A 360 px wide Android phone (the narrowest layout the app supports). */
const { defaultBrowserType: _ignored, ...pixel7 } = devices['Pixel 7'];
export const PHONE: BrowserContextOptions = {
  ...pixel7,
  viewport: { width: 360, height: 740 },
  screen: { width: 360, height: 740 },
};

export interface Account {
  email: string;
  name: string;
}

export function newAccount(): Account {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { email: `reader-${id}@example.com`, name: 'Ada Reader' };
}

/**
 * New browser context against the Hosting emulator. `theme` is stored as the device preference before the
 * app first loads (later changes made in the app are kept across reloads).
 */
export async function newContext(browser: Browser, opts: BrowserContextOptions & { theme?: Theme } = {}): Promise<BrowserContext> {
  const { theme, ...options } = opts;
  const ctx = await browser.newContext({ ...PHONE, colorScheme: 'light', baseURL: HOSTING, ...options });
  if (theme) {
    await ctx.addInitScript((t) => {
      try {
        if (localStorage.getItem('rl.theme') === null) localStorage.setItem('rl.theme', JSON.stringify(t));
      } catch {
        /* storage unavailable */
      }
    }, theme);
  }
  return ctx;
}

/**
 * Sign in with Google through the Auth emulator's fake IdP popup: picks the account if it already exists
 * in the emulator, otherwise "Add new account" with the given email and name.
 */
export async function googleSignIn(page: Page, account: Account): Promise<void> {
  await page.goto('/login');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Continue with Google' }).click()]);
  await popup.waitForLoadState('domcontentloaded');
  const existing = popup.locator('li', { hasText: account.email });
  const addNew = popup.getByText('Add new account');
  await expect(existing.or(addNew).first()).toBeVisible();
  if (await existing.count()) {
    await existing.first().click();
  } else {
    await addNew.click();
    await popup.locator('#email-input').fill(account.email);
    await popup.locator('#display-name-input').fill(account.name);
    await popup.locator('#sign-in').click();
  }
  await popup.waitForEvent('close');
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/**
 * The signed-in Firebase user of the page (read from the Auth SDK's IndexedDB persistence), with its current
 * ID token for calling functions from the test.
 */
export async function currentUser(page: Page): Promise<{ uid: string; email: string | null; idToken: string }> {
  const user = await page.evaluate(
    () =>
      new Promise<{ uid: string; email: string | null; idToken: string } | null>((resolve, reject) => {
        const req = indexedDB.open('firebaseLocalStorageDb');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const all = tx.objectStore('firebaseLocalStorage').getAll();
          all.onsuccess = () => {
            const rec = (all.result as { fbase_key: string; value: { uid: string; email?: string; stsTokenManager?: { accessToken?: string } } }[]).find((r) =>
              r.fbase_key.startsWith('firebase:authUser:'),
            );
            resolve(rec ? { uid: rec.value.uid, email: rec.value.email ?? null, idToken: rec.value.stsTokenManager?.accessToken ?? '' } : null);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
  if (!user) throw new Error('Not signed in');
  return user;
}

/** Fails when the page scrolls horizontally (content wider than the viewport). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
}

/** Opens the add dialog from the top bar ("+ Add" on wide screens, the compact "Add" button on phones). */
export async function openAddDialog(page: Page): Promise<Locator> {
  await page.locator('header.topbar').getByRole('button', { name: /^(\+ Add|Add)$/ }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Library' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** In-app navigation through the top bar (keeps pending local writes, unlike page.goto). */
export async function nav(page: Page, name: 'Library' | 'Feed' | 'Search' | 'Highlights' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
}

/** The library/feed/search row of an item, found by its title. */
export function row(page: Page, title: string | RegExp): Locator {
  return page.locator('article.item-row').filter({ has: page.locator('.item-title', { hasText: title }) });
}

/** A Library view tab ("Unread", "Archive", "Favorites", "All"). */
export function viewTab(page: Page, view: 'Unread' | 'Archive' | 'Favorites' | 'All'): Locator {
  return page.getByRole('navigation', { name: 'Library views' }).getByRole('button', { name: new RegExp(`^${view}`) });
}

/**
 * Replaces window.speechSynthesis in every page of the context with a scripted stand-in. Headless Chromium has
 * no voices and may never fire the events read-aloud waits for, so the Listen tests drive the real player
 * through this instead: each utterance "speaks" for `ms` (then fires `end`), cancel() fires an `interrupted`
 * error like Chrome does, and the spoken texts are kept in window.__spoken.
 */
export async function fakeSpeech(ctx: BrowserContext, ms = 4000): Promise<void> {
  await ctx.addInitScript((duration: number) => {
    const spoken: string[] = [];
    let current: SpeechSynthesisUtterance | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventTarget();
    const fire = (u: SpeechSynthesisUtterance, type: string, extra: Record<string, unknown> = {}) => u.dispatchEvent(Object.assign(new Event(type), extra));
    const finishLater = (u: SpeechSynthesisUtterance) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (current !== u) return;
        current = null;
        synth.speaking = false;
        fire(u, 'end');
      }, duration);
    };
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => [],
      speak(u: SpeechSynthesisUtterance) {
        spoken.push(u.text);
        current = u;
        synth.speaking = true;
        setTimeout(() => current === u && fire(u, 'start'), 0);
        if (!synth.paused) finishLater(u);
      },
      cancel() {
        clearTimeout(timer);
        const u = current;
        current = null;
        synth.speaking = false;
        if (u) fire(u, 'error', { error: 'interrupted' });
      },
      pause() {
        synth.paused = true;
        clearTimeout(timer);
      },
      resume() {
        synth.paused = false;
        if (current) finishLater(current);
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
  }, ms);
}
