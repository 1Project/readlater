import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests against the Firebase emulators. The Hosting emulator serves web/dist built with
 * VITE_USE_EMULATORS=1; global-setup.ts builds functions + web and starts the emulators unless they are
 * already running (see that file for the knobs: E2E_SKIP_BUILD, E2E_EMULATOR_LOGS).
 *
 * The tests save real pages (paulgraham.com, example.com, hnrss.org), so the functions emulator needs
 * outbound internet access.
 */

/**
 * Chromium to launch: PLAYWRIGHT_CHROMIUM_PATH if set; else the build this Playwright version expects; else any
 * Chromium found under PLAYWRIGHT_BROWSERS_PATH (a preinstalled browser of a different revision works fine).
 */
function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* not installed */
  }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir || !existsSync(dir)) return undefined;
  const builds = readdirSync(dir)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const p = join(dir, b, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export default defineConfig({
  testDir: 'specs',
  globalSetup: './global-setup.ts',
  // One signed-in user walks through the app in order; the tests share it.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: chromiumPath() },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
