/**
 * Draw-call census — a one-off diagnostic (not a gate). Boots a dressed track,
 * walks the live scene (window.__scene, dev-only), and buckets every visible
 * renderable by material family, counting colour-pass draws, shadow-pass draws
 * (castShadow), and instancing — then prints it next to renderer.info so "why so
 * many draw calls" becomes a ranked breakdown.
 *
 *   E2E_PORT=5397 BOOT_TRACK=sandbar pnpm e2e tests/e2e/draw-call-census.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const TRACK = process.env.BOOT_TRACK ?? 'sandbar'

test.describe('draw-call census', () => {
  test(`${TRACK}: where the draws come from`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/?autostart=1&track=${TRACK}&skipintro=1`)
    await page.bringToFront()
    await waitForReady(page, { timeout: 60_000 })
    await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 60, null, { timeout: 40_000 })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `test-results/census-${TRACK}.png` })

    const census = await page.evaluate(() => {
      type Obj = {
        isMesh?: boolean
        isInstancedMesh?: boolean
        isSkinnedMesh?: boolean
        visible: boolean
        parent: Obj | null
        name?: string
        castShadow?: boolean
        count?: number
        material?: { name?: string } | Array<{ name?: string }>
      }
      const scene = (window as unknown as { __scene?: { traverse(cb: (o: Obj) => void): void } })
        .__scene
      const info = window.__hover?.perf?.renderInfo?.() ?? {
        calls: -1,
        triangles: -1,
        geometries: -1,
        textures: -1,
      }
      if (!scene) return { info, error: 'no __scene' }

      const visibleEff = (o: Obj | null): boolean => {
        let cur = o
        while (cur) {
          if (!cur.visible) return false
          cur = cur.parent
        }
        return true
      }

      const cats: Record<
        string,
        { color: number; shadow: number; instMeshes: number; instances: number }
      > = {}
      let totalColor = 0
      let totalShadow = 0
      let instMeshes = 0
      let regMeshes = 0
      let instanceDraws = 0

      scene.traverse((obj) => {
        if (!(obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh)) return
        if (!visibleEff(obj)) return
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material
        const mn = mat?.name ?? ''
        let cat = 'other'
        if (mn.startsWith('mat_terrain')) cat = 'terrain'
        else if (mn.startsWith('mat_foliage')) cat = 'foliage'
        else if (mn.startsWith('mat_lava')) cat = 'lava'
        else if (mn.startsWith('mat_vinyl')) cat = 'vinyl (prop/building/bike)'
        else if (/water/i.test(mn) || /water/i.test(obj.name ?? '')) cat = 'water'
        else cat = `other: ${(obj.name || mn || 'unnamed').replace(/\d+$/, '').slice(0, 28)}`

        let c = cats[cat]
        if (!c) {
          c = { color: 0, shadow: 0, instMeshes: 0, instances: 0 }
          cats[cat] = c
        }
        c.color++
        totalColor++
        if (obj.castShadow) {
          c.shadow++
          totalShadow++
        }
        if (obj.isInstancedMesh) {
          c.instMeshes++
          c.instances += obj.count ?? 0
          instMeshes++
          instanceDraws += 1
        } else {
          regMeshes++
        }
      })

      const ranked = Object.entries(cats)
        .map(([k, v]) => ({ cat: k, ...v, total: v.color + v.shadow }))
        .sort((a, b) => b.total - a.total)
      return { info, totalColor, totalShadow, instMeshes, regMeshes, instanceDraws, ranked }
    })

    console.log(`\n=== ${TRACK} draw-call census ===\n${JSON.stringify(census, null, 2)}`)

    // ── renderInfo().calls must be PER-FRAME, not cumulative. renderFrame() resets
    //    renderer.info each frame (three only auto-resets inside its own
    //    setAnimationLoop, which this app's custom rAF loop bypasses). Confirm the
    //    count is small + stable across frames, not a running total that grows
    //    ~N/frame since boot. This guards the renderFrame reset against removal. ──
    const sample = () =>
      page.evaluate(() => ({
        f: window.__hover?.frame() ?? 0,
        c: window.__hover?.perf?.renderInfo?.().calls ?? -1,
      }))
    const s0 = await sample()
    await page.waitForTimeout(1500)
    const s1 = await sample()

    console.log(
      `\n=== ${TRACK} per-frame draw calls ===\n` +
        `  frame${s0.f}=${s0.c}  frame${s1.f}=${s1.c}  (per-frame; cumulative would be in the thousands and rising)`,
    )

    // Per-frame counts are small; a cumulative-since-boot total would be thousands.
    expect(s1.c).toBeGreaterThan(0)
    expect(s1.c).toBeLessThan(500)
    // And stable — not climbing ~N per frame the way the un-reset cumulative did.
    expect(Math.abs(s1.c - s0.c)).toBeLessThan(150)
  })
})
