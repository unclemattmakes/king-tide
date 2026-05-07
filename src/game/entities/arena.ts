import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Physics arena for M2 — a circular island raised above the water plus a
 * deep safety floor below water level. The bike spawns on the island; driving
 * off it puts you on water (handled by the wave field, not a physical collider).
 */

export const ISLAND_RADIUS = 24
export const ISLAND_TOP_Y = 3
export const ISLAND_HEIGHT = 6
export const SAFETY_FLOOR_Y = -50

export function createArena(phys: PhysicsWorld): void {
  // Safety floor — backstop in case the bike falls through everything.
  {
    const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, SAFETY_FLOOR_Y, 0)
    const rb = phys.world.createRigidBody(desc)
    const col = phys.rapier.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(0.6)
    phys.world.createCollider(col, rb)
  }

  // Island — cylinder centered at origin, top at y=ISLAND_TOP_Y.
  {
    const centerY = ISLAND_TOP_Y - ISLAND_HEIGHT / 2
    const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, centerY, 0)
    const rb = phys.world.createRigidBody(desc)
    const col = phys.rapier.ColliderDesc.cylinder(ISLAND_HEIGHT / 2, ISLAND_RADIUS).setFriction(0.7)
    phys.world.createCollider(col, rb)
  }
}
