/**
 * Water look-pass capture harness — the "see the water" tool for the global
 * water aesthetic pass (foam / contours / reflections / normals).
 *
 * Boots `?watertune=<id>` (real track water + sky + geometry, free cam, no
 * race) and drives the `window.__watertune` test hook to:
 *   - park the camera at a set of fixed POSES (deterministic framing),
 *   - apply a list of look PRESETS live on one boot (identical wave state →
 *     clean A/B of uniform-only knob changes), and
 *   - freeze the wave clock and screenshot each preset × pose to disk.
 *
 * Structural shader changes (new code, recompile) are compared across separate
 * runs: same poses + same warmup + freeze gives a near-identical wave state.
 *
 * Gated on WATER_LOOK=1 so `pnpm e2e` stays fast. Headed (real GPU) by default
 * via playwright.config — the water shader reads nothing like SwiftShader.
 *
 * Env knobs (all optional):
 *   WATER_LOOK_ID       track slug                         (default cape-town-drift)
 *   WATER_LOOK_TOD      time-of-day seconds (0..360)       (default: track's own)
 *   WATER_LOOK_WARMUP   ms to let the field develop        (default 3500)
 *   WATER_LOOK_POSES    JSON [{label,pos:[x,y,z],target:[x,y,z]}]
 *   WATER_LOOK_SET      JSON [{label, look:{knob:val,...}|null}]
 *
 * Output: artifacts/water-look/<id>/<lookLabel>__<poseLabel>.jpg
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const SHOT_W = 1280
const SHOT_H = 720

const ID = process.env.WATER_LOOK_ID ?? 'cape-town-drift'
const WARMUP = Number(process.env.WATER_LOOK_WARMUP ?? 3500)
const TOD = process.env.WATER_LOOK_TOD ? Number(process.env.WATER_LOOK_TOD) : null

type Pose = { label: string; pos: [number, number, number]; target: [number, number, number] }
type LookEntry = { label: string; look: Record<string, number> | null }

// Default camera poses for Cape Town Drift. Start line sits at (18, 3, 302) on
// the south edge; the circuit loops clockwise around a central ridge, so the
// water is the channel + outer ocean. These frame the water from the angles
// that matter for the look pass: a grazing horizon read, a steep wave-face
// read, and an establishing 3/4.
const DEFAULT_POSES: Pose[] = [
  // Grazing: low over the bay looking out toward the horizon — reflections,
  // Fresnel, foam silhouettes against the sky.
  { label: 'graze', pos: [30, 5.5, 295], target: [-180, 3, 250] },
  // Down-3/4: higher, steeper over open water — wave-face foam, contours,
  // value ramp, the painterly read.
  { label: 'down', pos: [40, 34, 285], target: [-30, 0, 215] },
  // Establish: the watertune default-ish framing for orientation.
  { label: 'establish', pos: [70, 24, 348], target: [18, 1.5, 302] },
]

const POSES: Pose[] = process.env.WATER_LOOK_POSES
  ? (JSON.parse(process.env.WATER_LOOK_POSES) as Pose[])
  : DEFAULT_POSES

// Default look set: just the current shipped baseline. Override via
// WATER_LOOK_SET to A/B knob presets on one boot.
const LOOK_SET: LookEntry[] = process.env.WATER_LOOK_SET
  ? (JSON.parse(process.env.WATER_LOOK_SET) as LookEntry[])
  : [{ label: 'baseline', look: null }]

const OUT_ROOT = path.resolve(process.cwd(), 'artifacts', 'water-look')

// Overlays the watertune scene draws on top of the canvas — hidden for a clean
// art read. (#water-debug = tuner panel, #watertune-hud = bottom-right card.)
const HUD_HIDE = ['#water-debug', '#water-debug-toggle', '#watertune-hud', '#dev-dock']
  .map((s) => `${s}{display:none!important}`)
  .join('')

test.describe('water look capture', () => {
  test.skip(process.env.WATER_LOOK !== '1', 'gated on WATER_LOOK=1')

  test(`${ID} water look`, async ({ page }) => {
    test.setTimeout(WARMUP + LOOK_SET.length * POSES.length * 1500 + 60_000)

    const outDir = path.join(OUT_ROOT, ID)
    mkdirSync(outDir, { recursive: true })

    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    await page.goto(`/?watertune=${ID}`)

    // Wait for the watertune hook to be installed (boot complete).
    await page.waitForFunction(
      () => !!(window as unknown as { __watertune?: unknown }).__watertune,
      {
        timeout: 45_000,
      },
    )
    const backend = await page.evaluate(() =>
      (window as unknown as { __watertune: { backend(): string } }).__watertune.backend(),
    )
    console.log(`water-look:${ID}:backend=${backend}`)
    expect(['webgpu', 'webgl2']).toContain(backend)

    if (TOD !== null) {
      await page.evaluate(
        (t) =>
          (
            window as unknown as { __watertune: { setTimeOfDay(s: number): void } }
          ).__watertune.setTimeOfDay(t),
        TOD,
      )
    }

    await page.addStyleTag({ content: HUD_HIDE })

    // Let the wave field develop, then freeze for sharp, consistent captures.
    await page.waitForTimeout(WARMUP)
    await page.evaluate(() =>
      (window as unknown as { __watertune: { freeze(v: boolean): void } }).__watertune.freeze(true),
    )

    const written: string[] = []
    for (const entry of LOOK_SET) {
      await page.evaluate((e) => {
        const api = (
          window as unknown as {
            __watertune: { resetLook(): void; applyLook(o: Record<string, number>): void }
          }
        ).__watertune
        api.resetLook()
        if (e.look) api.applyLook(e.look)
      }, entry)
      // A couple frames for the uniform change to land on the GPU.
      await page.waitForTimeout(250)

      for (const pose of POSES) {
        await page.evaluate((p) => {
          ;(
            window as unknown as {
              __watertune: { pose(a: number[], b: number[]): void }
            }
          ).__watertune.pose(p.pos, p.target)
        }, pose)
        await page.waitForTimeout(220)
        const name = `${entry.label}__${pose.label}.jpg`
        await page.screenshot({
          path: path.join(outDir, name),
          type: 'jpeg',
          quality: 92,
          clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
        })
        written.push(name)
      }
    }

    writeFileSync(
      path.join(outDir, 'index.json'),
      `${JSON.stringify({ id: ID, backend, tod: TOD, warmup: WARMUP, poses: POSES, set: LOOK_SET.map((l) => l.label), written }, null, 2)}\n`,
    )
    console.log(`water-look:${ID}:wrote ${written.length} frames to ${outDir}`)
  })
})
