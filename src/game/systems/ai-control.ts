import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { ControlIntent, ControlIntentStore, RBHandle, RBHandleStore } from '@/game/components'
import { AIController, AIControllerStore, AITag } from '@/game/components/ai'
import type { Track } from '@/game/tracks/types'

/**
 * Spline-following AI: each tick, finds the spline point ahead by `lookAhead`,
 * computes the angle to it in the bike's local frame, and writes throttle/steer
 * into ControlIntent. Hover system drives the rigid body.
 *
 * Steering is angle-based (atan2 of target in bike-local frame) with a
 * derivative damping term on the bike's current angular velocity to prevent
 * the oversteer/spin-out failure mode of pure proportional control.
 */
export function aiControlSystem(sim: SimWorld, phys: PhysicsWorld, track: Track): void {
  const eids = query(sim, [AITag, AIController, RBHandle, ControlIntent])
  for (const eid of eids) {
    const ai = AIControllerStore.must(eid)
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue

    const spline = track.aiSplines.find((s) => s.id === ai.splineId)
    if (!spline || spline.points.length < 2) continue

    const t = rb.translation()
    const q = rb.rotation()
    const linvel = rb.linvel()
    const angvel = rb.angvel()
    const speedHoriz = Math.hypot(linvel.x, linvel.z)

    // Dynamic look-ahead: ~0.6s ahead, with a floor so we don't chase the
    // current spline point at low speed.
    const lookDist = Math.max(8, speedHoriz * 0.6)

    // Closest spline point search — small window around the previous closest.
    const N = spline.points.length
    let bestIdx = ai.lastClosestIndex
    let bestDist = Number.POSITIVE_INFINITY
    const window = 6
    for (let i = -window; i <= window; i++) {
      const idx = (ai.lastClosestIndex + i + N) % N
      const p = spline.points[idx]!
      const d = (p.x - t.x) ** 2 + (p.z - t.z) ** 2
      if (d < bestDist) {
        bestDist = d
        bestIdx = idx
      }
    }

    // Walk forward along spline to cover `lookDist` meters.
    let cumulative = 0
    let lookIdx = (bestIdx + 1) % N
    for (let i = 0; i < N; i++) {
      const a = spline.points[(bestIdx + i) % N]!
      const b = spline.points[(bestIdx + i + 1) % N]!
      const seg = Math.hypot(b.x - a.x, b.z - a.z)
      cumulative += seg
      if (cumulative >= lookDist) {
        lookIdx = (bestIdx + i + 1) % N
        break
      }
    }
    const target = spline.points[lookIdx]!

    // Direction to target.
    const dx = target.x - t.x
    const dz = target.z - t.z
    const dlen = Math.hypot(dx, dz) || 1
    const dirX = dx / dlen
    const dirZ = dz / dlen

    // Project into bike's local frame.
    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const localX = dirX * right.x + dirZ * right.z // lateral (right = +)
    const localZ = dirX * fwd.x + dirZ * fwd.z // forward

    // Angle to target in bike-local horizontal frame.
    // atan2(lateral, forward): 0 = ahead, ±π/2 = sides, ±π = behind.
    const angle = Math.atan2(localX, localZ)

    // PD steering. Convention (from hover.ts): positive steer = right turn,
    // which produces positive Y torque, which increases angvel.y.
    // To damp existing rotation, steer should oppose current angvel.y:
    //   angvel.y > 0 (already spinning right) → steer should reduce → damp = -angvel.y * KD.
    const KP = 1.4
    const KD = 0.25
    const damp = -angvel.y * KD
    let steer = angle * KP + damp
    steer = Math.max(-1, Math.min(1, steer))

    // Throttle: scale down as the angle grows. At 0 deg: full speed. At 180 deg:
    // 40% throttle (still moving — needed to keep hover engaged). The PD damping
    // term will take care of "slowing down" via opposing torque; this prevents
    // momentum from carrying us past the corner.
    const angleAbs = Math.abs(angle)
    const angleScale = Math.max(0.4, 1 - angleAbs / Math.PI)
    const throttle = ai.topSpeedFactor * angleScale

    AIControllerStore.set(eid, { ...ai, lastClosestIndex: bestIdx })
    ControlIntentStore.set(eid, {
      throttle,
      steer,
      brake: 0,
      fire: false,
      boost: false,
    })
  }
}
