import { expect, test } from '@playwright/test'

/**
 * Air-control feel probe (added 2026-05-07 with the hang-time pass;
 * launch + measurement hardened 2026-06-09 — see docs/status.md).
 *
 * Drives the bike off the Lagoon Loop right-straight ramp three times,
 * each time switching to a different "test intent" the moment the bike
 * is clearly airborne. Compares trajectories:
 *
 *  - baseline: throttle=0 pitch=0 — gravity + hang-time only.
 *  - dive_Q:   throttle=1 pitch=-1 (Q, nose visibly down) — thrust along
 *              fwd pushes the bike DOWN.
 *  - lift_E:   throttle=1 pitch=+1 (E, nose visibly up) — thrust along
 *              fwd pushes the bike UP.
 *
 * Pass conditions:
 *  - All three scenarios actually go airborne (sanity check).
 *  - lift_E's vertical acceleration across the airborne window is
 *    GREATER (less negative) than baseline — E fights gravity.
 *  - dive_Q's is never SOFTER than baseline beyond measurement noise,
 *    and sits well below lift_E.
 *
 * Looking for the relative ordering, not absolute magnitudes. Note the
 * dive side is deliberately a SOFT bound vs baseline: the shipped
 * dive-then-level model (cf11928 + the 12° dive ceiling, 6bd1276)
 * bounds the airborne nose-down attitude near the local surface
 * tangent, and at top speed thrust is drag-cancelled — so Q's NET
 * vertical acceleration is designed to sit near baseline (the kick is
 * an attitude authority, not a downward thruster). The kick itself +
 * the clamp's orientation are pinned deterministically in
 * tests/unit/hover-dive-clamp.test.ts; this spec pins the integration
 * ordering E > baseline ≳ Q and the E-vs-Q separation.
 *
 * Robustness notes (each guards a failure mode seen in real traces):
 *  - ?tt=1 — no AI field. AI traffic on the start straight wiped out
 *    1-in-3 ramp approaches.
 *  - Steer-held approach. The ramp face is only x∈[47,53]; wave drift
 *    alone is enough to miss it. The steer sign is calibrated at boot.
 *  - Launch gate requires a RISING bike (vy > 0.5): detection on the
 *    falling side of the arc (or on a ramp-lip bounce) makes the accel
 *    sample a pre-bounce fragment under the wrong intent state.
 *  - Each scenario retries its approach (fresh wave phase) until a
 *    valid airborne measurement lands, instead of forfeiting the trial.
 *  - All windows + the accel dt are measured on the SIM clock
 *    (race().raceTime, fixedDt per tick). Wall-clock dt shrinks the
 *    measured accel by the sim-dilation factor under CPU load (the rAF
 *    dt clamp is 1/15s) — that was the "margins shrink under load"
 *    flake.
 */
type Sample = {
  r: number
  y: number
  vy: number
  grounded: boolean
  fwdY: number
  intentPitch: number
}
type Scenario = {
  label: string
  attempts: number
  launchY: number
  launchVy: number
  samples: Sample[]
}

const MAX_ATTEMPTS = 5

async function runScenario(
  page: import('@playwright/test').Page,
  testIntent: {
    throttle: number
    steer: number
    brake: number
    fire: boolean
    boost: boolean
    pitch: number
    trickLeft: boolean
    trickRight: boolean
  },
  label: string,
  steerPlusXSign: number,
): Promise<Scenario> {
  return await page.evaluate(
    async ({ testIntent, label, steerPlusXSign, MAX_ATTEMPTS }) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const driveIntent = (steer: number) => ({
        throttle: 1,
        steer,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
      })
      type Sample = {
        r: number
        y: number
        vy: number
        grounded: boolean
        fwdY: number
        intentPitch: number
      }
      const samples: Sample[] = []
      let launchY = 0
      let launchVy = 0
      let attempts = 0
      for (let a = 0; a < MAX_ATTEMPTS; a++) {
        attempts = a + 1
        samples.length = 0
        // Reset to the start pose.
        window.__hover!.setIntentOverride(null)
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace' }))
        await wait(50)
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace' }))
        await wait(400)
        // Phase stagger: the solo sim is deterministic and the attempt
        // cadence is near-constant, so without this, consecutive retries
        // replay the same wave phase at the ramp — a bad phase stays bad
        // for all of them. The growing offset walks each retry to a
        // different point of the swell cycle.
        await wait(a * 650)
        window.__hover!.setIntentOverride(driveIntent(0))
        const r0 = window.__hover!.race()?.raceTime ?? 0
        // Approach: full throttle, steer-held onto the ramp center line
        // (x=50) while grounded short of the ramp (z<24); the launch
        // itself is always steer-neutral. Budget 12 sim seconds.
        let airborne = false
        for (let i = 0; i < 400; i++) {
          await wait(50)
          const p = window.__hover!.player()!
          const r = window.__hover!.race()?.raceTime ?? 0
          // Launch gate: airborne, not yet falling hard, above
          // wave-crest reach, and inside the ramp band (the ramp spans
          // z=25..37; full-throttle riding also hops off wave CRESTS to
          // y≈3-4, so without the z-band a pre-ramp crest hop
          // false-triggers detection). vy > -1 admits weak launches
          // detected just past apex: while still OVER the ramp slab the
          // hover probe reads grounded (the slab sits within the
          // grounded cutoff), so airborne is only observable after the
          // far edge — late in a weak launch's arc. Late-fall and
          // bounce detects are rejected by the airborne-segment
          // validity below instead.
          if (
            !p.isGrounded &&
            p.position.y > 2.5 &&
            p.velocity.y > -1 &&
            p.position.z > 22 &&
            p.position.z < 45
          ) {
            airborne = true
            launchY = p.position.y
            launchVy = p.velocity.y
            break
          }
          if (r - r0 > 12) break
          if (p.isGrounded && p.position.z < 24) {
            const err = 50 - p.position.x
            const steer = Math.max(
              -0.25,
              Math.min(0.25, (0.1 * err - 0.05 * p.velocity.x) * steerPlusXSign),
            )
            window.__hover!.setIntentOverride(driveIntent(steer))
          } else {
            window.__hover!.setIntentOverride(driveIntent(0))
          }
        }
        if (!airborne) continue
        // Switch to the test intent and sample the flight on the sim
        // clock: at least 18 samples, then keep going until touchdown or
        // 2.0 sim seconds, so slow wall clocks still cover the full arc.
        window.__hover!.setIntentOverride(testIntent)
        const rFlight0 = window.__hover!.race()?.raceTime ?? 0
        for (let i = 0; i < 60; i++) {
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
          const r = window.__hover!.race()?.raceTime ?? 0
          samples.push({
            r,
            y: p.position.y,
            vy: p.velocity.y,
            grounded: p.isGrounded,
            fwdY,
            intentPitch,
          })
          if (i >= 17 && (p.isGrounded || r - rFlight0 > 2)) break
          await wait(60)
        }
        window.__hover!.setIntentOverride(null)
        // Validity: the first contiguous airborne segment must be long
        // enough to measure, or the launch was a graze/bounce/late-apex
        // fragment — retry with a fresh wave phase. lift_E needs a
        // longer bar: its pitch-up takes ~1.2s to ramp, and a genuinely
        // lifting arc always hangs that long (E extends air time), so a
        // shorter arc means the measurement would mostly see pre-ramp
        // freefall and read baseline-ish.
        const minAirS = label === 'lift_E' ? 1.0 : 0.55
        let startIdx = -1
        for (let i = 1; i < samples.length; i++) {
          if (!samples[i]!.grounded) {
            startIdx = i
            break
          }
        }
        if (startIdx >= 0) {
          let endIdx = startIdx
          for (let i = startIdx + 1; i < samples.length; i++) {
            if (samples[i]!.grounded) break
            endIdx = i
          }
          if (samples[endIdx]!.r - samples[startIdx]!.r >= minAirS) {
            return { label, attempts, launchY, launchVy, samples: samples.slice() }
          }
        }
      }
      window.__hover!.setIntentOverride(null)
      return { label, attempts, launchY: 0, launchVy: 0, samples: [] }
    },
    { testIntent, label, steerPlusXSign, MAX_ATTEMPTS },
  )
}

test('air control: pitch-vectored thrust + hang-time work as designed', async ({ page }) => {
  // Three scenarios × 3 trials each, with per-scenario approach retries.
  test.setTimeout(420_000)
  await page.goto('/?autostart=1&tt=1')
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 10_000,
  })

  // Steer-sign calibration — hold steer=+0.5 with some throttle from the
  // spawn pose (facing +Z) and observe the x drift. The approach
  // controller multiplies by this sign so a steer-convention re-tune
  // can't silently break the ramp line-hold.
  const steerPlusXSign = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const x0 = window.__hover!.player()!.position.x
    window.__hover!.setIntentOverride({
      throttle: 0.7,
      steer: 0.5,
      brake: 0,
      fire: false,
      boost: false,
      pitch: 0,
      trickLeft: false,
      trickRight: false,
    })
    const r0 = window.__hover!.race()?.raceTime ?? 0
    for (let i = 0; i < 200; i++) {
      await wait(50)
      if ((window.__hover!.race()?.raceTime ?? 0) - r0 > 1.5) break
    }
    const dx = window.__hover!.player()!.position.x - x0
    window.__hover!.setIntentOverride(null)
    return dx >= 0 ? 1 : -1
  })

  // Effective vertical acceleration over the FIRST contiguous airborne
  // segment, on the SIM clock. Skips the very first sample (transitional
  // — the test intent had only just been applied so pitch hasn't ramped)
  // and stops at the first grounded sample so post-landing bounces don't
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
    const dt = last.r - start.r
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
  const diveAccs: number[] = []
  const liftAccs: number[] = []
  const diveSampleDumps: string[] = []
  for (let i = 0; i < TRIALS; i++) {
    const baseline = await runScenario(
      page,
      {
        throttle: 0,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
      },
      'baseline',
      steerPlusXSign,
    )
    const dive = await runScenario(
      page,
      {
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: -1,
        trickLeft: false,
        trickRight: false,
      },
      'dive_Q',
      steerPlusXSign,
    )
    const lift = await runScenario(
      page,
      {
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: +1,
        trickLeft: false,
        trickRight: false,
      },
      'lift_E',
      steerPlusXSign,
    )
    expect(
      baseline.samples.length,
      `baseline trial ${i + 1} must launch within ${MAX_ATTEMPTS} approach attempts`,
    ).toBeGreaterThan(0)
    expect(
      dive.samples.length,
      `dive trial ${i + 1} must launch within ${MAX_ATTEMPTS} approach attempts`,
    ).toBeGreaterThan(0)
    expect(
      lift.samples.length,
      `lift trial ${i + 1} must launch within ${MAX_ATTEMPTS} approach attempts`,
    ).toBeGreaterThan(0)
    baseAccs.push(airborneAccel(baseline))
    diveAccs.push(airborneAccel(dive))
    liftAccs.push(airborneAccel(lift))
    // Detailed dump of dive samples — to debug when Q doesn't dive.
    diveSampleDumps.push(
      `\n  TRIAL ${i + 1} Q (dive) samples (attempts=${dive.attempts} launchVy=${dive.launchVy.toFixed(2)}):\n` +
        dive.samples
          .map(
            (s) =>
              `    r=${s.r.toFixed(2)} y=${s.y.toFixed(2)} vy=${s.vy.toFixed(2)} grd=${s.grounded ? 'T' : 'F'} fwdY=${s.fwdY.toFixed(3)} pitch=${s.intentPitch.toFixed(2)}`,
          )
          .join('\n'),
    )
  }

  const baseA = median(baseAccs)
  const diveA = median(diveAccs)
  const liftA = median(liftAccs)

  // biome-ignore lint/suspicious/noConsole: diagnostic
  console.log(
    `\nair control summary (median of ${TRIALS} trials, vertical acceleration m/s², sim clock):\n  baseline (thr0 pitch0):  trials=[${baseAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${baseA.toFixed(2)}\n  dive_Q   (thr1 pitch-1): trials=[${diveAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${diveA.toFixed(2)}\n  lift_E   (thr1 pitch+1): trials=[${liftAccs.map((v) => v.toFixed(2)).join(', ')}]  median=${liftA.toFixed(2)}` +
      diveSampleDumps.join('\n'),
  )

  // Hang-time sanity: with 60% gravity counter the air-accel should be
  // softer than raw gravity (-25). We're targeting around -10.
  expect(baseA, 'baseline air-accel should be softer than raw gravity').toBeGreaterThan(-22)

  // E (nose visibly up + throttle) should LIFT — accel strictly higher
  // (less negative) than baseline.
  expect(liftA, 'E (nose up + throttle) should fight gravity vs baseline').toBeGreaterThan(
    baseA + 1,
  )

  // Q (nose down + throttle): the 12° dive ceiling bounds the attitude
  // near the surface tangent, so Q's net vertical accel rides close to
  // baseline by design (see header). Pin the sign — Q must never read
  // SOFTER than baseline beyond noise (a pitch-sign flip would send it
  // to lift territory)…
  expect(diveA, 'Q (nose down + throttle) must not soften vs baseline').toBeLessThan(baseA + 0.75)
  // …and must stay well separated from E.
  expect(diveA, 'Q and E must stay separated (pitch vector authority)').toBeLessThan(liftA - 1.5)
})
