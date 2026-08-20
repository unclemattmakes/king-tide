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
   *  Call this at the end of the spec (or any checkpoint mid-spec).
   *  NB: the project default now runs this automatically after every test
   *  (see the auto fixture below), so most specs no longer need to call it
   *  by hand — importing this `test` is enough. */
  assertNone(): void
  /** Opt OUT of the automatic post-test assertion for specs that
   *  legitimately exercise an error path (renderer-init failure probes, a
   *  spec that asserts on the error itself, …). The fixture still records
   *  everything, so the spec can make its own targeted assertions. Returns
   *  the collector for chaining. */
  expectErrors(): ConsoleErrorCollector
  /** Returns a snapshot of currently-recorded records for log attachment. */
  snapshot(): ConsoleErrorRecord[]
}

/**
 * Extended Playwright `test` with a `consoleErrors` fixture. Drop-in
 * replacement for the bare `test` import.
 *
 * PROJECT DEFAULT: any spec that imports this `test` now fails on an
 * unexpected `console.error` / `pageerror` automatically — the
 * `_consoleErrorAutoAssert` auto-fixture below runs `assertNone()` after
 * the test body without the spec having to call it. A spec that
 * legitimately drives an error path opts out with
 * `consoleErrors.expectErrors()` (and/or narrows with `.allow(/…/)`).
 *
 * Playwright resolves `test` per import, so this can't be wired purely
 * from `playwright.config.ts` — adopting the default is a one-line import
 * swap (`from '@playwright/test'` → `from './helpers/console-errors'`),
 * no per-test assertion call. Specs still on the bare import are tracked
 * for migration; see playwright.config.ts and the workstream followups.
 */
export type Asset404Record = {
  url: string
  status: number
  tMs: number
}

export type Asset404Collector = {
  records: Asset404Record[]
  /** Throws via expect() if any asset-looking request 404'd. Opt-in per
   *  spec (unlike console errors, not an auto-fixture): some specs probe
   *  missing-asset fallbacks on purpose. */
  assertNone(): void
  snapshot(): Asset404Record[]
}

/** Requests we grade as "assets": game content the schema loads softly
 *  (warned, never crashed) — which is exactly how three phantom
 *  ambience files 404'd on every production load unnoticed. */
const ASSET_URL_RE = /\/(assets|audio|tracks)\/|\.(glb|opus|jpe?g|png|ktx2|webp)(\?|$)/

export const test = base.extend<{
  consoleErrors: ConsoleErrorCollector
  /** Opt-in collector: every 404 response for an asset-looking URL.
   *  QA matrix cells call `asset404s.assertNone()` so a dangling
   *  content reference fails the cell instead of warning into a log. */
  asset404s: Asset404Collector
  /** Auto-fixture: enforces "no console errors" after every test that uses
   *  this `test`, unless the spec called `consoleErrors.expectErrors()`.
   *  Never referenced by name in specs — `auto: true` runs it regardless. */
  _consoleErrorAutoAssert: undefined
}>({
  asset404s: async ({ page }, use) => {
    const t0 = Date.now()
    const records: Asset404Record[] = []
    const onResponse = (res: { url(): string; status(): number }): void => {
      if (res.status() !== 404) return
      if (!ASSET_URL_RE.test(res.url())) return
      records.push({ url: res.url(), status: res.status(), tMs: Date.now() - t0 })
    }
    page.on('response', onResponse)
    const collector: Asset404Collector = {
      records,
      assertNone() {
        expect(
          records,
          records.length === 0
            ? 'no asset 404s'
            : `${records.length} asset request(s) 404'd:\n${records
                .map((r) => `[+${r.tMs}ms] ${r.url}`)
                .join('\n')}`,
        ).toEqual([])
      },
      snapshot: () => records.slice(),
    }
    await use(collector)
    page.off('response', onResponse)
  },
  consoleErrors: async ({ page }, use) => {
    const t0 = Date.now()
    const records: ConsoleErrorRecord[] = []
    const allowlist: RegExp[] = []
    let optedOut = false

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

    const collector: ConsoleErrorCollector & { __optedOut(): boolean } = {
      records,
      allow(pattern: RegExp) {
        allowlist.push(pattern)
        return collector
      },
      reset() {
        records.length = 0
      },
      expectErrors() {
        optedOut = true
        return collector
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
      __optedOut: () => optedOut,
    }

    await use(collector)

    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  },

  // Runs for EVERY test using this `test` (auto: true). After the body
  // finishes, fail on any unexpected console error unless the spec opted
  // out via `consoleErrors.expectErrors()`. Depends on `consoleErrors` so
  // the listener is installed first and torn down after this runs.
  _consoleErrorAutoAssert: [
    async ({ consoleErrors }, use) => {
      await use(undefined)
      const c = consoleErrors as ConsoleErrorCollector & { __optedOut(): boolean }
      if (!c.__optedOut()) consoleErrors.assertNone()
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'

function formatRecord(r: ConsoleErrorRecord): string {
  return `[+${r.tMs}ms ${r.source}] ${r.message}`
}
