import { expect, test } from '@playwright/test'

/**
 * Air-control feel probe (added 2026-05-07 with the hang-time pass).
 *
 * Drives the bike off the Lagoon Loop right-straight ramp three times,
 * each time switching to a different "test intent" the moment the bike
 * is clearly airborne. Compares trajectories:
 *
 *  - baseline: throttle=0 pitch=0 — gravity + hang-time only.
 *  - noseUp:   throttle=1 pitch=-1 (Q) — pitch-vectored thrust pushes UP.
 *  - noseDown: throttle=1 pitch=+1 (E) — pitch-vectored thrust pushes DOWN.
 *
 * Pass conditions:
 *  - All three scenarios actually go airborne (sanity check).
 *  - noseUp's average vy across the airborne window is GREATER (less
 *    negative / more positive) than baseline. Q + throttle should fight
 *    gravity, not aid it.
 *  - noseDown's average vy is LESS than baseline (E dives faster).
 *
 * Looking for the relative ordering, not absolute magnitudes — the
 * launch state has frame-to-frame jitter and the magnitudes shift with
 * tuning. As long as Q > baseline > E in vy, the sign convention is
 * correct.
 */
type Sample = {
  t: number
  y: number
  vy: number
  grounded: boolean
  fwdY: number
  intentPitch: number
}
type Scenario = {
  label: string
  launchY: number
  launchVy: number
  samples: Sample[]
}

async function runScenario(
  page: import('@playwright/test').Page,
  testIntent: {
    throttle: number
    steer: number
    brake: number
    fire: boolean
    boost: boolean
    pitch: number
  },
  label: string,
): Promise<Scenario> {
  return await page.evaluate(
    async ({ testIntent, label }) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // Reset to start.
      window.__hover!.setIntentOverride(null)
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace' }))
      await wait(50)
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace' }))
      await wait(400)
      // Drive forward to the ramp at full throttle, no pitch.
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
      })
      // Wait until clearly off the ramp (y > 3, !grounded).
      let launchY = 0
      let launchVy = 0
      let airborne = false
      for (let i = 0; i < 160; i++) {
        await wait(50)
        const p = window.__hover!.player()!
        if (!p.isGrounded && p.position.y > 3) {
          airborne = true
          launchY = p.position.y
          launchVy = p.velocity.y
          break
        }
      }
      if (!airborne) return { label, launchY: 0, launchVy: 0, samples: [] }
      // Switch to the test intent.
      window.__hover!.setIntentOverride(testIntent)
      const samples: {
        t: number
        y: number
        vy: number
        grounded: boolean
        fwdY: number
        intentPitch: number
      }[] = []
      const start = performance.now()
      for (let i = 0; i < 18; i++) {
        const p = window.__hover!.player()!
        const bikes = window.__hover!.bikes()
        const me = bikes.find((b) => b.eid === window.__hover!.playerEid())
        // Compute bike fwd.y from rotation quaternion: rotated +Z basis.
        // fwd.y = 2*(q.y*q.z - q.x*q.w). (Standard quat-rotation of (0,0,1).)
        let fwdY = 0
        let intentPitch = 0
        if (me) {
          const q = me.rot
          fwdY = 2 * (q.y * q.z - q.x * q.w)
          intentPitch = me.intent.pitch
        }
        samples.push({
          t: (performance.now() - start) / 1000,
          y: p.position.y,
          vy: p.velocity.y,
          grounded: p.isGrounded,
          fwdY,
          intentPitch,
        })
        await wait(60)
      }
      window.__hover!.setIntentOverride(null)
      return { label, launchY, launchVy, samples }
    },
    { testIntent, label },
  )
}

test('air control: pitch-vectored thrust + hang-time work as designed', async ({ page }) => {
  // Three scenarios × 3 trials each; bump default 30s timeout.
  test.setTimeout(120000)
  await page.goto('/')
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 10000,
  })

  // Effective vertical acceleration over the FIRST contiguous airborne
  // segment. Skips the very first sample (transitional — the test
  // intent had only just been applied so pitch hasn't ramped) and
  // stops at the first grounded sample so post-landing bounces don't
  // pollute the metric.
  function airborneAccel(s: Scenario): number {
    if (s.samples.length < 3) return Number.NaN
    let startIdx = -1
    for (let i = 1; i < s.samples.length; i++) {
      if (!s.samples[i]!.grounded) {
        startIdx = i
        break
      }
    }
    if (startIdx < 0) return Number.NaN
    let endIdx = startIdx
    for (let i = startIdx + 1; i < s.samples.length; i++) {
      if (s.samples[i]!.grounded) break
      endIdx = i
    }
    if (endIdx === startIdx) return Number.NaN
    const start = s.samples[startIdx]!
    const last = s.samples[endIdx]!
    const dt = last.t - start.t
    if (dt <= 0) return Number.NaN
    return (last.vy - start.vy) / dt
  }

  function median(xs: number[]): number {
    const valid = xs
      .filter((x) => Number.isFinite(x))
      .slice()
      .sort((a, b) => a - b)
    if (valid.length === 0) return Number.NaN
    return valid[Math.floor(valid.length / 2)]!
  }

  // Run each scenario 3× to average out launch-state noise.
  const TRIALS = 3
  const baseAccs: number[] = []
  const upAccs: number[] = []
  const downAccs: number[] = []
  const downSampleDumps: string[] = []
  for (let i = 0; i < TRIALS; i++) {
    const baseline = await runScenario(
      page,
      { throttle: 0, steer: 0, brake: 0, fire: false, boost: false, pitch: 0 },
      'baseline',
    )
    const noseUp = await runScenario(
      page,
      { throttle: 1, steer: 0, brake: 0, fire: false, boost: false, pitch: -1 },
      'noseUp_Q',
    )
    const noseDown = await runScenario(
      page,
      { throttle: 1, steer: 0, brake: 0, fire: false, boost: false, pitch: +1 },
      'noseDown_E',
    )
    baseAccs.push(airborneAccel(baseline))
    upAccs.push(airborneAccel(noseUp))
    downAccs.push(airborneAccel(noseDown))
    // Detailed dump of E samples — to debug when E doesn't dive.
    downSampleDumps.push(
      `\n  TRIAL ${i + 1} E samples (launchVy=${noseDown.launchVy.toFixed(2)}):\n` +
        noseDown.samples
          .map(
            (s) =>
              `    t=${s.t.toFixed(2)} y=${s.y.toFixed(2)} vy=${s.vy.toFixed(2)} grd=${s.grounded ? 'T' : 'F'} fwdY=${s.fwdY.toFixed(3)} pitch=${s.intentPitch.toFixed(2)}`,
          )
          .join('\n'),
    )
  }

  const baseA = median(baseAccs)
  const upA = median(upAccs)
  const downA = median(downAccs)

  // biome-ignore lint/suspicious/noConsole: diagnostic
  console.log(
    `\nair control summary (median of ${TRIALS} trials, vertical acceleration m/s²):\n  baseline   (thr0 pitch0):  trials=[${baseAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${baseA.toFixed(2)}\n  noseUp Q   (thr1 pitch-1): trials=[${upAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${upA.toFixed(2)}\n  noseDown E (thr1 pitch+1): trials=[${downAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${downA.toFixed(2)}` +
      downSampleDumps.join('\n'),
  )

  // Hang-time sanity: with 40% gravity counter the air-accel should be
  // softer than raw gravity (-25). We're targeting around -15.
  expect(baseA, 'baseline air-accel should be softer than raw gravity').toBeGreaterThan(-22)

  // Q (nose up + throttle) should fight gravity — accel strictly
  // higher (less negative) than baseline.
  expect(upA, 'Q (nose up + throttle) should fight gravity vs baseline').toBeGreaterThan(baseA + 1)

  // E (nose down + throttle) should dive — accel strictly more negative
  // than baseline.
  expect(downA, 'E (nose down + throttle) should add to gravity vs baseline').toBeLessThan(
    baseA - 1,
  )
})
