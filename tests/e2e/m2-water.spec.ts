import { expect, test } from '@playwright/test'

// The GPU water shader added in M9.25 has a per-fragment foam loop that
// hammers SwiftShader (the WebGL2 software fallback used by headless
// Chromium). On real hardware with a GPU it runs at full speed; in
// headless Playwright the sim ends up running ~5× slower than wall-clock
// because rendering is a few FPS. The conditions these tests assert are
// still real (bike rides waves, doesn't sink) — we just need more wall
// time for the sim to advance enough to observe them.
test.describe('M2 water', () => {
  test('bike drives off the island onto water and rides waves', async ({ page }) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    })

    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 15000,
    })

    // Drive forward at full throttle for 4 seconds — long enough to leave the
    // island (radius 24m) and ride water for a beat.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
      }),
    )

    // Wait until the bike is past the right-straight ramp (which spans
    // z=25..37) and back on water with room to settle. Sampling y inside
    // the ramp's launch zone would conflate ramp height with wave bob.
    await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 60, {
      timeout: 60_000,
    })

    // Now sample y over ~1.5s while still throttling on water — waves should
    // oscillate the bike's vertical position.
    const ySamples: number[] = await page.evaluate(async () => {
      const out: number[] = []
      for (let i = 0; i < 30; i++) {
        out.push(window.__hover!.player()!.position.y)
        await new Promise((r) => setTimeout(r, 50))
      }
      return out
    })

    await page.evaluate(() => window.__hover!.setIntentOverride(null))

    const yMin = Math.min(...ySamples)
    const yMax = Math.max(...ySamples)
    const yRange = yMax - yMin

    // Should be substantially below island top (3m) — bike is on water.
    expect(yMax).toBeLessThan(3)
    // Should ride above the deepest wave troughs.
    expect(yMin).toBeGreaterThan(-2)
    // Wave-driven oscillation should be at least 0.4m peak-to-peak.
    expect(yRange).toBeGreaterThan(0.4)

    expect(errors, errors.join('\n')).toEqual([])
  })

  test('bike floats on water from rest (does not sink)', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 15000,
    })

    // Coast off the island (no throttle), let physics settle.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 0.5,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
      }),
    )
    await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 35, {
      timeout: 60_000,
    })
    await page.evaluate(() => window.__hover!.setIntentOverride(null))

    // Wait for bike to settle at hover height on water.
    await page.waitForTimeout(2000)
    const settled = await page.evaluate(() => window.__hover!.player()!)

    // Bike should not have sunk far below water surface (waves go to ~-1.4m, hover height ~1.2 above).
    expect(settled.position.y).toBeGreaterThan(-1)
    expect(settled.isGrounded).toBe(true)
  })
})
