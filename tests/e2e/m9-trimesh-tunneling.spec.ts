import { expect, test } from '@playwright/test'

/**
 * Trimesh-collision tunneling regression test.
 *
 * Background (status.md, M9.27): Rapier 0.19's discrete broadphase
 * doesn't reliably catch a fast-falling capsule on a thin trimesh
 * surface — the bike tunnels through. Two fixes layered in this
 * branch:
 *
 *   1. `setCcdEnabled(true)` on the bike rigid body — Rapier's
 *      Continuous Collision Detection runs a swept-shape check per
 *      step that catches fast-moving bodies.
 *   2. Spec-driven track surfaces are now slab-extruded (1m thick by
 *      default) instead of 0-thickness planes — gives the trimesh
 *      enough geometry to catch the bike on any approach.
 *
 * This test loads `?track=test-ring` (a 60×60 spec-driven slab with a
 * 4-gate ring) and stress-drives the bike around with autoplay. We
 * assert the bike never falls below the slab's bottom face — y < -2
 * is the tunneling signal (slab top at y=0, bottom at y=-1 with the
 * default 1m thickness).
 *
 * Drives ~10s of game time; the player at autoplay reaches 17+ m/s
 * which is well above the tunneling threshold (~0.5m per fixed step).
 */
test.describe('M9.27 trimesh + CCD — no tunneling', () => {
  test('bike stays on the slab during a full autoplay lap on test-ring', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/?track=test-ring')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 15_000,
    })

    // Capture the slab-top reference: spec-driven test-ring uses the
    // default 1m thickness, so the bottom face sits at y=-1. Anything
    // below y=-2 means the bike has fallen through and is sinking
    // toward the safety floor.
    const TUNNEL_Y = -2

    // Engage autoplay so the AI controller drives the player around
    // the ring at full throttle.
    await page.evaluate(() => window.__hover!.toggleAutoPlay())

    // Sample once per ~200ms over 10s. Track the lowest y observed.
    let minY = Number.POSITIVE_INFINITY
    let maxSpeed = 0
    let tunneled = false
    for (let i = 0; i < 50; i++) {
      const sample = await page.evaluate(() => {
        const p = window.__hover!.player()
        return p ? { y: p.position.y, speed: p.speed } : null
      })
      if (!sample) continue
      minY = Math.min(minY, sample.y)
      maxSpeed = Math.max(maxSpeed, sample.speed)
      if (sample.y < TUNNEL_Y) {
        tunneled = true
        break
      }
      await page.waitForTimeout(200)
    }

    expect(tunneled, `bike fell below y=${TUNNEL_Y} (minY=${minY.toFixed(2)}, maxSpeed=${maxSpeed.toFixed(1)})`).toBe(false)
    // Sanity: the AI did get the bike moving; the test isn't accidentally
    // passing because the bike sat still.
    expect(maxSpeed).toBeGreaterThan(8)
  })
})
