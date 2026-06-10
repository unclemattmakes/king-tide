/**
 * Wind-trail gust verification. Boots Sandbar into a live race with the
 * ambient wind strokes on, waits for the pool to fade in on the wave-field
 * clock, and asserts live gusts via the `__windTrails` dev hook (camera-
 * independent). Screenshots land in artifacts/wind/ (test-results/ is wiped
 * per run) for the eyeball pass — strokes should read as white calligraphic
 * gusts, some carrying a loop-de-loop curl.
 *
 *   E2E_PORT=5397 pnpm e2e tests/e2e/wind-trails.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const TRACK = process.env.BOOT_TRACK ?? 'sandbar'

type WindHook = {
  activeCount(): number
  isEnabled(): boolean
}

function hook(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = (
      window as unknown as { __windTrails?: { activeCount(): number; isEnabled(): boolean } }
    ).__windTrails
    return w ? { active: w.activeCount(), enabled: w.isEnabled() } : null
  })
}

test.describe('wind trails', () => {
  test('gusts go live in a race and render', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })

    // Pool births are staggered across ~5 s of wave-field time — wait until a
    // healthy share of the field is mid-stroke.
    await page.waitForFunction(
      () => {
        const w = (window as unknown as { __windTrails?: WindHook }).__windTrails
        return (w?.activeCount() ?? 0) >= 3
      },
      null,
      { timeout: 30_000 },
    )

    const first = await hook(page)
    expect(first).not.toBeNull()
    expect(first!.enabled).toBe(true)
    expect(first!.active).toBeGreaterThanOrEqual(3)

    // Three beats a couple seconds apart — strokes at different window
    // phases, hopefully a curl in frame somewhere.
    await page.screenshot({ path: 'artifacts/wind/wind-on-1.png' })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: 'artifacts/wind/wind-on-2.png' })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: 'artifacts/wind/wind-on-3.png' })

    const later = await hook(page)
    // The pool keeps cycling — still live minutes-of-frames later.
    expect(later!.active).toBeGreaterThanOrEqual(3)
  })

  test('regimes split: curly ambient gusts when still, straight speed-lines racing', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })

    type Dbg = { blend: number; hasLoop: boolean; active: boolean }
    type DbgHook = { debug(): Dbg[] }
    const sample = () =>
      page.evaluate(
        () =>
          (window as unknown as { __windTrails?: { debug(): Dbg[] } }).__windTrails?.debug() ?? [],
      )
    const stats = (trails: Dbg[]) => ({
      n: trails.length,
      meanBlend: trails.reduce((s, t) => s + t.blend, 0) / Math.max(1, trails.length),
      loopFrac: trails.filter((t) => t.hasLoop).length / Math.max(1, trails.length),
    })

    // Still on the start line (autostart leaves the player parked): the pool
    // spawns under the ambient regime — true-wind speed. Curls are a rare
    // flourish by design (CURL_CHANCE_STILL), so only the blend is asserted
    // here; loopChance semantics are pinned at the unit layer.
    await page.waitForFunction(
      () => {
        const w = (window as unknown as { __windTrails?: DbgHook }).__windTrails
        return (w?.debug().filter((t) => t.active).length ?? 0) >= 3
      },
      null,
      { timeout: 30_000 },
    )
    const still = stats(await sample())
    expect(still.meanBlend).toBeLessThan(0.15)

    // Auto-play drives the player up to race speed. Trail lives are short in
    // the speed regime, so the pool recycles onto speed-spawned curves within
    // a few seconds of sustained pace — wait on the pool state itself rather
    // than a fixed clock (AI pace varies run to run).
    await page.evaluate(() => {
      if (!window.__hover?.isAutoPlay()) window.__hover?.toggleAutoPlay()
    })
    await page.waitForFunction(
      () => {
        const w = (window as unknown as { __windTrails?: DbgHook }).__windTrails
        const t = w?.debug() ?? []
        if (t.length === 0) return false
        return t.reduce((s, x) => s + x.blend, 0) / t.length > 0.6
      },
      null,
      { timeout: 45_000 },
    )
    // The hard rule — at ≥40% of top speed (blend pins to 1) curls never
    // spawn. Sample the recycling pool a few times so the assert covers a few
    // generations of spawns, not one instant.
    const fullSpeed: Dbg[] = []
    let racing = stats(await sample())
    for (let i = 0; i < 3; i++) {
      const trails = await sample()
      racing = stats(trails)
      fullSpeed.push(...trails.filter((t) => t.blend >= 0.999))
      if (i < 2) await page.waitForTimeout(2500)
    }
    console.log(
      `still: blend=${still.meanBlend.toFixed(2)} loops=${still.loopFrac.toFixed(2)} | ` +
        `racing: blend=${racing.meanBlend.toFixed(2)} loops=${racing.loopFrac.toFixed(2)} ` +
        `fullSpeedTrails=${fullSpeed.length}`,
    )
    expect(racing.meanBlend).toBeGreaterThan(0.6)
    expect(fullSpeed.length).toBeGreaterThanOrEqual(5)
    expect(fullSpeed.every((t) => !t.hasLoop)).toBe(true)
  })

  test('?wind=0 boots the gusts disabled', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1&wind=0`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })
    const state = await hook(page)
    expect(state).not.toBeNull()
    expect(state!.enabled).toBe(false)
    await page.screenshot({ path: 'artifacts/wind/wind-off.png' })
  })
})
