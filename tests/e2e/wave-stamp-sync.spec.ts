/**
 * Authored wave stamps — sim↔render sync (P3.2 of
 * docs/water-next-research.md §7.10).
 *
 * A stamp is a crest line + a traveling sech² pulse evaluated identically
 * by CPU buoyancy and the GPU vertex stage (uniform mirror, like zones).
 * This spec injects a stamp at runtime through `__hover.setWaveStamps`
 * (the same sim setter track JSON drives — the water mesh reference-
 * watches `field.stamps`, so injection exercises the full both-sides
 * path) and pins:
 *
 *  - `__hover.waterSync()` transects ACROSS the stamp line at
 *    deterministic cycle moments (the report's `fieldTime` steers the
 *    clock): buoyancy must sit on the mirrored render surface through
 *    approach, peak, release and dead time.
 *  - Liveness evidence: with/without-stamp probes at the SAME frozen
 *    instant differ by the ridge's mean area contribution — the sync
 *    claim isn't vacuous.
 *  - `?wavedots=1&wire=1` capture at the live peak for the GPU-truth
 *    eyeball record.
 *
 * Headed, real GPU. Artifacts under artifacts/wave-stamp-sync/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const OUT_DIR = 'artifacts/wave-stamp-sync'

type SyncReport = {
  samples: number
  maxAbsDy: number
  rmsDy: number
  maxDisp: number
  maxRenderY: number
  meanRenderY: number
  fieldTime: number
}

test('lagoon-edit: injected stamp is the surface ridden (sync through the pulse)', async ({
  page,
}) => {
  test.setTimeout(180_000)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?autostart=1&track=lagoon-edit&skipintro=1&wavedots=1&wire=1')
  await waitFullyBooted(page, { timeout: 60_000 })

  // Drive off the start pad onto open water.
  await page.evaluate(() => window.__hover!.toggleAutoPlay())
  await page.waitForTimeout(8_000)

  // Ambient baseline along the probe axis BEFORE injection.
  await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
  await page.waitForTimeout(250)
  const probeArgs = await page.evaluate(() => {
    const p = window.__hover!.player()!.position
    return { x: p.x, z: p.z, dirX: 1, dirZ: 0, step: 1.0, count: 129 }
  })
  const baseline = (await page.evaluate(
    (args) => window.__hover!.waterSync(args),
    probeArgs,
  )) as SyncReport | null
  expect(baseline).not.toBeNull()

  // Inject: crest line 80 m long, anchored to the PROBE frame (the bike
  // keeps driving under autoplay — anchoring to it would drift the line
  // off the transect). The line crosses the transect 20 m ahead of its
  // centre, perpendicular to the probe axis. 20 s period, 10 m/s, 60 m
  // approach → pulse peaks on the line 6 s into each cycle (phase01 = 0)
  // and lives for ~9.6 s of it.
  await page.evaluate((args) => {
    window.__hover!.setWaveStamps([
      {
        x0: args.x + 20,
        z0: args.z - 40,
        x1: args.x + 20,
        z1: args.z + 40,
        amplitude: 1.4,
        widthM: 6,
        periodS: 20,
        speed: 10,
        approachM: 60,
        phase01: 0,
      },
    ])
  }, probeArgs)

  // Steer the water clock onto deterministic cycle moments. With
  // phase01 = 0, the pulse center crosses the authored line (c = 0) at
  // fieldTime ≡ approachM/speed = 6 (mod 20); it is live from ~0 s
  // (entry) to ~9.6 s of each cycle. Probe at peak −3 s (mid approach),
  // peak, peak +2 s (release), and +12 s (dead time) — sync must hold at
  // every one of them.
  const reports: SyncReport[] = []
  const targets = [3, 6, 8, 18] // fieldTime mod 20
  // Corrective seek: hop the water clock (timeScale tops out at 4×
  // effective — the menu clamp is 5 and rAF cadence eats some), re-read,
  // repeat until within ±0.8 s of the target phase.
  const seekTo = async (target: number) => {
    for (let k = 0; k < 5; k++) {
      const now = (await page.evaluate(
        (args) => window.__hover!.waterSync(args)!.fieldTime,
        probeArgs,
      )) as number
      const delta = (((target - now) % 20) + 20) % 20
      if (delta < 0.8 || delta > 19.2) return
      await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(4))
      await page.waitForTimeout(Math.max(120, Math.ceil((delta / 4) * 1000 * 0.85)))
      await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
      await page.waitForTimeout(200)
    }
  }
  for (const [i, target] of targets.entries()) {
    await seekTo(target)
    const rep = (await page.evaluate(
      (args) => window.__hover!.waterSync(args),
      probeArgs,
    )) as SyncReport | null
    expect(rep, `probe ${i} null`).not.toBeNull()
    reports.push(rep!)
  }

  // Liveness oracle at the PEAK probe phase: with/without-stamp probes at
  // the SAME frozen clock difference out the ambient exactly — the stamp's
  // mean ridge contribution over the 128 m transect is ≈ A·2w/span ≈
  // 0.13 m, far above mirror noise. (maxRenderY is no oracle here: the
  // ridge only raises the max if the ambient happens to be high at the
  // crossing.)
  await seekTo(6)
  const withStamp = (await page.evaluate(
    (args) => window.__hover!.waterSync(args),
    probeArgs,
  )) as SyncReport
  await page.screenshot({ path: `${OUT_DIR}/lagoon-stamp-live-wavedots.png` })
  await page.evaluate(() => window.__hover!.setWaveStamps([]))
  await page.waitForTimeout(150)
  const withoutStamp = (await page.evaluate(
    (args) => window.__hover!.waterSync(args),
    probeArgs,
  )) as SyncReport
  expect(withoutStamp.fieldTime).toBeCloseTo(withStamp.fieldTime, 6)
  const ridgeMean = withStamp.meanRenderY - withoutStamp.meanRenderY
  // Re-inject for the trailing clear-path check below.
  await page.evaluate((args) => {
    window.__hover!.setWaveStamps([
      {
        x0: args.x + 20,
        z0: args.z - 40,
        x1: args.x + 20,
        z1: args.z + 40,
        amplitude: 1.4,
        widthM: 6,
        periodS: 20,
        speed: 10,
        approachM: 60,
        phase01: 0,
      },
    ])
  }, probeArgs)

  writeFileSync(`${OUT_DIR}/transects.json`, JSON.stringify({ baseline, reports }, null, 2))
  // biome-ignore lint/suspicious/noConsole: diagnostic — P3.2 sync evidence
  console.log('wave-stamp-sync:', JSON.stringify({ baseline, reports }))

  // Sync holds at every moment of the cycle…
  for (const [i, rep] of reports.entries()) {
    expect(rep.samples, `probe ${i}: too few samples`).toBeGreaterThan(24)
    expect(rep.maxAbsDy, `probe ${i}: buoyancy off the stamped surface`).toBeLessThan(0.01)
  }
  // …and the claim isn't vacuous: at the peak phase the with/without mean
  // difference is the stamp's ridge area (≈ 0.13 m over this transect).
  expect(ridgeMean, 'no live pulse at the peak probe').toBeGreaterThan(0.06)

  // Clearing restores a stamp-free field (the no-stamps path every other
  // track takes).
  await page.evaluate(() => window.__hover!.setWaveStamps([]))
  await page.waitForTimeout(250)
  const cleared = (await page.evaluate(
    (args) => window.__hover!.waterSync(args),
    probeArgs,
  )) as SyncReport | null
  expect(cleared).not.toBeNull()
  expect(cleared!.maxAbsDy).toBeLessThan(0.01)
})
