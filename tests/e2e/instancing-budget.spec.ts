/**
 * Instancing budget guard — keeps the scene "stupid fast" by failing loudly if a
 * field of identical meshes ships UN-instanced (the buoy-wall regression: 100
 * identical `prop_body` clones = 100 draw calls). A run-time scene census groups
 * every visible NON-instanced mesh by (geometry, material); if any one group is
 * larger than the cap, that field should be an InstancedMesh (or BatchedMesh).
 *
 *   E2E_PORT=5398 GUARD_TRACKS=sandbar,the-maw pnpm e2e tests/e2e/instancing-budget.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

/** Max identical (same geometry + material) non-instanced meshes before a field
 *  MUST be instanced. Above the unavoidable floor (≤8 skinned rider mannequins,
 *  which can't be InstancedMesh-merged), low enough to catch a 100-buoy-style
 *  proliferation or a gate-heavy track that forgot to instance. */
const MAX_IDENTICAL = 16

const TRACKS = (process.env.GUARD_TRACKS ?? 'sandbar').split(',').filter(Boolean)

type Group = { n: number; sample: string; mat: string }

test.describe('instancing budget', () => {
  for (const track of TRACKS) {
    test(`${track}: no un-instanced identical-mesh fields`, async ({ page }) => {
      test.setTimeout(90_000)
      await page.goto(`/?autostart=1&track=${track}&skipintro=1`)
      await page.bringToFront()
      await waitForReady(page, { timeout: 60_000 })
      await page.waitForFunction(() => (window.__hover?.frame() ?? 0) > 60, null, {
        timeout: 40_000,
      })
      await page.waitForTimeout(500)

      const groups: Group[] = await page.evaluate(() => {
        type Obj = {
          isMesh?: boolean
          isInstancedMesh?: boolean
          visible: boolean
          parent: Obj | null
          name?: string
          geometry?: { uuid?: string }
          material?: { name?: string } | Array<{ name?: string }>
        }
        const scene = (window as unknown as { __scene?: { traverse(cb: (o: Obj) => void): void } })
          .__scene
        const vis = (o: Obj | null): boolean => {
          let c = o
          while (c) {
            if (!c.visible) return false
            c = c.parent
          }
          return true
        }
        const counts: Record<string, { n: number; sample: string; mat: string }> = {}
        scene?.traverse((o) => {
          if (!o.isMesh || o.isInstancedMesh) return // only NON-instanced meshes
          if (!vis(o)) return
          const mat = Array.isArray(o.material) ? o.material[0] : o.material
          const matName = mat?.name ?? '?'
          const key = `${o.geometry?.uuid ?? '?'}|${matName}`
          let e = counts[key]
          if (!e) {
            e = { n: 0, sample: o.name ?? matName, mat: matName }
            counts[key] = e
          }
          e.n++
        })
        return Object.values(counts)
          .sort((a, b) => b.n - a.n)
          .slice(0, 6)
      })

      console.log(`${track} worst identical non-instanced groups: ${JSON.stringify(groups)}`)
      const worst = groups[0]
      expect(
        worst?.n ?? 0,
        `Instance the '${worst?.sample}' (${worst?.mat}) field — ${worst?.n} identical ` +
          `un-instanced meshes, cap ${MAX_IDENTICAL}. Use an InstancedMesh/BatchedMesh.`,
      ).toBeLessThanOrEqual(MAX_IDENTICAL)
    })
  }
})
