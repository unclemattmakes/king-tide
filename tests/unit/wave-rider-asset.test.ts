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
import {
  deriveWaveRiderTuning,
  WaveRiderStore,
  WaveRiderTag,
} from '../../src/game/components/wave-rider'
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
    animations: [],
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

  it('lifts the static collider by the GLB collider local offset (scaled by size)', async () => {
    // Regression: library props like the shipping container pivot at their
    // BASE, with the collider carrying a +Y offset to sit at the model centre.
    // The collider must inherit that offset (scaled per-axis), or it sinks
    // below the visible mesh — see addAssetPropColliders.
    const phys = await createPhysicsWorld({ gravity: 0 })
    const loaded: LoadedProp = {
      root: { userData: {}, traverse: () => {} } as unknown as LoadedProp['root'],
      colliders: [
        {
          shape: 'box',
          position: { x: 0, y: 2, z: 0 }, // collider centre offset above the base pivot
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          halfExtents: [4, 2, 1.9],
        },
      ],
      extras: { prop_id: 'container', category: 'decor' },
      animations: [],
    }
    const assets: PropAssetRegistry = new Map([['container', loaded]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'container',
        position: { x: 10, y: 0, z: 5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1.5, y: 1.5, z: 1.5 },
      },
    ]
    createPropColliders(phys, props, assets)
    const translations: Array<{ x: number; y: number; z: number }> = []
    phys.world.forEachCollider((c) => {
      const t = c.translation()
      translations.push({ x: t.x, y: t.y, z: t.z })
    })
    expect(translations.length).toBe(1)
    const w = translations[0]
    // body.y (0) + offset.y (2) * size.y (1.5) = 3 — NOT 0 (the pre-fix bug).
    expect(w?.y).toBeCloseTo(3, 5)
    expect(w?.x).toBeCloseTo(10, 5)
    expect(w?.z).toBeCloseTo(5, 5)
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

  it('floats a per-instance prop (not a wave-rider asset) using its own collider', async () => {
    const sim = createSimWorld({ seed: 4 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    // A plain crate asset — NOT tagged as a wave-rider at the asset level.
    const assets: PropAssetRegistry = new Map([['crate', stubLoadedProp({})]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'crate',
        position: { x: 1, y: 3, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        waveRider: { dof: 'locked' },
      },
    ]
    const bindings = createPropColliders(phys, props, assets, sim, { baseY: 0.5 })
    const entities = query(sim, [WaveRiderTag])
    expect(entities.length).toBe(1)
    const wr = WaveRiderStore.get(entities[0]!)!
    // Per-instance floats carry no archetype — they auto-tune off the
    // collider and render from their own GLB.
    expect(wr.archetype).toBeUndefined()
    // Rests where it was placed: authored y (3) − mean level (0.5).
    expect(wr.tuning.floatOffsetY).toBeCloseTo(2.5, 5)
    // 'locked' DOF holds the heading — no yaw drift.
    expect(wr.tuning.yawDriftRate).toBe(0)
    expect(bindings.get(entities[0]!)).toBe('crate')
  })

  it("'yaw' DOF enables yaw drift", async () => {
    const sim = createSimWorld({ seed: 5 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    const assets: PropAssetRegistry = new Map([['crate', stubLoadedProp({})]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'crate',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        waveRider: { dof: 'yaw' },
      },
    ]
    createPropColliders(phys, props, assets, sim, { baseY: 0 })
    const wr = WaveRiderStore.get(query(sim, [WaveRiderTag])[0]!)!
    expect(wr.tuning.yawDriftRate).not.toBe(0)
  })

  it('per-instance float overrides an asset-level archetype', async () => {
    const sim = createSimWorld({ seed: 6 })
    const phys = await createPhysicsWorld({ gravity: 0 })
    // Asset IS a buoy, but the placement opts into per-instance float —
    // the per-instance path (auto tuning, no archetype) should win.
    const assets: PropAssetRegistry = new Map([['buoy', stubLoadedProp({ waveRider: 'buoy' })]])
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'buoy',
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        waveRider: { dof: 'locked' },
      },
    ]
    createPropColliders(phys, props, assets, sim, { baseY: 0 })
    const entities = query(sim, [WaveRiderTag])
    expect(entities.length).toBe(1)
    expect(WaveRiderStore.get(entities[0]!)!.archetype).toBeUndefined()
  })

  it('deriveWaveRiderTuning reproduces the buoy preset at buoy size and softens for big props', () => {
    const buoyish = deriveWaveRiderTuning({
      halfHeight: 0.45,
      footprint: 0.4,
      restOffsetY: 0.35,
      dof: 'locked',
    })
    expect(buoyish.springK).toBeCloseTo(36, 0)
    expect(buoyish.normalFollow).toBeCloseTo(0.6, 2)
    expect(buoyish.floatOffsetY).toBe(0.35)
    expect(buoyish.yawDriftRate).toBe(0)
    const boatish = deriveWaveRiderTuning({
      halfHeight: 2,
      footprint: 4,
      restOffsetY: 0,
      dof: 'locked',
    })
    // Bigger props bob slower and resist tilting.
    expect(boatish.springK).toBeLessThan(buoyish.springK)
    expect(boatish.normalFollow).toBeLessThan(buoyish.normalFollow)
  })
})
