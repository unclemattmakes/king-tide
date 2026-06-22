import { defineConfig, devices, type PlaywrightTestProject } from '@playwright/test'

// ── Project-wide console-error default ──────────────────────────────────
// The canonical base `test`/`expect` lives in
// `tests/e2e/helpers/console-errors.ts`. It auto-asserts "no unexpected
// console.error / pageerror" after every test that imports it (an
// `auto: true` fixture — no per-test `assertNone()` call needed), with a
// clean opt-out via `consoleErrors.expectErrors()` for specs that
// legitimately drive an error path.
//
// Playwright resolves `test` per import, so a bare `import { test } from
// '@playwright/test'` can't be redirected from this config file — adopting
// the default is a one-line import swap per spec. New specs SHOULD import
// from `./helpers/console-errors`. Specs still on the bare import are
// tracked for migration in the workstream followups.

// Run headed by default so Chromium uses the real GPU. The headless WebGL2
// software fallback (SwiftShader) tanks any non-trivial shader work to
// single-digit fps under parallel workers, which made the GPU water shader
// (M9.25+) chronically flaky. Headed mode pops a browser window per worker
// — fine for local dev. Set `E2E_HEADLESS=1` to opt back in (e.g. CI on a
// machine without a display server).
const headless = process.env.E2E_HEADLESS === '1'

// Server host. Defaults to `localhost` (unchanged). Override with E2E_HOST
// (e.g. `127.0.0.1`) on machines where `localhost` resolves to an IPv6 `::1`
// that the dev server isn't reachable on.
const e2eHost = process.env.E2E_HOST ?? 'localhost'
const e2ePort = process.env.E2E_PORT ?? 5391

// Cross-browser projects are opt-in via `E2E_BROWSERS`:
//   unset / 'chromium'  → Chromium only (default, fastest)
//   'all'               → Chromium + Firefox + WebKit
//   'chromium,firefox'  → comma-separated subset
//
// Cross-browser runs are slow (3× the suite + browser cold-starts) and the
// WebKit GPU story on Linux is software-only — see docs/cross-browser.md.
function parseBrowsers(): Set<string> {
  const raw = (process.env.E2E_BROWSERS ?? 'chromium').toLowerCase().trim()
  if (raw === 'all') return new Set(['chromium', 'firefox', 'webkit'])
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

const enabled = parseBrowsers()

// Chromium gets the real GPU pass via the `--use-gl=egl` flag on Linux when
// headed. Firefox supports WebGL2 fine but ignores Chromium-specific launch
// args; we let Playwright's `devices['Desktop Firefox']` defaults apply.
// WebKit on Linux can ONLY run a software WebGL pipeline (no real GPU access
// through WebKitGTK in Playwright), so GPU-heavy specs (m2-water, m9-audio)
// carry a `test.skip(browserName === 'webkit' && platform === 'linux')` guard.
// Run those suites on macOS WebKit for real coverage.
const allProjects: Array<{ key: string; project: PlaywrightTestProject }> = [
  { key: 'chromium', project: { name: 'chromium', use: { ...devices['Desktop Chrome'] } } },
  { key: 'firefox', project: { name: 'firefox', use: { ...devices['Desktop Firefox'] } } },
  { key: 'webkit', project: { name: 'webkit', use: { ...devices['Desktop Safari'] } } },
]
const projects: PlaywrightTestProject[] = allProjects
  .filter(({ key }) => enabled.has(key))
  .map(({ project }) => project)

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
    // E2E uses a dedicated port so the suite isn't fragile to whatever
    // is squatting Vite's default 5191 (multi-session local dev,
    // earlier preview servers, etc.). Override via E2E_PORT.
    baseURL: `http://${e2eHost}:${e2ePort}`,
    trace: 'on-first-retry',
    headless,
  },
  projects,
  webServer: {
    command: `pnpm dev --port ${e2ePort} --strictPort --host`,
    url: `http://${e2eHost}:${e2ePort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
