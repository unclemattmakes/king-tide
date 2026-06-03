/**
 * Render-transform interpolation pass.
 *
 * The sim advances in fixed 1/60 s steps; the render loop runs at a
 * variable (often higher / out-of-phase) rate. Drawing bodies at their
 * latest committed tick pose makes them stair-step — freeze on a frame that
 * ran no sim step, lurch on a frame that ran two. This pass removes that:
 * once per render frame, after the accumulator loop has drained, it writes
 * each physics body's `TransformStore` (the pose every render system reads)
 * to the point `alpha = physAccum / fixedDt` of the way from its previous
 * committed tick (`PrevTickTransformStore`) to its latest (`TickTransformStore`).
 *
 * Because it targets the shared render-read store, the bike mesh, rider
 * bones, shield bubble, wave-riders and every bike-attached FX emitter all
 * become smooth with no per-system change. It only touches bodies that have
 * a tick history (maintained by `syncFromPhysics`), so render-only entities
 * that drive `TransformStore` directly each frame — ghosts, replay bikes —
 * are left untouched.
 *
 * Render-only: never reads or writes sim/physics state, so it carries no
 * determinism / replay obligations (the snapshot + replay recorder sample
 * the Rapier bodies, not these stores).
 */
import { PrevTickTransformStore, TickTransformStore, TransformStore } from '@/game/components'

/**
 * Per-step position delta (metres) above which a prev→cur pair is treated
 * as a teleport rather than continuous motion, so we snap to `cur` instead
 * of smearing across the gap. Real per-tick travel tops out well under a
 * metre (~0.8 m at the fastest boosted speeds over a 1/60 s step); a
 * respawn, a multiplayer position correction, or a recycled entity slot at
 * race start jumps far further. Comfortably above the former, far below the
 * latter.
 */
export const TELEPORT_SNAP_DIST = 5
const TELEPORT_SNAP_DIST_SQ = TELEPORT_SNAP_DIST * TELEPORT_SNAP_DIST

/**
 * Write the interpolated render pose for every body with a tick history.
 * `alpha` is the leftover accumulator fraction (`physAccum / fixedDt`),
 * clamped to [0, 1]. Allocation-free: mutates the existing `TransformStore`
 * entry in place (a distinct object from the tick-history entries).
 */
export function interpolateRenderTransforms(alpha: number): void {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha
  PrevTickTransformStore.forEach((prev, eid) => {
    const cur = TickTransformStore.get(eid)
    if (!cur) return
    const out = TransformStore.get(eid)
    if (!out) return

    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    const dz = cur.z - prev.z
    if (dx * dx + dy * dy + dz * dz > TELEPORT_SNAP_DIST_SQ) {
      // Teleport / respawn / recycled slot — snap to the destination.
      out.x = cur.x
      out.y = cur.y
      out.z = cur.z
      out.qx = cur.qx
      out.qy = cur.qy
      out.qz = cur.qz
      out.qw = cur.qw
      return
    }

    out.x = prev.x + dx * a
    out.y = prev.y + dy * a
    out.z = prev.z + dz * a
    slerpInto(prev, cur, a, out)
  })
}

type Quatish = { qx: number; qy: number; qz: number; qw: number }

/**
 * Shortest-arc spherical lerp from `prev` to `cur` by `t`, written into
 * `out.q*`. Falls back to normalized lerp when the quaternions are nearly
 * parallel (the common case for adjacent 60 Hz ticks), which avoids the
 * sin(θ)→0 blow-up and is visually indistinguishable there.
 */
function slerpInto(prev: Quatish, cur: Quatish, t: number, out: Quatish): void {
  const ax = prev.qx
  const ay = prev.qy
  const az = prev.qz
  const aw = prev.qw
  let bx = cur.qx
  let by = cur.qy
  let bz = cur.qz
  let bw = cur.qw
  let cos = ax * bx + ay * by + az * bz + aw * bw
  // Take the short way around the hypersphere.
  if (cos < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cos = -cos
  }
  let s0: number
  let s1: number
  if (cos > 0.9995) {
    s0 = 1 - t
    s1 = t
  } else {
    const theta = Math.acos(cos)
    const sinTheta = Math.sin(theta)
    s0 = Math.sin((1 - t) * theta) / sinTheta
    s1 = Math.sin(t * theta) / sinTheta
  }
  let x = ax * s0 + bx * s1
  let y = ay * s0 + by * s1
  let z = az * s0 + bz * s1
  let w = aw * s0 + bw * s1
  const lenSq = x * x + y * y + z * z + w * w
  if (lenSq > 0 && Math.abs(lenSq - 1) > 1e-6) {
    const inv = 1 / Math.sqrt(lenSq)
    x *= inv
    y *= inv
    z *= inv
    w *= inv
  }
  out.qx = x
  out.qy = y
  out.qz = z
  out.qw = w
}
