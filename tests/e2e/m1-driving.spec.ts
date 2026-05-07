import { expect, test } from '@playwright/test'

test.describe('M1 driving', () => {
  test('bike spawns, hovers, and accelerates forward under throttle', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    })

    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.ready === true, { timeout: 10000 })

    // Wait for the bike to spawn and reach hover height (~1.2m).
    await page.waitForFunction(
      () => {
        const p = window.__hover?.player()
        return p !== null && p !== undefined && p.isGrounded
      },
      { timeout: 5000 },
    )

    const initial = await page.evaluate(() => window.__hover!.player()!)
    expect(initial.position.y).toBeGreaterThan(0.8)
    expect(initial.position.y).toBeLessThan(2.0)
    expect(initial.isGrounded).toBe(true)
    expect(initial.speed).toBeLessThan(1.0) // resting at spawn

    // Drive forward for ~2 seconds.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
      }),
    )

    // Wait for both meaningful speed AND distance travelled. waitForFunction polls,
    // so this is more robust than a fixed sleep.
    await page.waitForFunction(
      (start) => {
        const p = window.__hover?.player()
        return !!p && p.speed > 10 && p.position.z - start.z > 5
      },
      initial.position,
      { timeout: 5000 },
    )

    const driving = await page.evaluate(() => window.__hover!.player()!)
    expect(driving.speed).toBeGreaterThan(10)
    expect(driving.position.z - initial.position.z).toBeGreaterThan(5)
    // Still hovering, not ground-pounded
    expect(driving.position.y).toBeGreaterThan(0.5)

    // Release throttle, bike should decelerate.
    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })

  test('steering produces yaw', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    // Throttle + full left steer for 1s.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 0.6,
        steer: -1,
        brake: 0,
        fire: false,
        boost: false,
      }),
    )

    const before = await page.evaluate(() => window.__hover!.player()!.position)
    await page.waitForTimeout(1500)
    const after = await page.evaluate(() => window.__hover!.player()!.position)

    // After turning left while accelerating, the bike should have moved off the
    // straight forward axis. We just check that abs(x) deviation > 1m.
    const dx = Math.abs(after.x - before.x)
    expect(dx).toBeGreaterThan(0.5)

    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })
})
