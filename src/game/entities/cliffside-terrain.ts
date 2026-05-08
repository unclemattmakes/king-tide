import type { PhysicsWorld } from '@/engine/sim/physics/rapier'

/**
 * Static physics for the Cliffside track. Three named pieces, each
 * intentionally a single rigid body so they map 1:1 to objects you'd
 * author in Blender:
 *
 *   - mesa     → a Blender mesh, material `mat_track_mesa`,
 *                extras `{ kind: "track" }`. Flat top platform forming
 *                the top half of the stadium.
 *   - climb_ramp → another `mat_track_*` mesh tilted along its long
 *                axis. Spans the right straight, takes the bike from
 *                water level up to the mesa rim.
 *   - cliff_face → the visual wall under the mesa's south edge. In
 *                Blender this is purely a render mesh (no physics
 *                kind); the bike never collides with it because the
 *                JetMoto signature is to launch OFF the mesa lip and
 *                land on water below.
 *
 * Constants are exported so the matching mesh module can place its
 * visuals at the same transforms — pre-Blender, the procedural code
 * has to keep the two layers in sync manually.
 */

// --- Mesa ---------------------------------------------------------------
export const MESA_CENTER = { x: 0, y: 14, z: 75 }
export const MESA_HALF_EXTENTS = { x: 50, y: 1, z: 25 }
/** Top surface of the mesa in world Y, used by spline / spawn logic. */
export const MESA_TOP_Y = MESA_CENTER.y + MESA_HALF_EXTENTS.y // 15
/** Z-coordinate of the mesa's south (cliff) edge — bike launches here. */
export const MESA_SOUTH_EDGE_Z = MESA_CENTER.z - MESA_HALF_EXTENTS.z // 50

// --- Climb ramp ---------------------------------------------------------
// Tilted cuboid that takes the right straight from water (y=0, z=0) up
// to the mesa rim (y=15, z=50). Slope angle = atan(15/50) ≈ 16.7°. The
// cuboid's center sits midway along the slope; -16.7° rotation around
// +X tilts the +Z end up.
export const CLIMB_RAMP_CENTER = { x: 50, y: 7, z: 25 }
export const CLIMB_RAMP_HALF_EXTENTS = { x: 6, y: 0.5, z: 26 }
export const CLIMB_RAMP_PITCH_RADIANS = -Math.atan(15 / 50) // ≈ -0.291

// --- Cliff face (visual only) -------------------------------------------
// Shown by the mesh module so the south side of the mesa reads as a
// dramatic drop. No physics body — the bike is meant to fly OFF the
// mesa and land on water in front of the wall, not collide into it.
export const CLIFF_FACE_CENTER = { x: 0, y: MESA_TOP_Y / 2, z: MESA_SOUTH_EDGE_Z }
export const CLIFF_FACE_HALF_EXTENTS = {
  x: MESA_HALF_EXTENTS.x,
  y: MESA_TOP_Y / 2,
  z: 0.5,
}

export function createCliffsideTerrain(phys: PhysicsWorld): void {
  // Mesa: flat cuboid, top at MESA_TOP_Y.
  {
    const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(
      MESA_CENTER.x,
      MESA_CENTER.y,
      MESA_CENTER.z,
    )
    const rb = phys.world.createRigidBody(desc)
    const col = phys.rapier.ColliderDesc.cuboid(
      MESA_HALF_EXTENTS.x,
      MESA_HALF_EXTENTS.y,
      MESA_HALF_EXTENTS.z,
    ).setFriction(0.7)
    phys.world.createCollider(col, rb)
  }

  // Climb ramp: tilted slab on the right straight.
  {
    const halfA = CLIMB_RAMP_PITCH_RADIANS / 2
    const desc = phys.rapier.RigidBodyDesc.fixed()
      .setTranslation(CLIMB_RAMP_CENTER.x, CLIMB_RAMP_CENTER.y, CLIMB_RAMP_CENTER.z)
      .setRotation({ x: Math.sin(halfA), y: 0, z: 0, w: Math.cos(halfA) })
    const rb = phys.world.createRigidBody(desc)
    const col = phys.rapier.ColliderDesc.cuboid(
      CLIMB_RAMP_HALF_EXTENTS.x,
      CLIMB_RAMP_HALF_EXTENTS.y,
      CLIMB_RAMP_HALF_EXTENTS.z,
    ).setFriction(0.7)
    phys.world.createCollider(col, rb)
  }

  // Cliff face is render-only — see cliffside-mesh.ts.
}
