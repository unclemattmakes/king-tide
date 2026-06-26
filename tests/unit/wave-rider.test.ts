/**
 * Wave-rider sim system — pose + perturbation tests against a real
 * Rapier world.
 *
 * Covers:
 *   1. Body height tracks `sampleHeight(field, x, z) + floatOffsetY` at
 *      rest (no perturbation, springs at zero).
 *   2. A vertical hit kicks `perturbY` down and the spring restores it.
 *   3. A horizontal hit tilts the body in the impulse direction and the
 *      tilt spring restores it.
 *   4. With `normalFollow = 1` the body's local +Y axis aligns with the
 *      wave-surface normal at rest.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import { createPhysicsWorld, type PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import {
  createWaveField,
  sampleHeight,
  sampleSurface,
  type WaveFieldState,
} from '../../src/engine/sim/water/wave-field'
import { RBHandleStore } from '../../src/game/components'
import { WaveRiderStore } from '../../src/game/components/wave-rider'
import { createWaveRider } from '../../src/game/entities/wave-rider'
import { createWaveRiderSystem } from '../../src/game/systems/wave-rider'

function flatField(baseY = 0): WaveFieldState {
  // Empty wave list = perfectly flat water at `baseY`. Lets us check
  // the system's rest pose without wave-noise.
  return createWaveField([], { baseY })
}

describe('wave-rider sim system', () => {
  let sim: SimWorld
  let phys: PhysicsWorld

  beforeAll(async () => {
    sim = createSimWorld({ seed: 1 })
    phys = await createPhysicsWorld({ gravity: 0 })
  })

  it('rests on the surface at surface.y + floatOffsetY (flat water)', () => {
    const field = flatField(1.5)
    const sys = createWaveRiderSystem(sim, phys, field)
    const eid = createWaveRider(sim, phys, {
      position: { x: 4, y: 99, z: -3 },
      archetype: 'buoy',
    })
    // One step settles the body onto the surface.
    sys.step(1 / 60)
    phys.world.step()
    const rb = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!
    const t = rb.translation()
    const wr = WaveRiderStore.get(eid)!
    expect(t.y).toBeCloseTo(field.baseY + wr.tuning.floatOffsetY, 4)
    expect(t.x).toBeCloseTo(4, 5)
    expect(t.z).toBeCloseTo(-3, 5)
  })

  it('a downward hit pushes the body below rest and the spring restores it', () => {
    const field = flatField(0)
    const sys = createWaveRiderSystem(sim, phys, field)
    const eid = createWaveRider(sim, phys, {
      position: { x: 12, y: 0, z: 0 },
      archetype: 'buoy',
    })
    sys.step(1 / 60) // settle
    sys.applyHit(eid, { x: 0, y: -8, z: 0 })
    // Step until the spring pushes the body below rest, then back up.
    const restY = field.baseY + WaveRiderStore.get(eid)!.tuning.floatOffsetY
    let minY = Infinity
    for (let i = 0; i < 30; i++) {
      sys.step(1 / 60)
      phys.world.step()
      const y = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!.translation().y
      if (y < minY) minY = y
    }
    expect(minY).toBeLessThan(restY - 0.05)
    // Run a couple seconds — should be back near rest (damped).
    for (let i = 0; i < 600; i++) {
      sys.step(1 / 60)
      phys.world.step()
    }
    const finalY = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!.translation().y
    expect(finalY).toBeCloseTo(restY, 2)
  })

  it('a horizontal hit tilts the body and damping returns it upright', () => {
    const field = flatField(0)
    const sys = createWaveRiderSystem(sim, phys, field)
    const eid = createWaveRider(sim, phys, {
      // Disable yaw drift so the upright-quaternion compare stays clean.
      position: { x: -5, y: 0, z: 7 },
      archetype: 'buoy',
    })
    const wr = WaveRiderStore.get(eid)!
    wr.tuning.yawDriftRate = 0
    sys.step(1 / 60)
    sys.applyHit(eid, { x: 6, y: 0, z: 0 })
    let maxTilt = 0
    for (let i = 0; i < 60; i++) {
      sys.step(1 / 60)
      phys.world.step()
      const tilt = Math.hypot(wr.tiltDirX, wr.tiltDirZ)
      if (tilt > maxTilt) maxTilt = tilt
    }
    expect(maxTilt).toBeGreaterThan(0.05) // ≈ 3°
    // Wait it out — tilt spring should bring tilt back to ~0.
    for (let i = 0; i < 600; i++) {
      sys.step(1 / 60)
      phys.world.step()
    }
    expect(Math.hypot(wr.tiltDirX, wr.tiltDirZ)).toBeLessThan(0.01)
  })

  it('with a tilted wave normal and normalFollow=1, the body inherits the lean', () => {
    // Single travelling wave — non-zero surface normal at the sample
    // point. Steepness picked so the normal has a visible horizontal
    // component without the sim crashing through small-angle.
    const field = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 0.4, wavelength: 8, speed: 0, phase: Math.PI / 2 },
    ])
    const sys = createWaveRiderSystem(sim, phys, field)
    const eid = createWaveRider(sim, phys, {
      position: { x: 1, y: 0, z: 0 },
      archetype: 'buoy',
    })
    const wr = WaveRiderStore.get(eid)!
    wr.tuning.normalFollow = 1
    wr.tuning.yawDriftRate = 0
    sys.step(1 / 60)
    phys.world.step()
    const surface = sampleSurface(field, wr.anchorX, wr.anchorZ)
    expect(Math.abs(surface.nx) + Math.abs(surface.nz)).toBeGreaterThan(0.05)
    // Body's local +Y under its current quaternion.
    const rb = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!
    const q = rb.rotation()
    // Apply quaternion to (0,1,0) → world (uy_x, uy_y, uy_z).
    const ux = 2 * (q.x * q.y - q.w * q.z)
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z)
    const uz = 2 * (q.y * q.z + q.w * q.x)
    // Compare against the surface normal — should be within a few degrees.
    const dot = ux * surface.nx + uy * surface.ny + uz * surface.nz
    expect(dot).toBeGreaterThan(0.995) // ≈ ≤ 5.7° apart
  })

  it('sampleHeight matches the kinematic body height on rough water', () => {
    const field = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 0.3, wavelength: 12, speed: 1, phase: 0 },
      { dirX: 0, dirZ: 1, amplitude: 0.2, wavelength: 7, speed: 0.5, phase: 1.4 },
    ])
    const sys = createWaveRiderSystem(sim, phys, field)
    const eid = createWaveRider(sim, phys, {
      position: { x: 3, y: 0, z: -2 },
      archetype: 'log',
    })
    const wr = WaveRiderStore.get(eid)!
    sys.step(1 / 60)
    phys.world.step()
    const expectedY = sampleHeight(field, wr.anchorX, wr.anchorZ) + wr.tuning.floatOffsetY
    const actualY = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!.translation().y
    // Body has perturbY ≈ 0 at first settle; should hit the rest target
    // exactly (kinematic body honours setNextKinematicTranslation after
    // the world step).
    expect(actualY).toBeCloseTo(expectedY, 4)
  })

  it('beaches on exposed terrain when the tide drops below it', () => {
    // King-tide beaching: water at y=0, terrain at +2 → the float rests on the
    // ground (terrainY + offset), not on the lower water surface.
    const field = flatField(0)
    const sys = createWaveRiderSystem(sim, phys, field, { sampleTerrainY: () => 2 })
    const eid = createWaveRider(sim, phys, {
      position: { x: 40, y: 0, z: 40 },
      archetype: 'buoy',
    })
    sys.step(1 / 60)
    phys.world.step()
    const wr = WaveRiderStore.get(eid)!
    const rb = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!
    expect(rb.translation().y).toBeCloseTo(2 + wr.tuning.floatOffsetY, 4)
  })

  it('floats (does not beach) when terrain sits below the water', () => {
    // Terrain at -5, well under the water (y=0) → normal float on the surface.
    const field = flatField(0)
    const sys = createWaveRiderSystem(sim, phys, field, { sampleTerrainY: () => -5 })
    const eid = createWaveRider(sim, phys, {
      position: { x: -40, y: 0, z: -40 },
      archetype: 'buoy',
    })
    sys.step(1 / 60)
    phys.world.step()
    const wr = WaveRiderStore.get(eid)!
    const rb = phys.world.getRigidBody(RBHandleStore.get(eid)!.handle)!
    expect(rb.translation().y).toBeCloseTo(field.baseY + wr.tuning.floatOffsetY, 4)
  })
})
