/**
 * Step 8 — Perf budget smoke.
 *
 * Boots the default track (lagoon) under auto-play, lets the recorder
 * accumulate ~5 s of frame-time samples, then asserts a loose floor:
 *   fps >= 30, p95 <= 50 ms.
 *
 * The bounds are intentionally generous — headed Chromium on CI sees
 * heavy throttling, and we don't want CI to start flapping the moment
 * a track gains a new prop. The point of this test is to give us a
 * deterministic regression handle once the v1 art lands; when we tune
 * up the numbers we'll do it from the bottom of the trace, not the top.
 *
 * The full stats blob is console.logged so CI traces always carry the
 * numbers — when this starts failing the first thing we want is "what
 * was the actual p99 / hitch count?".
 */
import { expect, test } from '@playwright/test'

test.describe('Step 8 perf budget', () => {
  test('lagoon under autoplay holds fps >= 30 and p95 <= 50ms', async ({ page }) => {
    await page.goto('/?autostart=1')

    // Boot gate — debug API mounts once main.ts finishes phase 8.
    await page.waitForFunction(() => window.__hover?.ready === true, { timeout: 10000 })
    // The perf accessor is attached inside startGameLoop, after the rAF
    // loop is kicked. Wait for it explicitly so the test doesn't race
    // against the install order.
    await page.waitForFunction(() => window.__hover?.perf != null, { timeout: 10000 })

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
    expect(stats.fps).toBeGreaterThanOrEqual(30)
    expect(stats.p95Ms).toBeLessThanOrEqual(50)
  })

  test('?perf=1 boots with the overlay visible; backquote toggles it', async ({ page }) => {
    await page.goto('/?autostart=1&perf=1')
    await page.waitForFunction(() => window.__hover?.perf != null, { timeout: 10000 })

    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(true)

    // Backquote keybind toggles the overlay off.
    await page.keyboard.press('Backquote')
    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(false)

    // And back on.
    await page.keyboard.press('Backquote')
    expect(await page.evaluate(() => window.__hover!.perf!.isHudOn())).toBe(true)
  })
})
