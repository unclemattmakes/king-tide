import { expect, test } from '@playwright/test'

/**
 * Cliffside is the second track. Same stadium gate layout as Lagoon Loop,
 * but the top half of the loop sits 15m up on a mesa. The right straight
 * is a long ramp climbing to the rim; the left straight starts at the
 * cliff edge with a sheer drop into the water below — the JetMoto
 * signature moment.
 *
 * Tests here cover both transitions:
 *   1. ramp climb works (bike actually reaches mesa altitude)
 *   2. cliff drop works (bike launches, becomes airborne, lands cleanly
 *      on the water below)
 *
 * Switching tracks is via the `?track=cliffside` URL param so existing
 * Lagoon Loop e2e tests are unaffected.
 */
test.describe('M9 Cliffside', () => {
  // WebKit on Linux uses software WebGL (WebKitGTK has no real GPU passthrough
  // in Playwright); the heavy mesa geometry + water makes this suite unreliable.
  // Run on macOS WebKit for real coverage.
  test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
    'WebKit-Linux uses software WebGL; this GPU-heavy suite is unreliable. Run on macOS for WebKit coverage.',
  )

  test('right-straight climb reaches the mesa', async ({ page }) => {
    await page.goto('/?track=cliffside')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

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

    // Drive forward until the bike has climbed past 12m of altitude (mesa
    // top is 15m, hover height ≈ 1.2 above that).
    await page.waitForFunction(() => (window.__hover?.player()?.position.y ?? 0) > 12, {
      timeout: 15000,
    })

    const onMesa = await page.evaluate(() => window.__hover!.player())
    expect(onMesa!.position.y).toBeGreaterThan(12)
    // Should be near the top of the right-straight climb (z ~50, x = 50).
    expect(onMesa!.position.z).toBeGreaterThan(35)
    expect(Math.abs(onMesa!.position.x - 50)).toBeLessThan(8)
    expect(onMesa!.isGrounded).toBe(true)
  })

  test('left-straight cliff drop launches the bike onto water', async ({ page }) => {
    test.setTimeout(60_000) // wait-for-cliff-drop alone is up to 45s under parallel CPU load
    await page.goto('/?track=cliffside')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    // Teleport the bike onto the mesa near the cliff edge so we don't have
    // to drive a full lap to test the drop. setBikeHeldPickup → ramp test
    // → wait would be slow and racy; bypass by setRotation/setLinvel are
    // not exposed, so we rely on driving up. Instead, just hand-pick a
    // segment of an autoplay run that crosses the drop.
    await page.evaluate(() => window.__hover!.toggleAutoPlay())

    // Watch for: bike is airborne (isGrounded false), high-ish y, on the
    // west side of the track (x < -30). That's the cliff-drop transition.
    await page.waitForFunction(
      () => {
        const p = window.__hover?.player()
        if (!p) return false
        return !p.isGrounded && p.position.x < -30 && p.position.y > 4
      },
      { timeout: 45000 },
    )

    // Sample for a couple seconds to confirm the bike comes back down to
    // water hover and stays alive.
    let landedSafely = false
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(150)
      const p = await page.evaluate(() => window.__hover!.player()!)
      // Touched water (low y) AND grounded — i.e., back on the wave
      // surface, not stuck airborne or under the safety floor.
      if (p.position.y < 3 && p.isGrounded) {
        landedSafely = true
        break
      }
    }
    expect(landedSafely, 'bike never landed cleanly after the cliff drop').toBe(true)
  })
})
