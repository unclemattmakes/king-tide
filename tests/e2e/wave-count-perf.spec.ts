/**
 * Wave-component-count perf grid (P2.2 of docs/water-next-research.md §7.1,
 * §9.4): "add an A/B vertex-cost measurement (6 vs N waves) on the 768²
 * plane before committing P2 component counts."
 *
 * Boots the same open-water scene once per component count — the bank is
 * baked into the shader at construction, so this is necessarily a
 * boot-per-point grid rather than a within-boot knob sweep. Each boot:
 * autoplay over open water, reset the perf window, sample ~8 s of frame
 * times, record p50/p95/fps. The driver-warmup variance between boots is
 * why this is a measurement harness (gated, machine-local) and not a CI
 * assertion — eyeball the table, then set DEFAULT_SPECTRUM_COMPONENTS
 * from it.
 *
 * Gated on WAVE_PERF=1. Output: artifacts/wave-count-perf/grid.json +
 * a console table per point.
 *
 *   WAVE_PERF=1 E2E_PORT=5397 pnpm e2e wave-count-perf
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const OUT_DIR = 'artifacts/wave-count-perf'

// 'default' = the hand-tuned 6-wave bank (no spectrum); numbers are
// mixed-sea component counts. mixed-sea is the JONSWAP-neutral preset so
// the only variable across points is the count.
const POINTS: Array<{ label: string; query: string }> = [
  { label: 'default-6', query: '' },
  { label: 'spectrum-8', query: '&spectrum=mixed-sea:1:8' },
  { label: 'spectrum-12', query: '&spectrum=mixed-sea:1:12' },
  { label: 'spectrum-16', query: '&spectrum=mixed-sea:1:16' },
]

type PerfStats = { count: number; fps: number; p50Ms: number; p95Ms: number; p99Ms?: number }

test('wave-count perf grid (boot-per-point)', async ({ page }) => {
  test.skip(process.env.WAVE_PERF !== '1', 'gated on WAVE_PERF=1')
  test.setTimeout(120_000 * POINTS.length)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 900 })

  const grid: Array<{ label: string; bankCount: number; stats: PerfStats }> = []
  for (const point of POINTS) {
    await page.goto(`/?autostart=1&track=lagoon-edit&skipintro=1${point.query}`)
    await waitFullyBooted(page, { timeout: 60_000 })
    const bank = await page.evaluate(() => window.__hover!.waveBank())
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    // Settle past the start pad + countdown before opening the window.
    await page.waitForTimeout(6_000)
    await page.evaluate(() => window.__hover!.perf!.resetWindow())
    await page.waitForTimeout(8_000)
    const stats = (await page.evaluate(() => window.__hover!.perf!.stats())) as PerfStats
    grid.push({ label: point.label, bankCount: bank?.count ?? -1, stats })
    // biome-ignore lint/suspicious/noConsole: measurement harness output
    console.log(
      `wave-count-perf ${point.label} (bank=${bank?.count}): fps=${stats.fps.toFixed(1)} ` +
        `p50=${stats.p50Ms.toFixed(2)}ms p95=${stats.p95Ms.toFixed(2)}ms over ${stats.count} frames`,
    )
    expect(stats.count).toBeGreaterThan(60)
  }

  writeFileSync(`${OUT_DIR}/grid.json`, JSON.stringify(grid, null, 2))
  // biome-ignore lint/suspicious/noConsole: measurement harness output
  console.log('wave-count-perf grid:', JSON.stringify(grid))
})
