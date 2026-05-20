import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Flat plate arena for the `drift-test` map.
 *
 * One large cuboid collider centered at y = 0 with surface y = 0 —
 * matches the layout the bike's hover spring expects (target hover
 * 1.2 m above the surface). High enough friction that the drift-time
 * lateral slide reads visibly, low enough that the bike still
 * accelerates straight.
 */
export const DRIFT_TEST_PLATE_HALF_SIZE = 220
const PLATE_THICKNESS = 2
const PLATE_FRICTION = 0.55

export function createDriftTestPlate(phys: PhysicsWorld): void {
  // Collider top sits at y = 0. Cuboid extends downward by
  // PLATE_THICKNESS so the bike's hover probe always sees ground.
  const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, -PLATE_THICKNESS, 0)
  const rb = phys.world.createRigidBody(desc)
  const col = phys.rapier.ColliderDesc.cuboid(
    DRIFT_TEST_PLATE_HALF_SIZE,
    PLATE_THICKNESS,
    DRIFT_TEST_PLATE_HALF_SIZE,
  ).setFriction(PLATE_FRICTION)
  phys.world.createCollider(col, rb)
}
