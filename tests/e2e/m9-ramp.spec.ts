import { expect, test } from '@playwright/test'

/**
 * Verify the ramp on the right straight actually launches the bike. Drive
 * forward at full throttle from spawn and watch position.y + velocity.y +
 * isGrounded over time. Pass conditions:
 *   - bike's y exceeds 3m at some point (top of ramp + air time)
 *   - bike's vertical velocity goes positive (rising) on the way up
 *   - bike returns to a low y (back on water hover height) by end of run
 *   - isGrounded transitions false at least once (airborne moment)
 *
 * This exercises raycast hover vs a static collider, surface alignment
 * on a non-(0,1,0) normal, the hover spring releasing on launch, and
 * re-acquisition of water on landing.
 */
test('bike launches off the ramp on the right straight', async ({ page }) => {
  await page.goto('/?autostart=1')
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

  type Sample = {
    t: number
    z: number
    y: number
    vy: number
    grounded: boolean
  }
  const samples: Sample[] = []
  const start = Date.now()
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(150)
    const s = await page.evaluate(() => {
      const p = window.__hover!.player()!
      return {
        z: p.position.z,
        y: p.position.y,
        vy: p.velocity.y,
        grounded: p.isGrounded,
      }
    })
    samples.push({ t: (Date.now() - start) / 1000, ...s })
  }

  const yMax = Math.max(...samples.map((s) => s.y))
  const vyMax = Math.max(...samples.map((s) => s.vy))
  const wentAirborne = samples.some((s) => !s.grounded)
  const reachedFarField = samples.some((s) => s.z > 50)
  // After we've passed the ramp's landing zone (z > 55), did we settle
  // back to a normal hover height?
  const postRamp = samples.filter((s) => s.z > 55)
  const settledLow = postRamp.some((s) => s.y < 2.5)

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
