import { expect, test } from '@playwright/test'

test.describe('M2 water', () => {
  test('bike drives off the island onto water and rides waves', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    })

    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
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
      }),
    )

    // Wait until the bike has moved off the island in z.
    await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 30, {
      timeout: 8000,
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
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    // Coast off the island (no throttle), let physics settle.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 0.5,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
      }),
    )
    await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 35, {
      timeout: 10000,
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
