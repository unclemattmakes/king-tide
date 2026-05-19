import { expect, test } from '@playwright/test'

/**
 * Verify the ramp on the right straight actually launches the bike. Drive
 * forward at full throttle from spawn and watch position.y + velocity.y +
 * isGrounded over time. Pass conditions:
 *   - bike's y exceeds 2.8m at some point (top of ramp + air time)
 *   - bike's vertical velocity goes positive (rising) on the way up
 *   - bike returns to a low y *while grounded* (back on water hover) by
 *     end of run
 *   - isGrounded transitions false at least once (airborne moment)
 *
 * This exercises raycast hover vs a static collider, surface alignment
 * on a non-(0,1,0) normal, the hover spring releasing on launch, and
 * re-acquisition of water on landing.
 *
 * Timing model: previously this loop sampled at a fixed 35×150ms cadence
 * from spawn. Under CPU contention or cold-start shader compile, the bike
 * sometimes failed to clear the ramp inside that 5.25s window, producing
 * a 1-in-N flake. The loop is now event-driven — we wait for the bike to
 * approach the ramp, sample while it traverses + settles, and exit early
 * once the settle condition is met. Per-phase timeouts replace the
 * implicit one.
 */
test('bike launches off the ramp on the right straight', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/?autostart=1')
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 15_000,
  })

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

  // Wait for the bike to roll into the ramp's near edge (z=25, the -Z
  // edge of the cuboid in src/game/entities/ramp.ts). Decouples sampling
  // from how long the approach takes under variable CPU load.
  await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 22, {
    timeout: 20_000,
  })

  // Sample the trajectory in-page (one round-trip instead of N) until the
  // bike has both cleared the landing zone and re-acquired hover height,
  // or a hard ~12s sample budget runs out. In-page lets the rAF loop tick
  // freely between samples instead of paying a Playwright round-trip per
  // 150ms.
  type Sample = {
    t: number
    z: number
    y: number
    vy: number
    grounded: boolean
  }
  const samples: Sample[] = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const out: {
      t: number
      z: number
      y: number
      vy: number
      grounded: boolean
    }[] = []
    const start = performance.now()
    // 120 × 100ms = 12s budget. Worst-case approach→launch→settle on a
    // warm dev server is well under 8s.
    for (let i = 0; i < 120; i++) {
      const p = window.__hover!.player()!
      const s = {
        t: (performance.now() - start) / 1000,
        z: p.position.z,
        y: p.position.y,
        vy: p.velocity.y,
        grounded: p.isGrounded,
      }
      out.push(s)
      // Exit as soon as we've seen the post-ramp settle. One extra sample
      // before bailing so the trajectory dump shows it.
      if (s.z > 55 && s.grounded && s.y < 2.5) {
        await wait(80)
        const p2 = window.__hover!.player()!
        out.push({
          t: (performance.now() - start) / 1000,
          z: p2.position.z,
          y: p2.position.y,
          vy: p2.velocity.y,
          grounded: p2.isGrounded,
        })
        break
      }
      await wait(100)
    }
    return out
  })

  const yMax = Math.max(...samples.map((s) => s.y))
  const vyMax = Math.max(...samples.map((s) => s.vy))
  const wentAirborne = samples.some((s) => !s.grounded)
  const reachedFarField = samples.some((s) => s.z > 50)
  // After we've passed the ramp's landing zone (z > 55), did we settle
  // back to a normal hover height? Requires grounded — a transient
  // bounce that dips low without re-acquiring the water surface doesn't
  // count.
  const postRamp = samples.filter((s) => s.z > 55)
  const settledLow = postRamp.some((s) => s.grounded && s.y < 2.5)

  // biome-ignore lint/suspicious/noConsole: diagnostic
  console.log(
    'ramp trajectory:',
    samples
      .map(
        (s) =>
          `t=${s.t.toFixed(1)} z=${s.z.toFixed(1)} y=${s.y.toFixed(2)} vy=${s.vy.toFixed(2)} grounded=${s.grounded}`,
      )
      .join('\n'),
  )

  expect(reachedFarField, 'bike never made it past the ramp landing zone').toBe(true)
  expect(yMax, 'bike never climbed the ramp').toBeGreaterThan(2.8)
  expect(vyMax, 'bike never had upward vertical velocity').toBeGreaterThan(2)
  expect(wentAirborne, 'bike never left the ramp surface').toBe(true)
  expect(settledLow, 'bike never returned to normal hover height after the jump').toBe(true)
})
