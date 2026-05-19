/**
 * Boot-readiness probes for Playwright specs.
 *
 * Every existing spec invents its own boot dance — some wait only for
 * `__hover.ready`, others also wait for `perf`, others wait for the
 * bike to be grounded. This module collects the variants so a future
 * regression in the boot sequence has one place to update.
 *
 * Three probes, increasing in strictness:
 *  - `waitForReady` — debug API mounted (`__hover.ready === true`).
 *    Use when the spec only drives state via `__hover.*` and doesn't
 *    need a bike yet.
 *  - `waitForPerfReady` — adds `__hover.perf != null`. Use for perf /
 *    matrix specs that read the recorder.
 *  - `waitFullyBooted` — adds the bike-spawned + grounded gate. Use
 *    for any spec that asserts on physics state.
 *
 * Each probe carries its own timeout. The defaults are tuned for headed
 * Chromium on a developer machine; CI under SwiftShader pays an extra
 * ~10s for first paint and may need more — pass `{ timeout }` overrides
 * at the call site rather than bumping the default here.
 */
import type { Page } from '@playwright/test'

const DEFAULT_READY_TIMEOUT_MS = 20_000
const DEFAULT_GROUNDED_TIMEOUT_MS = 30_000

/** Wait for the debug API to mount (phase 8 of main.ts). */
export async function waitForReady(page: Page, opts?: { timeout?: number }): Promise<void> {
  await page.waitForFunction(() => window.__hover?.ready === true, null, {
    timeout: opts?.timeout ?? DEFAULT_READY_TIMEOUT_MS,
  })
}

/** Wait for the debug API + perf recorder. Perf is attached after the
 *  rAF loop kicks off, which can race the `ready` flag. */
export async function waitForPerfReady(page: Page, opts?: { timeout?: number }): Promise<void> {
  const timeout = opts?.timeout ?? DEFAULT_READY_TIMEOUT_MS
  await waitForReady(page, { timeout })
  await page.waitForFunction(() => window.__hover?.perf != null, null, { timeout })
}

/** Wait for the debug API, perf recorder, AND for a player bike to have
 *  spawned and reached its rest hover height. The strictest probe — use
 *  in any spec that asserts on physics state. */
export async function waitFullyBooted(page: Page, opts?: { timeout?: number }): Promise<void> {
  const timeout = opts?.timeout ?? DEFAULT_GROUNDED_TIMEOUT_MS
  await waitForPerfReady(page, { timeout })
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, null, {
    timeout,
  })
}
