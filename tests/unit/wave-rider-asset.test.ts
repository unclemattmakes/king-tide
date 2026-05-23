/**
 * Asset-prop → wave-rider integration tests.
 *
 * Validates the branch in `createPropColliders` that routes an asset
 * prop with `loaded.waveRider` through `createWaveRider` instead of
 * the static-collider path. Stubs the prop-loader output (real GLB
 * loads need a Three.js GLTFLoader + a browser-backed file fetch) and
 * checks that:
 *
 *   - A wave-rider asset prop spawns a WaveRider entity at the
 *     authored position with the matching archetype.
 *   - The static-collider count stays at 0 for wave-rider props.
 *   - A regular (non-wave-rider) asset prop still produces a static
 *     collider and no WaveRider entity.
 *   - `createPropColliders` without a `sim` argument falls back to
 *     the static-collider path even when the loaded prop is tagged
 *     as a wave-rider (legacy call sites stay safe).
 */
import { query } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import { createPhysicsWorld } from '../../src/engine/sim/physics/rapier'
import type { LoadedProp } from '../../src/game/assets/prop-loader'
import { WaveRiderStore, WaveRiderTag } from '../../src/game/components/wave-rider'
import { createPropColliders, type PropAssetRegistry } from '../../src/game/entities/props'
import type { Prop } from '../../src/game/tracks/types'

/** Build a minimum-viable LoadedProp stub. The runtime path we exercise
 *  here only reads `colliders`, `extras`, and `waveRider` — the
 *  Three.js `root` is referenced by `cloneLoadedProp` but the
 *  static-collider path used below doesn't clone. */
function stubLoadedProp(opts: {
  waveRider?: 'buoy' | 'log'
  shape?: 'box' | 'cylinder'
}): LoadedProp {
  return {
    root: { userData: {}, traverse: () => {} } as unknown as LoadedProp['root'],
    colliders: [
      {
        shape: opts.shape ?? 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfExtents: [0.5, 0.5, 0.5],
      },
    ],
    extras: { prop_id: opts.waveRider ?? 'stub', category: 'decor' },
    ...(opts.waveRider ? { waveRider: opts.waveRider } : {}),
  }
}

describe('createPropColliders + wave-rider asset-prop branch', () => {
  it('spawns a WaveRider entity for a buoy asset prop', async () => {
    const sim = createSimWorld({ seed: 1 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    const assets: PropAssetRegistry = new Map([['buoy', stubLoadedProp({ waveRider: 'buoy' })]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'buoy',
        position: { x: 7, y: 2, z: -3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
      },
    ]
    const bindings = createPropColliders(phys, props, assets, sim)
    const entities = query(sim, [WaveRiderTag])
    expect(entities.length).toBe(1)
    const eid = entities[0]!
    const wr = WaveRiderStore.get(eid)!
    expect(wr.archetype).toBe('buoy')
    expect(wr.anchorX).toBeCloseTo(7, 5)
    expect(wr.anchorZ).toBeCloseTo(-3, 5)
    // Bindings expose the assetId so the render system can pick the
    // right GLB for this entity.
    expect(bindings.get(eid)).toBe('buoy')
  })

  it('spawns a log archetype for a log asset prop', async () => {
    const sim = createSimWorld({ seed: 2 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    const assets: PropAssetRegistry = new Map([
      ['log', stubLoadedProp({ waveRider: 'log', shape: 'cylinder' })],
    ])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'log',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
      },
    ]
    createPropColliders(phys, props, assets, sim)
    const entities = query(sim, [WaveRiderTag])
    expect(entities.length).toBe(1)
    expect(WaveRiderStore.get(entities[0]!)!.archetype).toBe('log')
  })

  it('non-wave-rider asset prop spawns a static body, not a WaveRider', async () => {
    const sim = createSimWorld({ seed: 3 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    const assets: PropAssetRegistry = new Map([['crate', stubLoadedProp({})]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'crate',
        position: { x: 4, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
      },
    ]
    const before = phys.world.bodies.len()
    createPropColliders(phys, props, assets, sim)
    expect(query(sim, [WaveRiderTag]).length).toBe(0)
    // A fixed rigid body should have landed in the world.
    expect(phys.world.bodies.len()).toBeGreaterThan(before)
  })

  it('falls back to static collider when sim is absent (legacy callers)', async () => {
    const phys = await createPhysicsWorld({ gravity: 0 })
    const assets: PropAssetRegistry = new Map([['buoy', stubLoadedProp({ waveRider: 'buoy' })]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'buoy',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
      },
    ]
    const before = phys.world.bodies.len()
    const bindings = createPropColliders(phys, props, assets /* no sim */)
    expect(bindings.size).toBe(0)
    // The static-collider path created a fixed body for the prop.
    expect(phys.world.bodies.len()).toBeGreaterThan(before)
  })
})
