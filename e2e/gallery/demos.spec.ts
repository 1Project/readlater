/**
 * Demo clips for the project overview: scripted walkthroughs recorded as video (with a visible cursor or tap
 * marker), trimmed and encoded to looping MP4s plus a poster frame, and a few extra stills (bookmarklet page,
 * public share page, emailed newsletter) and the Telegram bot's real replies.
 *
 * Run: `npm run demos` (writes docs/demos/). Needs outbound internet for the saved pages and ffmpeg on PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { currentUser, fakeSpeech, googleSignIn, newAccount, newContext, row } from '../helpers/app';
import { makeEpub } from '../helpers/fixtures';
import { callFunction, FUNCTIONS, HOSTING, listDocs, setDoc, waitFor } from '../helpers/emulators';
import { ANTHROPIC_MODEL, ANTHROPIC_PORT, EMAIL_SECRET, FakeApi, fakeTelegram, TELEGRAM_BOT, TELEGRAM_SECRET } from '../helpers/integrations';

// Clips run in order (one worker) but independently: a failed clip does not stop the others.
test.describe.configure({ mode: 'default' });

const OUT = fileURLToPath(new URL('../../docs/demos/', import.meta.url));
const RAW = fileURLToPath(new URL('../test-results/demo-raw/', import.meta.url));

type Kind = 'desktop' | 'phone' | 'boox';
const DEVICES: Record<Kind, BrowserContextOptions> = {
  desktop: { viewport: { width: 1280, height: 800 }, screen: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  boox: { viewport: { width: 536, height: 724 }, screen: { width: 536, height: 724 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
/** Encoded width of each clip. */
const OUT_WIDTH: Record<Kind, number> = { desktop: 1280, phone: 600, boox: 720 };

const GREAT_WORK = 'How to Do Great Work';
const SUMMARY = [
  'TL;DR: Great work comes from picking something you are naturally good at and deeply curious about, then working on it hard and consistently.',
  '- Choose work by aptitude and interest; ambition takes care of itself.',
  '- You often only find out what to work on by working.',
  '- Curiosity, delight and the desire to do something impressive drive great work.',
  '- Consistency compounds: small daily progress beats sporadic heroics.',
].join('\n');
const ANSWER =
  'Curiosity is the engine. Graham calls it “the best guide” and says it is both the motivation and the means: “Curiosity and delight are the motives that drive the best work.” Follow what you find interesting, even when it seems a detour.';
const QUESTION = 'What role does curiosity play?';

const account = newAccount();
let uid = '';
let idToken = '';
let greatWorkId = '';
let anthropic: FakeApi;
let telegram: FakeApi;

// ---------------------------------------------------------------------------
// Recording helpers

/** A visible pointer for the recordings: an arrow on desktop, a fading tap circle on touch screens. */
function cursorScript(touch: boolean): string {
  return `(() => {
    const touch = ${touch};
    let el = null;
    const mk = () => {
      el = document.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      const s = el.style;
      s.position = 'fixed'; s.left = '0'; s.top = '0'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
      if (touch) {
        s.width = '34px'; s.height = '34px'; s.marginLeft = '-17px'; s.marginTop = '-17px'; s.borderRadius = '50%';
        s.background = 'rgba(47,91,211,0.28)'; s.border = '2px solid rgba(47,91,211,0.85)'; s.opacity = '0';
      } else {
        s.width = '24px'; s.height = '24px';
        s.background = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\'><path d=\\'M3 2l7.5 19 2.6-7.4L20.5 11z\\' fill=\\'#111\\' stroke=\\'#fff\\' stroke-width=\\'1.6\\' stroke-linejoin=\\'round\\'/></svg>') + '") no-repeat';
      }
      document.documentElement.appendChild(el);
    };
    const move = (x, y) => { if (!el || !el.isConnected) mk(); el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
    document.addEventListener('mousedown', (e) => {
      move(e.clientX, e.clientY);
      const r = document.createElement('div');
      const s = r.style;
      s.position = 'fixed'; s.left = (e.clientX - 18) + 'px'; s.top = (e.clientY - 18) + 'px'; s.width = '36px'; s.height = '36px';
      s.borderRadius = '50%'; s.border = '3px solid rgba(47,91,211,0.9)'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
      document.documentElement.appendChild(r);
      r.animate([{ transform: 'scale(0.4)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 500, easing: 'ease-out' }).onfinish = () => r.remove();
      if (touch && el) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700 });
    }, true);
  })();`;
}

/**
 * Records a clip as a sequence of device-resolution screenshots taken back to back while footage is "kept"
 * (Playwright's own video is capped at CSS pixels, which blurs the phone and Boox clips), then stitches them
 * into an MP4 with each frame shown for as long as it was on screen.
 */
class Clip {
  private frames: { file: string; t: number }[] = [];
  private loop: Promise<void> | null = null;
  private recording = false;
  private posterFrame = -1;
  private dir: string;
  constructor(
    readonly name: string,
    readonly kind: Kind,
    readonly ctx: BrowserContext,
    readonly page: Page,
  ) {
    this.dir = `${RAW}${name}/`;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Start (or resume) recording. */
  rec(): void {
    if (this.recording) return;
    this.recording = true;
    this.loop = (async () => {
      while (this.recording) {
        const file = `${this.dir}${String(this.frames.length).padStart(5, '0')}.jpg`;
        try {
          await this.page.screenshot({ path: file, type: 'jpeg', quality: 88, caret: 'initial', timeout: 5_000 });
          this.frames.push({ file, t: Date.now() });
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      // Mark the end of the last kept frame.
      this.frames.push({ file: '', t: Date.now() });
    })();
  }

  /** Stop recording (e.g. while waiting for the server); the gap is cut from the clip. */
  async cut(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    await this.loop;
  }

  /** Use the current frame as the poster image. */
  poster(): void {
    this.posterFrame = this.frames.filter((f) => f.file).length - 1;
  }

  async finish(): Promise<void> {
    await this.cut();
    await this.ctx.close();
    // Durations: each frame lasts until the next one; segment ends ('' markers) close the previous frame.
    const lines: string[] = [];
    let last = '';
    for (let i = 0; i < this.frames.length - 1; i++) {
      const f = this.frames[i];
      if (!f.file) continue;
      const d = Math.min(1.5, Math.max(0.02, (this.frames[i + 1].t - f.t) / 1000));
      lines.push(`file '${f.file}'`, `duration ${d.toFixed(3)}`);
      last = f.file;
    }
    lines.push(`file '${last}'`); // concat demuxer needs the last file repeated
    const list = `${this.dir}list.txt`;
    writeFileSync(list, lines.join('\n') + '\n');
    const mp4 = `${OUT}${this.name}.mp4`;
    const enc = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `fps=25,scale=${OUT_WIDTH[this.kind]}:-2:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', mp4,
    ]);
    if (enc.status !== 0) throw new Error(`ffmpeg failed for ${this.name}: ${enc.stderr}`);
    const kept = this.frames.filter((f) => f.file);
    const poster = kept[this.posterFrame >= 0 ? this.posterFrame : kept.length - 1];
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', poster.file, '-vf', `scale=${OUT_WIDTH[this.kind]}:-2:flags=lanczos`, '-q:v', '3', `${OUT}${this.name}.jpg`]);
  }
}

async function clip(browser: Browser, name: string, kind: Kind, opts: { theme?: string; signedIn?: boolean; speech?: number } = {}): Promise<Clip> {
  const ctx = await newContext(browser, {
    ...DEVICES[kind],
    colorScheme: opts.theme === 'dark' ? 'dark' : 'light',
    theme: (opts.theme ?? 'light') as 'light',
  });
  await ctx.addInitScript(cursorScript(kind !== 'desktop'));
  if (opts.speech) await fakeSpeech(ctx, opts.speech);
  const page = await ctx.newPage();
  if (opts.signedIn !== false) {
    await googleSignIn(page, account);
    await expect(row(page, GREAT_WORK)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(400);
  }
  return new Clip(name, kind, ctx, page);
}

/** Glide the pointer to an element and click it, like a person would. */
async function tap(p: Page, target: Locator, opts: { pause?: number; steps?: number } = {}): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('target not visible');
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: opts.steps ?? 16 });
  await p.waitForTimeout(220);
  await p.mouse.down();
  await p.waitForTimeout(70);
  await p.mouse.up();
  await p.waitForTimeout(opts.pause ?? 500);
}

async function typeInto(p: Page, target: Locator, text: string, delay = 45): Promise<void> {
  await tap(p, target, { pause: 200 });
  await target.pressSequentially(text, { delay });
}

async function scrollSmooth(p: Page, dy: number, steps = 12): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await p.mouse.wheel(0, dy / steps);
    await p.waitForTimeout(40);
  }
}

async function openItem(p: Page, title: string | RegExp): Promise<void> {
  await tap(p, row(p, title).locator('.item-title a'));
  await expect(p.locator('.reader-content')).toBeVisible({ timeout: 30_000 });
  await p.waitForTimeout(600);
}

async function nav(p: Page, name: 'Library' | 'Feed' | 'Search' | 'Highlights' | 'Settings'): Promise<void> {
  await tap(p, p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }));
}

// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(RAW, { recursive: true });
  anthropic = new FakeApi(ANTHROPIC_PORT, (call) => ({
    body: {
      id: 'msg_demo',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [{ type: 'text', text: JSON.stringify(call.body).includes('curiosity play') ? ANSWER : SUMMARY }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 120 },
    },
  }));
  telegram = fakeTelegram();
  await Promise.all([anthropic.start(), telegram.start()]);
});

test.afterAll(async () => {
  await Promise.all([anthropic?.stop(), telegram?.stop()]);
});

test('seed a realistic library', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const ctx = await newContext(browser, { ...DEVICES.desktop, theme: 'light' });
  const p = await ctx.newPage();
  await googleSignIn(p, account);
  const user = await currentUser(p);
  uid = user.uid;
  idToken = user.idToken;

  const { key } = await callFunction<{ key: string }>('createApiKey', { name: 'Demo', scope: 'all' }, user);
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
  await callFunction('addFeed', { url: 'https://simonwillison.net/atom/everything/', categoryId: null, tags: ['blogs'] }, user).catch(() => null);
  await request.post(`${HOSTING}/api/save`, { headers: { authorization: `Bearer ${key}` }, data: { url: 'https://example.com/' } }).catch(() => null);

  // An uploaded EPUB.
  await p.locator('header.topbar').getByRole('button', { name: /^(\+ Add|Add)$/ }).filter({ visible: true }).click();
  const dialog = p.getByRole('dialog', { name: 'Add to Library' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'lighthouse.epub', mimeType: 'application/epub+zip', buffer: await makeEpub() });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  await waitFor(
    'library processed',
    async () => {
      const lib = (await listDocs(`users/${uid}/items`)).filter((i) => i.data.location === 'library');
      return lib.length >= 8 && lib.every((i) => i.data.fetchStatus === 'done' || i.data.fetchStatus === 'error');
    },
    300_000,
  );
  // example.com was only needed so "Example Domain" exists for nothing else; remove it from view by archiving.
  const items = await listDocs(`users/${uid}/items`);
  const byTitle = (re: RegExp) => items.find((i) => re.test(String(i.data.title)));
  for (const [re, patch] of [
    [/Work Hard/, { favorite: true, progress: 0.35 }],
    [/Having Kids/, { status: 'archived', archivedAt: new Date(), progress: 1 }],
    [/Attention/, { progress: 0.12 }],
    [/Example Domain/, { status: 'archived', archivedAt: new Date() }],
  ] as const) {
    const it = byTitle(re);
    if (it) await setDoc(`users/${uid}/items/${it.id}`, { ...it.data, ...patch } as Record<string, unknown>).catch(() => null);
  }
  const now = new Date();
  await setDoc(`users/${uid}/highlights/d1`, {
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

test('clip: save a link and read it', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'save-link', 'desktop');
  const p = c.page;
  c.rec();
  await p.waitForTimeout(700);
  await tap(p, p.locator('header.topbar').getByRole('button', { name: /^(\+ Add|Add)$/ }).filter({ visible: true }));
  const dialog = p.getByRole('dialog', { name: 'Add to Library' });
  await expect(dialog).toBeVisible();
  await typeInto(p, dialog.locator('input[type="url"], input[type="text"]').first(), 'https://www.paulgraham.com/useful.html', 30);
  await p.waitForTimeout(400);
  await tap(p, dialog.getByRole('button', { name: 'Save' }));
  await p.waitForTimeout(1500);
  await c.cut();
  await expect(row(p, /Write Usefully/)).toBeVisible({ timeout: 90_000 });
  await expect(row(p, /Write Usefully/).locator('.item-state')).toHaveCount(0, { timeout: 90_000 });
  c.rec();
  await p.waitForTimeout(1300);
  c.poster();
  await openItem(p, /Write Usefully/);
  await p.waitForTimeout(800);
  await scrollSmooth(p, 500, 16);
  await p.waitForTimeout(1200);
  await c.finish();
});

test('clip: highlight with a colour and a note', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'highlight', 'desktop');
  const p = c.page;
  await openItem(p, GREAT_WORK);
  // Bring the sentence to the middle of the screen before recording.
  const phrase = 'But pick something and get going.';
  await p.evaluate((t) => {
    const root = document.querySelector('.reader-content')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes(t)) {
        (n.parentElement as HTMLElement).scrollIntoView({ block: 'center' });
        return;
      }
    }
    throw new Error('phrase not found');
  }, phrase);
  await p.waitForTimeout(500);
  const rects = await p.evaluate((t) => {
    const root = document.querySelector('.reader-content')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue?.indexOf(t) ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + t.length);
        const all = Array.from(r.getClientRects());
        const a = all[0];
        const b = all[all.length - 1];
        return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
      }
    }
    return null;
  }, phrase);
  if (!rects) throw new Error('no rects');
  c.rec();
  await p.mouse.move(rects.x1 - 60, rects.y1 + 60, { steps: 1 });
  await p.waitForTimeout(500);
  await p.mouse.move(rects.x1, rects.y1, { steps: 14 });
  await p.waitForTimeout(250);
  await p.mouse.down();
  await p.mouse.move(rects.x2, rects.y2, { steps: 30 });
  await p.mouse.up();
  await p.waitForTimeout(700);
  const bar = p.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toBeVisible();
  await tap(p, bar.getByRole('button', { name: 'Green' }), { pause: 400 });
  await tap(p, bar.getByRole('button', { name: 'Highlight + note' }));
  const dialog = p.getByRole('dialog', { name: 'Highlight' });
  await expect(dialog).toBeVisible();
  await typeInto(p, dialog.getByLabel('Note'), 'Bias to action: start before you feel ready.', 35);
  await p.waitForTimeout(300);
  await tap(p, dialog.getByRole('button', { name: 'Save' }), { pause: 1200 });
  c.poster();
  await tap(p, p.locator('.reader-toolbar').getByRole('button', { name: /^Highlights \(\d+\)$/ }), { pause: 2500 });
  await c.finish();
});

test('clip: reading settings and themes', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'themes', 'desktop');
  const p = c.page;
  await openItem(p, GREAT_WORK);
  c.rec();
  await p.waitForTimeout(600);
  await tap(p, p.locator('.reader-toolbar').getByRole('button', { name: 'Text settings' }));
  const panel = p.getByRole('dialog', { name: 'Reading settings' });
  await expect(panel).toBeVisible();
  await tap(p, panel.getByRole('group', { name: 'Font' }).getByRole('button', { name: 'Literata' }), { pause: 700 });
  await tap(p, panel.getByRole('button', { name: 'Larger text' }), { pause: 350 });
  await tap(p, panel.getByRole('button', { name: 'Larger text' }), { pause: 700 });
  for (const t of ['Sepia', 'Dark', 'E-ink']) {
    await tap(p, panel.getByRole('group', { name: 'Theme' }).getByRole('button', { name: t }), { pause: 1300 });
    if (t === 'Sepia') c.poster();
  }
  await tap(p, panel.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }), { pause: 900 });
  await c.finish();
});

test('clip: full-text search', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'search', 'desktop');
  const p = c.page;
  c.rec();
  await p.waitForTimeout(500);
  await nav(p, 'Search');
  await typeInto(p, p.locator('#search-input'), 'procrastination', 110);
  await p.waitForTimeout(2500);
  c.poster();
  await p.waitForTimeout(1000);
  await c.finish();
});

test('clip: pages on the Boox', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'boox-pages', 'boox', { theme: 'eink' });
  const p = c.page;
  await openItem(p, GREAT_WORK);
  await expect(p.locator('.page-indicator')).toHaveText(/^\d+ \/ \d+$/);
  c.rec();
  await p.waitForTimeout(1200);
  const { width, height } = p.viewportSize()!;
  const tapAt = async (x: number, y: number, pause = 1100) => {
    await p.mouse.move(x, y, { steps: 6 });
    await p.mouse.down();
    await p.mouse.up();
    await p.waitForTimeout(pause);
  };
  await tapAt(width * 0.86, height * 0.55);
  await tapAt(width * 0.86, height * 0.55);
  c.poster();
  await tapAt(width * 0.86, height * 0.55);
  await tapAt(width * 0.14, height * 0.55);
  await tapAt(width * 0.5, height * 0.5, 1800); // middle: toolbar
  await c.finish();
});

test('clip: listen', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'listen', 'phone', { theme: 'sepia', speech: 1700 });
  const p = c.page;
  await openItem(p, GREAT_WORK);
  c.rec();
  await p.waitForTimeout(600);
  const listen = p.locator('.reader-toolbar').getByRole('button', { name: 'Listen', exact: true });
  if (await listen.isVisible()) {
    await tap(p, listen);
  } else {
    await tap(p, p.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }));
    await tap(p, p.getByRole('menuitem', { name: 'Listen' }));
  }
  const bar = p.getByRole('region', { name: 'Read aloud' });
  await expect(bar).toBeVisible();
  await p.waitForTimeout(4000);
  c.poster();
  await p.waitForTimeout(3500);
  await tap(p, bar.getByRole('button', { name: 'Pause' }), { pause: 1200 });
  await c.finish();
});

test('clip: link a device with a one-time code', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await clip(browser, 'link-code', 'desktop');
  const p = a.page;
  a.rec();
  await p.waitForTimeout(500);
  await nav(p, 'Settings');
  await tap(p, p.getByRole('link', { name: 'Link a device' }).first());
  await tap(p, p.getByRole('button', { name: 'Generate code' }), { pause: 1500 });
  const code = (await p.locator('.set-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/[A-Z0-9]{4}-?[A-Z0-9]{4}/);
  a.poster();
  await p.waitForTimeout(2000);
  await a.finish();

  const b = await clip(browser, 'link-phone', 'phone', { signedIn: false });
  const q = b.page;
  await q.goto('/');
  await expect(q).toHaveURL(/\/login/);
  b.rec();
  await q.waitForTimeout(800);
  await typeInto(q, q.locator('#login-code'), code, 140);
  await q.waitForTimeout(300);
  await tap(q, q.getByRole('button', { name: 'Sign in with code' }));
  await expect(row(q, GREAT_WORK)).toBeVisible({ timeout: 30_000 });
  await q.waitForTimeout(1800);
  b.poster();
  await q.waitForTimeout(600);
  await b.finish();
});

test('clip: follow an RSS feed', async ({ browser }) => {
  test.setTimeout(400_000);
  const c = await clip(browser, 'rss', 'desktop');
  const p = c.page;
  c.rec();
  await p.waitForTimeout(500);
  await nav(p, 'Feed');
  await tap(p, p.getByRole('link', { name: /Manage feeds/ }).first());
  await typeInto(p, p.getByPlaceholder('Site or feed address'), 'jvns.ca', 70);
  await tap(p, p.getByRole('button', { name: 'Add', exact: true }), { pause: 800 });
  await c.cut();
  await expect(p.getByText(/Added \d+|Julia Evans/).first()).toBeVisible({ timeout: 120_000 });
  c.rec();
  await p.waitForTimeout(1800);
  await nav(p, 'Feed');
  await p.waitForTimeout(1500);
  c.poster();
  await scrollSmooth(p, 400, 14);
  await p.waitForTimeout(1200);
  await c.finish();
});

test('clip: AI summary and questions', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'ai', 'desktop');
  const p = c.page;
  await openItem(p, GREAT_WORK);
  c.rec();
  await p.waitForTimeout(500);
  await tap(p, p.locator('.reader-toolbar').getByRole('button', { name: 'More actions' }));
  await tap(p, p.getByRole('menuitem', { name: 'Summarize' }));
  await expect(p.getByText(/TL;DR/).first()).toBeVisible({ timeout: 30_000 });
  await p.waitForTimeout(2200);
  c.poster();
  await tap(p, p.getByRole('group', { name: 'AI' }).getByRole('button', { name: 'Ask' }));
  await typeInto(p, p.getByPlaceholder('What is the main argument?'), QUESTION, 45);
  await tap(p, p.getByRole('button', { name: 'Ask', exact: true }).last());
  await expect(p.getByText(/Curiosity is the engine/)).toBeVisible({ timeout: 30_000 });
  await p.waitForTimeout(2600);
  await c.finish();
});

test('clip: saving from Telegram shows up live', async ({ browser }) => {
  test.setTimeout(300_000);
  const CHAT = 5150001;
  let updateId = 7_000_000;
  const chat: { from: 'me' | 'bot'; text: string }[] = [];
  const send = async (text: string) => {
    chat.push({ from: 'me', text });
    const entities: { type: string; offset: number; length: number }[] = [];
    const cmd = /^\/\w+/.exec(text);
    if (cmd) entities.push({ type: 'bot_command', offset: 0, length: cmd[0].length });
    for (const m of text.matchAll(/https?:\/\/\S+/g)) entities.push({ type: 'url', offset: m.index!, length: m[0].length });
    const before = telegram.calls.length;
    const res = await fetch(`${FUNCTIONS}/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      body: JSON.stringify({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT, type: 'private', username: 'ada_reads', first_name: 'Ada' },
          from: { id: CHAT, is_bot: false, username: 'ada_reads', first_name: 'Ada' },
          text,
          entities,
        },
      }),
    });
    expect(res.status).toBe(200);
    return before;
  };
  const botTexts = (from: number) => telegram.calls.slice(from).filter((x) => x.body.chat_id === CHAT && typeof x.body.text === 'string');

  const { url } = await callFunction<{ url: string }>('createTelegramLink', {}, { idToken });
  const token = new RegExp(`^https://t\\.me/${TELEGRAM_BOT}\\?start=([A-Za-z0-9]+)$`).exec(url)?.[1];
  let from = await send(`/start ${token}`);
  await waitFor('connected reply', async () => botTexts(from).length > 0, 30_000);
  chat.push({ from: 'bot', text: String(botTexts(from)[0].body.text) });

  const c = await clip(browser, 'telegram-live', 'desktop');
  const p = c.page;
  c.rec();
  await p.waitForTimeout(1500);
  from = await send('Great essay on writing https://www.paulgraham.com/simply.html #writing');
  await expect(row(p, /Write Simply/)).toBeVisible({ timeout: 60_000 });
  await p.waitForTimeout(1500);
  await c.cut();
  await expect(row(p, /Write Simply/).locator('.item-state')).toHaveCount(0, { timeout: 90_000 });
  c.rec();
  await p.waitForTimeout(1800);
  c.poster();
  await c.finish();
  await waitFor('saved reply', async () => botTexts(from).some((x) => String(x.body.text).startsWith('✓ Saved:')), 60_000);
  const edited = botTexts(from).map((x) => String(x.body.text));
  chat.push({ from: 'bot', text: edited[edited.length - 1] });

  from = await send('Remember to check the Boox refresh settings #todo');
  await waitFor('note reply', async () => botTexts(from).length > 0, 30_000);
  chat.push({ from: 'bot', text: String(botTexts(from).pop()!.body.text) });
  from = await send('/latest');
  await waitFor('latest reply', async () => botTexts(from).length > 0, 30_000);
  chat.push({ from: 'bot', text: String(botTexts(from).pop()!.body.text) });
  writeFileSync(`${OUT}telegram-chat.json`, JSON.stringify({ bot: TELEGRAM_BOT, chat }, null, 2));
});

test('stills: bookmarklet, newsletter, public share page', async ({ browser, request }) => {
  test.setTimeout(300_000);
  // Bookmarklet window: GET /api/save with a save-only key, as the bookmarklet opens it.
  const { key } = await callFunction<{ key: string }>('createApiKey', { name: 'Bookmarklet', scope: 'save' }, { idToken });
  const pop = await browser.newContext({ viewport: { width: 420, height: 260 }, deviceScaleFactor: 2 });
  const w = await pop.newPage();
  await w.goto(`${HOSTING}/api/save?key=${key}&source=bookmarklet&url=${encodeURIComponent('https://www.paulgraham.com/read.html')}&title=${encodeURIComponent('The Need to Read')}`);
  await w.waitForTimeout(400);
  await w.screenshot({ path: `${OUT}bookmarklet-window.png` });
  await pop.close();

  // Newsletter by email.
  const { address } = await callFunction<{ address: string }>('getInboundEmail', {}, { idToken });
  const html =
    '<h1>The Slow Web, issue 42</h1><p>Hello again. This week: why e-ink readers are having a moment, three essays about attention, and a tool for saving long reads.</p>' +
    '<h2>E-ink is back</h2><p>Paper-like screens used to be for novels only. Now tablets like the Boox run Android apps, which means your read-it-later app can live there too. The trick is designing for a screen that refreshes slowly: no animation, strong contrast, pages instead of scrolling.</p>' +
    '<h2>Three essays</h2><ul><li>On reading slowly, and why it sticks.</li><li>The case for a single reading list.</li><li>Notes on highlights you actually revisit.</li></ul><p>See you next week.</p>';
  const res = await request.post(`${FUNCTIONS}/inboundEmail`, {
    headers: { 'x-readlater-secret': EMAIL_SECRET, 'content-type': 'application/json' },
    data: { to: address, from: 'The Slow Web <hello@slowweb.example>', subject: 'The Slow Web #42: E-ink is back', html },
  });
  expect(res.ok()).toBe(true);
  const id = String(((await res.json()) as { id: string }).id);
  await waitFor('newsletter processed', async () => (await listDocs(`users/${uid}/items`)).some((i) => i.id === id && i.data.fetchStatus === 'done'));

  const c = await clip(browser, 'newsletter-still', 'phone');
  const p = c.page;
  await p.goto(`/item/${id}`);
  await expect(p.locator('.reader-content')).toContainText('E-ink is back');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}newsletter.png` });
  await c.ctx.close();

  // Public share page, opened by someone who is not signed in.
  const share = await callFunction<{ token: string; url: string }>('createShare', { itemId: greatWorkId, includeHighlights: true }, { idToken });
  const anon = await browser.newContext({ ...DEVICES.desktop });
  const s = await anon.newPage();
  await s.goto(`${HOSTING}/s/${share.token}`);
  await expect(s.getByText(GREAT_WORK).first()).toBeVisible({ timeout: 30_000 });
  await s.waitForTimeout(800);
  await s.screenshot({ path: `${OUT}share-page.png` });
  await anon.close();
});

test('clip: organise with filters and bulk actions', async ({ browser }) => {
  test.setTimeout(300_000);
  const c = await clip(browser, 'organise', 'phone');
  const p = c.page;
  c.rec();
  await p.waitForTimeout(700);
  await tap(p, p.getByRole('button', { name: 'Filters' }));
  const filters = p.getByRole('dialog', { name: 'Filter and sort' });
  await expect(filters).toBeVisible();
  await tap(p, filters.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: /^#essays/ }), { pause: 900 });
  await tap(p, filters.getByRole('button', { name: 'Done' }), { pause: 1500 });
  c.poster();
  await tap(p, p.getByRole('button', { name: 'Clear filters' }), { pause: 900 });
  await tap(p, p.getByRole('button', { name: 'Select', exact: true }), { pause: 600 });
  await tap(p, p.getByRole('checkbox', { name: /Select “Attention/ }), { pause: 300 });
  await tap(p, p.getByRole('checkbox', { name: /Select “The Lighthouse/ }), { pause: 600 });
  const bar = p.getByRole('region', { name: 'Selected items' });
  const tools = bar.getByRole('toolbar', { name: 'Bulk actions' });
  const fav = tools.getByRole('button', { name: 'Favorite' });
  await tap(p, (await fav.isVisible()) ? fav : tools.getByRole('button', { name: 'Archive' }), { pause: 1600 });
  await c.finish();
});
