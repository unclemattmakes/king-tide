import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Static jump ramp on the right straight, between the first pickup and
 * cp 1. Exercises the parts of the hover system that don't see action on
 * pure water:
 *   - raycast vs a static rigid collider (not just the wave field)
 *   - surface alignment on a non-(0,1,0) normal
 *   - hover-spring decoupling at launch (going from grounded → airborne)
 *   - re-acquisition of water surface on landing
 *
 * Geometry: a thin cuboid 12m long × 6m wide × 1m thick, tilted -14°
 * around the world +X axis so the +Z end is high. The near (-Z) edge of
 * the top surface sits roughly at water level; the far (+Z) edge tops out
 * around y = 3m. Slope angle ≈ 14° = arctan(3 / 12).
 */
export const RAMP_CENTER = { x: 50, y: 1, z: 31 }
export const RAMP_HALF_EXTENTS = { x: 3, y: 0.5, z: 6 }
export const RAMP_PITCH_RADIANS = -14 * (Math.PI / 180)

export function createRamp(phys: PhysicsWorld): void {
  const halfA = RAMP_PITCH_RADIANS / 2
  const rotation = {
    x: Math.sin(halfA),
    y: 0,
    z: 0,
    w: Math.cos(halfA),
  }

  const desc = phys.rapier.RigidBodyDesc.fixed()
    .setTranslation(RAMP_CENTER.x, RAMP_CENTER.y, RAMP_CENTER.z)
    .setRotation(rotation)
  const rb = phys.world.createRigidBody(desc)
  const col = phys.rapier.ColliderDesc.cuboid(
    RAMP_HALF_EXTENTS.x,
    RAMP_HALF_EXTENTS.y,
    RAMP_HALF_EXTENTS.z,
  ).setFriction(0.7)
  phys.world.createCollider(col, rb)
}
