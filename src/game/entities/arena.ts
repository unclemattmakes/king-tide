import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Universal arena pieces (the safety-floor backstop) and Lagoon Loop's
 * decorative center island. Per-track terrain (ramps, mesas, cliff faces)
 * lives in track-specific entity files so each track can be loaded
 * independently — see e.g. createCliffsideTerrain.
 */

export const ISLAND_RADIUS = 24
export const ISLAND_TOP_Y = 3
export const ISLAND_HEIGHT = 6
export const SAFETY_FLOOR_Y = -50

/**
 * Backstop floor far below water — catches the bike if it falls through
 * every surface above. Universal: every track creates this.
 */
export function createSafetyFloor(phys: PhysicsWorld): void {
  const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, SAFETY_FLOOR_Y, 0)
  const rb = phys.world.createRigidBody(desc)
  const col = phys.rapier.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(0.6)
  phys.world.createCollider(col, rb)
}

/**
 * Lagoon Loop's decorative central island — a cylinder rising out of the
 * water at the loop's centroid. Not used by Cliffside.
 */
export function createLagoonIsland(phys: PhysicsWorld): void {
  const centerY = ISLAND_TOP_Y - ISLAND_HEIGHT / 2
  const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, centerY, 0)
  const rb = phys.world.createRigidBody(desc)
  const col = phys.rapier.ColliderDesc.cylinder(ISLAND_HEIGHT / 2, ISLAND_RADIUS).setFriction(0.7)
  phys.world.createCollider(col, rb)
}

/** Backwards-compat: full Lagoon Loop arena = safety floor + center island. */
export function createArena(phys: PhysicsWorld): void {
  createSafetyFloor(phys)
  createLagoonIsland(phys)
}
