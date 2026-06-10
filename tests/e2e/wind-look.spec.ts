/**
 * TEMP look-study capture for the wind gust strokes — not a regression spec.
 * Boots with boosted wind, grabs an ON frame and an OFF frame ~120 ms apart
 * (toggled via the __windTrails dev hook), so a pixel diff isolates exactly
 * what the wind mesh contributes to the frame.
 *
 *   E2E_PORT=5397 pnpm e2e tests/e2e/wind-look.spec.ts
 */
import { test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

type WindHook = { activeCount(): number; setEnabled(on: boolean): void }

test('capture wind on/off pair for diffing', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?autostart=1&track=sandbar&skipintro=1')
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
      return (w?.activeCount() ?? 0) >= 5
    },
    null,
    { timeout: 40_000 },
  )
  // Let the field mature a few seconds so several strokes are mid-window.
  await page.waitForTimeout(4000)

  await page.screenshot({ path: 'artifacts/wind/look-on.png' })
  await page.evaluate(() => {
    const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
    w?.setEnabled(false)
  })
  await page.waitForTimeout(120)
  await page.screenshot({ path: 'artifacts/wind/look-off.png' })

  // Second set mid-race: auto-play drives the player onto the course, so the
  // vantage is the real racing chase cam out over the water.
  await page.evaluate(() => {
    const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
    w?.setEnabled(true)
    if (!window.__hover?.isAutoPlay()) window.__hover?.toggleAutoPlay()
  })
  await page.waitForTimeout(14_000)
  await page.screenshot({ path: 'artifacts/wind/look2-on.png' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: 'artifacts/wind/look3-on.png' })
  await page.evaluate(() => {
    const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
    w?.setEnabled(false)
  })
  await page.waitForTimeout(120)
  await page.screenshot({ path: 'artifacts/wind/look3-off.png' })
})
