/**
 * Wind-trail gust verification. Boots Sandbar into a live race with the
 * ambient wind strokes on, waits for the pool to fade in on the wave-field
 * clock, and asserts live gusts via the `__windTrails` dev hook (camera-
 * independent). Screenshots land in artifacts/wind/ (test-results/ is wiped
 * per run) for the eyeball pass — strokes should read as white calligraphic
 * gusts, some carrying a loop-de-loop curl.
 *
 *   E2E_PORT=5397 pnpm e2e tests/e2e/wind-trails.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const TRACK = process.env.BOOT_TRACK ?? 'sandbar'

type WindHook = {
  activeCount(): number
  isEnabled(): boolean
}

function hook(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = (
      window as unknown as { __windTrails?: { activeCount(): number; isEnabled(): boolean } }
    ).__windTrails
    return w ? { active: w.activeCount(), enabled: w.isEnabled() } : null
  })
}

test.describe('wind trails', () => {
  test('gusts go live in a race and render', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })

    // Pool births are staggered across ~5 s of wave-field time — wait until a
    // healthy share of the field is mid-stroke.
    await page.waitForFunction(
      () => {
        const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
        return (w?.activeCount() ?? 0) >= 3
      },
      null,
      { timeout: 30_000 },
    )

    const first = await hook(page)
    expect(first).not.toBeNull()
    expect(first!.enabled).toBe(true)
    expect(first!.active).toBeGreaterThanOrEqual(3)

    // Three beats a couple seconds apart — strokes at different window
    // phases, hopefully a curl in frame somewhere.
    await page.screenshot({ path: 'artifacts/wind/wind-on-1.png' })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: 'artifacts/wind/wind-on-2.png' })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: 'artifacts/wind/wind-on-3.png' })

    const later = await hook(page)
    // The pool keeps cycling — still live minutes-of-frames later.
    expect(later!.active).toBeGreaterThanOrEqual(3)
  })

  test('?wind=0 boots the gusts disabled', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1&wind=0`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })
    const state = await hook(page)
    expect(state).not.toBeNull()
    expect(state!.enabled).toBe(false)
    await page.screenshot({ path: 'artifacts/wind/wind-off.png' })
  })
})
