/**
 * End-to-end walk through Readlater on the Firebase emulators, on a 360 px Android-sized screen.
 *
 * One Google account (created through the Auth emulator's fake IdP popup) is used by all tests, in order:
 * later tests build on the library earlier ones created. Extra browser contexts sign in as the same account
 * (picking it in the IdP popup) or, in the device-link test, with a one-time code.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import JSZip from 'jszip';
import {
  currentUser,
  expectNoHorizontalOverflow,
  fakeSpeech,
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
/** Saved through /add; an auto rule matches its link. */
const RULE_URL = 'https://www.paulgraham.com/hwh.html';
const RULE_TITLE = 'How to Work Hard';
/** Saved with a plain GET /api/save, as the bookmarklet does. */
const GET_URL = 'https://www.paulgraham.com/kids.html';
const GET_TITLE = 'Having Kids';
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

  // Filter by tag (the filters live in the "Filters" dialog; the list updates while it is open).
  await page.getByRole('button', { name: 'Filters' }).click();
  const filters = page.getByRole('dialog', { name: 'Filter and sort' });
  await filters.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: /^#career/ }).click();
  await filters.getByRole('button', { name: 'Done' }).click();
  await expect(filters).toBeHidden();
  await expect(page).toHaveURL(/[?&]tag=career/);
  await expect(page.getByRole('group', { name: 'Active filters' }).getByRole('button', { name: 'Remove filter: tag career' })).toBeVisible();
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await expect(page.getByText(/^1 item$/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();

  // Filter by category; removing its chip clears it again.
  await page.getByRole('button', { name: 'Filters' }).click();
  await filters.getByLabel('Filter by category').selectOption({ label: 'Essays' });
  await filters.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/[?&]cat=/);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove filter: category Essays' }).click();
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();
  await page.getByRole('button', { name: 'Filters' }).click();
  await filters.getByLabel('Filter by category').selectOption({ label: 'Essays' });
  await filters.getByLabel('Filter by category').selectOption({ label: 'All categories' });
  await filters.getByRole('button', { name: 'Done' }).click();
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
  test.slow(); // live feed entries are fetched from many sites
  await nav(page, 'Feed');
  await page.getByRole('link', { name: /Manage feeds|Feeds|Add a feed/ }).first().click();
  await expect(page).toHaveURL(/\/feeds$/);
  await page.getByPlaceholder(/Site or feed address/).fill('https://hnrss.org/frontpage');
  const add = page.getByRole('main').getByRole('button', { name: 'Add', exact: true });
  await add.click();
  const added = page.getByText(/Added .* entr(y|ies)/);
  const failed = page.getByRole('main').locator('p.error-text').first();
  await expect(added.or(failed)).toBeVisible({ timeout: PROCESSING });
  if (await failed.isVisible()) {
    // The live feed did not answer this time (it is a busy public service): try again, as a user would.
    await add.click();
    await expect(added).toBeVisible({ timeout: PROCESSING });
  }
  await expectNoHorizontalOverflow(page);

  await nav(page, 'Feed');
  const entries = page.locator('article.item-row');
  await expect(entries.first()).toBeVisible();
  expect(await entries.count()).toBeGreaterThan(3);
  await expectNoHorizontalOverflow(page);

  // Prefer an entry whose content is ready (teaser entries are fetched in full from live sites, which can be slow
  // or refuse; failed fetches also try the Internet Archive), so wait for the first ready one, not for all.
  const ready = entries.filter({ hasNot: page.locator('.item-state') });
  await expect(ready.first()).toBeVisible({ timeout: PROCESSING }).catch(() => undefined);
  const first = (await ready.count()) ? ready.first() : entries.first();
  const title = ((await first.locator('.item-title').textContent()) ?? '').trim();
  expect(title.length).toBeGreaterThan(0);
  await first.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, title)).toHaveCount(0);
  // Let the other entries finish (best effort), so the next tests' items don't queue behind them.
  await expect(entries.locator('.item-state').filter({ hasText: /Fetching…|Processing…/ }))
    .toHaveCount(0, { timeout: PROCESSING })
    .catch(() => undefined);

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

/** Starts read-aloud from the reader toolbar (or the More menu, where narrow e-ink screens keep it). */
async function startListening(p: Page): Promise<Locator> {
  const button = p.locator('.reader-toolbar').getByRole('button', { name: 'Listen', exact: true });
  if (await button.isVisible()) {
    await button.click();
  } else {
    await p.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }).click();
    await p.getByRole('menuitem', { name: 'Listen' }).click();
  }
  const bar = p.getByRole('region', { name: 'Read aloud' });
  await expect(bar).toBeVisible();
  return bar;
}

/** The value shown in a Reading stats tile. */
function statsTile(p: Page, label: string): Locator {
  return p
    .locator('.stats-tile')
    .filter({ has: p.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('.stats-value');
}

test('13. Highlight colour: change it in the highlight dialog; the reader and /highlights show it', async () => {
  await page.goto(`/item/${articleId}`);
  const mark = page.locator('.reader-content mark.hl[data-hid]').first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('data-color', 'yellow');
  await mark.click();
  const dialog = page.getByRole('dialog', { name: 'Highlight' });
  const colours = dialog.getByRole('group', { name: 'Highlight colour' });
  await expect(colours.getByRole('button', { name: 'Yellow' })).toHaveAttribute('aria-pressed', 'true');
  await colours.getByRole('button', { name: 'Green' }).click();
  await expect(colours.getByRole('button', { name: 'Green' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('blockquote')).toHaveAttribute('data-color', 'green');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(mark).toHaveAttribute('data-color', 'green');
  await waitFor('highlight colour to be saved', async () => (await listDocs(`users/${uid}/highlights`)).find((h) => h.data.color === 'green'));

  await page.locator('.reader-toolbar').getByRole('button', { name: 'Back' }).click();
  await nav(page, 'Highlights');
  await expect(page.locator('.hls-group', { hasText: ARTICLE_TITLE }).locator('.hls-quote')).toHaveAttribute('data-color', 'green');
});

test('14. Read aloud: the player opens, follows the text, pauses, skips and closes', async () => {
  await fakeSpeech(context, 15_000); // long "utterances": the player stays on its paragraph while the test looks
  await page.goto(`/item/${articleId}`);
  await expect(page.locator('.reader-content')).toContainText(ARTICLE_START);
  const bar = await startListening(page);
  await expect(page.locator('.reader-toolbar').getByRole('button', { name: 'Listen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(bar.getByLabel('Speed')).toBeVisible();
  const pos = bar.locator('.tts-pos');
  await expect(pos).toHaveAttribute('aria-label', /^Paragraph \d+ of \d+$/);
  const current = page.locator('.reader-content .tts-current');
  await expect(current).toHaveCount(1);
  // What is spoken is the text of the marked paragraph.
  const spoken = await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
  expect(spoken.length).toBeGreaterThan(0);
  expect(((await current.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(spoken[0].replace(/\s+/g, ' ').trim().slice(0, 40));

  const at = Number(/Paragraph (\d+)/.exec((await pos.getAttribute('aria-label')) ?? '')![1]);
  await bar.getByRole('button', { name: 'Next paragraph' }).click();
  await expect(pos).toHaveAttribute('aria-label', new RegExp(`^Paragraph ${at + 1} of \\d+$`));
  await bar.getByRole('button', { name: 'Pause' }).click();
  await expect(bar.getByRole('button', { name: 'Play' })).toBeVisible();
  await bar.getByRole('button', { name: 'Play' }).click();
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await bar.getByRole('button', { name: 'Stop and close' }).click();
  await expect(bar).toBeHidden();
  await expect(current).toHaveCount(0);
  await expect(page.locator('.reader-toolbar').getByRole('button', { name: 'Listen', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('15. Sepia theme from the reader’s text settings', async () => {
  await expect(page).toHaveURL(new RegExp(`/item/${articleId}$`));
  await page.getByRole('button', { name: 'Text settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Reading settings' });
  await panel.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Sepia' }).click();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'sepia');
  await expect(html).toHaveAttribute('data-scheme', 'light');
  await panel.getByRole('button', { name: 'Close' }).click();
  // Warm paper, dark brown ink.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 236, 216)');
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(59, 47, 34)');
  await expectNoHorizontalOverflow(page);

  // Settings shows the same choice; back to the system theme for the next tests.
  await page.locator('.reader-toolbar').getByRole('button', { name: 'Back' }).click();
  await nav(page, 'Settings');
  const theme = page.locator('#appearance').getByRole('group', { name: 'Theme' });
  await expect(theme.getByRole('button', { name: 'Sepia' })).toHaveAttribute('aria-pressed', 'true');
  await theme.getByRole('button', { name: 'System' }).click();
  await expect(html).toHaveAttribute('data-theme', 'system');
});

test('16. Bulk select: archive two items, then move one back from the Archive', async () => {
  await nav(page, 'Library');
  await expect(viewTab(page, 'Unread')).toHaveAttribute('aria-current', 'page');
  const exampleId = (await row(page, EXAMPLE_TITLE).getAttribute('data-item-id')) ?? '';
  const pdfId = (await row(page, PDF_TITLE).getAttribute('data-item-id')) ?? '';
  expect(exampleId && pdfId).toBeTruthy();

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const bar = page.getByRole('region', { name: 'Selected items' });
  await expect(bar).toContainText('Tap items to select them');
  await page.getByRole('checkbox', { name: `Select “${EXAMPLE_TITLE}”` }).check();
  await page.getByRole('checkbox', { name: `Select “${PDF_TITLE}”` }).check();
  await expect(bar.locator('.bulk-count')).toHaveText('2 selected');
  await expectNoHorizontalOverflow(page);
  await bar.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('Archived 2 items')).toBeVisible();
  await expect(row(page, EXAMPLE_TITLE)).toHaveCount(0);
  await expect(row(page, PDF_TITLE)).toHaveCount(0);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await waitForItem(exampleId, 'bulk archive to be saved', (d) => d.status === 'archived');
  await waitForItem(pdfId, 'bulk archive to be saved', (d) => d.status === 'archived');
  await page.getByRole('button', { name: 'Done', pressed: true }).click();
  await expect(bar).toBeHidden();

  await viewTab(page, 'Archive').click();
  await expect(viewTab(page, 'Archive')).toHaveText(/Archive\s*2/);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await row(page, PDF_TITLE).locator('.item-title').click(); // in select mode, tapping a row toggles it
  await expect(page.getByRole('checkbox', { name: `Select “${PDF_TITLE}”` })).toBeChecked();
  await bar.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Unarchive' }).click();
  await expect(row(page, PDF_TITLE)).toHaveCount(0);
  await expect(row(page, EXAMPLE_TITLE)).toBeVisible();
  await waitForItem(pdfId, 'bulk unarchive to be saved', (d) => d.status === 'unread');
  await page.getByRole('button', { name: 'Done', pressed: true }).click();
  await viewTab(page, 'Unread').click();
  await expect(row(page, PDF_TITLE)).toBeVisible();
});

test('17. Saved view: save a filter as a view and open it from its chip', async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  const filters = page.getByRole('dialog', { name: 'Filter and sort' });
  await filters.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: /^#career/ }).click();
  await filters.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/[?&]tag=career/);

  await page.getByRole('button', { name: 'Save view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  const name = dialog.getByLabel('Name');
  await expect(name).toHaveValue(/#career/);
  await name.fill('Career reads');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const views = page.getByRole('navigation', { name: 'Saved views' });
  const chip = views.getByRole('link', { name: 'Career reads' });
  await expect(chip).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Save view' })).toHaveCount(0);
  const stored = await waitFor('the saved view', async () => (await listDocs(`users/${uid}/views`)).find((v) => v.data.name === 'Career reads'));
  expect(String(stored.data.params)).toContain('tag=career');

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chip).not.toHaveAttribute('aria-current', 'page');
  await expect(row(page, PDF_TITLE)).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/[?&]tag=career/);
  await expect(chip).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('article.item-row')).toHaveCount(1);
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(row(page, PDF_TITLE)).toBeVisible();
});

test('18. Auto rule from Settings is applied to a link saved through /add', async () => {
  await nav(page, 'Settings');
  const rules = page.locator('#rules');
  await rules.getByRole('button', { name: 'New rule' }).click();
  await rules.getByLabel('Field').selectOption({ label: 'Link' });
  await rules.getByLabel('Condition').selectOption({ label: 'contains' });
  await rules.getByLabel('Value').fill('hwh.html');
  const tags = rules.getByRole('textbox', { name: 'Add tags' });
  await tags.fill('auto-rule');
  await tags.press('Enter');
  await rules.getByLabel('Add to favorites').check();
  await rules.getByLabel(/^Name/).fill('Work essays');
  await rules.getByRole('button', { name: 'Add rule' }).click();
  await expect(rules.getByText('Work essays')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await waitFor('the rule to be saved', async () => (await listDocs(`users/${uid}/rules`)).find((r) => r.data.name === 'Work essays'));

  // "Open in Readlater" (bookmarklet, other apps) links land on /add, which asks before saving.
  await page.goto(`/add?url=${encodeURIComponent(RULE_URL)}&title=${encodeURIComponent(RULE_TITLE)}`);
  await expect(page.getByRole('heading', { name: 'Save to Readlater?' })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved ✓' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read now' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(`${HOSTING}/`);

  const item = row(page, RULE_TITLE);
  await expect(item.getByRole('link', { name: '#auto-rule' })).toBeVisible({ timeout: PROCESSING });
  await expect(item.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
  const id = (await item.getAttribute('data-item-id')) ?? '';
  const stored = await waitForItem(id, 'the rule to be applied', (d) => d.rulesApplied === true);
  expect(stored).toMatchObject({ favorite: true, tags: ['auto-rule'], url: RULE_URL });
});

test('19. Bookmarklet key: a plain GET saves a link; the key cannot read the library', async ({ request }) => {
  await nav(page, 'Settings');
  const section = page.locator('#bookmarklets');
  await section.getByRole('button', { name: 'Generate' }).click();
  const link = section.locator('a.set-bookmarklet', { hasText: 'Save to Readlater' });
  await expect(link).toHaveAttribute('href', /^javascript:/);
  const key = /key=(rl_[A-Za-z0-9]{40})/.exec(decodeURIComponent((await link.getAttribute('href'))!))![1];

  const res = await request.get(`${HOSTING}/api/save?key=${key}&source=bookmarklet&url=${encodeURIComponent(GET_URL)}&title=${encodeURIComponent(GET_TITLE)}`, {
    headers: { accept: 'text/html' },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^text\/html/);
  expect(await res.text()).toContain('Saved ✓');
  expect((await request.get(`${HOSTING}/api/items?key=${key}`)).status()).toBe(403);

  await nav(page, 'Library');
  const item = row(page, GET_TITLE);
  await expect(item).toBeVisible({ timeout: PROCESSING });
  const id = (await item.getAttribute('data-item-id')) ?? '';
  const stored = await waitForItem(id, 'the bookmarklet save to be processed', (d) => d.fetchStatus === 'done');
  expect(stored).toMatchObject({ source: 'bookmarklet', url: GET_URL, location: 'library' });
});

test('20. Reading stats and daily review show the library and the highlight', async () => {
  await expect(row(page, ARTICLE_TITLE)).toBeVisible();
  await page.getByRole('link', { name: 'Reading stats' }).click();
  await expect(page).toHaveURL(/\/stats$/);
  await expect(page.getByRole('heading', { name: 'Reading stats' })).toBeInViewport(); // a new page opens at its top
  expect(Number(await statsTile(page, 'Saved').textContent())).toBeGreaterThanOrEqual(6);
  await expect(statsTile(page, 'Highlights')).toHaveText('1');
  await expect(statsTile(page, 'Finished')).toHaveText('1');
  await expect(statsTile(page, 'Current streak')).toHaveText('1 day');
  await expect(page.locator('.stats-table tbody th').first()).toHaveText('This week');
  const tags = page.locator('section', { has: page.getByRole('heading', { name: 'Top tags' }) });
  await expect(tags.getByRole('link', { name: '#career' })).toBeVisible();
  await expect(tags.getByRole('link', { name: '#auto-rule' })).toBeVisible();
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Top sites' }) })).toContainText(/paulgraham\.com/i);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('link', { name: 'Daily review' }).click();
  await expect(page).toHaveURL(/\/review$/);
  const card = page.getByRole('article', { name: 'Highlight 1 of 1' });
  await expect(card.locator('.review-quote')).toHaveText(highlightText);
  await expect(card.locator('.review-quote')).toHaveAttribute('data-color', 'green');
  await expect(card.locator('.review-note')).toHaveText(highlightNote);
  await expectNoHorizontalOverflow(page);
  await card.getByRole('link', { name: 'Open in document' }).click();
  await expect(page).toHaveURL(new RegExp(`/item/${articleId}\\?hl=`));
  await expect(page.locator('.reader-content mark.hl[data-hid]').first()).toBeInViewport();
});

test('21. Download as EPUB from the reader', async () => {
  await expect(page.locator('.reader-content')).toContainText(ARTICLE_START);
  await page.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }).click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.getByRole('menuitem', { name: 'Download as EPUB' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.epub$/);
  const zip = await JSZip.loadAsync(readFileSync(await download.path()));
  expect(Object.keys(zip.files)[0]).toBe('mimetype');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
  const text = (await Promise.all(Object.values(zip.files).filter((f) => /\.x?html$/.test(f.name)).map((f) => f.async('string')))).join('\n');
  expect(text).toContain(ARTICLE_TITLE);
  expect(text).toContain(ARTICLE_BODY_WORD);
  await page.locator('.reader-toolbar').getByRole('button', { name: 'Back' }).click();
});

/**
 * Screenshots for the README. Written to docs/screenshots/ with UPDATE_SCREENSHOTS=1 (`npm run screenshots`),
 * otherwise only attached to the test report.
 */
test('22. Screenshots: login, library (light, dark), settings, stats, reader (e-ink pages, read aloud)', async ({ browser }, testInfo) => {
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
    await nav(p, 'Library');
    await p.getByRole('link', { name: 'Reading stats' }).click();
    await expect(p.locator('.stats-tile').first()).toBeVisible();
    await shot(p, 'stats');
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

  // Reader on a Boox Go 6 (1072x1448 px at 2x), e-ink theme, pages mode; then with the read-aloud bar.
  ctx = await newContext(browser, { viewport: { width: 536, height: 724 }, screen: { width: 536, height: 724 }, deviceScaleFactor: 2, theme: 'eink' });
  try {
    await fakeSpeech(ctx, 600_000);
    const p = await ctx.newPage();
    await googleSignIn(p, account);
    await openItem(p, ARTICLE_TITLE);
    await expect(p.locator('.reader')).toHaveClass(/reader-pages/);
    await expect(p.locator('.page-indicator')).toHaveText(/^\d+ \/ \d+$/);
    await expect(p.locator('.reader-content')).toContainText(ARTICLE_START);
    await shot(p, 'reader-eink');
    const bar = await startListening(p);
    await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(p.locator('.reader-content .tts-current')).toBeInViewport();
    await shot(p, 'reader-eink-listen');
  } finally {
    await ctx.close();
  }
});
