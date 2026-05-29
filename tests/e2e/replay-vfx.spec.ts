import { test as base, expect } from '@playwright/test'

// Sandbox ships chromium-1194 via /opt/pw-browsers/chromium; the
// Playwright version this PR uses wants chromium-1223. Override
// `executablePath` so the existing binary is used.
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture sig
  launchOptions: async ({}, use) => {
    await use({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  },
})

/**
 * Verifies the replay-mode VFX fix end-to-end.
 *
 * Synthesises a v2 replay file in-browser via an init script (runs
 * before any boot script), stashes it in sessionStorage, then loads
 * `?replay=session`. The boot path picks up the stashed payload and
 * runs replay-mode.ts → state-reconstructor → combat-replay-driver →
 * fxTick. We then read `window.__fx.stats()` and confirm every FX
 * particle pool touched by the fix lights up during playback. Before
 * this fix every pool stayed at 0 because the FX system's gates read
 * un-refreshed spawn-default ECS state.
 *
 * The synthetic replay drives:
 *  - bike 0 forward over water at 18 m/s with throttle=1 + boost=1
 *    (foam wake + exhaust + boost-blossom exhaust)
 *  - bike 1 alongside at tier-2 drift with pitch=-0.5 (drift sparks
 *    blue + orange, tuck slipstream)
 *  - one missile track in flight (missile trail)
 *  - one explosion burst (explosion pool)
 *
 * Bikes are parked off the lagoon terrain heightmap so the
 * reconstructor's `surfaceIsWater` branch engages and the foam gate
 * unblocks.
 */

const SAMPLE_RATE = 30
const DURATION_S = 4
// Far from any track terrain — `sampleTerrainHeightAtXZ` returns null
// outside the heightmap AABB, which routes the reconstructor through
// its "deep ocean" branch (`surfaceIsWater = true`).
const SYNTH_X0 = 5000
const SYNTH_X1 = 5003
const SYNTH_Z = 5000
const SYNTH_Y = 1.2 // nominal hover height above wave-field baseline

function synthesiseReplay(): string {
  const numFrames = SAMPLE_RATE * DURATION_S
  const frames: { t: number; bikes: number[] }[] = []
  for (let i = 0; i < numFrames; i++) {
    const t = i / SAMPLE_RATE
    const dz = t * 18
    frames.push({
      t,
      bikes: [
        // bike 0 — throttle + boost, no drift, no pitch
        SYNTH_X0,
        SYNTH_Y,
        SYNTH_Z + dz,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0,
        // bike 1 — tier-2 drift right + half tuck (negative pitch =
        // nose down = tuck per the Intent convention)
        SYNTH_X1,
        SYNTH_Y,
        SYNTH_Z + dz,
        0,
        0,
        0,
        1,
        -0.5,
        1,
        0,
        1,
        2,
      ],
    })
  }
  const missileSamples: number[] = []
  for (let i = 0; i <= 15; i++) {
    const t = 0.1 + i * 0.05
    missileSamples.push(t, SYNTH_X0 + 10, 1, SYNTH_Z + i * 2, 0, 0, 40)
  }
  return JSON.stringify({
    version: 2,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon',
      recordedAt: new Date().toISOString(),
      durationSeconds: DURATION_S,
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'Player',
        bodyColor: 0xff5577,
      },
      {
        slot: 1,
        isPlayer: false,
        variantId: 'racer',
        displayName: 'AI',
        bodyColor: 0x55aaff,
      },
    ],
    sampleRateHz: SAMPLE_RATE,
    frames,
    events: [],
    missiles: [
      {
        id: 0,
        spawnT: 0.1,
        endT: 0.85,
        detonated: true,
        detonatedAt: [SYNTH_X0 + 10, 1, SYNTH_Z + 30],
        samples: missileSamples,
      },
    ],
    explosions: [
      { t: 0.9, x: SYNTH_X0 + 10, y: 1, z: SYNTH_Z + 30, color: 0xff5577, lifetime: 0.6 },
    ],
    isLegacyV1: false,
  })
}

test.describe('replay VFX playback', () => {
  test.setTimeout(180_000)

  test('fxTick emits particles during synthetic v2 replay', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // Inject the synthetic replay before any boot script runs.
    const replayJson = synthesiseReplay()
    await page.addInitScript((json) => {
      try {
        sessionStorage.setItem('hover-replay-pending', json)
      } catch {
        // ignore
      }
    }, replayJson)

    await page.goto('/?replay=session', { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__hover?.ready === true, {
      timeout: 90_000,
    })

    // Let the replay loop spin up — the state reconstructor needs >1
    // frame to prime its prev-pose buffer, and FX emission accumulators
    // need a few frames to cross 1 particle. Under headless WebGPU the
    // replay clock advances at ~0.1× of wall time, so the sample loop
    // (below) keeps polling until the clock has crossed every event
    // we care about (explosion at 0.9s of replay time).
    await page.waitForTimeout(800)

    const samples: Array<{ clock: number; stats: Record<string, number> }> = []
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500)
      const sample = await page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: harness internals
        const fx: any = (window as any).__fx
        return {
          stats: fx?.stats ? (fx.stats() as Record<string, number>) : null,
        }
      })
      const replayTimeEl = await page
        .locator('#replay-time, .rb-time')
        .first()
        .textContent()
        .catch(() => null)
      const clock = replayTimeEl ? Number(replayTimeEl.replace('s', '')) : -1
      if (sample.stats) samples.push({ clock, stats: sample.stats })
      if (clock > 1.5) break
    }

    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log('FX stats across replay playback:')
    for (const s of samples) {
      // biome-ignore lint/suspicious/noConsole: diagnostic
      console.log(`  clk=${s.clock.toFixed(2)}s ${JSON.stringify(s.stats)}`)
    }

    await page
      .screenshot({ path: 'test-results/replay-vfx-evidence.png', fullPage: false })
      .catch(() => undefined)

    // Hard requirements — every emission category should have fired
    // at least once across the replay window. Before this fix every
    // value here stayed 0 because the FX gates evaluated against
    // un-refreshed spawn-default ECS state.
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.some((s) => (s.stats.foamAlive ?? 0) > 0)).toBe(true)
    expect(samples.some((s) => (s.stats.exhaustAlive ?? 0) > 0)).toBe(true)
    expect(samples.some((s) => (s.stats.tuckAlive ?? 0) > 0)).toBe(true)
    expect(samples.some((s) => (s.stats.missileTrailAlive ?? 0) > 0)).toBe(true)
    expect(samples.some((s) => (s.stats.explosionAlive ?? 0) > 0)).toBe(true)
    expect(samples.some((s) => (s.stats.driftBlueAlive ?? 0) > 0)).toBe(true)

    const replayErrors = consoleErrors.filter((e) =>
      /replay|combat-replay|state-reconstructor|fxTick/i.test(e),
    )
    expect(replayErrors).toEqual([])
  })
})
