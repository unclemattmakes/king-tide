import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'
import { skipWebKitLinux } from './helpers/platform-skips'

// The GPU water shader added in M9.25 has a per-fragment foam loop that
// hammers SwiftShader (the WebGL2 software fallback used by headless
// Chromium). On real hardware with a GPU it runs at full speed; in
// headless Playwright the sim ends up running ~5× slower than wall-clock
// because rendering is a few FPS. The conditions these tests assert are
// still real (bike rides waves, doesn't sink) — sampling windows are
// therefore measured on the SIM clock (race().raceTime advances by
// fixedDt per sim tick), so the same sim span is covered regardless of
// how slowly wall time delivers it.
test.describe('M2 water', () => {
  skipWebKitLinux(test)

  test('bike drives onto open water and rides waves', async ({ page, consoleErrors }) => {
    test.setTimeout(120_000)
    // Time-trial mode: same track, no AI field. The assertion is about
    // the player bike riding the wave surface; AI traffic and wakes only
    // add per-run variance (collisions on the straight were a major
    // flake source — see docs/status.md).
    await page.goto('/?autostart=1&tt=1')
    await waitFullyBooted(page, { timeout: 15_000 })

    const data = await page.evaluate(async () => {
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
      // The right straight is open water, but the jump ramp sits on the
      // racing line at x∈[47,53], z∈[25,37] (see game/entities/ramp.ts).
      // Hold a line at x=58 — inside the corridor, clear of the ramp —
      // so the bike rides pure wave surface at full throttle instead of
      // rolling a launch/face-plant/stall lottery on the ramp lip.
      const TARGET_X = 58
      // Steer-sign calibration: hold steer=+0.5 from the spawn pose and
      // see which way x moves. Keeps the line-hold immune to steer-sign
      // re-tunes (sign conventions here have flipped before).
      const x0 = window.__hover!.player()!.position.x
      window.__hover!.setIntentOverride({ ...driveIntent(0.5), throttle: 0.7 })
      const rCal0 = window.__hover!.race()?.raceTime ?? 0
      for (let i = 0; i < 200; i++) {
        await wait(50)
        if ((window.__hover!.race()?.raceTime ?? 0) - rCal0 > 1.5) break
      }
      const steerPlusXSign = window.__hover!.player()!.position.x - x0 >= 0 ? 1 : -1
      // Reset to the start pose, then drive the held line. (The
      // player-facing respawn key snaps to the nearest racing-line
      // point now — specs use the deterministic to-start debug hook.)
      window.__hover!.setIntentOverride(null)
      window.__hover!.respawnToStart()
      await wait(400)
      window.__hover!.setIntentOverride(driveIntent(0))

      const sample = () => {
        const p = window.__hover!.player()!
        return {
          r: window.__hover!.race()?.raceTime ?? -1,
          x: p.position.x,
          y: p.position.y,
          z: p.position.z,
          g: p.isGrounded,
          speed: p.speed,
        }
      }
      // Two-phase drive. Phase A makes the 8m lateral move from the
      // spawn line (x=50) at LOW throttle — at ~10m/s the step settles
      // without overshoot; a full-speed P-controller step weaved ±14m
      // and swung across the ramp. Phase B holds the line at full
      // throttle with gentle, grounded-only corrections: at racing speed
      // the bike launches off crests, steering in air has no authority
      // and integrating error there winds the controller up.
      const steerTick = (phaseA: boolean) => {
        const p = window.__hover!.player()!
        const err = TARGET_X - p.position.x
        const steer = p.isGrounded
          ? Math.max(-0.3, Math.min(0.3, (0.12 * err - 0.1 * p.velocity.x) * steerPlusXSign))
          : 0
        window.__hover!.setIntentOverride({
          ...driveIntent(steer),
          throttle: phaseA ? 0.45 : 1,
        })
      }
      // Phase A until the bike is near the target line (or 4 sim s cap).
      const rA0 = window.__hover!.race()?.raceTime ?? 0
      while (true) {
        const p = window.__hover!.player()!
        const r = window.__hover!.race()?.raceTime ?? 0
        if (Math.abs(TARGET_X - p.position.x) < 1.5 && Math.abs(p.velocity.x) < 2) break
        if (r - rA0 > 4) break
        steerTick(true)
        await wait(30)
      }
      // Window gate: first grounded moment past z=20 at racing speed.
      // (No grounded-streak requirement — at full throttle the bike
      // legitimately hops off crests, so long streaks are themselves a
      // phase lottery that drifts the window toward the corridor edge.)
      let settled = false
      const rGate0 = window.__hover!.race()?.raceTime ?? 0
      while (true) {
        const s = sample()
        if (s.g && s.z > 20 && s.speed > 15) {
          settled = true
          break
        }
        if (s.r - rGate0 > 25) break
        steerTick(false)
        await wait(30)
      }
      // Sample y over a fixed 3.0-SIM-second window — at least one full
      // bob period at full throttle, identical coverage idle or loaded.
      const win: { r: number; x: number; y: number; z: number; g: boolean; speed: number }[] = []
      const rWin0 = window.__hover!.race()?.raceTime ?? 0
      while (true) {
        const s = sample()
        win.push(s)
        if (s.r - rWin0 >= 3.0) break
        if (win.length > 2000) break
        steerTick(false)
        await wait(30)
      }
      window.__hover!.setIntentOverride(null)
      return { settled, win }
    })

    // Window digest — printed so a threshold failure carries its
    // trajectory (where the bike was, how fast, on which line).
    const digest = {
      settled: data.settled,
      z: `${data.win[0]!.z.toFixed(1)}..${data.win[data.win.length - 1]!.z.toFixed(1)}`,
      x: `${Math.min(...data.win.map((s) => s.x)).toFixed(1)}..${Math.max(...data.win.map((s) => s.x)).toFixed(1)}`,
      speed: `${Math.min(...data.win.map((s) => s.speed)).toFixed(1)}..${Math.max(...data.win.map((s) => s.speed)).toFixed(1)}`,
      airborneSamples: data.win.filter((s) => !s.g).length,
      samples: data.win.length,
    }
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(`rides-waves window: ${JSON.stringify(digest)}`)

    expect(data.settled, 'bike should reach racing speed on the water within the sim budget').toBe(
      true,
    )
    const ys = data.win.map((s) => s.y)
    const yMin = Math.min(...ys)
    const yMax = Math.max(...ys)
    const yRange = yMax - yMin
    const simSpan = data.win[data.win.length - 1]!.r - data.win[0]!.r
    expect(simSpan, 'window must cover the full sim span').toBeGreaterThanOrEqual(2.95)
    const groundedFraction = data.win.filter((s) => s.g).length / data.win.length

    // Riding the surface, not flying away: full-throttle riding hops off
    // wave crests by design (apex ≈ 4m), but the bike must spend most of
    // the window ON the surface and stay inside a sane flight envelope.
    expect(groundedFraction, 'bike should surf the waves, not fly').toBeGreaterThan(0.5)
    expect(yMax).toBeLessThan(6)
    // Should ride above the deepest wave troughs (landing compressions
    // included — the envelope holds at racing speed).
    expect(yMin).toBeGreaterThan(-2)
    // Wave-driven oscillation should be at least 0.4m peak-to-peak.
    expect(yRange).toBeGreaterThan(0.4)

    consoleErrors.assertNone()
  })

  test('bike floats on water from rest (does not sink)', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/?autostart=1&tt=1')
    await waitFullyBooted(page, { timeout: 15_000 })

    // Coast out onto open water (half throttle), then cut power.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 0.5,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
        trickLeft: false,
        trickRight: false,
      }),
    )
    await page.waitForFunction(() => (window.__hover?.player()?.position.z ?? 0) > 35, {
      timeout: 60_000,
    })

    // Let it settle for 2 SIM seconds, then sample a 2.5-sim-second
    // window. A single-instant sample here is a wave-phase lottery — the
    // bike legitimately bobs to ~-1.6 in a trough moment; sinking is a
    // sustained property, so assert on the window.
    const win = await page.evaluate(async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      window.__hover!.setIntentOverride(null)
      const r0 = window.__hover!.race()?.raceTime ?? 0
      while ((window.__hover!.race()?.raceTime ?? 0) - r0 < 2) await wait(30)
      const out: { r: number; y: number; g: boolean }[] = []
      const rW0 = window.__hover!.race()?.raceTime ?? 0
      while (true) {
        const p = window.__hover!.player()!
        const r = window.__hover!.race()?.raceTime ?? 0
        out.push({ r, y: p.position.y, g: p.isGrounded })
        if (r - rW0 >= 2.5 || out.length > 2000) break
        await wait(30)
      }
      return out
    })

    const ys = win.map((s) => s.y).sort((a, b) => a - b)
    const yMin = ys[0]!
    const yMedian = ys[Math.floor(ys.length / 2)]!
    const groundedFraction = win.filter((s) => s.g).length / win.length
    // Bobbing in troughs is fine; sustained depth is sinking. Waves go to
    // ~-1.4m and hover height is ~1.2 above the surface.
    expect(yMin, 'should ride above the deepest troughs at rest').toBeGreaterThan(-2)
    expect(yMedian, 'should bob around the wave envelope, not below it').toBeGreaterThan(-1)
    expect(groundedFraction, 'should stay settled on the surface').toBeGreaterThan(0.8)
  })
})
