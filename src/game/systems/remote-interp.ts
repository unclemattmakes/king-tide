/**
 * Snapshot-interpolation buffer for remote (kinematic) bikes.
 *
 * Snapshots arrive at 20 Hz; the sim ticks at 60 Hz. Pushing each snapshot
 * straight into `setNextKinematicTranslation` makes the body teleport once
 * per arrival and sit still for ~2 ticks — the visible "hitch" players
 * report. Instead we hold the two most recent snapshots per entity and on
 * each sim tick set the kinematic next-pose to a wall-clock-interpolated
 * point between them. Render time is `now - INTERP_DELAY_MS` so we're
 * always sampling between two snapshots we've already received.
 *
 * The interp is purely visual — no determinism contract. Different peers
 * may smooth slightly differently; that's fine since none of them are
 * authoritative for these bodies.
 *
 * Lifecycle: `pushRemoteSnapshot` on every inbound record for a kinematic
 * body, `tickRemoteInterp` once per sim tick (from the game loop), and
 * `clearRemoteInterp(eid)` when a remote bike despawns / a peer leaves.
 */
import type { BikeSnapshotRecord } from '@/engine/net/transform-snapshot'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { RBHandleStore } from '@/game/components'

/** Wall-clock delay between the latest snapshot and the rendered pose.
 *  At 20 Hz snapshot cadence (50 ms spacing) a 100 ms render delay leaves
 *  the interpolator sitting comfortably between two received frames, with
 *  one frame of slack for jitter. Adds visible-position latency for
 *  remote peers but eliminates the per-snapshot teleport. */
const INTERP_DELAY_MS = 100

/** Cap on the interpolation parameter when the next snapshot is overdue.
 *  t=1 is the latest sample; 1.5 lets the bike coast half a snapshot
 *  interval past it before freezing — keeps motion plausible during a
 *  brief packet gap without flinging the bike to infinity. */
const MAX_EXTRAPOLATE_T = 1.5

type Sample = {
  position: Vec3
  rotation: Quat
  receivedAt: number
}

type Buffer = {
  prev: Sample
  next: Sample
}

const buffers = new Map<number, Buffer>()

/**
 * Record a snapshot for a remote (kinematic) entity. Slides the buffer:
 * the previous "next" becomes the new "prev". The first push for an eid
 * seeds both slots with the same sample so the first interp call is a
 * no-op rather than a divide-by-zero.
 */
export function pushRemoteSnapshot(
  eid: number,
  record: BikeSnapshotRecord,
  receivedAt: number,
): void {
  const sample: Sample = {
    position: { x: record.position.x, y: record.position.y, z: record.position.z },
    rotation: {
      x: record.rotation.x,
      y: record.rotation.y,
      z: record.rotation.z,
      w: record.rotation.w,
    },
    receivedAt,
  }
  const buf = buffers.get(eid)
  if (!buf) {
    buffers.set(eid, { prev: sample, next: sample })
    return
  }
  buf.prev = buf.next
  buf.next = sample
}

/**
 * Forget any buffered samples for an entity. Call on remote-bike despawn
 * (peer-left) and on disconnect so a slot recycled to a new peer doesn't
 * inherit the previous occupant's pose.
 */
export function clearRemoteInterp(eid: number): void {
  buffers.delete(eid)
}

/** Drop every buffer — used by tests that share a Rapier world. */
export function resetRemoteInterp(): void {
  buffers.clear()
}

/**
 * Advance every buffered remote bike toward the wall-clock-interpolated
 * pose between its `prev` and `next` snapshots. Sets the kinematic
 * next-pose; the caller's next `phys.step()` commits it.
 *
 * Skips entries whose entity has no rigid body or is currently Dynamic
 * (host changeover edge — handled by `applySnapshot` instead).
 */
export function tickRemoteInterp(phys: PhysicsWorld, now: number): void {
  if (buffers.size === 0) return
  const Kinematic = phys.rapier.RigidBodyType.KinematicPositionBased
  const renderTime = now - INTERP_DELAY_MS
  for (const [eid, buf] of buffers) {
    const handle = RBHandleStore.get(eid)
    if (!handle) continue
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) continue
    if (rb.bodyType() !== Kinematic) continue

    const span = buf.next.receivedAt - buf.prev.receivedAt
    let t: number
    if (span <= 0) {
      t = 1
    } else {
      t = (renderTime - buf.prev.receivedAt) / span
      if (t < 0) t = 0
      else if (t > MAX_EXTRAPOLATE_T) t = MAX_EXTRAPOLATE_T
    }

    const p = buf.prev.position
    const n = buf.next.position
    const pos = {
      x: p.x + (n.x - p.x) * t,
      y: p.y + (n.y - p.y) * t,
      z: p.z + (n.z - p.z) * t,
    }
    const rot = slerpQuat(buf.prev.rotation, buf.next.rotation, t)
    rb.setNextKinematicTranslation(pos)
    rb.setNextKinematicRotation(rot)
  }
}

/**
 * Shortest-arc spherical lerp between two unit quaternions. Falls back to
 * a normalized nlerp when the rotations are close enough that sin(θ) loses
 * precision. Returns a fresh object so callers can hand it to Rapier
 * without aliasing concerns.
 */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw
  // Take the short way around.
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
    // Near-parallel — nlerp + normalize, avoids sin(theta)≈0 blowup.
    s0 = 1 - t
    s1 = t
  } else {
    const theta = Math.acos(cos)
    const sinTheta = Math.sin(theta)
    s0 = Math.sin((1 - t) * theta) / sinTheta
    s1 = Math.sin(t * theta) / sinTheta
  }
  const x = a.x * s0 + bx * s1
  const y = a.y * s0 + by * s1
  const z = a.z * s0 + bz * s1
  const w = a.w * s0 + bw * s1
  const lenSq = x * x + y * y + z * z + w * w
  if (lenSq > 0 && Math.abs(lenSq - 1) > 1e-6) {
    const inv = 1 / Math.sqrt(lenSq)
    return { x: x * inv, y: y * inv, z: z * inv, w: w * inv }
  }
  return { x, y, z, w }
}
