/**
 * Step 8 — QA stability soak.
 *
 * Boots a default track under autoplay and holds it for `durationSec`
 * (default 60 s) to surface failure modes the 5 s smoke can't:
 *
 *   - Memory leaks (heap grows monotonically across the window)
 *   - Mid-run console errors (audio context drop, peer disconnect spam,
 *     etc.) that 5 s of warm-up never hits
 *   - Bike position NaN'ing under sustained AI driving
 *   - Hitch accumulation — we tolerate occasional hitches, but a
 *     soak should keep the fraction below 5%
 *
 * Skipped unless `QA_SOAK=1` so day-to-day `pnpm e2e` stays fast. The
 * orchestrator (`tools/qa/runner.mjs`) flips the env on for `pnpm qa`.
 *
 * The duration is configurable via `QA_SOAK_SECONDS` for ad-hoc nightly
 * runs; the default keeps CI runtime under five minutes when the soak
 * lands.
 */
import { SOAK_TRACKS } from '../../tools/qa/matrix.mjs'
import { expect, test } from './helpers/console-errors'

const DEFAULT_DURATION_SEC = 60
const HITCH_FRACTION_CEILING = 0.05

test.describe('QA stability soak', () => {
  test.skip(process.env.QA_SOAK !== '1', 'gated on QA_SOAK=1')

  for (const cell of SOAK_TRACKS) {
    const dur =
      parseInt(process.env.QA_SOAK_SECONDS ?? '', 10) || cell.durationSec || DEFAULT_DURATION_SEC

    test(`${cell.id} × ${cell.bike} soak ${dur}s`, async ({ page, consoleErrors }) => {
      // Generous timeout — dur + boot + tail-end assertions. We carry an
      // extra 30 s of slack so headed-Chromium throttle doesn't make this
      // flap.
      test.setTimeout(dur * 1000 + 60_000)

      consoleErrors.allow(/^\[vite\]/)

      await page.goto(`/?autostart=1&track=${cell.id}&bike=${cell.bike}`)
      await page.waitForFunction(() => window.__hover?.ready === true, { timeout: 20_000 })
      await page.waitForFunction(() => window.__hover?.perf != null, { timeout: 20_000 })

      await page.evaluate(() => {
        window.__hover!.qa?.consoleClear()
        window.__hover!.perf!.resetWindow()
      })
      await page.evaluate(() => window.__hover!.toggleAutoPlay())

      // Sample heap mid-run + at end so a monotonic leak is visible
      // even when the perf budget alone would pass.
      const sampleHeap = () =>
        page.evaluate(() => {
          // performance.memory is Chromium-only; absent in WebKit/Firefox.
          // Return 0 when unavailable so the assertion below short-circuits.
          const m = (
            performance as unknown as {
              memory?: { usedJSHeapSize: number }
            }
          ).memory
          return m?.usedJSHeapSize ?? 0
        })

      const heapStart = await sampleHeap()
      await page.waitForTimeout(Math.floor((dur * 1000) / 2))
      const heapMid = await sampleHeap()
      await page.waitForTimeout(Math.ceil((dur * 1000) / 2))
      const heapEnd = await sampleHeap()

      const stats = await page.evaluate(() => window.__hover!.perf!.stats())
      const player = await page.evaluate(() => window.__hover!.player())
      const race = await page.evaluate(() => window.__hover!.race())

      // biome-ignore lint/suspicious/noConsole: diagnostic for QA report
      console.log(
        `qa-soak:${cell.id}:${cell.bike}`,
        JSON.stringify({
          stats,
          heap: { start: heapStart, mid: heapMid, end: heapEnd },
          race,
          player,
        }),
      )

      // Hitch fraction — soak tolerates more hitches than the 5 s smoke
      // since wave-pump / lap dings are statistically more likely to
      // collide with an unlucky frame across 60 s.
      const hitchFraction = stats.count > 0 ? stats.hitchCount / stats.count : 0
      expect(hitchFraction, `hitch fraction ${(hitchFraction * 100).toFixed(2)}%`).toBeLessThan(
        HITCH_FRACTION_CEILING,
      )

      // Position sanity.
      const pos = player?.position ?? { x: NaN, y: NaN, z: NaN }
      expect(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)).toBe(true)
      expect(Math.abs(pos.x) + Math.abs(pos.y) + Math.abs(pos.z)).toBeLessThan(100_000)

      // Heap leak gate — only check when Chromium's performance.memory is
      // available. We tolerate up to 2× growth across the soak; Three.js
      // pre-allocates a lot on first track load, so a strict bound would
      // false-positive. A real leak shows up as the end heap exceeding
      // the mid by more than 50%.
      if (heapStart > 0 && heapMid > 0 && heapEnd > 0) {
        expect(
          heapEnd / heapMid,
          `heap end/mid ratio ${(heapEnd / heapMid).toFixed(2)}`,
        ).toBeLessThan(1.5)
      }

      consoleErrors.assertNone()
    })
  }
})
