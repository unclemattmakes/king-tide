/**
 * Wave-rider sim system — kinematic float + spring-damped perturbation.
 *
 * Per fixed step, for each WaveRider entity:
 *   1. Sample the analytic wave surface at the body's anchor XZ.
 *   2. Compute rest pose: y = surface.y + floatOffsetY, tilt = wave normal
 *      scaled by `normalFollow`, yaw = accumulated drift.
 *   3. Step the perturbation springs (vertical + tilt vector).
 *   4. Compose final pose and push to the kinematic body via
 *      `setNextKinematic{Translation,Rotation}`.
 *
 * Tilt representation: a 2D horizontal vector `(tiltDirX, tiltDirZ)`
 * whose length is the lean angle in radians and direction is the world
 * direction the body's local +Y axis is tilted toward. The wave-surface
 * tilt is computed the same way (≈ horizontal component of the surface
 * normal flipped sign) and the two are summed before being turned into
 * a quaternion. Small-angle commutativity makes this OK.
 */

import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { RBHandleStore, TransformStore } from '@/game/components'
import { WaveRiderStore, WaveRiderTag } from '@/game/components/wave-rider'

export type WaveRiderSystem = {
  /** Advance every wave-rider by `dt` seconds. Call once per fixed step. */
  step(dt: number): void
  /**
   * Apply a hit impulse to a specific wave-rider. `impulse` is in world
   * coordinates and unscaled — magnitudes around 1..6 give a satisfying
   * Wave-Race-style knock. The vertical component pushes the perturbY
   * spring; the horizontal component tilts the top of the body in that
   * direction (lean away from the source of the hit).
   */
  applyHit(eid: number, impulse: { x: number; y: number; z: number }): void
}

/** Max lean angle (rad). Caps a strong hit from pushing the buoy past
 *  horizontal, where the small-angle linearisation breaks down and the
 *  composed quaternion gimbals visibly. ~75° leaves headroom while
 *  still allowing dramatic knocks. */
const MAX_TILT = (75 * Math.PI) / 180

export type WaveRiderSystemOpts = {
  /** King-tide beaching probe: max terrain Y at an XZ, or null where there's
   *  no terrain (open water). When the receding tide drops the water below the
   *  terrain at a float's anchor, it rests on the exposed ground (a beached
   *  buoy → static obstacle/ramp) instead of floating. Pure closure (the sim
   *  layer stays Three-free); omit it to disable beaching (still water). */
  sampleTerrainY?: (x: number, z: number) => number | null
}

export function createWaveRiderSystem(
  sim: SimWorld,
  phys: PhysicsWorld,
  waveField: WaveFieldState,
  opts: WaveRiderSystemOpts = {},
): WaveRiderSystem {
  const sampleTerrainY = opts.sampleTerrainY
  function step(dt: number): void {
    const entities = query(sim, [WaveRiderTag])
    for (const eid of entities) {
      const wr = WaveRiderStore.get(eid)
      const handle = RBHandleStore.get(eid)
      if (!wr || !handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue

      const surface = sampleSurface(waveField, wr.anchorX, wr.anchorZ)
      // King-tide beaching: if the (receding) water sits below the terrain at
      // this anchor, the float rests on the exposed ground and sits flat — no
      // wave lean and no vertical bob; hit-driven tilt (the spring below) still
      // applies so a beached buoy can still be knocked.
      let restY = surface.y
      let grounded = false
      if (sampleTerrainY) {
        const terrainY = sampleTerrainY(wr.anchorX, wr.anchorZ)
        if (terrainY !== null && terrainY > surface.y) {
          restY = terrainY
          grounded = true
        }
      }
      // Wave-normal tilt → horizontal lean vector. Normal is unit;
      // (nx, nz) is the horizontal projection of "where the surface
      // top is pointing", small-angle equal to the lean direction. Zeroed
      // while beached — a grounded buoy doesn't follow the swell.
      const waveLeanX = grounded ? 0 : surface.nx * wr.tuning.normalFollow
      const waveLeanZ = grounded ? 0 : surface.nz * wr.tuning.normalFollow

      // ---- Spring step (vertical) -----------------------------------
      const t = wr.tuning
      wr.perturbYVel += (-t.springK * wr.perturbY - t.springDamping * wr.perturbYVel) * dt
      wr.perturbY += wr.perturbYVel * dt

      // ---- Spring step (tilt vector) -------------------------------
      wr.tiltVelX += (-t.tiltK * wr.tiltDirX - t.tiltDamping * wr.tiltVelX) * dt
      wr.tiltVelZ += (-t.tiltK * wr.tiltDirZ - t.tiltDamping * wr.tiltVelZ) * dt
      wr.tiltDirX += wr.tiltVelX * dt
      wr.tiltDirZ += wr.tiltVelZ * dt

      // ---- Drift yaw ------------------------------------------------
      wr.yawDrift += t.yawDriftRate * dt

      // ---- Compose final pose ---------------------------------------
      const totalLeanX = waveLeanX + wr.tiltDirX
      const totalLeanZ = waveLeanZ + wr.tiltDirZ
      const leanMag = Math.hypot(totalLeanX, totalLeanZ)
      const clampedMag = Math.min(leanMag, MAX_TILT)
      // Axis-angle: angle = leanMag, axis = perpendicular to lean dir in
      // the horizontal plane. lean toward +X = rotate around -Z.
      // axis = (leanZ, 0, -leanX) / leanMag (right-hand rule).
      let qLean = { x: 0, y: 0, z: 0, w: 1 }
      if (leanMag > 1e-5) {
        const half = clampedMag * 0.5
        const s = Math.sin(half) / leanMag
        qLean = {
          x: totalLeanZ * s,
          y: 0,
          z: -totalLeanX * s,
          w: Math.cos(half),
        }
      }
      // Yaw on top.
      const halfYaw = wr.yawDrift * 0.5
      const qYaw = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }
      // Apply lean first, then yaw — yaw is the prop's local spin so it
      // multiplies on the right.
      const fx = qLean.x
      const fy = qLean.y
      const fz = qLean.z
      const fw = qLean.w
      const yx = qYaw.x
      const yy = qYaw.y
      const yz = qYaw.z
      const yw = qYaw.w
      const qx = fw * yx + fx * yw + fy * yz - fz * yy
      const qy = fw * yy - fx * yz + fy * yw + fz * yx
      const qz = fw * yz + fx * yy - fy * yx + fz * yw
      const qw = fw * yw - fx * yx - fy * yy - fz * yz

      const finalY = restY + t.floatOffsetY + (grounded ? 0 : wr.perturbY)
      rb.setNextKinematicTranslation({ x: wr.anchorX, y: finalY, z: wr.anchorZ })
      rb.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw })

      // Mirror to Transform for the render system.
      TransformStore.set(eid, {
        x: wr.anchorX,
        y: finalY,
        z: wr.anchorZ,
        qx,
        qy,
        qz,
        qw,
      })
    }
  }

  function applyHit(eid: number, impulse: { x: number; y: number; z: number }): void {
    const wr = WaveRiderStore.get(eid)
    if (!wr) return
    // Vertical: push the perturbY spring directly. Mass is implicit
    // in the spring constants — `gain` here is a feel knob.
    const vGain = 0.6
    wr.perturbYVel += impulse.y * vGain
    // Horizontal: tilt the top in the direction of the impulse (lean
    // away from the hit source). The tilt-direction storage and the
    // impulse direction share world XZ axes, so this is a direct add.
    const hGain = 0.4
    wr.tiltVelX += impulse.x * hGain
    wr.tiltVelZ += impulse.z * hGain
  }

  return { step, applyHit }
}
