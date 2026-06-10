/**
 * Per-track spectrum banks — sim↔render sync (P2.2 of
 * docs/water-next-research.md §7.1).
 *
 * A spectrum track replaces the hand-tuned 6-wave bank with a generated
 * 12-component one BEFORE the water mesh bakes its wave constants. This
 * spec pins the whole plumbing end-to-end on a real GPU:
 *
 *  - `__hover.waveBank()` — the generated bank actually reached the field
 *    (count / swell split / longest-first order), and a default-bank boot
 *    is untouched (still the 6-wave preset).
 *  - `__hover.waterSync()` — buoyancy floats on the rendered surface for
 *    the GENERATED bank, at Q=0 (control) and Q=1.2 (pinch exercises the
 *    per-wave qBase bake across all 12 components), on open water.
 *  - `?wavedots=1&wire=1` capture — the GPU-truth eyeball record (red sim
 *    dots on the real shader's wireframe), plus a clean horizon shot for
 *    the swell-only outer/skirt change (chop dropped from the far layers
 *    must not show a seam at the 380→480 m cross-fade band).
 *
 * Headed, real GPU. Artifacts under artifacts/wave-spectrum-sync/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const OUT_DIR = 'artifacts/wave-spectrum-sync'

type SyncReport = {
  samples: number
  effectiveQ: number
  maxDisp: number
  maxAbsDy: number
  rmsDy: number
}

test('lagoon-edit + ?spectrum=open-swell: generated bank is the surface ridden', async ({
  page,
}) => {
  test.setTimeout(180_000)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 900 })
  // lagoon-edit = open water, no zones/terrain — the pure-bank case.
  await page.goto(
    '/?autostart=1&track=lagoon-edit&skipintro=1&spectrum=open-swell:1&wavedots=1&wire=1',
  )
  await waitFullyBooted(page, { timeout: 60_000 })

  // Plumbing: the override reached the field the mesh was built from.
  const bank = await page.evaluate(() => window.__hover!.waveBank())
  expect(bank).not.toBeNull()
  expect(bank!.count).toBe(12)
  expect(bank!.swellCount).toBeGreaterThanOrEqual(1)
  expect(bank!.swellCount).toBeLessThan(bank!.count)
  for (let i = 1; i < bank!.waves.length; i++) {
    expect(bank!.waves[i]!.wavelength).toBeLessThanOrEqual(bank!.waves[i - 1]!.wavelength)
  }

  // Off the spawn shallows so the transect sits over open water.
  await page.evaluate(() => window.__hover!.toggleAutoPlay())
  await page.waitForTimeout(9_000)

  const runTransects = async (q: number) => {
    await page.evaluate((qq) => window.__hover!.waterDebug()!.setSteepness(qq), q)
    await page.waitForTimeout(250)
    return page.evaluate(() => ({
      alongX: window.__hover!.waterSync({ dirX: 1, dirZ: 0 }) as SyncReport | null,
      diagonal: window.__hover!.waterSync({ dirX: 0.34, dirZ: 0.94 }) as SyncReport | null,
    }))
  }
  const q0 = await runTransects(0)
  const qShipped = await runTransects(0.44)
  const q12 = await runTransects(1.2)

  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT_DIR}/lagoon-edit-open-swell-wavedots.png` })

  const reports = { bank, q0, qShipped, q12 }
  writeFileSync(`${OUT_DIR}/lagoon-edit-open-swell.json`, JSON.stringify(reports, null, 2))
  // biome-ignore lint/suspicious/noConsole: diagnostic — P2.2 sync evidence
  console.log('wave-spectrum-sync lagoon-edit:', JSON.stringify(reports))

  for (const dir of ['alongX', 'diagonal'] as const) {
    const r0 = q0[dir]
    expect(r0, `q0 ${dir} probe null`).not.toBeNull()
    expect(r0!.samples).toBeGreaterThan(24)
    // No pinch → any mirror↔sampler gap is real drift in the 12-wave bake.
    expect(r0!.maxAbsDy, `q0 ${dir}: drift with pinch OFF`).toBeLessThan(1e-3)

    // The CONTRACT case: the shipped Q. The buoyancy inverse map's
    // contraction factor is Q·Σ(q·A·k) = 0.44 × ≤0.45 ≈ 0.2 → four
    // fixed-point steps land sub-2 mm on metre-scale displacement.
    const rs = qShipped[dir]
    expect(rs, `q0.44 ${dir} probe null`).not.toBeNull()
    expect(rs!.samples).toBeGreaterThan(24)
    expect(rs!.maxDisp, `q0.44 ${dir}: pinch never engaged`).toBeGreaterThan(0.05)
    expect(rs!.maxAbsDy, `q0.44 ${dir}: buoyancy off the shipped-Q surface`).toBeLessThan(0.002)

    // STRESS case, ~3× the shipped Q: contraction ≈ 0.54, so 4 steps
    // leave ≈0.54⁴ ≈ 8.5% of the (≈1.7 m) displacement step as residual
    // — worst-case ~1.5 cm. Known inverse-map convergence behaviour
    // (water-next-research §4.2 measured the same shape on the default
    // bank), not a desync; the tolerance documents it.
    const r12 = q12[dir]
    expect(r12, `q12 ${dir} probe null`).not.toBeNull()
    expect(r12!.samples).toBeGreaterThan(24)
    expect(r12!.maxDisp, `q12 ${dir}: pinch never engaged`).toBeGreaterThan(0.05)
    expect(r12!.maxAbsDy, `q12 ${dir}: buoyancy off the generated surface`).toBeLessThan(0.02)
  }
})

test('cape-town-drift boots its authored spectrum; ?spectrum=off restores the default bank', async ({
  page,
}) => {
  test.setTimeout(180_000)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 900 })
  // Authored plumbing (track JSON → field), on the real shipped track —
  // zones + shore field + swellSets all active alongside the spectrum.
  await page.goto('/?autostart=1&track=cape-town-drift&skipintro=1&wavedots=1&wire=1')
  await waitFullyBooted(page, { timeout: 60_000 })
  const bank = await page.evaluate(() => window.__hover!.waveBank())
  expect(bank).not.toBeNull()
  expect(bank!.count).toBe(12)
  expect(bank!.swellCount).toBeGreaterThanOrEqual(2)

  await page.evaluate(() => window.__hover!.toggleAutoPlay())
  await page.waitForTimeout(8_000)
  const rep = await page.evaluate(
    () => window.__hover!.waterSync({ dirX: 1, dirZ: 0.21 }) as SyncReport | null,
  )
  expect(rep, 'cape-town transect null').not.toBeNull()
  expect(rep!.samples).toBeGreaterThan(24)
  expect(rep!.maxAbsDy, 'buoyancy off the authored-spectrum surface').toBeLessThan(0.02)

  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT_DIR}/cape-town-authored-spectrum.png` })
  writeFileSync(`${OUT_DIR}/cape-town-authored.json`, JSON.stringify({ bank, rep }, null, 2))
  // biome-ignore lint/suspicious/noConsole: diagnostic — P2.2 sync evidence
  console.log('wave-spectrum-sync cape-town:', JSON.stringify({ bank, rep }))

  // Kill switch: ?spectrum=off must restore the 6-wave default on the
  // same track (the A/B lever the playtest gate depends on).
  await page.goto('/?autostart=1&track=cape-town-drift&skipintro=1&spectrum=off')
  await waitFullyBooted(page, { timeout: 60_000 })
  const defaultBank = await page.evaluate(() => window.__hover!.waveBank())
  expect(defaultBank!.count).toBe(6)
  expect(defaultBank!.swellCount).toBe(2)
})

test('default tracks keep the hand-tuned 6-wave bank (regression)', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?autostart=1&skipintro=1')
  await waitFullyBooted(page, { timeout: 60_000 })
  const bank = await page.evaluate(() => window.__hover!.waveBank())
  expect(bank).not.toBeNull()
  expect(bank!.count).toBe(6)
  expect(bank!.swellCount).toBe(2)
  // The default bank's first two entries are the 50 m + 85 m swells —
  // longest-first ordering is a spectrum-bank property, not imposed here.
  expect(bank!.waves[0]!.wavelength).toBe(50)
  expect(bank!.waves[1]!.wavelength).toBe(85)
})
