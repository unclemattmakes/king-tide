/**
 * Wake-trail look harness — drives the player bike through a scripted
 * straight + hard-carve sequence on a solo time-trial boot, captures the
 * wake from a parked camera at each beat, and sanity-asserts the trail
 * bookkeeping. Real GPU (headed Chromium, like foam-sweep) — the trail wake
 * lives in the water shader (TSL Loop + dynamic uniform-array indexing), so
 * a software-GL run would both throttle and under-test it.
 *
 * What the beats show (eye-review artifacts for the look pass):
 *   1-straight  — wake behind a straight run: center churn + edge rails,
 *                 trail-aligned strokes (no polka-dot break-up).
 *   2-turning   — mid-carve: the wake must CURVE along the ridden arc, not
 *                 pivot rigidly with the bike's heading (the old look).
 *   3-dissolve  — throttle released: the laid wake age-fades in place.
 *
 * Assertions (regression net, deliberately coarse):
 *   - no WebGPU / shader errors on the console during the run
 *   - the trail probe reports breadcrumbs laid roughly per meter ridden
 *
 * Gated on WAKE_LOOK=1. Env knobs:
 *   WAKE_LOOK_TRACK  track id        (default "sandbar")
 *   WAKE_LOOK_TOD    ?tod= override  (default track default)
 *
 * Output: test-results/wake-look/<track>/<beat>.jpg
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

const SHOT_W = 1280
const SHOT_H = 720

const TRACK = process.env.WAKE_LOOK_TRACK ?? 'sandbar'
const TOD = process.env.WAKE_LOOK_TOD

type IntentLike = {
  throttle: number
  steer: number
  brake: number
  fire: boolean
  boost: boolean
  pitch: number
  trickLeft: boolean
  trickRight: boolean
}
const intent = (over: Partial<IntentLike>): IntentLike => ({
  throttle: 0,
  steer: 0,
  brake: 0,
  fire: false,
  boost: false,
  pitch: 0,
  trickLeft: false,
  trickRight: false,
  ...over,
})

test.describe('wake trail look', () => {
  test.skip(process.env.WAKE_LOOK !== '1', 'gated on WAKE_LOOK=1')

  test(`${TRACK} wake beats`, async ({ page }) => {
    test.setTimeout(150_000)
    const outDir = path.join(process.cwd(), 'test-results', 'wake-look', TRACK)
    mkdirSync(outDir, { recursive: true })

    const shaderErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return
      const text = msg.text()
      if (/webgpu|wgsl|shader|pipeline|infringe/i.test(text)) shaderErrors.push(text)
    })
    page.on('pageerror', (err) => shaderErrors.push(`pageerror: ${err.message}`))

    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    const tod = TOD ? `&tod=${TOD}` : ''
    await page.goto(`/?autostart=1&track=${TRACK}&tt=1${tod}`)
    await waitFullyBooted(page)
    await page.addStyleTag({
      content:
        '#hud,#hud-scaffold,#race-timer,#race-position-badge,#race-banner,#race-gap,#race-minimap,#race-intro-ui,#race-intro-skip,#hud-positions,#devsettings-toggle,#water-debug-toggle,#garage-toggle,#loading-screen,#dev-dock{display:none!important}',
    })

    // Camera helper: park above-behind the bike's CURRENT heading so the
    // frame looks down the wake. Evaluated fresh per beat.
    const parkCamera = (back: number, up: number) =>
      page.evaluate(
        ({ back, up }) => {
          const p = window.__hover!.player()!
          const v = p.velocity
          const sp = Math.max(Math.hypot(v.x, v.z), 0.001)
          const hx = v.x / sp
          const hz = v.z / sp
          window.__hover!.setCameraPose({
            pos: { x: p.position.x - hx * back, y: p.position.y + up, z: p.position.z - hz * back },
            target: { x: p.position.x - hx * back * 0.3, y: 0, z: p.position.z - hz * back * 0.3 },
          })
        },
        { back, up },
      )
    const drive = (over: Partial<IntentLike>) =>
      page.evaluate((i) => window.__hover!.setIntentOverride(i), intent(over))
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(outDir, `${name}.jpg`),
        type: 'jpeg',
        quality: 92,
        clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
      })

    // Beat 1 — straight run. Build speed for ~8 s so the trail spans its
    // full recorded length, then frame the wake from behind-above.
    await drive({ throttle: 1 })
    await page.waitForTimeout(8000)
    const probeStraight = await page.evaluate(() => {
      const p = window.__hover!.player()!
      return {
        trails: window.__hover!.waterDebug()?.getWakeTrails() ?? [],
        speed: p.speed,
      }
    })
    await parkCamera(30, 16)
    await page.waitForTimeout(250)
    await shot('1-straight')

    // The solo bike must have exactly one trail, breadcrumbs at full ring
    // (8 s of riding ≫ 15 drops × 2.5 m), and an arc that says the
    // breadcrumbs really were laid per-meter-ridden (standing-start
    // acceleration keeps the average speed well under race pace — the
    // bound is deliberately loose).
    expect(probeStraight.trails.length).toBe(1)
    const tr = probeStraight.trails[0]!
    expect(tr.count).toBeGreaterThanOrEqual(10)
    expect(tr.headArc).toBeGreaterThan(40)

    // Beat 2 — sustained hard carve. The wake should bend with the arc.
    await drive({ throttle: 1, steer: 0.85 })
    await page.waitForTimeout(3500)
    await parkCamera(26, 30)
    await page.waitForTimeout(250)
    await shot('2-turning')

    // Beat 3 — release + brake: the bike stops laying wake; the painted
    // trail should dissolve in place over ~WAKE_AGE_TAU seconds.
    await drive({ brake: 1 })
    await page.waitForTimeout(2500)
    await parkCamera(24, 22)
    await page.waitForTimeout(250)
    await shot('3-dissolve')

    await page.evaluate(() => {
      window.__hover!.setCameraPose(null)
      window.__hover!.setIntentOverride(null)
    })

    expect(shaderErrors, `shader/WebGPU console errors:\n${shaderErrors.join('\n')}`).toEqual([])
  })

  test(`${TRACK} race-field wakes (chase cam)`, async ({ page }) => {
    test.setTimeout(120_000)
    const outDir = path.join(process.cwd(), 'test-results', 'wake-look', TRACK)
    mkdirSync(outDir, { recursive: true })

    const shaderErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return
      const text = msg.text()
      if (/webgpu|wgsl|shader|pipeline|infringe/i.test(text)) shaderErrors.push(text)
    })
    page.on('pageerror', (err) => shaderErrors.push(`pageerror: ${err.message}`))

    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    const tod = TOD ? `&tod=${TOD}` : ''
    // Full 8-bike grid this time (no ?tt=1) — every bike lays a trail, and
    // the shot is the real chase-cam gameplay view, mid-pack, where wakes
    // matter most.
    await page.goto(`/?autostart=1&track=${TRACK}${tod}`)
    await waitFullyBooted(page)
    await page.evaluate(() => {
      if (!window.__hover!.isAutoPlay()) window.__hover!.toggleAutoPlay()
      if (window.__hover!.isDirectionArrowOn()) window.__hover!.toggleDirectionArrow()
    })
    await page.keyboard.press('Enter')
    await page.addStyleTag({
      content:
        '#hud,#hud-scaffold,#race-timer,#race-position-badge,#race-banner,#race-gap,#race-minimap,#race-intro-ui,#race-intro-skip,#hud-positions,#devsettings-toggle,#water-debug-toggle,#garage-toggle,#loading-screen,#dev-dock{display:none!important}',
    })
    // Wall-clock waits undercount here: the intro flythrough + countdown eat
    // ~10 s before the race clock starts, and the first stretch of the start
    // straight can be dock (no water contact, no wakes). Gate on RACE time so
    // the pack is genuinely mid-lap on open water.
    await page.waitForFunction(() => (window.__hover!.race()?.raceTime ?? 0) > 12, null, {
      timeout: 60_000,
    })

    const probe = await page.evaluate(() => {
      const p = window.__hover!.player()
      return {
        trails: window.__hover!.waterDebug()?.getWakeTrails() ?? [],
        speed: p?.speed ?? -1,
        pos: p?.position ?? null,
        grounded: p?.isGrounded ?? null,
        auto: window.__hover!.isAutoPlay(),
        race: window.__hover!.race(),
      }
    })
    const trails = probe.trails
    // biome-ignore lint/suspicious/noConsole: failure diagnostics
    console.log('race-field probe:', JSON.stringify(probe))
    await page.screenshot({
      path: path.join(outDir, '4-race-field.jpg'),
      type: 'jpeg',
      quality: 92,
      clip: { x: 0, y: 0, width: SHOT_W, height: SHOT_H },
    })

    // Every grid bike on the water should own a trail by 12 s in. Bikes can
    // be airborne / off-water momentarily, so assert a loose majority.
    expect(trails.length).toBeGreaterThanOrEqual(4)
    expect(shaderErrors, `shader/WebGPU console errors:\n${shaderErrors.join('\n')}`).toEqual([])
  })
})
