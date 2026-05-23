import { addComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, type Vec3 } from '@/engine/sim/physics/vec'
import { BikeTag, RBHandle, RBHandleStore } from '@/game/components'
import { BoostEffect, BoostEffectStore } from '@/game/components/pickup'
import type { BoostPad, Track } from '@/game/tracks/types'

/**
 * While the bike sits on a pad, refresh boost so it lasts at least this long.
 * Short — the pad keeps refreshing tick-by-tick while overlap holds, so the
 * boost effectively expires within ~0.25 s of leaving the pad.
 */
const PAD_BOOST_REFRESH = 0.25

/**
 * Pure predicate. True when `bikePos` is inside the pad's oriented box —
 * `halfWidth × halfHeight × halfDepth` in the pad's local frame. Tested
 * directly; the system below is just iteration + effect-application
 * around this check.
 */
export function isOverBoostPad(bikePos: Vec3, pad: BoostPad): boolean {
  const dx = bikePos.x - pad.position.x
  const dy = bikePos.y - pad.position.y
  const dz = bikePos.z - pad.position.z
  const fwd = quatRotate(pad.rotation, { x: 0, y: 0, z: 1 })
  const right = quatRotate(pad.rotation, { x: 1, y: 0, z: 0 })
  const up = quatRotate(pad.rotation, { x: 0, y: 1, z: 0 })
  const localAlong = dx * fwd.x + dy * fwd.y + dz * fwd.z
  const localAcross = dx * right.x + dy * right.y + dz * right.z
  const localUp = dx * up.x + dy * up.y + dz * up.z
  return (
    Math.abs(localAcross) <= pad.halfWidth &&
    Math.abs(localUp) <= pad.halfHeight &&
    Math.abs(localAlong) <= pad.halfDepth
  )
}

/**
 * For each bike, refresh its `BoostEffect` when it sits on any track boost
 * pad. Pad strength overrides current boost when stronger; weaker pads
 * leave a stronger active boost intact (e.g. from a pickup). A bike sitting
 * on overlapping pads only consumes one — first match wins.
 *
 * No-op when the track has no pads. Must run before `boostTickSystem` so
 * the refreshed duration isn't immediately decremented for the same tick.
 */
export function boostPadSystem(sim: SimWorld, phys: PhysicsWorld, track: Track): void {
  if (track.boostPads.length === 0) return
  const bikeEids = query(sim, [BikeTag, RBHandle])
  for (const bEid of bikeEids) {
    const { handle } = RBHandleStore.must(bEid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    const t = rb.translation()

    for (const pad of track.boostPads) {
      if (!isOverBoostPad(t, pad)) continue
      if (!BoostEffectStore.has(bEid)) addComponent(sim, bEid, BoostEffect)
      const current = BoostEffectStore.get(bEid)
      const useMultiplier =
        current && current.remaining > 0 ? Math.max(current.multiplier, pad.strength) : pad.strength
      const useRemaining =
        current && current.remaining > PAD_BOOST_REFRESH ? current.remaining : PAD_BOOST_REFRESH
      BoostEffectStore.set(bEid, { remaining: useRemaining, multiplier: useMultiplier })
      break
    }
  }
}
