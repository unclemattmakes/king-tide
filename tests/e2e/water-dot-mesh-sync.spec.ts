/**
 * Sim-dot ↔ rendered-mesh sync (`?waterlab=1`).
 *
 * The red drifter dots are parked at the SIM surface (`sampleHeight` — what
 * buoyancy floats the bike on). The wireframe is what the GPU vertex shader
 * DRAWS. They must coincide: a bike riding a wave it can't see (or seeing a
 * wave it can't ride) is the exact desync this scene exists to catch.
 *
 * This spec measures the vertical gap analytically (`dotMeshResidual`, the
 * GPU forward transform vs the sim sampler at the same drawn XZ) AND captures
 * it visually from a SIDE PROFILE — looking along the crest axis, where a
 * vertical dot↔mesh gap can't hide behind perspective foreshortening the way
 * it can in the ¾ / persp views — plus the grazing + top-down reads.
 *
 *   E2E_PORT=5473 pnpm e2e tests/e2e/water-dot-mesh-sync.spec.ts
 */
import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  // Defaults only — stored tuning would change the steepness/amplitudes the
  // dots and mesh are measured against.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('hoverbike.waterDebug.v10')
    } catch {
      /* storage unavailable — defaults apply anyway */
    }
  })
})

test('sim dots sit on the rendered mesh (numeric + side/persp capture)', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  // Warm the shader + let the swell build, then freeze a phase so the dots
  // and the mesh are sampled at the same instant.
  await page.waitForTimeout(3500)
  await page.evaluate(() => {
    window.__waterlab!.setPaused(true)
    window.__waterlab!.water.setWireframe(true)
  })
  await page.waitForTimeout(200)

  // ---- Numeric: the vertical dot↔mesh gap over the dot grid -------------
  const residual = await page.evaluate(() =>
    window.__waterlab!.dotMeshResidual({ half: 24, step: 1 }),
  )
  console.log('[dot/mesh] residual', JSON.stringify(residual))

  // A couple of spot checks: the drawn mesh position of a rest vertex vs the
  // sim height the dots use at that exact XZ.
  const spot = await page.evaluate(() => {
    const samples: Array<{ rest: [number, number]; mesh: number; dot: number; gap: number }> = []
    for (const [rx, rz] of [
      [0, 0],
      [12, -6],
      [-18, 9],
      [6, 20],
    ] as Array<[number, number]>) {
      const m = window.__waterlab!.meshVertexAt(rx, rz)
      const dot = window.__waterlab!.surfaceYAt(m.x, m.z)
      samples.push({ rest: [rx, rz], mesh: m.y, dot, gap: dot - m.y })
    }
    return samples
  })
  console.log('[dot/mesh] spot', JSON.stringify(spot))

  // ---- Visual: side profile is the un-fakeable height read --------------
  await page.evaluate(() => window.__waterlab!.setCamPreset(4))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-dot-mesh/side-profile.png' })

  await page.evaluate(() => window.__waterlab!.setCamPreset(1))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-dot-mesh/graze.png' })

  await page.evaluate(() => window.__waterlab!.setCamPreset(2))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/water-dot-mesh/threequarter.png' })

  // The residual is always finite; the THRESHOLD assertion below is what the
  // fix has to satisfy. Start loose (repro), tighten after the fix lands.
  expect(Number.isFinite(residual.maxAbs)).toBe(true)
  // Post-fix target: dots within a few cm of the drawn surface everywhere.
  expect(residual.maxAbs).toBeLessThan(0.05)
})
