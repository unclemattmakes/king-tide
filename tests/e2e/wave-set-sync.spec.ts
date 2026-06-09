/**
 * Wave-set envelope sim↔render sync — P2.1 of docs/water-next-research.md
 * (§7.2). Cape Town Drift authors `water.swellSets {periodS 60, depth 0.3}`,
 * so its ambient sea breathes between 0.7× and 1.3× every minute. The
 * envelope is evaluated three ways — CPU buoyancy (`waveSetFactor`), the GPU
 * vertex stage (`setEnvNode` from mirrored uniforms), and the `renderVertex`
 * CPU mirror — and this spec pins that they agree on a live track:
 *
 *  - `__hover.waterSync()` transects at several moments across the set
 *    cycle (the factor differs at each), asserting buoyancy sits on the
 *    mirrored render surface through the whole breath.
 *  - Captures a set-high vs set-low screenshot pair (~half a period apart
 *    via a fast-forwarded water clock) for the eyeball record.
 *
 * Headed, real GPU. Artifacts under artifacts/wave-set-sync/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const OUT_DIR = 'artifacts/wave-set-sync'

test('cape-town-drift: envelope breathes in sync on both sides', async ({ page }) => {
  test.setTimeout(240_000)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?autostart=1&track=cape-town-drift&skipintro=1&wavedots=1&wire=1')
  await waitFullyBooted(page, { timeout: 60_000 })

  // Authoring plumbing: the track JSON's swellSets reached the field.
  const authored = await page.evaluate(() => window.__hover!.waterDebug()!.getSwellSet())
  expect(authored.periodS).toBe(60)
  expect(authored.depth).toBeCloseTo(0.3, 6)

  await page.evaluate(() => window.__hover!.toggleAutoPlay())
  await page.waitForTimeout(8_000)

  // Transects at several moments across the cycle. 6× water clock walks
  // ~21 wave-seconds between probes, so the factor lands at distinctly
  // different phases each time.
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(6))
  const reports: unknown[] = []
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(3_500)
    const rep = await page.evaluate(() => window.__hover!.waterSync({ dirX: 1, dirZ: 0.21 }))
    reports.push(rep)
    expect(rep, `probe ${i} returned null`).not.toBeNull()
    if (!rep) continue
    expect(rep.samples, `probe ${i}: too few usable samples`).toBeGreaterThan(24)
    expect(rep.maxAbsDy, `probe ${i}: buoyancy off the enveloped surface`).toBeLessThan(0.02)
  }
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(1))

  // Set-high vs set-low captures, ~half a period apart (fast-forwarded).
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT_DIR}/cape-town-setA.png` })
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(8))
  await page.waitForTimeout(3_750) // ≈ 30 wave-seconds = half the 60 s period
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT_DIR}/cape-town-setB.png` })

  writeFileSync(`${OUT_DIR}/transects.json`, JSON.stringify(reports, null, 2))
  // biome-ignore lint/suspicious/noConsole: diagnostic — P2.1 sync evidence
  console.log('wave-set-sync cape-town:', JSON.stringify(reports))
})
