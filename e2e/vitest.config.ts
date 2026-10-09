import { defineConfig } from 'vitest/config';

// Vitest runs only the security-rules tests (against the Firestore and Storage
// emulators started by `npm run test:rules`). Browser tests use Playwright.
export default defineConfig({
  test: {
    include: ['rules/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
