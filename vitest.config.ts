import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // V8 is the recommended provider for Vitest 4.x — built-in, no
      // instrumentation pass, and reads the same coverage data Chromium
      // emits in production.
      provider: 'v8',
      // text → stdout summary; html → coverage/index.html for browsing;
      // json → machine-readable for CI. lcov omitted intentionally — we
      // don't ship a Codecov / Coveralls integration.
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      // Limit collection to source we actually ship — the test tree and
      // build configs would otherwise dilute the percentages.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        // Vite-injected glue + entry points that are mostly side effects.
        'src/main.ts',
        'src/debug.ts',
      ],
    },
  },
})
