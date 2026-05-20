import { expect, test } from '@playwright/test'

/**
 * Focused MK8 hop-drift verification on the `drift-test` map.
 *
 * The track is a flat oval (see `src/game/tracks/drift-test.ts`) with
 * a wide racing line and no obstacles — just the gates + a tarmac
 * plate so the drift state machine is the only variable.
 *
 * The harness drives the bike with `setIntentOverride`:
 *
 *   1. Spawn → throttle to drift floor speed (≥ 6 m/s).
 *   2. Press trickRight (`hold` it — drift activation needs the
 *      button held continuously through the airborne arc / settle).
 *   3. Continue holding trickRight + commit steer right.
 *   4. Watch `__hover.driftState()` per frame. Pass requires:
 *        - `active` flips true within ~2 s of the press
 *        - `chargeSec` crosses the tier-1 threshold (1.0 s)
 *        - `direction === +1` (matches the steer sign)
 *   5. Release the trick button. Pass requires:
 *        - `releaseSerial` increments
 *        - `lastReleaseTier >= 1`
 *        - `playerBoostEffect()` returns a non-null BoostEffect
 *          (the mini-turbo attached)
 *
 * The whole thing runs headlessly inside Playwright in ~6 s. If any
 * assertion fails the test dumps the per-frame drift-state trail so
 * the failure is diagnosable without re-running with logging.
 */

type DriftState = {
  active: boolean
  direction: number
  chargeSec: number
  armedButton: number
  lastReleaseTier: number
  releaseSerial: number
}

type Sample = {
  t: number
  state: DriftState
  speed: number
  isGrounded: boolean
  y: number
}

test('drift activates on the drift-test track + releases a mini-turbo', async ({ page }) => {
  test.setTimeout(60_000)

  // Surface uncaught browser errors so boot-time failures aren't
  // hidden behind a generic test timeout.
  // biome-ignore lint/suspicious/noConsole: e2e diagnostic
  page.on('pageerror', (e) => console.log(`[browser:error] ${e.message}`))

  await page.goto('/?autostart=1&track=drift-test')

  // Boot gate — wait for the harness to expose the debug API and
  // confirm the bike is grounded on the plate. drift-test spawn is at
  // y=2, hover height drops it to ~1.2 within a few ticks.
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 20_000,
  })
  // biome-ignore lint/suspicious/noConsole: e2e diagnostic
  console.log('boot complete; bike grounded')

  // Stage 1 — get up to drift-floor speed with a straight-line burn.
  // No steer yet; the drift activation gate requires |steer| ≥ 0.35.
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

  await page.waitForFunction(() => (window.__hover?.player()?.speed ?? 0) > 9, {
    timeout: 10_000,
  })

  // Stage 2 — press trickLeft + steer LEFT. The drift-test track is
  // an oval where the first corner (cp1, NE) requires a LEFT turn
  // from the starting heading (+X). Drifting right would pull the
  // bike off the racing line into the surrounding plate, which
  // tends to trip the speed-floor break after ~1 s. Left keeps the
  // bike sweeping around the corner so the drift can hold for the
  // full charge window.
  await page.evaluate(() =>
    window.__hover!.setIntentOverride({
      throttle: 1,
      steer: -0.9,
      brake: 0,
      fire: false,
      boost: false,
      pitch: 0,
      trickLeft: true,
      trickRight: false,
    }),
  )

  // Stage 3 — wait for drift to activate. waitForFunction polls
  // every animation frame on the page; cheaper + more reliable than
  // an in-page setTimeout loop inside page.evaluate (which can stall
  // under contention from the rAF physics loop).
  try {
    await page.waitForFunction(
      () => {
        const d = window.__hover?.driftState()
        return d?.active === true
      },
      { timeout: 8_000, polling: 'raf' },
    )
  } catch (err) {
    const snapshot = await page.evaluate(() => ({
      drift: window.__hover?.driftState(),
      player: window.__hover?.player(),
      intent: window.__hover?.intent(),
    }))
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(
      'drift never activated — snapshot:',
      JSON.stringify(snapshot, null, 2),
    )
    throw err
  }

  // Snapshot the drift right after activation so a later "no charge"
  // failure has context.
  const activationSnapshot = await page.evaluate(() => ({
    drift: window.__hover!.driftState(),
    player: window.__hover!.player(),
    intent: window.__hover!.intent(),
  }))
  // biome-ignore lint/suspicious/noConsole: e2e diagnostic
  console.log('drift activated:', JSON.stringify(activationSnapshot))

  expect(activationSnapshot.drift.direction, 'drift direction did not lock to -1 (left)').toBe(-1)

  // Wait for the drift charge to cross tier 1 (~1.0 s of sustain).
  // Sample via repeated page.evaluate round-trips with playwright
  // waitForTimeout — the page's own setTimeout has been observed to
  // starve under the rAF physics loop in this dev-mode harness, so
  // we drive the cadence from the test runner side instead.
  type Trail = { t: number; active: boolean; charge: number; dir: number; speed: number; grnd: boolean }
  const trail: Trail[] = []
  const trailStart = Date.now()
  for (let i = 0; i < 30; i++) {
    const sample = await page.evaluate(() => {
      const d = window.__hover!.driftState()
      const p = window.__hover!.player()!
      return {
        active: d.active,
        charge: d.chargeSec,
        dir: d.direction,
        speed: p.speed,
        grnd: p.isGrounded,
      }
    })
    trail.push({
      t: (Date.now() - trailStart) / 1000,
      active: sample.active,
      charge: sample.charge,
      dir: sample.dir,
      speed: sample.speed,
      grnd: sample.grnd,
    })
    if (sample.active && sample.charge >= 1.05) break
    await page.waitForTimeout(100)
  }

  const lastCharge = trail[trail.length - 1]?.charge ?? 0
  if (lastCharge < 1.0) {
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(
      'charge trail:',
      trail
        .map(
          (s) =>
            `t=${s.t.toFixed(2)} active=${s.active} dir=${s.dir} charge=${s.charge.toFixed(3)} speed=${s.speed.toFixed(1)} grnd=${s.grnd}`,
        )
        .join('\n'),
    )
  }

  expect(lastCharge, 'drift charge never reached tier-1').toBeGreaterThanOrEqual(1.0)

  // Quick stop-here verification of the direction lock as well —
  // the activation snapshot captures it once, the trail confirms it
  // never flipped mid-drift.
  const lastDir = trail[trail.length - 1]?.dir ?? 0
  expect(lastDir, 'drift direction flipped mid-charge').toBe(-1)

  // Capture the pre-release serial so we can confirm the release path
  // bumps it (not just any stale value).
  const preReleaseSerial = await page.evaluate(
    () => window.__hover!.driftState().releaseSerial,
  )

  // Stage 4 — release the trick button. The drift system fires the
  // mini-turbo on the release tick.
  await page.evaluate(() =>
    window.__hover!.setIntentOverride({
      throttle: 1,
      steer: -0.9,
      brake: 0,
      fire: false,
      boost: false,
      pitch: 0,
      trickLeft: false,
      trickRight: false,
    }),
  )

  // Stage 5 — wait for the release event to register on the serial
  // counter. Single sim tick suffices once the override flush lands.
  await page.waitForFunction(
    (prev: number) => (window.__hover?.driftState().releaseSerial ?? prev) !== prev,
    preReleaseSerial,
    { timeout: 4_000, polling: 'raf' },
  )
  const releaseResult = await page.evaluate(() => ({
    driftState: window.__hover!.driftState(),
    boostEffect: window.__hover!.playerBoostEffect(),
  }))

  expect(
    releaseResult.driftState.releaseSerial,
    'release serial never bumped',
  ).toBeGreaterThan(preReleaseSerial)
  expect(
    releaseResult.driftState.lastReleaseTier,
    'release tier was below tier-1',
  ).toBeGreaterThanOrEqual(1)
  expect(releaseResult.boostEffect, 'no BoostEffect attached after release').not.toBeNull()
  expect(
    releaseResult.boostEffect?.multiplier ?? 0,
    'mini-turbo multiplier below the tier-1 floor',
  ).toBeGreaterThanOrEqual(1.4)
  expect(
    releaseResult.boostEffect?.remaining ?? 0,
    'mini-turbo had no remaining duration',
  ).toBeGreaterThan(0)
})
