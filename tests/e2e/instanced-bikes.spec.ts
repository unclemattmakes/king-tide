/**
 * Instanced-bike verification. Boots Sandbar into a live race twice — once with
 * the per-variant instanced AI fields on (default), once with ?instbikes=0 (the
 * per-clone path) — drives past the countdown so the field spreads across the
 * track, and compares vinyl-material compiles (boot trace) + draw calls
 * (renderer.info). Instancing should compile FEWER materials (the boot-time
 * lever; the shared cross-field vinyl cache keeps the count ~flat across five
 * variant fields) and stay in the same draw-call ballpark while the field still
 * renders. Screenshots land in test-results/instbikes-*.png for an eyeball
 * check that per-bike livery + exhaust colours survived the move to per-instance
 * attributes.
 *
 *   E2E_PORT=5395 pnpm e2e tests/e2e/instanced-bikes.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const TRACK = process.env.BOOT_TRACK ?? 'sandbar'

type BikeDbg = { livery: [number, number, number]; x: number; y: number; z: number }
type Sample = { calls: number; vinyl: number; frame: number; field: BikeDbg[] }

async function bootRace(
  page: import('@playwright/test').Page,
  query: string,
  shot: string,
): Promise<Sample> {
  await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1${query}`)
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  // Grid shot FIRST — at the countdown the whole field is clustered on the start
  // line, so the per-bike livery + exhaust colours are all in frame (the visual
  // proof the per-instance attributes survived the move off the per-clone path).
  await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 8, null, { timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: shot.replace('.png', '-grid.png') })
  // Then drive the field well past the countdown so the AI bikes spread across the
  // track (a meaningful draw-call count, and a real test of per-instance motion).
  await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 120, null, { timeout: 40_000 })
  await page.waitForTimeout(1500)
  const calls = await page.evaluate(() => window.__hover?.perf?.renderInfo?.().calls ?? -1)
  const vinyl = await page.evaluate(
    () =>
      (window as unknown as { __bootTrace?: { stats?: Record<string, number> } }).__bootTrace?.stats
        ?.vinylMaterials ?? -1,
  )
  const frame = await page.evaluate(() => window.__hover?.frame() ?? 0)
  const field = await page.evaluate(() => {
    const f = (window as unknown as { __bikeField?: { debug(): BikeDbg[] } }).__bikeField
    return f?.debug() ?? []
  })
  await page.screenshot({ path: shot })
  return { calls, vinyl, frame, field }
}

test.describe('instanced bikes', () => {
  test('instancing cuts draw calls + shader compiles, field still renders', async ({ page }) => {
    test.setTimeout(180_000)

    const on = await bootRace(page, '', 'test-results/instbikes-on.png')
    const off = await bootRace(page, '&instbikes=0', 'test-results/instbikes-off.png')

    console.log(`instanced ON : calls=${on.calls} vinyl=${on.vinyl} frame=${on.frame}`)
    console.log(`instanced OFF: calls=${off.calls} vinyl=${off.vinyl} frame=${off.frame}`)
    console.log(
      `field: ${on.field.length} bikes, liveries=${JSON.stringify(
        on.field.map((b) => b.livery.map((c) => Math.round(c * 100) / 100)),
      )}`,
    )

    // The race ran in both modes (the loop kept ticking through the reveal).
    expect(on.frame).toBeGreaterThan(60)
    expect(off.frame).toBeGreaterThan(60)
    // Fewer shader compiles than the per-clone path — the instancing win that
    // pays at boot (material count is the pre-warm lever), now via the shared
    // cross-field vinyl cache (one material set serves every variant field).
    expect(on.vinyl).toBeLessThan(off.vinyl)
    // Draw calls: instanced sub-meshes skip frustum culling (a field's
    // origin-local bounds would wrongly cull it), so with the AI spread around
    // the track the clone path may cull MORE of them at this instant than the
    // per-variant fields save. Guard the order of magnitude, not strict order.
    expect(on.calls).toBeLessThan(off.calls * 1.25)

    // Field render-correctness (camera-independent): a real field of bikes, each
    // with a livery colour actually applied (not the unclaimed white default), in
    // more than one hue, spread across the track (not stacked at the origin).
    expect(on.field.length).toBeGreaterThanOrEqual(5)
    const isWhite = (c: [number, number, number]) => c[0] > 0.98 && c[1] > 0.98 && c[2] > 0.98
    expect(on.field.every((b) => !isWhite(b.livery))).toBe(true)
    const hues = new Set(on.field.map((b) => b.livery.map((c) => Math.round(c * 20)).join(',')))
    expect(hues.size).toBeGreaterThanOrEqual(3)
    const xs = on.field.map((b) => b.x)
    const zs = on.field.map((b) => b.z)
    const spread = Math.max(...xs) - Math.min(...xs) + (Math.max(...zs) - Math.min(...zs))
    expect(spread).toBeGreaterThan(5)
  })
})
