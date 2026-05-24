import { waitForReady } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

test.describe('M0 boot', () => {
  test('debug API mounts, renderer picks a backend, fps ticks, no console errors', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/?autostart=1')

    // Debug API present and ready
    await waitForReady(page, { timeout: 8000 })

    const backend = await page.evaluate(() => window.__hover!.backend())
    expect(['webgpu', 'webgl2']).toContain(backend)

    // Render loop runs. Headless Chromium may throttle rAF, so we assert
    // frames accumulate rather than a specific FPS — fps reporting is best-effort.
    await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 5, { timeout: 8000 })

    const frame = await page.evaluate(() => window.__hover!.frame())
    expect(frame).toBeGreaterThan(5)

    // HUD elements populated
    await expect(page.locator('#hud-backend')).toContainText(/backend: (webgpu|webgl2)/)
    await expect(page.locator('#hud-fps')).toContainText(/fps: \d+/)

    consoleErrors.assertNone()
  })

  test('intent override flows through to state', async ({ page }) => {
    await page.goto('/?autostart=1')
    await waitForReady(page, { timeout: 8000 })

    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: -0.5,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
      }),
    )

    // Wait for at least one frame to apply the override
    const before = await page.evaluate(() => window.__hover!.frame())
    await page.waitForFunction((f) => (window.__hover?.frame() ?? 0) > f + 2, before)

    const intent = await page.evaluate(() => window.__hover!.intent())
    expect(intent.throttle).toBe(1)
    expect(intent.steer).toBe(-0.5)

    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })
})
