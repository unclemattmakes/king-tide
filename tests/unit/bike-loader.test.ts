import { describe, expect, it } from 'vitest'
import { type GltfRoot, parseGlbJson } from '@/game/tracks/glb-loader'
import { readAssetBytes } from './helpers/assets'

// Compiled GLBs are not in git — they're served from R2 and gitignored (see
// docs/asset-storage.md), so they're absent until `pnpm assets:pull` and in
// CI's deliberately asset-free `check-and-build` job. Skip with a stated
// reason rather than failing on a missing file; every environment that *has*
// the bytes (local dev, hydrated CI jobs) still exercises the contract below.
const racer = readAssetBytes('bikes/racer.glb')

/**
 * Bike GLB contract test.
 *
 * The runtime `bike-loader.ts` resolves nodes by their glTF `extras.kind`
 * tag (Three.js GLTFLoader maps `extras` to `userData`). This test
 * verifies the contract directly off the bytes the build pipeline
 * produced — same fixture the runtime fetches in production. If the
 * builder ever stops emitting one of these nodes, the runtime breaks
 * silently; this test catches the regression headlessly.
 */
describe.skipIf(!racer.available)(racer.describeSuffix('bike GLB contract — racer.glb'), () => {
  // The body still runs to collect tests even when skipped, so keep the parse
  // behind the availability check.
  const gltf: GltfRoot = racer.available ? parseGlbJson(racer.arrayBuffer()) : { nodes: [] }
  const nodes = gltf.nodes ?? []

  it('contains exactly one bike_root with the canonical extras', () => {
    const bikeRoots = nodes.filter((n) => n.extras?.kind === 'bike')
    expect(bikeRoots).toHaveLength(1)
    const root = bikeRoots[0]!
    expect(root.name).toBe('bike_root')
    expect(root.extras?.bike_id).toBe('racer')
    expect(typeof root.extras?.mass_kg).toBe('number')
    expect(typeof root.extras?.top_speed_mps).toBe('number')
    expect(typeof root.extras?.hover_height).toBe('number')
  })

  it('exposes the standard socket set with named slots', () => {
    const required = ['seat', 'nose_cam', 'fx_thruster_l', 'fx_thruster_r', 'fx_exhaust']
    const sockets = nodes.filter((n) => n.extras?.kind === 'socket')
    expect(sockets.length).toBeGreaterThanOrEqual(required.length)
    const slots = sockets.map((n) => n.extras?.slot as string).sort()
    for (const slot of required) {
      expect(slots).toContain(slot)
    }
    // Each socket's name follows socket_<slot>.
    for (const sock of sockets) {
      expect(sock.name).toBe(`socket_${sock.extras?.slot}`)
    }
  })

  it('declares at least one primitive collider with three-axis half_extents', () => {
    const colliders = nodes.filter((n) => n.extras?.kind === 'collider')
    expect(colliders.length).toBeGreaterThanOrEqual(1)
    const body = colliders.find((n) => n.name === 'collider_body')
    expect(body).toBeDefined()
    expect(body?.extras?.shape).toBe('box')
    const he = body?.extras?.half_extents as unknown
    expect(Array.isArray(he)).toBe(true)
    expect((he as number[]).length).toBe(3)
    // racer spec: width 0.6, height 0.4, length 2.5 →
    // half_extents [W*0.55, H*0.6, L*0.5] in three axes [right, up, fwd].
    expect((he as number[])[0]).toBeCloseTo(0.6 * 0.55, 5)
    expect((he as number[])[1]).toBeCloseTo(0.4 * 0.6, 5)
    expect((he as number[])[2]).toBeCloseTo(2.5 * 0.5, 5)
  })

  it('renames kit materials to per-bike role-prefixed names', () => {
    const materials = (gltf as { materials?: { name?: string }[] }).materials ?? []
    const names = materials.map((m) => m.name ?? '')
    // The AI-conditioned bikes carry the per-bike role-prefixed materials the
    // runtime recolours from the spec: chassis / livery / glow. (The earlier
    // procedural kit also pinned a `_fork` role; the AI bikes don't emit a
    // separate fork material, so it's dropped from the contract.)
    const expected = ['mat_bike_racer_chassis', 'mat_bike_racer_livery', 'mat_bike_racer_glow']
    for (const e of expected) {
      expect(names).toContain(e)
    }
    // No bare kit-prefixed materials should leak through.
    for (const n of names) {
      expect(n.startsWith('mat_kit_bike_')).toBe(false)
    }
  })
})
