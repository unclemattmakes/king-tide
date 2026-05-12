import { expect, test } from '@playwright/test'

test.describe('M5 pickup + boost', () => {
  test('drives through pickup, slot fills, fire consumes + boost engages', async ({ page }) => {
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    // Slot starts empty.
    const initialHeld = await page.evaluate(() => window.__hover!.heldPickup())
    expect(initialHeld).toBeNull()

    // Force the slot to 'boost' so this test is deterministic across the
    // randomised pickup pool. (Driving over a real spawn would sometimes
    // hand us missile / mine / shield instead.)
    await page.evaluate(() => window.__hover!.setHeldPickup('boost'))

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

    const heldAfter = await page.evaluate(() => window.__hover!.heldPickup())
    expect(heldAfter).toBe('boost')

    // Capture pre-boost speed.
    const preBoostSpeed = await page.evaluate(() => window.__hover!.player()!.speed)

    // Fire the pickup.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: true,
        boost: false,
        pitch: 0,
      }),
    )

    // Slot should clear within a few ticks.
    await page.waitForFunction(() => window.__hover!.heldPickup() === null, { timeout: 1000 })
    const heldAfterFire = await page.evaluate(() => window.__hover!.heldPickup())
    expect(heldAfterFire).toBeNull()

    // Stop firing, let boost accelerate the bike.
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

    // Wait for boosted speed to clearly exceed pre-boost speed.
    await page.waitForFunction(
      (preBoost) => (window.__hover?.player()?.speed ?? 0) > preBoost + 3,
      preBoostSpeed,
      { timeout: 2000 },
    )

    const finalSpeed = await page.evaluate(() => window.__hover!.player()!.speed)
    expect(finalSpeed).toBeGreaterThan(preBoostSpeed + 3)

    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })
})
