/**
 * Playwright console-error fixture.
 *
 * Existing specs (e.g. `boot.spec.ts`) capture page errors ad-hoc with
 * `page.on('pageerror', ...)`. That's fine for one spec but the QA pass
 * wants every track-matrix cell + the soak run to share a single
 * assertion: "no uncaught errors, no `console.error` calls". This
 * fixture turns that into a one-liner the spec opts into.
 *
 * Usage in a spec:
 *
 *   import { test } from './helpers/console-errors'
 *
 *   test('matrix cell boots cleanly', async ({ page, consoleErrors }) => {
 *     await page.goto('/?autostart=1')
 *     // ... your assertions ...
 *     consoleErrors.assertNone()
 *   })
 *
 * The fixture installs the listener BEFORE `page.goto` so early-boot
 * errors are captured (anything synchronous in the bundle's top-level
 * code, the renderer's WebGPU init dance, etc.).
 *
 * Allowlist: pass `consoleErrors.allow(/regex/)` from inside the test to
 * mark known-noisy lines as expected. The regex matches against the
 * full `<source>: <text>` string we record below. Use sparingly — every
 * entry is a TODO.
 */
import { test as base, type ConsoleMessage, expect } from '@playwright/test'

export type ConsoleErrorRecord = {
  source: 'pageerror' | 'console.error'
  message: string
  /** Time relative to fixture install, in ms. Useful for triage when a
   *  flaky test prints errors only on certain frames. */
  tMs: number
}

export type ConsoleErrorCollector = {
  records: ConsoleErrorRecord[]
  /** Add an allowlist regex. Lines matching ANY regex are ignored by
   *  `assertNone`. Returns the collector for chaining. */
  allow(pattern: RegExp): ConsoleErrorCollector
  /** Wipe collected records (allowlist stays). Call after the boot /
   *  settle-in window if you want `assertNone` to grade only the post-
   *  reset interval — e.g. a perf-budget spec that doesn't care about
   *  cold-load shader compile warnings. */
  reset(): void
  /** Throws via expect() if any non-allowlisted error has been recorded.
   *  Call this at the end of the spec (or any checkpoint mid-spec). */
  assertNone(): void
  /** Returns a snapshot of currently-recorded records for log attachment. */
  snapshot(): ConsoleErrorRecord[]
}

/**
 * Extended Playwright `test` with a `consoleErrors` fixture. Drop-in
 * replacement for the bare `test` import — every spec under tests/e2e/
 * can adopt it incrementally.
 */
export const test = base.extend<{ consoleErrors: ConsoleErrorCollector }>({
  consoleErrors: async ({ page }, use) => {
    const t0 = Date.now()
    const records: ConsoleErrorRecord[] = []
    const allowlist: RegExp[] = []

    const onPageError = (err: Error): void => {
      records.push({
        source: 'pageerror',
        message: `${err.name}: ${err.message}`,
        tMs: Date.now() - t0,
      })
    }
    const onConsole = (msg: ConsoleMessage): void => {
      if (msg.type() !== 'error') return
      records.push({
        source: 'console.error',
        message: msg.text(),
        tMs: Date.now() - t0,
      })
    }
    page.on('pageerror', onPageError)
    page.on('console', onConsole)

    const collector: ConsoleErrorCollector = {
      records,
      allow(pattern: RegExp) {
        allowlist.push(pattern)
        return collector
      },
      reset() {
        records.length = 0
      },
      assertNone() {
        const offending = records.filter((r) => !allowlist.some((re) => re.test(formatRecord(r))))
        // Format the offending records for the assertion message so the
        // failure ouput shows what actually went wrong.
        expect(
          offending,
          offending.length === 0
            ? 'no console errors'
            : `${offending.length} console error(s):\n${offending.map(formatRecord).join('\n')}`,
        ).toEqual([])
      },
      snapshot: () => records.slice(),
    }

    await use(collector)

    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  },
})

export { expect } from '@playwright/test'

function formatRecord(r: ConsoleErrorRecord): string {
  return `[+${r.tMs}ms ${r.source}] ${r.message}`
}
