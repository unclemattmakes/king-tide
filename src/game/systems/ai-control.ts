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
 * - Lookahead scales with speed (~0.4s ahead) so faster bikes see further.
 * - Steering blends look-ahead heading with a "pull toward the line" term
 *   so the AI doesn't drift wide on long arcs and miss gates.
 * - Curvature scan looks 1.5s ahead along the spline and measures the
 *   total bend. Tight upcoming curves drop the target speed; the AI brakes
 *   when current speed > target. Without this, brake only ever fired
 *   *during* a sharp corner — too late to actually take it.
 * - Throttle scales down with target speed (curvature-driven), not just
 *   with current angle to target.
 */
/** Max lateral acceleration the AI will plan for, m/s^2. Lower = more
 *  conservative cornering. ~9 m/s² gives ~21 m/s through a 50m-radius arc. */
const AI_MAX_LATERAL_ACCEL = 11
/** How far ahead (in seconds) we scan the spline for upcoming curvature. */
const CURVATURE_LOOKAHEAD_SECONDS = 1.6
/** Minimum scan distance even at low speed (m), so we still see the next corner. */
const CURVATURE_LOOKAHEAD_MIN = 18
/** Margin: brake when current speed exceeds target speed by this much (m/s). */
const BRAKE_TRIGGER_MARGIN = 1.5
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
    const aheadOfLook = spline.points[(lookIdx + 1) % N]!

    // 3. Blended target — 55% lookahead + 45% line. Pulls the AI back onto
    // the racing line when it's drifting wide.
    const blendT = 0.55
    let targetX = lookTarget.x * blendT + lineTarget.x * (1 - blendT)
    let targetZ = lookTarget.z * blendT + lineTarget.z * (1 - blendT)

    // 3b. Per-AI lateral offset — perpendicular to the spline tangent so each
    //    AI hugs a slightly different line. Prevents convergence pile-ups at gates.
    if (ai.lineOffset !== 0) {
      const tdx = aheadOfLook.x - lookTarget.x
      const tdz = aheadOfLook.z - lookTarget.z
      const tlen = Math.hypot(tdx, tdz) || 1
      // Perpendicular (right of forward).
      const perpX = tdz / tlen
      const perpZ = -tdx / tlen
      targetX += perpX * ai.lineOffset
      targetZ += perpZ * ai.lineOffset
    }

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

    // 6. Curvature look-ahead. Walk ~1.5s ahead along the spline summing arc
    // length, then take the heading-change between (here→lookSegStart) and
    // (lookSegStart→lookSegEnd) as a measure of the upcoming bend. We also
    // sample a wider window's worth of cumulative bend so a long arc (like
    // the half-circle curves) registers the same way a sharp single corner
    // would. The radius implied by total bend over scanned arclength gives
    // us a target speed via v = sqrt(latAccel * r).
    const scanDist = Math.max(CURVATURE_LOOKAHEAD_MIN, speedHoriz * CURVATURE_LOOKAHEAD_SECONDS)
    let scanned = 0
    let totalBend = 0
    let prevDx = 0
    let prevDz = 0
    let initialized = false
    for (let i = 0; i < N && scanned < scanDist; i++) {
      const a = spline.points[(bestIdx + i) % N]!
      const b = spline.points[(bestIdx + i + 1) % N]!
      const segDx = b.x - a.x
      const segDz = b.z - a.z
      const segLen = Math.hypot(segDx, segDz)
      if (segLen < 1e-6) continue
      if (initialized) {
        const cross = prevDx * segDz - prevDz * segDx
        const dot = prevDx * segDx + prevDz * segDz
        totalBend += Math.abs(Math.atan2(cross, dot))
      }
      prevDx = segDx
      prevDz = segDz
      initialized = true
      scanned += segLen
    }
    // Implied corner radius: bend (rad) over arclength (m) → curvature (1/m).
    // Cap min radius at 8m so missing data doesn't produce a near-stop target.
    const curvature = scanned > 0 ? totalBend / scanned : 0
    const impliedRadius = curvature > 1e-4 ? Math.max(8, 1 / curvature) : 1e6
    const cornerSpeedCap = Math.sqrt(AI_MAX_LATERAL_ACCEL * impliedRadius)
    const baseTopSpeed = ai.topSpeedFactor * 30 // ~bike topSpeed; a soft target, not a hard cap
    const targetSpeed = Math.min(baseTopSpeed, cornerSpeedCap)

    // Throttle: scale down as we approach the target speed, with a small
    // angle-error term so a steering correction also pulls throttle.
    const angleAbs = Math.abs(angle)
    const speedHeadroom = Math.max(0, (targetSpeed - speedHoriz) / Math.max(targetSpeed, 1))
    const angleScale = Math.max(0.55, 1 - angleAbs / Math.PI)
    const throttle = Math.min(1, ai.topSpeedFactor * (0.45 + 0.65 * speedHeadroom) * angleScale)

    // Brake when current speed exceeds the target by more than the margin.
    // Magnitude scales with overshoot, capped at 0.9 (full brake bogs the
    // chassis and breaks the lean-into-turn weight transfer).
    const overshoot = speedHoriz - targetSpeed
    const brake =
      overshoot > BRAKE_TRIGGER_MARGIN
        ? Math.min(0.9, (overshoot - BRAKE_TRIGGER_MARGIN) * 0.18)
        : 0

    AIControllerStore.set(eid, { ...ai, lastClosestIndex: bestIdx })
    ControlIntentStore.set(eid, {
      throttle,
      steer,
      brake,
      fire: false,
      boost: false,
      pitch: 0,
    })
  }
}
