/**
 * Wave-zone sim↔render sync harness.
 *
 * Wave zones (per-track heightMult / freqMult / surge OBBs) are applied by the
 * CPU buoyancy sampler AND — since the zone-uniform port — by the GPU water
 * shader. This spec captures the evidence either way:
 *
 *  1. Visual: boots each zone-bearing shipped track with `?wavedots=1&wire=1`
 *     (red dots = CPU `sampleHeight`, wireframe = what the GPU draws), freezes
 *     the water clock, and screenshots. Inside a zone the dots must sit ON the
 *     wireframe; pre-port they visibly float above it (sandbar: dots at 0.5×
 *     crest height) or sit on phase-shifted crests (the-maw: freqMult 0.85).
 *     Eyeball the PNGs under `test-results/wave-zone-sync/<tag>/`.
 *
 *  2. Perf: the zone evaluation adds per-vertex ALU on ~590k verts + the outer
 *     tile, so the-maw (two zones, the heaviest case) gets a 6 s autoplay FPS
 *     probe whose stats are written next to the screenshots for before/after
 *     comparison.
 *
 * Tag a run via WAVE_SYNC_TAG (e.g. `before` / `after`); artifacts land in
 * `test-results/wave-zone-sync/<tag>/`. Headed run on a real GPU only —
 * SwiftShader fps numbers are meaningless and the dots check needs the real
 * vertex displacement.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitForPerfReady, waitFullyBooted } from './helpers/boot'

const TAG = process.env.WAVE_SYNC_TAG ?? 'now'
// NOT under test-results/ — Playwright clears that dir at run start, which
// would delete the `before` captures the moment the `after` run begins.
const OUT_DIR = `artifacts/wave-zone-sync/${TAG}`

type ZoneCase = {
  id: string
  /** Player must be within `radius` of this world-XZ point (inside the zone)
   *  before the screenshot — null when the zone covers the whole play area. */
  zonePoint: { x: number; z: number; radius: number } | null
}

// The three shipped tracks with waveZones (see public/tracks/<id>.json).
const CASES: ZoneCase[] = [
  // One zone, heightMult 0.5, OBB 640×560 m centred at origin — covers the
  // whole play area, so any camera framing shows the divergence.
  { id: 'sandbar', zonePoint: null },
  // Zone 1: heightMult 1.4 + freqMult 0.85 over most of the track (crests at
  // literally different positions); zone 2 adds a local 8 s surge.
  { id: 'the-maw', zonePoint: null },
  // Single 60×60 m zone at (0, 95), heightMult 1.3. The racing line never
  // comes closer than ~50 m (nearest AI anchor 79 m, start 82 m), so the
  // best a player-following dot grid can do is clip the blend edge —
  // treat this shot as context; sandbar + the-maw are the decisive pair.
  { id: 'mexico-city', zonePoint: { x: 0, z: 95, radius: 70 } },
]

for (const c of CASES) {
  test(`${c.id}: wavedots vs wireframe screenshot`, async ({ page }) => {
    test.setTimeout(180_000)
    mkdirSync(OUT_DIR, { recursive: true })
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/?autostart=1&track=${c.id}&skipintro=1&wavedots=1&wire=1`)
    await waitFullyBooted(page, { timeout: 60_000 })

    // Autoplay the bike off the start pad and onto open water so the dot
    // grid brackets real waves (the grid follows the player).
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    if (c.zonePoint) {
      // Drive the lap until the bike passes through the (small) zone.
      const { x, z, radius } = c.zonePoint
      try {
        await page.waitForFunction(
          ([zx, zz, r]) => {
            const p = window.__hover?.player()?.position
            if (!p) return false
            return Math.hypot(p.x - (zx as number), p.z - (zz as number)) < (r as number)
          },
          [x, z, radius],
          { timeout: 120_000, polling: 100 },
        )
      } catch {
        // Bike never entered the zone (AI line drift) — shoot anyway, the
        // screenshot is still useful context; flag it in the filename.
        await page.screenshot({ path: `${OUT_DIR}/${c.id}-MISSED-ZONE.png` })
        return
      }
    } else {
      await page.waitForTimeout(9_000)
    }

    // Freeze the water clock so dots + wireframe hold still for the shot.
    await page.evaluate(() => window.__hover!.waterDebug()?.setTimeScale(0))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT_DIR}/${c.id}.png` })
  })
}

test('the-maw: 6s autoplay FPS probe (zone-eval perf cost)', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT_DIR, { recursive: true })
  await page.goto('/?autostart=1&track=the-maw&skipintro=1')
  await waitForPerfReady(page, { timeout: 60_000 })
  await page.evaluate(() => window.__hover!.toggleAutoPlay())
  // Let boot/countdown settle out of the sample window.
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__hover!.perf!.resetWindow())
  await page.waitForTimeout(6000)
  const stats = await page.evaluate(() => window.__hover!.perf!.stats())
  // biome-ignore lint/suspicious/noConsole: diagnostic — before/after compare
  console.log(`the-maw perf [${TAG}]:`, JSON.stringify(stats))
  writeFileSync(`${OUT_DIR}/the-maw-perf.json`, JSON.stringify(stats, null, 2))
  expect(stats.count).toBeGreaterThan(60)
})
