import { type QueryResult, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { BikeTag, RBHandle, RBHandleStore } from '@/game/components'

/** Rapier rigid body, narrowed to what the spatial helpers need. */
type Body = NonNullable<ReturnType<PhysicsWorld['world']['getRigidBody']>>

/**
 * The bike's rigid body, or null if it has no handle / the body is gone.
 * Centralizes the `RBHandleStore.get(eid) → getRigidBody(handle)` dance that
 * was hand-rolled in combat / ai-combat / pickup / race.
 */
export function bikeBody(phys: PhysicsWorld, eid: number): Body | null {
  const h = RBHandleStore.get(eid)
  if (!h) return null
  return phys.world.getRigidBody(h.handle) ?? null
}

export type BikeHit = {
  eid: number
  body: Body
  /** Vector from `origin` to the bike (bike − origin). */
  dx: number
  dy: number
  dz: number
  /** Euclidean (3D) distance from `origin` to the bike. */
  dist: number
}

/**
 * Iterate every bike whose center is within `maxDist` (3D) of `origin`,
 * nearest-first order NOT guaranteed (raw query order — callers that need a
 * nearest/tie-break must track it themselves and break ties by eid for
 * determinism). The callback may return `true` to stop early (like a `break`).
 *
 * Replaces four near-identical proximity loops (missile target / missile hit /
 * mine proximity / mine-chaser) that each re-derived bike body + delta + dist,
 * inconsistently mixing squared and sqrt distance.
 */
export function forEachBikeInRange(
  sim: SimWorld,
  phys: PhysicsWorld,
  origin: Vec3,
  maxDist: number,
  fn: (hit: BikeHit) => boolean | void,
  opts?: { skipEid?: number; bikeEids?: QueryResult | undefined },
): void {
  const bikes = opts?.bikeEids ?? query(sim, [BikeTag, RBHandle])
  const maxSq = maxDist * maxDist
  const skip = opts?.skipEid
  for (const eid of bikes) {
    if (skip !== undefined && eid === skip) continue
    const body = bikeBody(phys, eid)
    if (!body) continue
    const t = body.translation()
    const dx = t.x - origin.x
    const dy = t.y - origin.y
    const dz = t.z - origin.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > maxSq) continue
    if (fn({ eid, body, dx, dy, dz, dist: Math.sqrt(d2) }) === true) break
  }
}
