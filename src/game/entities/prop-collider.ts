/**
 * Shared Rapier collider-descriptor builder for asset props.
 *
 * One prop GLB carries primitive collider descriptors (box / sphere /
 * cylinder / capsule) authored relative to `prop_root`. Both the static-
 * prop path (`createPropColliders` → `addAssetPropColliders`) and the
 * wave-rider kinematic-body path (`createWaveRider`) need to turn one of
 * those descriptors into a `ColliderDesc` scaled by the placement's
 * `size` and carrying its local pose. This module is that single
 * implementation so the two paths can't drift (a float must collide with
 * exactly the silhouette its static twin would).
 *
 * Kept Rapier-only (no Three.js, no ECS) and dependency-light so both
 * `props.ts` and `wave-rider.ts` can import it without a cycle.
 */

import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import type { LoadedPropCollider } from '@/game/assets/prop-loader'

type ColliderDesc = ReturnType<PhysicsWorld['rapier']['ColliderDesc']['cuboid']>

/**
 * Build a `ColliderDesc` for one prop collider descriptor, scaled by the
 * placement `size` and positioned at the collider's local pose within the
 * prop (so a base-pivoted model's collider sits at the model centre, not
 * the body origin). Friction / restitution / surface tags are the
 * caller's job. Returns `null` for an under-specified / unsupported shape.
 *
 * The prop's `size` is treated as a per-axis scale; sphere / cylinder /
 * capsule radii use the average so a non-uniform scale doesn't deform a
 * round primitive into something Rapier can't represent.
 */
export function buildPropColliderDesc(
  phys: PhysicsWorld,
  c: LoadedPropCollider,
  size: Vec3,
): ColliderDesc | null {
  const sx = Math.max(0.01, size.x)
  const sy = Math.max(0.01, size.y)
  const sz = Math.max(0.01, size.z)
  const sAvg = (sx + sy + sz) / 3
  let col: ColliderDesc | null = null
  if (c.shape === 'box' && c.halfExtents) {
    col = phys.rapier.ColliderDesc.cuboid(
      Math.max(0.05, c.halfExtents[0] * sx),
      Math.max(0.05, c.halfExtents[1] * sy),
      Math.max(0.05, c.halfExtents[2] * sz),
    )
  } else if (c.shape === 'sphere' && typeof c.radius === 'number') {
    col = phys.rapier.ColliderDesc.ball(Math.max(0.05, c.radius * sAvg))
  } else if (
    c.shape === 'cylinder' &&
    typeof c.radius === 'number' &&
    typeof c.height === 'number'
  ) {
    col = phys.rapier.ColliderDesc.cylinder(
      Math.max(0.05, c.height * 0.5 * sy),
      Math.max(0.05, c.radius * sAvg),
    )
  } else if (
    c.shape === 'capsule' &&
    typeof c.radius === 'number' &&
    typeof c.height === 'number'
  ) {
    col = phys.rapier.ColliderDesc.capsule(
      Math.max(0.05, c.height * 0.5 * sy),
      Math.max(0.05, c.radius * sAvg),
    )
  }
  if (!col) return null
  col.setTranslation(c.position.x * sx, c.position.y * sy, c.position.z * sz)
  col.setRotation(c.rotation)
  return col
}

/**
 * Characteristic extents of a prop collider (scaled by `size`), used to
 * auto-tune a wave-rider's float feel: `halfHeight` is its vertical
 * half-span, `footprint` its horizontal radius. Mirrors the shape mapping
 * in {@link buildPropColliderDesc}.
 */
export function colliderExtents(
  c: LoadedPropCollider,
  size: Vec3,
): { halfHeight: number; footprint: number } {
  const sx = Math.max(0.01, size.x)
  const sy = Math.max(0.01, size.y)
  const sz = Math.max(0.01, size.z)
  const sAvg = (sx + sy + sz) / 3
  if (c.shape === 'box' && c.halfExtents) {
    return {
      halfHeight: c.halfExtents[1] * sy,
      footprint: Math.max(c.halfExtents[0] * sx, c.halfExtents[2] * sz),
    }
  }
  if (c.shape === 'sphere' && typeof c.radius === 'number') {
    const r = c.radius * sAvg
    return { halfHeight: r, footprint: r }
  }
  if (
    (c.shape === 'cylinder' || c.shape === 'capsule') &&
    typeof c.radius === 'number' &&
    typeof c.height === 'number'
  ) {
    return { halfHeight: c.height * 0.5 * sy, footprint: c.radius * sAvg }
  }
  return { halfHeight: 0.5 * sy, footprint: 0.5 * sAvg }
}
