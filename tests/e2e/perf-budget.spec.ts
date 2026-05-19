/**
 * Step 8 — Perf budget smoke.
 *
 * Boots the default track (lagoon) under auto-play, lets the recorder
 * accumulate ~5 s of frame-time samples, then asserts a loose floor.
 *
 * Imports the global budget directly from `tools/qa/matrix.mjs` so the
 * non-matrix `pnpm e2e` shares thresholds with the QA matrix — a
 * tightening of the floor doesn't require touching two files.
 *
 * The full stats blob is console.logged so CI traces always carry the
 * numbers — when this starts failing the first thing we want is "what
 * was the actual p99 / hitch count?".
 */
import { expect, test } from '@playwright/test'
import { GLOBAL_PERF_BUDGET } from '../../tools/qa/matrix.mjs'
import { waitForPerfReady } from './helpers/boot'

test.describe('Step 8 perf budget', () => {
  test(`lagoon under autoplay holds fps >= ${GLOBAL_PERF_BUDGET.fpsFloor} and p95 <= ${GLOBAL_PERF_BUDGET.p95CeilingMs}ms`, async ({
    page,
  }) => {
    await page.goto('/?autostart=1')
    await waitForPerfReady(page, { timeout: 10_000 })

    // Drive 5 s of auto-play. Toggle on, then sleep — we don't need to
    // sample the trajectory here; the recorder runs every rAF frame.
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    // Reset the window so settle-in frames (boot, countdown) don't
    // contaminate the budget. The recorder keeps sampling immediately.
    await page.evaluate(() => window.__hover!.perf!.resetWindow())
    await page.waitForTimeout(5000)

    const stats = await page.evaluate(() => window.__hover!.perf!.stats())

    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log('perf budget stats:', JSON.stringify(stats))

    expect(stats.count).toBeGreaterThan(60) // we should have ≥ 1s of samples
    expect(stats.fps).toBeGreaterThanOrEqual(GLOBAL_PERF_BUDGET.fpsFloor)
    expect(stats.p95Ms).toBeLessThanOrEqual(GLOBAL_PERF_BUDGET.p95CeilingMs)
  })

  test('?perf=1 boots with the overlay visible; backquote toggles it', async ({ page }) => {
    await page.goto('/?autostart=1&perf=1')
    await waitForPerfReady(page, { timeout: 10_000 })

    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(true)

    // Backquote keybind toggles the overlay off.
    await page.keyboard.press('Backquote')
    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(false)

    // And back on.
    await page.keyboard.press('Backquote')
    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(true)
  })
})
