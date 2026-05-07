import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { ControlIntent, ControlIntentStore, RBHandle, RBHandleStore } from '@/game/components'
import { AIController, AIControllerStore, AITag } from '@/game/components/ai'
import type { Track } from '@/game/tracks/types'

/**
 * Spline-following AI: each tick, finds a target ahead on the spline and a
 * stay-close-to-line target right under us, then writes throttle/steer/brake
 * into ControlIntent. Hover system drives the rigid body.
 *
 * Key design points after several iterations:
 * - Lookahead scales with speed (~0.6s ahead) so faster bikes see further.
 * - Steering blends look-ahead heading with a "pull toward the line" term
 *   so the AI doesn't drift wide on long arcs and miss gates.
 * - Brake fires when the upcoming direction sharply diverges from our current
 *   heading AND we're going fast — converts momentum into a tighter line.
 * - Throttle scales down with how sharply we'd have to turn at this speed.
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

    const lookDist = Math.max(6, speedHoriz * 0.4)

    // 1. Closest spline point — search a window around the cached cursor.
    const N = spline.points.length
    let bestIdx = ai.lastClosestIndex
    let bestDist = Number.POSITIVE_INFINITY
    const window = 8
    for (let i = -window; i <= window; i++) {
      const idx = (ai.lastClosestIndex + i + N) % N
      const p = spline.points[idx]!
      const d = (p.x - t.x) ** 2 + (p.z - t.z) ** 2
      if (d < bestDist) {
        bestDist = d
        bestIdx = idx
      }
    }

    // 2. Lookahead point.
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
    const lookTarget = spline.points[lookIdx]!
    const lineTarget = spline.points[bestIdx]!

    // 3. Blended target — 55% lookahead + 45% line. Pulls the AI back onto
    // the racing line when it's drifting wide.
    const blendT = 0.55
    const targetX = lookTarget.x * blendT + lineTarget.x * (1 - blendT)
    const targetZ = lookTarget.z * blendT + lineTarget.z * (1 - blendT)

    const dx = targetX - t.x
    const dz = targetZ - t.z
    const dlen = Math.hypot(dx, dz) || 1
    const dirX = dx / dlen
    const dirZ = dz / dlen

    // 4. Local-frame angle.
    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const localX = dirX * right.x + dirZ * right.z
    const localZ = dirX * fwd.x + dirZ * fwd.z
    const angle = Math.atan2(localX, localZ)

    // 5. PD steering.
    // Empirically (verified by e2e auto-play trajectory): with hover.ts's
    // `aTurn = -intent.steer`, *positive* steer rotates the bike's forward from
    // +Z toward -X — what the player perceives as a "right turn" via the chase
    // cam (the world rotates right under them). For the AI to drive toward a
    // target at +localX (right of the bike), it must therefore command a
    // *negative* steer. Hence the angle sign flip below.
    const KP = 0.85
    const KD = 0.45
    const damp = angvel.y * KD
    let steer = -angle * KP + damp
    steer = Math.max(-1, Math.min(1, steer))

    // 6. Throttle scales down with angle. Brake into very sharp turns at speed.
    const angleAbs = Math.abs(angle)
    const throttleScale = Math.max(0.4, 1 - angleAbs / Math.PI)
    const throttle = ai.topSpeedFactor * throttleScale

    // Brake when we're going fast AND the angle ahead is genuinely sharp.
    // Gentle threshold so we don't slam brakes on every bend.
    const brake = angleAbs > 1.0 && speedHoriz > 24 ? Math.min(0.8, (angleAbs - 1.0) * 1.2) : 0

    AIControllerStore.set(eid, { ...ai, lastClosestIndex: bestIdx })
    ControlIntentStore.set(eid, {
      throttle,
      steer,
      brake,
      fire: false,
      boost: false,
    })
  }
}
