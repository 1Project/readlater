import base from './playwright.config';

/** Demo clips (gallery/demos.spec.ts): `npm run demos` → docs/demos/. Needs ffmpeg. */
export default { ...base, testDir: 'gallery', testMatch: 'demos.spec.ts', retries: 0, timeout: 600_000 };
