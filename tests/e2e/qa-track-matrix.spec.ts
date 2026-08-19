/**
 * Step 8 — QA track × bike smoke matrix.
 *
 * Parameterised over `tools/qa/matrix.mjs` so the catalog of cells lives
 * in one place (also consumed by `tools/qa/runner.mjs`). Each cell:
 *
 *   1. Loads `/?autostart=1&track=<id>&bike=<bike>`.
 *   2. Asserts the debug API mounts and a backend is picked.
 *   3. Drives 5 s of auto-play (AI controls the player bike).
 *   4. Asserts no console errors / page errors during the window
 *      (the `consoleErrors` fixture is shared with future specs).
 *   5. Asserts a loose perf budget — fps >= 30, p95 <= 50ms.
 *   6. Asserts the bike's position is finite at the end (no NaN /
 *      tunnel-through-ground signal).
 *
 * Skipped unless `QA_MATRIX=1` so `pnpm e2e` stays fast for day-to-day
 * dev. `pnpm qa` flips the env var on for the QA orchestrator.
 *
 * The thresholds match `perf-budget.spec.ts` deliberately so a CI flake
 * on this matrix can be triaged against the existing perf budget spec
 * without translating units.
 */
import { enabledCells, GLOBAL_PERF_BUDGET } from '../../tools/qa/matrix.mjs'
import { waitForPerfReady, waitForReady } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

// Boot budget — ms from navigation start to `__hover.ready === true`. A
// regression tripwire, not a target: mexico-city (the heaviest dressed
// track) sits ~17.6s today, so 20s catches a boot-time regression without
// failing current state. One knob for every cell.
const BOOT_READY_BUDGET_MS = 20_000

test.describe('QA track × bike matrix', () => {
  test.skip(process.env.QA_MATRIX !== '1', 'gated on QA_MATRIX=1')

  for (const cell of enabledCells()) {
    const label = `${cell.id} × ${cell.bike}`
    test(`${label} boots, autoplays 5s clean, holds perf budget`, async ({
      page,
      consoleErrors,
    }) => {
      test.setTimeout(60_000)

      // Spurious cross-browser noise we never want to fail QA on:
      //   - WebGPU shader-compile warnings under headless Chromium
      //   - Vite's HMR "[vite] connecting…" log
      // Keep this list short; every entry is a deliberate ignore.
      consoleErrors.allow(/^\[vite\]/)

      const navStart = Date.now()
      await page.goto(`/?autostart=1&track=${cell.id}&bike=${cell.bike}`)

      // Boot budget — time to `__hover.ready === true` from navigation start.
      // waitForPerfReady() calls waitForReady() first, so measure around that
      // ready gate, then let it finish waiting for the perf recorder.
      await waitForReady(page, { timeout: BOOT_READY_BUDGET_MS })
      const readyMs = Date.now() - navStart
      await waitForPerfReady(page)

      // biome-ignore lint/suspicious/noConsole: diagnostic for QA report ingestion
      console.log(`qa-matrix:${cell.id}:${cell.bike}:bootMs`, readyMs)
      expect(
        readyMs,
        `boot budget exceeded: ${cell.id} took ${readyMs}ms to ready (budget ${BOOT_READY_BUDGET_MS}ms)`,
      ).toBeLessThanOrEqual(BOOT_READY_BUDGET_MS)

      const backend = await page.evaluate(() => window.__hover!.backend())
      expect(['webgpu', 'webgl2']).toContain(backend)

      // Reset console + perf windows so any settle-in noise (cold-load
      // shader compiles, audio context resume, etc.) doesn't bleed
      // into the metrics this cell is graded against. The fixture's
      // `reset()` clears the Playwright-side collector that drives
      // `assertNone()` below; the in-page `consoleClear()` keeps the
      // bug-bundle ring aligned for any failure dumps.
      consoleErrors.reset()
      await page.evaluate(() => {
        window.__hover!.qa?.consoleClear()
        window.__hover!.perf!.resetWindow()
      })

      // Drive autoplay for the smoke window. AI takes the bike around.
      await page.evaluate(() => window.__hover!.toggleAutoPlay())
      await page.waitForTimeout(5000)

      // Perf budget — same shape as perf-budget.spec.ts.
      const stats = await page.evaluate(() => window.__hover!.perf!.stats())
      // biome-ignore lint/suspicious/noConsole: diagnostic for QA report ingestion
      console.log(`qa-matrix:${cell.id}:${cell.bike}:perf`, JSON.stringify(stats))
      expect(stats.count, 'should have accumulated samples').toBeGreaterThan(60)
      expect(stats.fps).toBeGreaterThanOrEqual(
        cell.perfBudget?.fpsFloor ?? GLOBAL_PERF_BUDGET.fpsFloor,
      )
      expect(stats.p95Ms).toBeLessThanOrEqual(
        cell.perfBudget?.p95CeilingMs ?? GLOBAL_PERF_BUDGET.p95CeilingMs,
      )

      // Position sanity — the bike has not NaN'd out of the world. The
      // perf budget alone won't catch a tunneling regression that
      // freezes the bike off-track.
      const player = await page.evaluate(() => window.__hover!.player())
      expect(player, 'player snapshot present').not.toBeNull()
      const pos = player?.position ?? { x: NaN, y: NaN, z: NaN }
      expect(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)).toBe(true)
      expect(Math.abs(pos.x) + Math.abs(pos.y) + Math.abs(pos.z)).toBeLessThan(100_000)

      // Console gate runs last so a failure carries the full window.
      consoleErrors.assertNone()
    })
  }
})
