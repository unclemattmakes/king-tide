/**
 * Editor wave-rider preview — floats placed props on the live water surface
 * so authors can see where a dock / buoy / crate will rest and how much it
 * bobs while placing it.
 *
 * This is a Three-free port of the spring-damped float math in
 * `game/systems/wave-rider.ts`, with the Rapier kinematic body replaced by a
 * plain pose the editor writes onto the prop's helper Object3D each frame. It
 * shows FLOATING (bob / tilt / resting height) — NOT interaction (collisions,
 * wake, hit impulses), which need Play mode + Rapier. Tuning is size-derived
 * (the editor has no GLB colliders), so the feel is a preview, refined for
 * real in Play.
 *
 * A prop floats in the editor when EITHER:
 *   - it carries a per-instance `waveRider` flag (the editor's "Float on
 *     waves" toggle), OR
 *   - its `assetId` is a wave-rider asset in the manifest (e.g. `buoy`) — the
 *     archetype-level float the runtime applies even without the per-instance
 *     flag, so spline-derived buoys preview correctly too.
 */

import type { Quat } from '@/engine/sim/physics/vec'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { deriveWaveRiderTuning, type WaveRiderTuning } from '@/game/components/wave-rider'
import type { Track } from '@/game/tracks/types'

/** Max lean angle (rad) — matches the sim so the preview tilt reads the same. */
const MAX_TILT = (75 * Math.PI) / 180

export type FloatPose = {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export type FloatState = {
  /** Index into `draft.props`. */
  propIndex: number
  tuning: WaveRiderTuning
  anchorX: number
  anchorZ: number
  perturbY: number
  perturbYVel: number
  tiltDirX: number
  tiltDirZ: number
  tiltVelX: number
  tiltVelZ: number
  yawDrift: number
}

/** Yaw (rotation about +Y) from a quaternion — matches `2·atan2(y,w)` for a
 *  pure-Y quat and degrades gracefully for tilted ones. Pure number math so
 *  this module stays Three-free + unit-testable. */
export function quatYaw(q: Quat): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
}

/**
 * Advance one float by `dt` and return its world pose. Mutates the spring
 * state in place. Direct port of `game/systems/wave-rider.ts::step` minus the
 * Rapier body — see that file for the tilt-vector / quaternion-compose rationale.
 */
export function stepFloat(s: FloatState, field: WaveFieldState, dt: number): FloatPose {
  const surface = sampleSurface(field, s.anchorX, s.anchorZ)
  const t = s.tuning
  const waveLeanX = surface.nx * t.normalFollow
  const waveLeanZ = surface.nz * t.normalFollow

  // Vertical spring.
  s.perturbYVel += (-t.springK * s.perturbY - t.springDamping * s.perturbYVel) * dt
  s.perturbY += s.perturbYVel * dt
  // Tilt-vector spring.
  s.tiltVelX += (-t.tiltK * s.tiltDirX - t.tiltDamping * s.tiltVelX) * dt
  s.tiltVelZ += (-t.tiltK * s.tiltDirZ - t.tiltDamping * s.tiltVelZ) * dt
  s.tiltDirX += s.tiltVelX * dt
  s.tiltDirZ += s.tiltVelZ * dt
  // Drift yaw (seeded with the authored heading on rebuild).
  s.yawDrift += t.yawDriftRate * dt

  const totalLeanX = waveLeanX + s.tiltDirX
  const totalLeanZ = waveLeanZ + s.tiltDirZ
  const leanMag = Math.hypot(totalLeanX, totalLeanZ)
  const clampedMag = Math.min(leanMag, MAX_TILT)
  let lx = 0
  const ly = 0
  let lz = 0
  let lw = 1
  if (leanMag > 1e-5) {
    const half = clampedMag * 0.5
    const sn = Math.sin(half) / leanMag
    lx = totalLeanZ * sn
    lz = -totalLeanX * sn
    lw = Math.cos(half)
  }
  const halfYaw = s.yawDrift * 0.5
  const yy = Math.sin(halfYaw)
  const yw = Math.cos(halfYaw)
  // qLean ∘ qYaw (yaw is the prop's local spin, multiplies on the right).
  const qx = lw * 0 + lx * yw + ly * 0 - lz * yy
  const qy = lw * yy - lx * 0 + ly * yw + lz * 0
  const qz = lw * 0 + lx * yy - ly * 0 + lz * yw
  const qw = lw * yw - lx * 0 - ly * yy - lz * 0
  const y = surface.y + t.floatOffsetY + s.perturbY
  return { x: s.anchorX, y, z: s.anchorZ, qx, qy, qz, qw }
}

export type EditorFloatPreview = {
  /** Rebuild the float set from the draft (call when props change). */
  rebuild(): void
  /** Advance every float by `dt` and refresh `poses`. */
  step(dt: number): void
  /** Latest pose per floating prop index, refreshed by `step`. */
  poses: Map<number, FloatPose>
}

/**
 * Build a float-preview driver over a draft track + its live wave field.
 * `waveRiderAssetIds` is the set of asset ids the manifest marks as
 * wave-riders, so archetype floats (buoys) preview alongside per-instance ones.
 */
export function createEditorFloatPreview(
  draft: Track,
  field: WaveFieldState,
  waveRiderAssetIds: ReadonlySet<string> = new Set(),
): EditorFloatPreview {
  let states: FloatState[] = []
  const poses = new Map<number, FloatPose>()

  function floats(p: Track['props'][number]): boolean {
    if (p.waveRider != null) return true
    return p.type === 'asset' && p.assetId != null && waveRiderAssetIds.has(p.assetId)
  }

  function rebuild(): void {
    states = []
    poses.clear()
    draft.props.forEach((p, i) => {
      if (!floats(p)) return
      const dof = p.waveRider?.dof ?? 'locked'
      const tuning = deriveWaveRiderTuning({
        halfHeight: Math.max(0.1, p.size.y),
        footprint: Math.max(0.1, p.size.x, p.size.z),
        // Rest where it was placed, relative to the mean surface.
        restOffsetY: p.position.y - field.baseY,
        dof,
      })
      states.push({
        propIndex: i,
        tuning,
        anchorX: p.position.x,
        anchorZ: p.position.z,
        perturbY: 0,
        perturbYVel: 0,
        tiltDirX: 0,
        tiltDirZ: 0,
        tiltVelX: 0,
        tiltVelZ: 0,
        // Seed the drift yaw with the authored heading (matches the sim spawn),
        // so a placed log keeps its orientation and only drifts from there.
        yawDrift: quatYaw(p.rotation),
      })
    })
  }

  function step(dt: number): void {
    if (dt <= 0) return
    for (const s of states) poses.set(s.propIndex, stepFloat(s, field, dt))
  }

  rebuild()
  return { rebuild, step, poses }
}
