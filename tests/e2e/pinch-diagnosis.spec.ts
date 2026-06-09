/**
 * Gerstner-pinch diagnosis — P0.2 of docs/water-next-research.md (§4.2, §9).
 *
 * The steepness pinch was distrusted ("physics feels out of phase with the
 * visuals") and the research doc ranked three candidate causes: (1) the wave
 * zones the GPU never drew (fixed by #340), (2) hover-spring phase lag under
 * a fast bike (feel, not position), (3) a residual math mismatch in the
 * pinch / inverse-map pair. This spec settles (3) and re-checks (1):
 *
 *  - Numerical: `__hover.waterSync()` walks rest-point transects through
 *    `WaterMesh.renderVertex` (the CPU mirror of the GPU vertex transform,
 *    live uniforms included) and diffs against `sampleHeight` at the
 *    displaced world point — at Q=0 (control: any error is sampler noise)
 *    and at Q=1.2 (well above the shipped 0.44; the no-fold clamp may trim
 *    it — the report records the effective Q).
 *  - Visual (GPU ground truth): `?wavedots=1&wire=1` screenshot at Q=1.2 —
 *    red sim dots must sit ON the wireframe the real shader draws. This is
 *    the half the CPU mirror can't prove (a TSL-side bug the mirror doesn't
 *    share). Eyeball the PNGs under `artifacts/pinch-diagnosis/<tag>/`.
 *
 * Tracks: lagoon-edit = open water, no zones, no terrain (pure pinch);
 * sandbar = whole-area 0.5× zone + island terrain (the worst case the
 * distrust was formed on). If both pass numerically and the dots sit on the
 * wireframe, the remaining "out of phase" feel is explanation (2) — spring
 * lag — and Q can be trusted by default.
 *
 * Headed run on a real GPU only (the dots check needs real vertex
 * displacement). Tag via PINCH_TAG; artifacts under artifacts/ so reruns
 * don't wipe them (test-results/ is cleared per run).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const TAG = process.env.PINCH_TAG ?? 'now'
const OUT_DIR = `artifacts/pinch-diagnosis/${TAG}`

/** Structural mirror of debug.ts WaterSyncReport (page-evaluated JSON). */
type SyncReport = {
  samples: number
  skippedShallow: number
  steepness: number
  effectiveQ: number
  zoned: boolean
  maxDisp: number
  maxAbsDy: number
  rmsDy: number
  meanDy: number
  worst: { x: number; z: number; dy: number }
}
type TransectPair = { alongX: SyncReport | null; diagonal: SyncReport | null }

type PinchCase = {
  id: string
  label: string
  /** Numerical tolerance at Q=1.2, metres. The zoned case gets slack for the
   *  documented evaluate-zone-factors-at-the-query-point approximation
   *  (sub-metre displacement against tens-of-metres blend radii). */
  maxDyAtQ: number
  /** Expect the transect to land inside zone influence? (Sanity that the
   *  test exercised what it claims to.) */
  expectZoned: boolean
}

const CASES: PinchCase[] = [
  {
    id: 'lagoon-edit',
    label: 'control: no zones / no terrain',
    maxDyAtQ: 0.01,
    expectZoned: false,
  },
  { id: 'sandbar', label: 'zoned: whole-area 0.5x + terrain', maxDyAtQ: 0.02, expectZoned: true },
]

for (const c of CASES) {
  test(`${c.id}: pinch transects (Q=0, Q=1.2) + wavedots capture`, async ({ page }) => {
    test.setTimeout(180_000)
    mkdirSync(OUT_DIR, { recursive: true })
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/?autostart=1&track=${c.id}&skipintro=1&wavedots=1&wire=1`)
    await waitFullyBooted(page, { timeout: 60_000 })

    // Autoplay off the start pad so the player (and the dot grid that
    // follows it) sits over open water rather than the spawn shallows.
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    await page.waitForTimeout(9_000)

    const runTransects = async (q: number): Promise<TransectPair> => {
      await page.evaluate((qq) => window.__hover!.waterDebug()!.setSteepness(qq), q)
      await page.waitForTimeout(250)
      return page.evaluate(() => ({
        alongX: window.__hover!.waterSync({ dirX: 1, dirZ: 0 }),
        diagonal: window.__hover!.waterSync({ dirX: 0.34, dirZ: 0.94 }),
      }))
    }

    const q0 = await runTransects(0)
    const q12 = await runTransects(1.2)

    // Freeze the clock so dots + wireframe hold still, then capture the
    // GPU-truth shot at the high Q.
    await page.evaluate(() => window.__hover!.waterDebug()!.setTimeScale(0))
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT_DIR}/${c.id}-steep1.2.png` })

    const reports = { track: c.id, label: c.label, q0, q12 }
    writeFileSync(`${OUT_DIR}/${c.id}-transects.json`, JSON.stringify(reports, null, 2))
    // biome-ignore lint/suspicious/noConsole: diagnostic — the P0.2 verdict evidence
    console.log(`pinch-diagnosis [${TAG}] ${c.id}:`, JSON.stringify(reports))

    for (const [label, pair] of [
      ['q0', q0],
      ['q12', q12],
    ] as const) {
      for (const dir of ['alongX', 'diagonal'] as const) {
        const r = pair[dir]
        expect(r, `${c.id} ${label} ${dir}: probe returned null`).not.toBeNull()
        if (!r) continue
        // Enough deep-water samples that the stats mean something even when
        // part of the transect crosses an island and gets skipped.
        expect(r.samples, `${c.id} ${label} ${dir}: too few usable samples`).toBeGreaterThan(24)
        if (label === 'q0') {
          // No pinch → mirror and sampler evaluate the same closed form at
          // the same point. Anything past float noise is a real drift.
          expect(r.maxAbsDy, `${c.id} q0 ${dir}: sampler↔mirror drift with pinch OFF`).toBeLessThan(
            1e-3,
          )
        } else {
          // Pinch must actually have displaced vertices...
          expect(r.maxDisp, `${c.id} q12 ${dir}: pinch never engaged`).toBeGreaterThan(0.05)
          expect(r.effectiveQ, `${c.id} q12 ${dir}: effective Q collapsed`).toBeGreaterThan(0.3)
          // ...and buoyancy must float on the displaced surface.
          expect(r.maxAbsDy, `${c.id} q12 ${dir}: buoyancy off the pinched surface`).toBeLessThan(
            c.maxDyAtQ,
          )
          expect(r.zoned, `${c.id} q12 ${dir}: zone coverage expectation`).toBe(c.expectZoned)
        }
      }
    }
  })
}
