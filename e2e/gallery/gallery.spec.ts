/**
 * Screenshot gallery: seeds a realistic library on the emulators (essays, an arXiv paper, an X thread, an RSS
 * feed, an EPUB, highlights) and captures the web app on a desktop, on a phone and on a Boox Go 6 e-reader.
 * The Android/iOS app runs this same bundle in a native WebView, so the phone and Boox shots show the app too.
 *
 * Run: `npm run gallery` (writes docs/screenshots/gallery/*.png). Needs outbound internet for the saved pages.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { currentUser, fakeSpeech, googleSignIn, nav, newAccount, newContext, openAddDialog, row } from '../helpers/app';
import { makeEpub, EPUB_TITLE } from '../helpers/fixtures';
import { callFunction, HOSTING, listDocs, setDoc, waitFor } from '../helpers/emulators';
import { ANTHROPIC_MODEL, ANTHROPIC_PORT, FakeApi } from '../helpers/integrations';

test.describe.configure({ mode: 'serial' });

const DIR = fileURLToPath(new URL('../../docs/screenshots/gallery/', import.meta.url));
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 820 }, screen: { width: 1280, height: 820 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2 };
/** Boox Go 6: 1072x1448 px panel, rendered at 2x. */
const BOOX: BrowserContextOptions = { viewport: { width: 536, height: 724 }, screen: { width: 536, height: 724 }, deviceScaleFactor: 2 };

const GREAT_WORK = 'How to Do Great Work';
const SUMMARY = [
  'TL;DR: Great work comes from picking something you are naturally good at and deeply curious about, then working on it hard and consistently.',
  '- Choose work by aptitude and interest; ambition takes care of itself.',
  '- You often only find out what to work on by working.',
  '- Curiosity, delight and the desire to do something impressive drive great work.',
  '- Consistency compounds: small daily progress beats sporadic heroics.',
  '- Stay open to being wrong and keep your projects small enough to finish.',
].join('\n');

const account = newAccount();
let uid = '';
let greatWorkId = '';
let anthropic: FakeApi;

async function shot(p: Page, name: string): Promise<void> {
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(600); // images in view finish decoding
  await p.screenshot({ path: `${DIR}${name}.png`, animations: 'disabled', caret: 'hide' });
}

async function signedIn(browser: Browser, opts: BrowserContextOptions & { theme?: 'light' | 'dark' | 'sepia' | 'eink' }): Promise<Page> {
  const ctx = await newContext(browser, opts as Parameters<typeof newContext>[1]);
  await fakeSpeech(ctx, 600_000);
  const p = await ctx.newPage();
  await googleSignIn(p, account);
  await expect(row(p, GREAT_WORK)).toBeVisible({ timeout: 60_000 });
  return p;
}

async function openItem(p: Page, title: string | RegExp): Promise<void> {
  await row(p, title).locator('.item-title a').click();
  await expect(p.locator('.reader-content')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  anthropic = new FakeApi(ANTHROPIC_PORT, () => ({
    body: {
      id: 'msg_gallery',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [{ type: 'text', text: SUMMARY }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 120 },
    },
  }));
  await anthropic.start();
});

test.afterAll(async () => {
  await anthropic?.stop();
});

test('seed a realistic library', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const ctx = await newContext(browser, { ...DESKTOP, theme: 'light' });
  const p = await ctx.newPage();
  await p.goto('/login');
  await expect(p.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await googleSignIn(p, account);
  const user = await currentUser(p);
  uid = user.uid;

  const { key } = await callFunction<{ key: string }>('createApiKey', { name: 'Gallery', scope: 'all' }, user);
  const save = async (url: string, extra: Record<string, unknown>) => {
    const res = await request.post(`${HOSTING}/api/save`, { headers: { authorization: `Bearer ${key}` }, data: { url, ...extra } });
    expect(res.ok(), `save ${url}`).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  await save('https://en.wikipedia.org/wiki/Electronic_paper', { tags: ['e-ink', 'hardware'], category: 'Reference' });
  await save('https://x.com/naval/status/1002103360646823936', { tags: ['ideas'] });
  await save('https://arxiv.org/abs/1706.03762', { tags: ['ml', 'transformers'], category: 'Papers' });
  await save('https://www.paulgraham.com/hwh.html', { tags: ['essays', 'work'], category: 'Essays' });
  await save('https://www.paulgraham.com/kids.html', { tags: ['essays', 'life'], category: 'Essays' });
  greatWorkId = await save('https://www.paulgraham.com/greatwork.html', { tags: ['essays', 'career'], category: 'Essays' });

  // A feed and an uploaded EPUB.
  await callFunction('addFeed', { url: 'https://simonwillison.net/atom/everything/', categoryId: null, tags: ['blogs'] }, user).catch(() => null);
  const dialog = await openAddDialog(p);
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'lighthouse.epub', mimeType: 'application/epub+zip', buffer: await makeEpub() });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // Wait for processing to finish (errors are tolerated: a live site may be down).
  await waitFor(
    'library processed',
    async () => {
      const items = await listDocs(`users/${uid}/items`);
      const lib = items.filter((i) => i.data.location === 'library');
      return lib.length >= 7 && lib.every((i) => i.data.fetchStatus === 'done' || i.data.fetchStatus === 'error');
    },
    300_000,
  );

  // Reading state: one favourite, one finished, progress on another.
  const items = await listDocs(`users/${uid}/items`);
  const byTitle = (re: RegExp) => items.find((i) => re.test(String(i.data.title)));
  const hwh = byTitle(/Work Hard/);
  const kids = byTitle(/Having Kids/);
  const paper = byTitle(/Attention/);
  if (hwh) await setDoc(`users/${uid}/items/${hwh.id}`, { ...hwh.data, favorite: true, progress: 0.35 } as Record<string, unknown>).catch(() => null);
  if (kids) await setDoc(`users/${uid}/items/${kids.id}`, { ...kids.data, status: 'archived', archivedAt: new Date(), progress: 1 } as Record<string, unknown>).catch(() => null);
  if (paper) await setDoc(`users/${uid}/items/${paper.id}`, { ...paper.data, progress: 0.12 } as Record<string, unknown>).catch(() => null);

  // Highlights in "How to Do Great Work".
  const now = new Date();
  await setDoc(`users/${uid}/highlights/g1`, {
    itemId: greatWorkId,
    text: 'The way to figure out what to work on is by working.',
    prefix: '',
    suffix: " If you're",
    note: 'Bias to action — start before you feel ready.',
    color: 'yellow',
    createdAt: now,
    updatedAt: now,
  });
  await setDoc(`users/${uid}/highlights/g2`, {
    itemId: greatWorkId,
    text: 'Ambitious people are if anything already too conservative about it.',
    prefix: 'third criterion. ',
    suffix: ' So all',
    note: '',
    color: 'blue',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.close();
});

test('desktop (1280x820)', async ({ browser }) => {
  test.setTimeout(300_000);
  const p = await signedIn(browser, { ...DESKTOP, theme: 'light' });
  await shot(p, 'desktop-library-light');

  await openItem(p, GREAT_WORK);
  await expect(p.locator('.reader-content mark.hl').first()).toBeVisible({ timeout: 20_000 });
  await p.locator('.reader-content mark.hl').first().scrollIntoViewIfNeeded();
  await p.mouse.wheel(0, -200);
  await shot(p, 'desktop-reader-light');

  // AI summary (the Anthropic API is faked here; in production it uses your Claude API key).
  await p.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }).click();
  await p.getByRole('menuitem', { name: 'Summarize' }).click();
  await expect(p.getByText(/TL;DR/).first()).toBeVisible({ timeout: 30_000 });
  await shot(p, 'desktop-reader-ai-summary');
  await p.keyboard.press('Escape');
  await p.goBack();

  await nav(p, 'Feed');
  await expect(p.locator('article.item-row').first()).toBeVisible({ timeout: 30_000 });
  await shot(p, 'desktop-feed');

  await nav(p, 'Search');
  await p.locator('#search-input').fill('curiosity');
  await expect(p.locator('article.item-row').first()).toBeVisible({ timeout: 30_000 });
  await p.waitForTimeout(1500);
  await shot(p, 'desktop-search');

  await nav(p, 'Highlights');
  await expect(p.locator('.hls-quote').first()).toBeVisible();
  await shot(p, 'desktop-highlights');

  await nav(p, 'Settings');
  await expect(p.locator('#appearance')).toBeVisible();
  await shot(p, 'desktop-settings');
  await p.locator('#extension').scrollIntoViewIfNeeded();
  await shot(p, 'desktop-settings-saving');
  await p.context().close();

  const d = await signedIn(browser, { ...DESKTOP, colorScheme: 'dark', theme: 'dark' });
  await shot(d, 'desktop-library-dark');
  await openItem(d, GREAT_WORK);
  await d.waitForTimeout(800);
  await shot(d, 'desktop-reader-dark');
  await d.context().close();
});

test('phone app (390x844)', async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await newContext(browser, { ...PHONE, theme: 'light' });
  const login = await ctx.newPage();
  await login.goto('/login');
  await expect(login.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await shot(login, 'phone-login');
  await ctx.close();

  const p = await signedIn(browser, { ...PHONE, theme: 'light' });
  await shot(p, 'phone-library');
  await p.getByRole('button', { name: 'Filters' }).click();
  await p.waitForTimeout(300);
  await shot(p, 'phone-filters');
  await p.keyboard.press('Escape');
  const dialog = await openAddDialog(p);
  await dialog.locator('input').first().fill('https://www.paulgraham.com/wealth.html');
  await shot(p, 'phone-add');
  await p.keyboard.press('Escape');
  await openItem(p, /Attention/);
  await p.waitForTimeout(800);
  await shot(p, 'phone-reader-paper');
  await p.goBack();
  await openItem(p, /naval|@naval/i);
  await p.waitForTimeout(800);
  await shot(p, 'phone-reader-x-thread');
  await p.context().close();

  const d = await signedIn(browser, { ...PHONE, colorScheme: 'dark', theme: 'dark' });
  await openItem(d, GREAT_WORK);
  await d.waitForTimeout(800);
  await shot(d, 'phone-reader-dark');
  await d.context().close();
});

test('themes side by side (light, sepia, dark, e-ink)', async ({ browser }) => {
  test.setTimeout(400_000);
  for (const theme of ['light', 'sepia', 'dark', 'eink'] as const) {
    const scheme = theme === 'dark' ? 'dark' : 'light';
    const desk = await signedIn(browser, { ...DESKTOP, colorScheme: scheme, theme });
    await shot(desk, `theme-${theme}-desktop-library`);
    await openItem(desk, GREAT_WORK);
    await expect(desk.locator('.reader-content mark.hl').first()).toBeVisible({ timeout: 20_000 });
    await desk.locator('.reader-content mark.hl').first().scrollIntoViewIfNeeded();
    await desk.mouse.wheel(0, -200);
    await shot(desk, `theme-${theme}-desktop-reader`);
    await desk.context().close();

    const phone = await signedIn(browser, { ...PHONE, colorScheme: scheme, theme });
    await shot(phone, `theme-${theme}-phone-library`);
    await openItem(phone, GREAT_WORK);
    await phone.waitForTimeout(800);
    await shot(phone, `theme-${theme}-phone-reader`);
    await phone.context().close();
  }
});

test('Boox Go 6 e-reader (1072x1448, e-ink theme)', async ({ browser }) => {
  test.setTimeout(300_000);
  const p = await signedIn(browser, { ...BOOX, theme: 'eink' });
  await shot(p, 'boox-library');
  await openItem(p, GREAT_WORK);
  await expect(p.locator('.page-indicator')).toHaveText(/^\d+ \/ \d+$/);
  await shot(p, 'boox-reader-pages');
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(300);
  await shot(p, 'boox-reader-page3');
  // In pages mode the toolbar is hidden until a middle tap; go back with the browser instead.
  await p.goBack();
  await openItem(p, EPUB_TITLE);
  await p.waitForTimeout(500);
  await shot(p, 'boox-reader-epub');
  await p.goBack();
  await nav(p, 'Highlights');
  await expect(p.locator('.hls-quote').first()).toBeVisible();
  await shot(p, 'boox-highlights');
  await p.context().close();
});
