import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { acquireWakeTrail, feedWakeTrail } from '@/engine/sim/water/wake-trail'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { BikeTag, RBHandle, RBHandleStore } from '@/game/components'

/**
 * Per fixed step, BEFORE `hoverSystem` reads the surface:
 *
 *  1. Re-derive `field.wakes` — one current-position source per surfaced
 *     bike. The render reads these for the at-hull effects (hull dimple,
 *     stern propwash, bow spray); buoyancy does NOT (it reads the trails).
 *  2. Feed `field.trails` — each surfaced bike's wake-trail breadcrumbs
 *     (`wake-trail.ts`). The trails ARE the wake: both CPU buoyancy and the
 *     GPU water shader evaluate the same profile along these same points,
 *     so a trailing rider feels (and can "jump") exactly the curved ridge
 *     the leader's wake draws — that ordering is why this runs first.
 *
 * Weight fades the deposit as the bike lifts off the surface; while fully
 * airborne (weight ≤ 0.05) the trail is not fed at all — its head freezes,
 * the laid wake age-fades in place, and the landing arrives at the next
 * feed as a head gap (see `feedWakeTrail`'s gap rules). The altitude driving
 * weight reads the AMBIENT surface (`includeWakes = false`) so a bike's
 * deposit can never depend on wake trails — its own or anyone else's — which
 * keeps the feed loop-free. Trails persist across steps but are pure
 * functions of sim history (deterministic for lockstep/replays); they are
 * intentionally NOT snapshotted — see wake-trail.ts for the self-healing
 * rollback story.
 */
export function wakeUpdateSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState): void {
  field.wakes.length = 0
  const eids = query(sim, [BikeTag, RBHandle])
  for (const eid of eids) {
    const rbh = RBHandleStore.get(eid)
    if (!rbh) continue
    const rb = phys.world.getRigidBody(rbh.handle)
    if (!rb) continue
    const t = rb.translation()
    const v = rb.linvel()
    const surfaceY = sampleHeight(field, t.x, t.z, false)
    const altitude = t.y - surfaceY
    let weight = 1
    if (altitude > 0.5) {
      weight = Math.max(0, 1 - (altitude - 0.5) / 1.5)
    }
    if (weight <= 0.05) continue
    const speed = Math.hypot(v.x, v.z)
    const trail = acquireWakeTrail(field.trails, eid, t.x, t.z, field.time)
    feedWakeTrail(trail, t.x, t.z, weight, speed, field.time)
    field.wakes.push({ x: t.x, z: t.z, vx: v.x, vz: v.z, weight })
  }
}
