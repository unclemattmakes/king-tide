import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

/**
 * Mayday Bay's docks must have collision.
 *
 * The docks are authored as a `decoration` plank deck (renders, never
 * collides) paired with a `collider_mesh` swept slab (collides, never
 * renders) — so the slab is the docks' ONLY collision. Sandbar is the one
 * shipped track with a decimated collision proxy, `sandbar-collider.glb`,
 * which `track-loader.ts` colliders INSTEAD of the render geometry. When the
 * proxy builder strips `collider_mesh`, both dock ramps render normally and
 * the bike flies straight through. That shipped until 2026-08-20; see
 * `NON_COLLIDING_KINDS` in `src/engine/render/glb-track.ts` and
 * `tools/blender/build_track_collider.py`.
 *
 * The assertion reads the proxy the game actually fetched and checks it
 * carries the undecimated dock-collider object. It is deliberately an
 * assertion about the SHIPPED ASSET, not just the builder source: the two
 * drift independently, and `.env` points `/assets/**` at R2 even in dev, so a
 * correct builder with a stale proxy on R2 is exactly the state that leaves
 * the bug live. A red run here usually means "rebuild and `pnpm assets:push`".
 *
 * The screenshots are for eyeballing the colliders — collision wireframe on,
 * water + visual dressing hidden, so the bare dock slabs stand alone. To shoot
 * against your LOCAL `public/assets` copy instead of R2, override the base:
 *   VITE_ASSET_BASE_URL= E2E_PORT=5399 pnpm e2e dock-collision.spec.ts
 */

/** Camera beats over each dock, derived from the `Dock_Demo.00N_autocol`
 *  world bounds in `sandbar.glb`. Dock 2 is the readable one — a pier ramp
 *  climbing 15 m out of the water. Dock 1's jetty lies close enough to the
 *  shallow seabed that its slab is hard to pick out of the terrain mesh. */
const SHOTS = [
  { id: 'dock-1-jetty', pos: { x: 108, y: 16, z: 34 }, target: { x: 82, y: 1, z: 66 } },
  { id: 'dock-2-pier', pos: { x: 183, y: 30, z: 62 }, target: { x: 183, y: 10, z: 18 } },
]

/** Object name `build_track_collider.py` gives the joined, undecimated
 *  `collider_mesh` proxies. Its absence means the proxy was baked by a
 *  builder that dropped them. */
const EXACT_OBJECT = 'HV_TrackColliderExact'

// Serial: both tests boot the full sandbar track, and two concurrent WebGPU
// boots on one GPU — each pulling ~25 MB of R2 assets — blow the 30 s
// grounded-bike gate in `waitFullyBooted`.
test.describe.configure({ mode: 'serial' })

test.describe('Mayday Bay dock collision', () => {
  test('the shipped collision proxy carries the dock collider slabs', async ({ page }) => {
    const proxyUrls: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('sandbar-collider')) proxyUrls.push(r.url())
    })

    await page.goto('/?track=sandbar&autostart=1')
    await waitFullyBooted(page)

    const url = proxyUrls[0] ?? ''
    expect(url, 'race boot never fetched sandbar-collider.glb').not.toBe('')

    // Parse the GLB's JSON chunk out of the very bytes the game loaded.
    const nodes = await page.evaluate(async (proxyUrl) => {
      const buf = await (await fetch(proxyUrl)).arrayBuffer()
      const view = new DataView(buf)
      let offset = 12 // past the 12-byte GLB header
      while (offset + 8 <= buf.byteLength) {
        const len = view.getUint32(offset, true)
        const type = view.getUint32(offset + 4, true)
        if (type === 0x4e4f534a /* "JSON" */) {
          const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset + 8, len)))
          return (json.nodes ?? []).map((n: { name?: string; extras?: { kind?: string } }) => ({
            name: n.name ?? '',
            kind: n.extras?.kind ?? '',
          }))
        }
        offset += 8 + len
      }
      throw new Error('no JSON chunk in collision proxy')
    }, url)

    const exact = nodes.find((n: { name: string }) => n.name === EXACT_OBJECT)
    expect(
      exact,
      `${url} has no "${EXACT_OBJECT}" object, so Mayday Bay's dock ramps have no ` +
        'collision. Rebuild the proxy and publish it:\n' +
        '  & $env:BLENDER_EXE --background --python tools/blender/build_track_collider.py -- ' +
        'public/assets/tracks/sandbar.glb public/assets/tracks/sandbar-collider.glb\n' +
        '  pnpm assets:push',
    ).toBeTruthy()
    expect(exact?.kind, `${EXACT_OBJECT} must stay tagged collider_mesh to be collided`).toBe(
      'collider_mesh',
    )
  })

  test('collider close-ups for eyeballing the dock slabs', async ({ page }) => {
    await page.goto('/?track=sandbar&autostart=1')
    await waitFullyBooted(page)

    const on = await page.evaluate(() => {
      // Strip the scene back to just Rapier's wireframe: the dock slab sits
      // INSIDE the visible deck volume, so with the dressing drawn the
      // depth-tested collider lines are hidden behind their own planks.
      window.__hover?.waterDebug()?.setWaterVisible?.(false)
      window.__hover?.scenery()?.setVisible(false)
      document.getElementById('dev-dock')?.style.setProperty('display', 'none')
      return window.__hover?.toggleCollisionDebug()
    })
    expect(on, 'collision debug should be ON after one toggle').toBe(true)
    // Let the countdown lights settle so successive shots are comparable.
    await page.waitForTimeout(7000)

    const suffix = process.env.DOCK_SHOT_SUFFIX ?? ''
    for (const shot of SHOTS) {
      await page.evaluate(({ pos, target }) => window.__hover?.setCameraPose({ pos, target }), shot)
      await page.waitForTimeout(700)
      await page.screenshot({ path: `test-results/dock-collision-${shot.id}${suffix}.png` })
    }
    await page.evaluate(() => window.__hover?.setCameraPose(null))
  })
})
