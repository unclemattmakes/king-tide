/**
 * Water lab (`?waterlab=1`) — boots the dedicated water-analysis scene and
 * turns the contour-line "sliding" diagnosis into asserted numbers:
 *
 *   1. The legacy two-train readability field really does race: the max
 *      iso-line sweep speed over a 30 s × 120 m window exceeds the primary
 *      train's 8.6 m/s phase speed on gate-visible faces (≈10.3 at the
 *      half-gate slope, ≈11.3 at the faint-gate floor — and unboundedly
 *      faster below the gate, where the lines fade).
 *   2. At contour coherence 1 the same scan pins to the dominant train's
 *      phase speed exactly — iso-lines ride the primary swell, never race.
 *
 * Plus scene plumbing (pause/step, HUD, camera presets) and an A/B
 * screenshot pair at identical wave phase for eyeballing the fix.
 *
 *   E2E_PORT=5462 pnpm e2e tests/e2e/water-lab.spec.ts
 */
import { expect, test } from '@playwright/test'

// `window.__waterlab` is typed by the scene's global declaration
// (src/boot/water-lab-mode.ts) — the page.evaluate callbacks below pick it
// up through the shared tsconfig, the same way specs use `window.__hover`.

// Serial: these are headed-GPU pages and Chromium starves rAF in unfocused
// windows — parallel workers fight over focus and the frame-dependent
// assertions (unpause resumes the clock) silently stall in the loser.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  // Stored tuning would skew the analytic assertions — every run starts from
  // the constructor defaults.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('hoverbike.waterDebug.v10')
    } catch {
      /* storage unavailable — defaults apply anyway */
    }
  })
})

test('iso-line racing is real and contour coherence pins it to phase speed', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  // The default bank's swell trains, verbatim — the lab's reference speeds.
  const trains = await page.evaluate(() => window.__waterlab!.phaseSpeeds())
  expect(trains).toEqual([
    { wavelength: 50, speed: 8.6 },
    { wavelength: 85, speed: 11.2 },
  ])
  const beat = await page.evaluate(() => window.__waterlab!.beatPeriodS())
  expect(beat).not.toBeNull()
  expect(beat!).toBeGreaterThan(20)
  expect(beat!).toBeLessThan(30)

  // Diagnosis: with the legacy field (coherence 0) iso-lines on faces the
  // slope gate draws sweep well past the PRIMARY train's 8.6 m/s phase
  // speed (analytic max ≈ 10.3 at slope ≥ 0.04 ≈ half-gate, ≈ 11.3 at the
  // faint-gate floor 0.025) — and unboundedly faster below the gate, which
  // is why the gate knob is the coherence knob's partner.
  const racingHalfGate = await page.evaluate(() =>
    window.__waterlab!.scanIsoMax({ durationS: 30, slopeMin: 0.04 }),
  )
  expect(racingHalfGate.maxV).toBeGreaterThan(9.5)
  const racingFaintGate = await page.evaluate(() =>
    window.__waterlab!.scanIsoMax({ durationS: 30, slopeMin: 0.025 }),
  )
  expect(racingFaintGate.maxV).toBeGreaterThan(10.5)

  // Fix: at coherence 1 the field is the dominant train alone, whose
  // iso-lines move at EXACTLY its phase speed (8.6 m/s) everywhere.
  await page.evaluate(() => window.__waterlab!.water.setContourCoherence(1))
  const cohRead = await page.evaluate(() => window.__waterlab!.water.getContourCoherence())
  expect(cohRead).toBe(1)
  const coherentMax = await page.evaluate(() =>
    window.__waterlab!.scanIsoMax({ durationS: 30, slopeMin: 0.04 }),
  )
  expect(Math.abs(coherentMax.maxV - 8.6)).toBeLessThan(0.1)

  // Live probe publishes a finite speed.
  const live = await page.evaluate(() => window.__waterlab!.isoSpeed())
  expect(Number.isFinite(live)).toBe(true)
  expect(live).toBeGreaterThanOrEqual(0)

  await page.evaluate(() => window.__waterlab!.water.setContourCoherence(0))
})

test('pause freezes the wave clock and step advances one frame', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  await page.evaluate(() => window.__waterlab!.setPaused(true))
  // Settle past any in-flight frame before taking the frozen baseline.
  await page.waitForTimeout(150)
  const y1 = await page.evaluate(() => window.__waterlab!.surfaceYAt(7, 3))
  await page.waitForTimeout(400)
  const y2 = await page.evaluate(() => window.__waterlab!.surfaceYAt(7, 3))
  expect(y2).toBe(y1)

  // One 60 Hz step moves the surface (synchronous — no frame needed).
  const y3 = await page.evaluate(() => {
    window.__waterlab!.step()
    return window.__waterlab!.surfaceYAt(7, 3)
  })
  expect(y3).not.toBe(y2)

  // Unpause resumes the wave clock — frame-driven, so poll rather than
  // sleep (and rely on serial mode for window focus → live rAF).
  await page.evaluate(() => window.__waterlab!.setPaused(false))
  await page.waitForFunction((prev) => window.__waterlab!.surfaceYAt(7, 3) !== prev, y3, {
    timeout: 15_000,
  })

  // HUD overlay exists and names the scene.
  await expect(page.locator('#waterlab-hud')).toContainText('WATER LAB')
})

test('capture lab views + coherence A/B pair at identical wave phase', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })
  // Let the swell + shader warm a few seconds before framing.
  await page.waitForTimeout(4000)

  await page.screenshot({ path: 'artifacts/water-lab/lab-threequarter.png' })

  await page.evaluate(() => window.__waterlab!.setCamPreset(1))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-lab/lab-graze.png' })

  // Frozen top-down A/B: same wave phase, only the coherence knob moves.
  await page.evaluate(() => {
    window.__waterlab!.setCamPreset(3)
    window.__waterlab!.setPaused(true)
    window.__waterlab!.water.setContourCoherence(0)
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-lab/lab-topdown-coherence0.png' })
  await page.evaluate(() => window.__waterlab!.water.setContourCoherence(1))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-lab/lab-topdown-coherence1.png' })
})
