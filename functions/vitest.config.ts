// CommonJS syntax because this package is "type": "commonjs" (avoids Vite's ESM-in-CJS config warning).
const { defineConfig } = require('vitest/config') as typeof import('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // jsdom + pdf.js are memory hungry; keep parallelism modest.
    maxWorkers: 2,
  },
});
