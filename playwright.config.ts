import { defineConfig, devices } from '@playwright/test'

// Run headed by default so Chromium uses the real GPU. The headless WebGL2
// software fallback (SwiftShader) tanks any non-trivial shader work to
// single-digit fps under parallel workers, which made the GPU water shader
// (M9.25+) chronically flaky. Headed mode pops a browser window per worker
// — fine for local dev. Set `E2E_HEADLESS=1` to opt back in (e.g. CI on a
// machine without a display server).
const headless = process.env.E2E_HEADLESS === '1'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // Physics-driven tests get flaky under heavy CPU contention. Cap workers
  // so the dev server has room to breathe at 60Hz fixed step.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5191',
    trace: 'on-first-retry',
    headless,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5191',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
