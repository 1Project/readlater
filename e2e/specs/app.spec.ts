/**
 * End-to-end walk through Readlater on the Firebase emulators, on a 360 px Android-sized screen.
 *
 * One Google account (created through the Auth emulator's fake IdP popup) is used by all tests, in order:
 * later tests build on the library earlier ones created. Extra browser contexts sign in as the same account
 * (picking it in the IdP popup) or, in the device-link test, with a one-time code.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  currentUser,
  expectNoHorizontalOverflow,
  googleSignIn,
  nav,
  newAccount,
  newContext,
  openAddDialog,
  row,
  viewTab,
} from '../helpers/app';
import { EPUB_CHAPTERS, EPUB_TITLE, makeEpub, makePdf, PDF_BODY_WORD, PDF_TITLE } from '../helpers/fixtures';
import { getDoc, HOSTING, listDocs, waitFor } from '../helpers/emulators';

test.describe.configure({ mode: 'serial' });

const ARTICLE_URL = 'https://www.paulgraham.com/greatwork.html';
const ARTICLE_TITLE = 'How to Do Great Work';
const ARTICLE_START = /If you collected lists of techniques for doing great work/;
/** Appears in the essay's body but not in its title, excerpt or metadata. */
const ARTICLE_BODY_WORD = 'procrastination';
const EXAMPLE_TITLE = 'Example Domain';
const PROCESSING = 90_000;

const account = newAccount();
let context: BrowserContext;
let page: Page;
let uid = '';
let articleId = '';
let highlightText = '';
const highlightNote = 'Curiosity is the engine — remember this one.';

test.beforeAll(async ({ browser }) => {
  context = await newContext(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/** Waits until the server has stored the item field (e.g. a debounced client write reached the emulator). */
async function waitForItem(id: string, what: string, check: (d: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return waitFor(what, async () => {
    const d = await getDoc(`users/${uid}/items/${id}`);
    return d && check(d) ? d : null;
  });
}

async function openItem(p: Page, title: string | RegExp): Promise<void> {
  await row(p, title).locator('.item-title a').click();
  await expect(p).toHaveURL(/\/item\//);
  await expect(p.locator('.reader-toolbar')).toBeAttached();
}

/** Selects about the first `words` words of a long text node inside the article that is on screen. */
async function selectVisibleText(p: Page, words = 7): Promise<string> {
  const text = await p.evaluate((n) => {
    const root = document.querySelector('.reader-content');
    if (!root) throw new Error('no article');
    const onScreen = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    };
    for (const para of Array.from(root.querySelectorAll('p'))) {
      if (!onScreen(para) || para.closest('mark')) continue;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        const m = value.match(new RegExp(`^\\s*(\\S+\\s+){${n - 1}}\\S+`));
        if (!m || m[0].trim().length < 25) continue;
        const range = document.createRange();
        range.setStart(node, value.length - value.trimStart().length);
        range.setEnd(node, m[0].length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return range.toString();
      }
    }
    throw new Error('no selectable paragraph on screen');
  }, words);
  return text.trim();
}

test('1. Google sign-in through the Auth emulator shows the empty library', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await googleSignIn(page, account);
  await expect(page.getByText('Your library is empty')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add a link' })).toBeVisible();
  const user = await currentUser(page);
  expect(user.email).toBe(account.email);
  uid = user.uid;
  await expectNoHorizontalOverflow(page);
});

test('2. Add an article, read it in pages mode, progress survives a reload', async () => {
  const dialog = await openAddDialog(page);
  await dialog.getByPlaceholder('https://…').fill(ARTICLE_URL);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // The row appears at once with a placeholder title and the fetch state, then gets the real title.
  const pending = page.locator('article.item-row').first();
  await expect(pending.locator('.item-state')).toContainText(/Fetching…|Processing…/);
  articleId = (await pending.getAttribute('data-item-id')) ?? '';
  expect(articleId).not.toBe('');
  const article = row(page, ARTICLE_TITLE);
  await expect(article).toBeVisible({ timeout: PROCESSING });
  await expect(article.locator('.item-state')).toHaveCount(0);
  await expect(article.locator('.item-meta')).toContainText(/paulgraham\.com|Paul Graham/i);
  await expectNoHorizontalOverflow(page);

  await openItem(page, ARTICLE_TITLE);
  await expect(page.locator('.reader-content')).toContainText(ARTICLE_START);
  await expect(page.locator('.reader')).toHaveClass(/reader-scroll/);

  // Switch to pages mode in the text settings panel.
  await page.getByRole('button', { name: 'Text settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Reading settings' });
  await panel.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Pages' }).click();
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.reader')).toHaveClass(/reader-pages/);

  const indicator = page.locator('.page-indicator');
  await expect(indicator).toHaveText(/^1 \/ \d+$/);
  const total = Number((await indicator.textContent())!.split('/')[1]);
  expect(total).toBeGreaterThan(5);
  await page.keyboard.press('ArrowRight');
  await expect(indicator).toHaveText(`2 / ${total}`);
  await expectNoHorizontalOverflow(page);

  // Progress is saved (debounced) to the item; after a reload the reader opens on the same page.
  const saved = await waitForItem(articleId, 'reading progress to be saved', (d) => Number(d.progress) > 0);
  expect(Number(saved.progress)).toBeLessThan(0.5);
  await page.reload();
  await expect(page.locator('.reader')).toHaveClass(/reader-pages/);
  await expect(indicator).toHaveText(`2 / ${total}`);
});

test('3. Highlight a passage, add a note, find it on /highlights and export Markdown', async () => {
  await expect(page).toHaveURL(new RegExp(`/item/${articleId}$`));
  await expect(page.locator('.page-indicator')).toBeVisible();

  highlightText = await selectVisibleText(page);
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Highlight', exact: true }).click();

  const mark = page.locator('.reader-content mark.hl[data-hid]').first();
  await expect(mark).toBeVisible();
  await expect(page.getByRole('button', { name: 'Highlights (1)' })).toBeAttached();

  // Tap the highlight to add a note.
  await mark.click();
  const dialog = page.getByRole('dialog', { name: 'Highlight' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('blockquote')).toHaveText(highlightText);
  await dialog.getByLabel('Note').fill(highlightNote);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await waitFor('highlight note to be saved', async () => (await listDocs(`users/${uid}/highlights`)).find((h) => h.data.note === highlightNote));

  await page.keyboard.press('Escape'); // back to the list
  await expect(page).not.toHaveURL(/\/item\//);
  await nav(page, 'Highlights');
  const group = page.locator('.hls-group', { hasText: ARTICLE_TITLE });
  await expect(group.locator('.hls-quote')).toHaveText(highlightText);
  await expect(group.locator('.hls-note')).toHaveText(highlightNote);
  await expectNoHorizontalOverflow(page);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Markdown' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^readlater-highlights-\d{4}-\d{2}-\d{2}\.md$/);
  const md = readFileSync(await download.path(), 'utf8');
  expect(md).toContain(ARTICLE_TITLE);
  expect(md).toContain(highlightText);
  expect(md).toContain(highlightNote);
  expect(md).toContain(ARTICLE_URL);
});

test('7. API key from Settings saves a link through POST /api/save', async ({ request }) => {
  await nav(page, 'Settings');
  const saving = page.locator('#saving');
  await saving.getByLabel('Key name').fill('E2E script');
  await saving.getByRole('button', { name: 'Create key' }).click();
  const key = ((await saving.locator('.set-key').textContent()) ?? '').trim();
  expect(key).toMatch(/^rl_[A-Za-z0-9]{40}$/);
  await expect(saving.getByText('E2E script').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const res = await request.post(`${HOSTING}/api/save`, {
    headers: { authorization: `Bearer ${key}` },
    data: { url: 'https://example.com/', tags: ['via-api'] },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; id: string };
  expect(body.ok).toBe(true);

  const bad = await request.post(`${HOSTING}/api/save`, { headers: { authorization: 'Bearer rl_wrong' }, data: { url: 'https://example.com/' } });
  expect(bad.status()).toBe(401);

  await nav(page, 'Library');
  const item = row(page, EXAMPLE_TITLE);
  await expect(item).toBeVisible({ timeout: PROCESSING });
  await expect(item.getByRole('link', { name: '#via-api' })).toBeVisible();
  await expect(item).toHaveAttribute('data-item-id', body.id);
});

test('4. Categories and tags: create, assign, filter', async () => {
  await nav(page, 'Settings');
  const categories = page.locator('#categories');
  await categories.getByLabel('New category name').fill('Essays');
  await categories.getByRole('button', { name: 'Add' }).click();
  await expect(categories.getByRole('link', { name: 'Essays' })).toBeVisible();

  await nav(page, 'Library');
  const article = row(page, ARTICLE_TITLE);
  await article.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit' });
  await dialog.getByLabel('Category').selectOption({ label: 'Essays' });
  const tags = dialog.getByRole('textbox', { name: 'Tags', exact: true });
  await tags.fill('career');
  await tags.press('Enter');
  await tags.fill('Classics');
  await tags.press('Enter');
  await expect(dialog.locator('.tag-chip')).toHaveText(['career', 'classics']);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await expect(article.getByRole('link', { name: 'Essays' })).toBeVisible();
  await expect(article.getByRole('link', { name: '#career' })).toBeVisible();
  await expect(article.getByRole('link', { name: '#classics' })).toBeVisible();
  await waitForItem(articleId, 'category and tags to be saved', (d) => (d.tags as string[]).includes('career') && d.categoryId !== null);

  // Filter by tag.
  await page.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: /^#career/ }).click();
  await expect(page).toHaveURL(/[?&]tag=career/);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await expect(page.getByText(/^1 item$/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();

  // Filter by category.
  await page.getByLabel('Filter by category').selectOption({ label: 'Essays' });
  await expect(page).toHaveURL(/[?&]cat=/);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await page.getByLabel('Filter by category').selectOption({ label: 'All categories' });
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('5. Archive, favorite and unarchive from the list and the reader', async () => {
  await expect(viewTab(page, 'Unread')).toHaveAttribute('aria-current', 'page');

  // List: favorite the article.
  const article = row(page, ARTICLE_TITLE);
  await article.getByRole('button', { name: 'Favorite' }).click();
  await expect(article.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
  await viewTab(page, 'Favorites').click();
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);

  // List: archive and unarchive the example page.
  await viewTab(page, 'Unread').click();
  await row(page, EXAMPLE_TITLE).getByRole('button', { name: 'Archive' }).click();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await viewTab(page, 'Archive').click();
  await expect(viewTab(page, 'Archive')).toHaveText(/Archive\s*1/);
  await row(page, EXAMPLE_TITLE).getByRole('button', { name: 'Move back to Library' }).click();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await viewTab(page, 'Unread').click();
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();

  // Reader: unfavorite and archive the article (archiving returns to the list).
  await openItem(page, ARTICLE_TITLE);
  const toolbar = page.locator('.reader-toolbar');
  await toolbar.getByRole('button', { name: 'Remove from favorites' }).click();
  await expect(toolbar.getByRole('button', { name: 'Add to favorites' })).toHaveAttribute('aria-pressed', 'false');
  await toolbar.getByRole('button', { name: 'Archive' }).click();
  await expect(page).not.toHaveURL(/\/item\//);
  await expect(row(page, ARTICLE_TITLE)).toHaveCount(0);
  await viewTab(page, 'Favorites').click();
  await expect(page.getByText('No favorites yet')).toBeVisible();

  // Reader: unarchive from the archive.
  await viewTab(page, 'Archive').click();
  await openItem(page, ARTICLE_TITLE);
  await toolbar.getByRole('button', { name: 'Unarchive' }).click();
  await expect(toolbar.getByRole('button', { name: 'Archive' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Back' }).click();
  await expect(page).not.toHaveURL(/\/item\//);
  await viewTab(page, 'Unread').click();
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();
  const stored = await waitForItem(articleId, 'unarchived state to be saved', (d) => d.status === 'unread' && d.favorite === false);
  expect(stored.archivedAt).toBeNull();
});

test('6. One-time code from Settings signs in a second device', async ({ browser }) => {
  await nav(page, 'Settings');
  const link = page.locator('#link');
  await link.getByRole('button', { name: 'Generate code' }).click();
  const code = ((await link.locator('.set-code').textContent()) ?? '').trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(link.locator('img.set-qr')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const other = await newContext(browser);
  try {
    const b = await other.newPage();
    await b.goto('/');
    await expect(b).toHaveURL(/\/login$/);
    await b.locator('#login-code').fill(code);
    await b.getByRole('button', { name: 'Sign in with code' }).click();
    await expect(b).not.toHaveURL(/\/login/, { timeout: 30_000 });
    await expect(row(b, ARTICLE_TITLE)).toBeVisible();
    await expect(row(b, EXAMPLE_TITLE)).toBeVisible();
    expect((await currentUser(b)).uid).toBe(uid);
  } finally {
    await other.close();
  }
});

test('8. Follow an RSS feed, see its entries, save one to the library', async () => {
  await nav(page, 'Feed');
  await page.getByRole('link', { name: /Manage feeds|Feeds|Add a feed/ }).first().click();
  await expect(page).toHaveURL(/\/feeds$/);
  await page.getByPlaceholder(/Site or feed address/).fill('https://hnrss.org/frontpage');
  await page.getByRole('main').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Added .* entr(y|ies)/)).toBeVisible({ timeout: PROCESSING });
  await expectNoHorizontalOverflow(page);

  await nav(page, 'Feed');
  const entries = page.locator('article.item-row');
  await expect(entries.first()).toBeVisible();
  expect(await entries.count()).toBeGreaterThan(3);
  await expectNoHorizontalOverflow(page);

  // Prefer an entry whose content is ready (teaser entries are fetched in full, which some sites refuse).
  await expect(entries.locator('.item-state').filter({ hasText: /Fetching…|Processing…/ })).toHaveCount(0, { timeout: PROCESSING });
  const ready = entries.filter({ hasNot: page.locator('.item-state') });
  const first = (await ready.count()) ? ready.first() : entries.first();
  const title = ((await first.locator('.item-title').textContent()) ?? '').trim();
  expect(title.length).toBeGreaterThan(0);
  await first.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, title)).toHaveCount(0);

  await nav(page, 'Library');
  await expect(row(page, title)).toBeVisible();
});

test('9. Upload a PDF and an EPUB: processed, PDF original view, EPUB contents', async () => {
  // PDF
  let dialog = await openAddDialog(page);
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'sample-report.pdf', mimeType: 'application/pdf', buffer: makePdf() });
  await expect(dialog.getByText('sample-report.pdf')).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const pdf = row(page, PDF_TITLE);
  await expect(pdf).toBeVisible({ timeout: PROCESSING });
  await expect(pdf.locator('.item-state')).toHaveCount(0);

  await openItem(page, PDF_TITLE);
  await expect(page.locator('.reader-content')).toContainText(PDF_BODY_WORD);
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Original' }).click();
  const canvas = page.locator('.pdf-view canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width), { message: 'PDF page rendered' }).toBeGreaterThan(100);
  await expect(page.getByLabel('Page number')).toHaveValue('1');
  await page.getByRole('button', { name: 'Next page' }).first().click();
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await expectNoHorizontalOverflow(page);
  // Back to the text view so other PDFs open as text again.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('.reader-content')).toContainText(PDF_BODY_WORD);
  await page.locator('.reader-toolbar').getByRole('button', { name: 'Back' }).click();

  // EPUB
  dialog = await openAddDialog(page);
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'lighthouse.epub', mimeType: 'application/epub+zip', buffer: await makeEpub() });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const epub = row(page, EPUB_TITLE);
  await expect(epub).toBeVisible({ timeout: PROCESSING });
  await expect(epub.locator('.item-state')).toHaveCount(0);
  await expect(epub.locator('.item-meta')).toContainText(/Ada Example/);

  await openItem(page, EPUB_TITLE);
  await expect(page.locator('.reader-content')).toContainText('The wind rose at dusk');
  await page.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Contents' }).click();
  const toc = page.getByRole('dialog', { name: 'Contents' });
  await expect(toc.locator('.reader-toc-link')).toHaveText(EPUB_CHAPTERS);
  await toc.getByRole('button', { name: EPUB_CHAPTERS[1] }).click();
  await expect(toc).toBeHidden();
  await expect(page.getByText('By morning the sea was calm')).toBeInViewport();
  await page.locator('.reader-toolbar').getByRole('button', { name: 'Back' }).click();
});

test('10. Full-text search finds words that only appear in the body', async () => {
  await nav(page, 'Search');
  const input = page.locator('#search-input');
  await input.fill(ARTICLE_BODY_WORD);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(page.locator('article.item-row')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`q=${ARTICLE_BODY_WORD}`));

  await input.fill(PDF_BODY_WORD);
  await expect(row(page, PDF_TITLE)).toBeVisible();
  await expect(page.locator('article.item-row')).toHaveCount(1);

  await input.fill('xylophonequartz');
  await expect(page.getByText('Nothing found for “xylophonequartz”')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('11. Themes: E-ink, dark and light from Settings', async () => {
  await nav(page, 'Settings');
  const html = page.locator('html');
  const theme = page.locator('#appearance').getByRole('group', { name: 'Theme' });
  await theme.getByRole('button', { name: 'E-ink' }).click();
  await expect(html).toHaveAttribute('data-theme', 'eink');
  await expect(html).toHaveAttribute('data-scheme', 'light');
  // E-ink: pure black on white.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(0, 0, 0)');
  await expectNoHorizontalOverflow(page);

  await theme.getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-scheme', 'dark');

  await theme.getByRole('button', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(html).toHaveAttribute('data-scheme', 'light');

  // The choice is a per-device preference that survives a reload.
  await theme.getByRole('button', { name: 'Dark' }).click();
  await page.reload();
  await expect(html).toHaveAttribute('data-scheme', 'dark');
  await page.locator('#appearance').getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click();
  await expect(html).toHaveAttribute('data-theme', 'system');
  await expect(html).toHaveAttribute('data-scheme', 'light');
});

test('12. 360x640 smoke: library and reader without horizontal overflow', async ({ browser }) => {
  for (const theme of ['eink', 'light'] as const) {
    const ctx = await newContext(browser, { viewport: { width: 360, height: 640 }, screen: { width: 360, height: 640 }, theme });
    try {
      const p = await ctx.newPage();
      await googleSignIn(p, account);
      await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(row(p, ARTICLE_TITLE)).toBeVisible();
      await expectNoHorizontalOverflow(p);

      await openItem(p, ARTICLE_TITLE);
      await expect(p.locator('.reader-content')).toContainText(ARTICLE_START);
      await expectNoHorizontalOverflow(p);
      // Reading mode is a per-device preference: pages by default with the e-ink theme, scroll otherwise.
      await expect(p.locator('.reader')).toHaveClass(theme === 'eink' ? /reader-pages/ : /reader-scroll/);
      if (theme === 'eink') {
        await expect(p.locator('.page-indicator')).toHaveText(/^\d+ \/ \d+$/);
        // Tap the right third of the page (on text, not on a link) to turn it.
        const before = await p.locator('.page-indicator').textContent();
        const y = await p.evaluate(() => {
          for (let y = 160; y < window.innerHeight - 80; y += 12) {
            const el = document.elementFromPoint(330, y);
            if (el?.closest('.reader-content') && !el.closest('a, mark, button')) return y;
          }
          return 320;
        });
        await p.mouse.click(330, y);
        await expect(p.locator('.page-indicator')).not.toHaveText(before!);
      }
      await expectNoHorizontalOverflow(p);
      for (const name of ['Feed', 'Search', 'Highlights', 'Settings'] as const) {
        await p.goto(name === 'Feed' ? '/feed' : `/${name.toLowerCase()}`);
        await expect(p.getByRole('navigation', { name: 'Main' })).toBeVisible();
        await expectNoHorizontalOverflow(p);
      }
    } finally {
      await ctx.close();
    }
  }
});

/**
 * Screenshots for the README. Written to docs/screenshots/ with UPDATE_SCREENSHOTS=1 (`npm run screenshots`),
 * otherwise only attached to the test report.
 */
test('13. Screenshots: login, library (light, dark), reader (e-ink pages), settings', async ({ browser }, testInfo) => {
  const dir = process.env.UPDATE_SCREENSHOTS === '1' ? fileURLToPath(new URL('../../docs/screenshots/', import.meta.url)) : testInfo.outputPath('screenshots/');
  mkdirSync(dir, { recursive: true });
  const phone = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2 };
  const shot = async (p: Page, name: string) => {
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300); // let images in view finish decoding
    const path = `${dir}${name}.png`;
    await p.screenshot({ path, animations: 'disabled', caret: 'hide' });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  };

  // Login and library, light.
  let ctx = await newContext(browser, { ...phone, theme: 'light' });
  try {
    const p = await ctx.newPage();
    await p.goto('/login');
    await expect(p.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await shot(p, 'login');
    await googleSignIn(p, account);
    await expect(row(p, ARTICLE_TITLE)).toBeVisible();
    await shot(p, 'library-light');
    await nav(p, 'Settings');
    await expect(p.locator('#appearance')).toBeVisible();
    await shot(p, 'settings');
  } finally {
    await ctx.close();
  }

  // Library, dark.
  ctx = await newContext(browser, { ...phone, colorScheme: 'dark', theme: 'dark' });
  try {
    const p = await ctx.newPage();
    await googleSignIn(p, account);
    await expect(row(p, ARTICLE_TITLE)).toBeVisible();
    await shot(p, 'library-dark');
  } finally {
    await ctx.close();
  }

  // Reader on a Boox Go 6 (1072x1448 px at 2x), e-ink theme, pages mode.
  ctx = await newContext(browser, { viewport: { width: 536, height: 724 }, screen: { width: 536, height: 724 }, deviceScaleFactor: 2, theme: 'eink' });
  try {
    const p = await ctx.newPage();
    await googleSignIn(p, account);
    await openItem(p, ARTICLE_TITLE);
    await expect(p.locator('.reader')).toHaveClass(/reader-pages/);
    await expect(p.locator('.page-indicator')).toHaveText(/^\d+ \/ \d+$/);
    await expect(p.locator('.reader-content')).toContainText(ARTICLE_START);
    await shot(p, 'reader-eink');
  } finally {
    await ctx.close();
  }
});
