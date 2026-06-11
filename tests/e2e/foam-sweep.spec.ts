/**
 * Foam-coverage sweep — captures the water shader at several whitecap
 * settings on ONE frozen wave + fixed camera, so the foam-coverage pass
 * (docs/water-foam-look-plan.md) can be dialed in apples-to-apples without
 * re-booting per value. Real GPU (headed Chromium, like gen-track-shots).
 *
 * Drives `window.__hover.waterDebug()` (the live WaterMesh.debug surface)
 * to scrub setWhitecapHeight / setWhitecapSlope / setWhitecapMode between
 * shots. Time is frozen (timeScale 0) and the camera parked at a fixed pose
 * so only the foam settings change frame-to-frame.
 *
 * Gated on FOAM_SWEEP=1. Env knobs:
 *   FOAM_SWEEP_TRACK   track id                         (default "the-maw")
 *   FOAM_SWEEP_TOD     time-of-day override (?tod=)     (default "285" = sunset)
 *   FOAM_SWEEP_POSE    JSON {pos:[x,y,z],target:[x,y,z]} fixed camera
 *   FOAM_SWEEP_GRID    JSON [{label,h,s,m}]             (default grid below)
 *   FOAM_SWEEP_FREEZE  "0" keeps waves moving           (default freeze)
 *
 * Output: test-results/foam-sweep/<track>/<label>.jpg + index.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const SHOT_W = 1280
const SHOT_H = 720

const TRACK = process.env.FOAM_SWEEP_TRACK ?? 'the-maw'
const TOD = process.env.FOAM_SWEEP_TOD ?? '285'
const FREEZE = process.env.FOAM_SWEEP_FREEZE !== '0'

// FOAM_SWEEP_WARMTH=1 switches to the warm-tint calibration: an INTO-sun
// pose (so the sunBackscatter rake fires hardest) + a foamWarmth grid.
const WARMTH_MODE = process.env.FOAM_SWEEP_WARMTH === '1'
// FOAM_SWEEP_STREAK=1 sweeps the directional-streak strength on the
// across-swell coverage pose (where wave faces are most visible).
const STREAK_MODE = process.env.FOAM_SWEEP_STREAK === '1'
// FOAM_SWEEP_AB=1 captures a clean before/after on one frozen wave: the full
// legacy look (every foam knob off) vs the shipped foam-pass defaults.
const AB_MODE = process.env.FOAM_SWEEP_AB === '1'
// FOAM_SWEEP_READABILITY=1 sweeps the P1 readability layers (posterized value
// ramp + contour-line foam + Wind-Waker relief pair — water-next-research §8
// P1) on the coverage pose: off → shipped defaults → each layer isolated →
// strong, so the A/B grid shows exactly what each layer buys.
const READABILITY_MODE = process.env.FOAM_SWEEP_READABILITY === '1'
// FOAM_SWEEP_BRUSH=1 A/Bs the foam break-up pattern (oil-stroke rework):
// legacy round-disc bubbles vs swell-combed oil-paint strokes, with the
// face-streak layer off/on/strong around each.
const BRUSH_MODE = process.env.FOAM_SWEEP_BRUSH === '1'
// FOAM_SWEEP_CBREAK=1 A/Bs the contour-line break-up: solid unbroken iso
// lines vs trough-biased brush dashes, at shipped and boosted contour
// strength so the dash structure is legible in the captures.
const CBREAK_MODE = process.env.FOAM_SWEEP_CBREAK === '1'
// FOAM_SWEEP_RISE=1 sweeps the rising-face strokes — the crest-PERPENDICULAR
// brush marks that climb the leading face of an approaching wave (the vertical
// partner of the contour crest lines). off → default → strong → max, plus a
// strokes-alone (contours off) frame for the orientation read and a
// strokes+contours frame for the cross-hatch.
const RISE_MODE = process.env.FOAM_SWEEP_RISE === '1'
// FOAM_SWEEP_ISO=1 isolates the rising-face strokes: zeroes every other foam /
// readability layer (whitecap, foam streaks, contours, brush, langmuir, ramp)
// so the strokes show ALONE on bare swell — the decisive orientation read
// (do they climb the face, perpendicular to the crest?).
const ISO_MODE = process.env.FOAM_SWEEP_ISO === '1'

type Pose = { pos: [number, number, number]; target: [number, number, number] }
// Coverage pose: elevated over The Maw's mid-section, looking DOWN (~33°) and
// ACROSS the swell train (toward -z) so wave faces + crest lines are visible
// rather than edge-on. The low sun (toward +x at tod 285) rakes from the right.
const COVERAGE_POSE: Pose = { pos: [-200, 50, -120], target: [-200, -3, -205] }
// Warmth pose: lower + looking toward the low sun (+x) so the warm foam rake
// is at its strongest — the worst case for "does it go orange/muddy?".
const WARMTH_POSE: Pose = { pos: [-235, 14, -150], target: [-150, -2, -150] }
const DEFAULT_POSE: Pose = WARMTH_MODE && !AB_MODE ? WARMTH_POSE : COVERAGE_POSE
const POSE: Pose = process.env.FOAM_SWEEP_POSE
  ? (JSON.parse(process.env.FOAM_SWEEP_POSE) as Pose)
  : DEFAULT_POSE

// `w` = foamWarmth, `st` = foamStreak (both default to the shipped 1.0).
// Readability fields (P1): `ramp`/`steps`/`post` = value-ramp strength /
// bands / posterize, `cs`/`csp`/`rel` = contour strength / spacing / relief.
// Whitecap h/s/m are optional so readability variants can leave the foam
// stack at its live defaults instead of forcing values through the setters.
type Variant = {
  label: string
  h?: number
  s?: number
  m?: number
  w?: number
  st?: number
  /** foamBrush — disc-bubble (0) ↔ oil-stroke (1) foam break-up. */
  br?: number
  ramp?: number
  steps?: number
  post?: number
  cs?: number
  csp?: number
  rel?: number
  /** contourBreakup — solid iso lines (0) ↔ trough-biased brush dashes (1). */
  cb?: number
  /** riseStroke — crest-perpendicular rising-face strokes, 0..2. */
  rise?: number
  /** Isolation: zero every other foam/readability layer so only the rising
   *  strokes paint (decisive orientation read on bare swell). */
  iso?: boolean
}
const COVERAGE_GRID: Variant[] = [
  { label: '0-legacy', h: 1.0, s: 0.3, m: 0.0 }, // the old glassy gate (sanity floor)
  { label: '1-overshoot', h: 0.45, s: 0.14, m: 0.6 }, // the uniform-wash we just saw
  { label: '2-crest', h: 0.6, s: 0.32, m: 0.3 },
  { label: '3-balanced', h: 0.55, s: 0.3, m: 0.35 },
  { label: '4-mid', h: 0.5, s: 0.28, m: 0.4 },
  { label: '5-loose', h: 0.5, s: 0.24, m: 0.45 },
  { label: '6-tight', h: 0.65, s: 0.34, m: 0.28 },
]
// Warm-tint calibration: hold coverage at the shipped default, sweep foamWarmth.
const WARMTH_GRID: Variant[] = [
  { label: '0-flat-white', h: 0.55, s: 0.3, m: 0.35, w: 0.0 },
  { label: '1-warmth-0.6', h: 0.55, s: 0.3, m: 0.35, w: 0.6 },
  { label: '2-warmth-1.0', h: 0.55, s: 0.3, m: 0.35, w: 1.0 },
  { label: '3-warmth-1.4', h: 0.55, s: 0.3, m: 0.35, w: 1.4 },
  { label: '4-warmth-2.0', h: 0.55, s: 0.3, m: 0.35, w: 2.0 },
]
// Streak calibration: hold coverage + warmth at the shipped (concentrated)
// defaults, sweep the directional-streak strength.
const STREAK_GRID: Variant[] = [
  { label: '0-no-streak', h: 0.8, s: 0.42, m: 0.2, st: 0.0 },
  { label: '1-streak-0.5', h: 0.8, s: 0.42, m: 0.2, st: 0.5 },
  { label: '2-streak-1.0', h: 0.8, s: 0.42, m: 0.2, st: 1.0 },
  { label: '3-streak-1.5', h: 0.8, s: 0.42, m: 0.2, st: 1.5 },
  { label: '4-streak-2.0', h: 0.8, s: 0.42, m: 0.2, st: 2.0 },
]
// Before/after: full legacy foam (every knob at its pre-pass value) vs the
// shipped defaults, on the same frozen wave + pose.
const AB_GRID: Variant[] = [
  { label: 'before-legacy', h: 1.0, s: 0.3, m: 0.0, w: 0.0, st: 0.0 },
  { label: 'after-foampass', h: 0.55, s: 0.3, m: 0.35, w: 1.0, st: 1.0 },
]
// Foam-brush A/B (oil-stroke rework): the legacy disc-bubble break-up vs
// oil-paint strokes, each with the face-streak layer off and on, plus a
// strong-streak variant. Whitecap coverage stays at its live defaults so the
// ONLY thing changing is the foam's texture treatment.
const BRUSH_GRID: Variant[] = [
  { label: '0-discs', br: 0, st: 0 },
  { label: '1-discs-streaks', br: 0, st: 1 },
  { label: '2-oil-mass-only', br: 1, st: 0 },
  { label: '3-oil-full', br: 1, st: 1 },
  { label: '4-oil-strong-streaks', br: 1, st: 1.6 },
]
// Contour break-up A/B: the same frozen wave with solid lines (pre-breakup
// look), the shipped dash default, and the half setting — then the pair
// again at boosted contour strength where the dash structure is easiest to
// judge. Everything else stays at live defaults.
const CBREAK_GRID: Variant[] = [
  { label: '0-solid', cb: 0 },
  { label: '1-half', cb: 0.5 },
  { label: '2-default', cb: 1 },
  { label: '3-strong-contours-solid', cs: 1.0, cb: 0 },
  { label: '4-strong-contours-broken', cs: 1.0, cb: 1 },
]
// P1 readability A/B: layers off (pre-P1 look) → shipped defaults → each
// layer isolated → strong. Foam knobs untouched (live defaults).
const READABILITY_GRID: Variant[] = [
  { label: '0-off', ramp: 0, steps: 3, post: 0.7, cs: 0, csp: 0.45, rel: 0.6 },
  { label: '1-default', ramp: 0.45, steps: 3, post: 0.7, cs: 0.55, csp: 0.45, rel: 0.6 },
  { label: '2-ramp-only', ramp: 0.45, steps: 3, post: 0.7, cs: 0, csp: 0.45, rel: 0.6 },
  { label: '3-contours-only', ramp: 0, steps: 3, post: 0.7, cs: 0.55, csp: 0.45, rel: 0.6 },
  { label: '4-contours-no-relief', ramp: 0, steps: 3, post: 0.7, cs: 0.55, csp: 0.45, rel: 0 },
  { label: '5-strong', ramp: 0.8, steps: 3, post: 1.0, cs: 1.0, csp: 0.35, rel: 0.9 },
  { label: '6-bands-2', ramp: 0.6, steps: 2, post: 1.0, cs: 0.55, csp: 0.45, rel: 0.6 },
  { label: '7-bands-4', ramp: 0.6, steps: 4, post: 1.0, cs: 0.55, csp: 0.45, rel: 0.6 },
]
// Rising-face stroke sweep: off → default → strong → max on the live default
// look (contours stay on, so default/strong frames show the cross-hatch of
// crest lines × up-face strokes), then strokes-alone (contours off) to read
// the orientation cleanly, then strokes + boosted contours for the full hatch.
const RISE_GRID: Variant[] = [
  { label: '0-off', rise: 0 },
  { label: '1-default', rise: 0.5 },
  { label: '2-strong', rise: 1.0 },
  { label: '3-max', rise: 2.0 },
  { label: '4-strong-no-contour', rise: 1.0, cs: 0 },
  { label: '5-strong-with-contour', rise: 1.0, cs: 0.9 },
]
// Isolation grid: strokes alone on bare swell, off vs strong, so the diff is
// purely the strokes and their up-the-face orientation is unambiguous.
const ISO_GRID: Variant[] = [
  { label: 'iso-off', iso: true, rise: 0 },
  { label: 'iso-default', iso: true, rise: 0.5 },
  { label: 'iso-strong', iso: true, rise: 1.5 },
]
// First mode whose flag is set wins; FOAM_SWEEP_GRID overrides everything.
const MODE_GRIDS: ReadonlyArray<readonly [boolean, Variant[]]> = [
  [ISO_MODE, ISO_GRID],
  [RISE_MODE, RISE_GRID],
  [CBREAK_MODE, CBREAK_GRID],
  [BRUSH_MODE, BRUSH_GRID],
  [READABILITY_MODE, READABILITY_GRID],
  [AB_MODE, AB_GRID],
  [WARMTH_MODE, WARMTH_GRID],
  [STREAK_MODE, STREAK_GRID],
]
const GRID: Variant[] = process.env.FOAM_SWEEP_GRID
  ? (JSON.parse(process.env.FOAM_SWEEP_GRID) as Variant[])
  : (MODE_GRIDS.find(([on]) => on)?.[1] ?? COVERAGE_GRID)

test.describe('foam coverage sweep', () => {
  test.skip(process.env.FOAM_SWEEP !== '1', 'gated on FOAM_SWEEP=1')

  test(`${TRACK} foam sweep`, async ({ page }) => {
    test.setTimeout(120_000)
    const outDir = path.join(process.cwd(), 'test-results', 'foam-sweep', TRACK)
    mkdirSync(outDir, { recursive: true })

    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    await page.goto(`/?autostart=1&track=${TRACK}&tod=${TOD}`)
    await waitForReady(page)

    // Autopilot so the field clears the start grid, then settle.
    await page.evaluate(() => {
      if (!window.__hover!.isAutoPlay()) window.__hover!.toggleAutoPlay()
      if (window.__hover!.isDirectionArrowOn()) window.__hover!.toggleDirectionArrow()
    })
    await page.keyboard.press('Enter')
    await page.addStyleTag({
      content:
        '#hud,#hud-scaffold,#race-timer,#race-banner,#race-gap,#race-minimap,#race-intro-ui,#race-intro-skip,#hud-positions,#devsettings-toggle,#water-debug-toggle,#garage-toggle,#loading-screen,#dev-dock{display:none!important}',
    })
    await page.waitForTimeout(6000)

    // Park the camera + (optionally) freeze the wave field so only foam
    // settings vary across the grid.
    await page.evaluate(
      ({ pose, freeze }) => {
        window.__hover!.setCameraPose({
          pos: { x: pose.pos[0], y: pose.pos[1], z: pose.pos[2] },
          target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
        })
        if (freeze) window.__hover!.waterDebug()?.setTimeScale(0)
      },
      { pose: POSE, freeze: FREEZE },
    )
    await page.waitForTimeout(800)

    const frames: Array<Record<string, unknown>> = []
    for (const v of GRID) {
      await page.evaluate((variant) => {
        const wd = window.__hover!.waterDebug()
        if (!wd) return
        // Isolation: silence every other foam / readability layer so only the
        // rising-face strokes paint (orientation read on bare swell).
        if (variant.iso) {
          wd.setWhitecapCurvature(0)
          wd.setFoamStreak(0)
          wd.setFoamBrush(0)
          wd.setLangmuir(0)
          wd.setContourStrength(0)
          wd.setRampStrength(0)
          wd.setShoreWaveStrength(0)
        }
        // Only drive knobs the variant specifies — readability variants
        // leave the foam stack at its live defaults and vice versa.
        if (variant.h !== undefined) wd.setWhitecapHeight(variant.h)
        if (variant.s !== undefined) wd.setWhitecapSlope(variant.s)
        if (variant.m !== undefined) wd.setWhitecapMode(variant.m)
        if (variant.h !== undefined || variant.w !== undefined) wd.setFoamWarmth(variant.w ?? 1.0)
        if (variant.h !== undefined || variant.st !== undefined) wd.setFoamStreak(variant.st ?? 1.0)
        if (variant.br !== undefined) wd.setFoamBrush(variant.br)
        if (variant.ramp !== undefined) wd.setRampStrength(variant.ramp)
        if (variant.steps !== undefined) wd.setRampSteps(variant.steps)
        if (variant.post !== undefined) wd.setRampPosterize(variant.post)
        if (variant.cs !== undefined) wd.setContourStrength(variant.cs)
        if (variant.csp !== undefined) wd.setContourSpacing(variant.csp)
        if (variant.rel !== undefined) wd.setContourRelief(variant.rel)
        if (variant.cb !== undefined) wd.setContourBreakup(variant.cb)
        if (variant.rise !== undefined) wd.setRiseStroke(variant.rise)
      }, v)
      await page.waitForTimeout(400)
      const name = `${v.label}.jpg`
      await page.screenshot({
        path: path.join(outDir, name),
        type: 'jpeg',
        quality: 92,
        clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
      })
      frames.push({ frame: name, ...v })
    }
    await page.evaluate(() => window.__hover!.setCameraPose(null))

    writeFileSync(
      path.join(outDir, 'index.json'),
      `${JSON.stringify({ track: TRACK, tod: TOD, freeze: FREEZE, pose: POSE, frames }, null, 2)}\n`,
    )
    // eslint-disable-next-line no-console
    console.log(`foam-sweep:${TRACK}:wrote ${frames.length} frames to ${outDir}`)
  })
})
