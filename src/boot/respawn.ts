/**
 * Respawn-to-racing-line — the one true rescue teleport, shared by:
 *
 *   - the manual respawn key (controls.ts, rebindable, default
 *     Backspace)
 *   - the automatic wedge / rider-eject rescue (stuck-rescue.ts →
 *     consumed in game-loop.ts)
 *   - the out-of-bounds lethal consequence (game-loop.ts)
 *
 * Snaps the bike to the nearest point on the OOB leash's dense racing
 * line, heading down-course, zero velocity, rider re-seated, crash
 * tracking cleared. Mid-race friendly: unlike the old respawn-to-start
 * it never costs a lap of re-riding, and the race system's teleport
 * guard (race.ts TELEPORT_DIST_SQ) classifies the jump as a warp so no
 * phantom checkpoint scores.
 *
 * Returns false when the track has no racing line to snap to (splineless
 * dev/spec scenes) — callers fall back to the start pose.
 */

import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import { RBHandleStore } from '@/game/components'
import { leashFor } from '@/game/systems/out-of-bounds'
import { clearCrashTracking } from '@/game/systems/rider-crash'
import { resetRiderForBike } from '@/game/systems/rider-pose'
import type { Track } from '@/game/tracks/types'

export function respawnBikeToLine(args: {
  sim: SimWorld
  phys: PhysicsWorld
  track: Track
  waveField: WaveFieldState
  eid: number
}): boolean {
  const { sim, phys, track, waveField, eid } = args
  const leash = leashFor(track)
  const rbh = RBHandleStore.get(eid)
  if (!leash || !rbh) return false
  const rb = phys.world.getRigidBody(rbh.handle)
  if (!rb) return false
  // Restore dynamics if a sequence had captured the bike (kinematic —
  // e.g. the OOB shark).
  if (rb.bodyType() !== phys.rapier.RigidBodyType.Dynamic) {
    rb.setBodyType(phys.rapier.RigidBodyType.Dynamic, true)
  }
  const t = rb.translation()
  const pts = leash.points
  let best = Number.POSITIVE_INFINITY
  let bi = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const dx = p.x - t.x
    const dz = p.z - t.z
    const d = dx * dx + dz * dz
    if (d < best) {
      best = d
      bi = i
    }
  }
  const p = pts[bi]!
  const nxt = pts[(bi + 1) % pts.length]!
  // start.yaw convention: 0 = facing +Z, +π/2 = +X → atan2(dx, dz).
  const yaw = Math.atan2(nxt.x - p.x, nxt.z - p.z)
  const hy = yaw / 2
  // Clear the live sea: the spline Y is authored at the mean tide, so on a
  // risen tide `p.y + 1.5` can sit under water — drop in at the higher of
  // the spline point and the current surface so buoyancy catches the bike.
  const respawnY = Math.max(p.y, waveField.baseY) + 1.5
  // Forget Δv history BEFORE zeroing velocity, or the crash detector
  // reads the stop as a full-speed wall hit and re-ejects the rider on
  // the very next tick (see clearCrashTracking).
  clearCrashTracking(eid)
  rb.setTranslation({ x: p.x, y: respawnY, z: p.z }, true)
  rb.setRotation({ x: 0, y: Math.sin(hy), z: 0, w: Math.cos(hy) }, true)
  rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
  rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
  resetRiderForBike(sim, phys, eid)
  return true
}
