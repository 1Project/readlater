import base from './playwright.config';

/** Screenshot gallery (gallery/gallery.spec.ts): `npm run gallery` → docs/screenshots/gallery/. */
export default { ...base, testDir: 'gallery', testMatch: 'gallery.spec.ts', retries: 0, timeout: 600_000 };
