import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

test.describe('M1 driving', () => {
  test('bike spawns, hovers, and accelerates forward under throttle', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/?autostart=1')
    // Wait for the bike to spawn and reach hover height (~1.2m).
    await waitFullyBooted(page, { timeout: 10_000 })

    const initial = await page.evaluate(() => window.__hover!.player()!)
    // Bike spawns on the right straight, over water; hovers ~1.2m above the
    // wave surface (which oscillates a bit, so allow a generous range).
    expect(initial.position.y).toBeGreaterThan(0.2)
    expect(initial.position.y).toBeLessThan(3)
    expect(initial.isGrounded).toBe(true)
    expect(initial.speed).toBeLessThan(2.5) // resting at spawn (waves jostle a little)

    // Drive forward for ~2 seconds.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
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
    // Still hovering, not ground-pounded (island top y=3, water y≈0)
    expect(driving.position.y).toBeGreaterThan(0)

    // Release throttle, bike should decelerate.
    await page.evaluate(() => window.__hover!.setIntentOverride(null))

    consoleErrors.assertNone()
  })

  test('steering produces yaw', async ({ page }) => {
    await page.goto('/?autostart=1')
    await waitFullyBooted(page, { timeout: 10_000 })

    // Throttle + full left steer for 1s.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 0.6,
        steer: -1,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
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
