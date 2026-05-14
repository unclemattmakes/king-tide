/**
 * Rider pose system — drives the attached rider's bones to their target
 * stance by directly positioning each bone every fixed step, modulated by
 * reactive offsets derived from bike state and player input.
 *
 * While the rest pose stays static (chest pitched 22°, etc.), the chest +
 * head get per-tick deltas on top:
 *
 *   - **Bounce** — vertical acceleration drives a critically-damped spring
 *     on the chest's pitch. Hard landings → torso flexes forward briefly,
 *     then settles. Hard takeoffs (boost pads, ramps) → torso flexes back.
 *   - **Flow** — bike yaw rate drives a low-pass roll offset on the chest.
 *     The torso leans INTO the turn (counter-roll of the bike's lateral
 *     lean would be wrong — riders carve with the bike, not against it).
 *   - **Head yaw** — ControlIntent.steer drives a low-pass yaw offset on
 *     the head. Head leads the bike into a turn.
 *   - **Head pitch** — ControlIntent.throttle - brake biases the head
 *     forward or back. Bracing into accel, pulling back on heavy braking.
 *
 * Bones are KinematicPositionBased while attached, so the constraint
 * solver never touches them. Each tick we compute, for each bone:
 *
 *   world_pose = bike_pose ⊗ (bike_local_rest_pose · reactive_offset)
 *
 * and call setNextKinematicTranslation / setNextKinematicRotation on the
 * bone's rigid body.
 *
 * Launched riders are skipped — their bones are dynamic at that point and
 * are owned by Rapier's iterative solver.
 *
 * Tuning constants are exported as `RIDER_POSE_TUNING` so the calibration
 * scene can mutate them at runtime via the debug console.
 */

import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { ControlIntentStore, RBHandleStore } from '@/game/components'
import {
  RIDER_BONE_NAMES,
  Rider,
  type RiderBoneRest,
  type RiderPoseResponse,
  RiderStore,
} from '@/game/components/rider'

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Rotate a vector by a unit quaternion. Inlined here for hot-path use —
 *  this runs for every bone of every rider every fixed step. */
function rotByQuat(q: Quat, vx: number, vy: number, vz: number) {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  return {
    x: vx + q.w * tx + (q.y * tz - q.z * ty),
    y: vy + q.w * ty + (q.z * tx - q.x * tz),
    z: vz + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** Quaternion from axis-angle (axis must be unit). */
function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle * 0.5
  const s = Math.sin(h)
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) }
}

/** Rider pose-response tuning. Exposed as a mutable object so the
 *  calibration scene can rebind values live from devtools without a
 *  page reload — `window.__hover.riderTuning = { ... }` style. */
export const RIDER_POSE_TUNING = {
  /** Bounce: critically-damped spring driven by vertical acceleration.
   *  Stiffness (k) and damping (c) for the torso-pitch spring. The
   *  forcing term is `-accelY * bounceForceGain` — negative because a
   *  positive accelY (bike pushed up) makes the torso lag behind (pitch
   *  forward), which reads as the rider "settling" into the bike.
   *  Tuned for visibility — small Δvy (a normal hover wobble) is meant
   *  to produce a perceptible torso flex, not a millimetric jitter. */
  bounceSpringK: 22,
  bounceSpringDamping: 7,
  bounceForceGain: 0.04,
  /** Clamp the chest's bounce-pitch offset (radians). At ±0.5 rad (~28°)
   *  the torso visibly flexes but never folds in half. */
  bounceMaxPitch: 0.5,

  /** Flow: low-pass on a target roll derived from bike yaw rate.
   *  Lerp coefficient per tick at 60Hz; ~0.08 = ~200ms time constant. */
  flowSmoothing: 0.08,
  /** Conversion factor from bike yaw rate (rad/s) to torso roll target
   *  (rad). At yawRate = 1 rad/s (a 360° turn in ~6s), the torso leans
   *  ~0.6 rad (~34°) into the turn. */
  flowRollPerYawRate: 0.6,
  /** Clamp on the chest roll offset (rad). */
  flowMaxRoll: 0.7,

  /** Head yaw: low-pass on ControlIntent.steer. */
  headYawSmoothing: 0.12,
  /** Maximum head yaw (rad) at full steer input. */
  headYawMax: 0.7,

  /** Head pitch: low-pass on ControlIntent.throttle - brake. */
  headPitchSmoothing: 0.06,
  /** Maximum head pitch (rad) at full throttle (forward) or full brake
   *  (backward). */
  headPitchMax: 0.18,
}

/** Reset pose-response state to its rest-at-equilibrium values. Called
 *  by resetRider() when the player respawns; also implicitly correct
 *  for the initial spawn. */
function zeroPoseResponse(r: RiderPoseResponse): void {
  r.prevVel.x = 0
  r.prevVel.y = 0
  r.prevVel.z = 0
  r.bouncePitch = 0
  r.bouncePitchVel = 0
  r.flowRoll = 0
  r.headYaw = 0
  r.headPitch = 0
}

/** Compute the per-bone reactive offset on top of its rest rotation.
 *  Most bones are pose-static (limbs follow rest pose verbatim); the
 *  chest and head get bounce/flow/yaw injected. Returned quaternion is
 *  the offset to right-multiply into rest.bikeLocalRot. */
function reactiveOffsetFor(name: string, resp: RiderPoseResponse): Quat | null {
  if (name === 'chest') {
    // Chest: pitch (bounce) around bone local X, roll (flow) around bone
    // local Z. Composed as roll·pitch so they apply independently of
    // order (small-angle regime).
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch)
    const rollQ = quatAxisAngle(0, 0, 1, resp.flowRoll)
    return quatMul(pitchQ, rollQ)
  }
  if (name === 'head') {
    // Head: yaw around bone local Y (the rider's vertical), pitch
    // around local X. Small forward bias on accel reads as the helmet
    // ducking into the wind.
    const yawQ = quatAxisAngle(0, 1, 0, resp.headYaw)
    const pitchQ = quatAxisAngle(1, 0, 0, resp.headPitch)
    return quatMul(yawQ, pitchQ)
  }
  return null
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Update the rider's pose-response signals from this tick's bike state.
 * Reads bike linvel / angvel and the bike's ControlIntent; writes to the
 * rider's `poseResponse`. Pure arithmetic — no physics calls.
 */
function tickPoseResponse(
  resp: RiderPoseResponse,
  bikeLinvel: Vec3,
  bikeAngvel: Vec3,
  intent: Intent | undefined,
  dt: number,
): void {
  // --- Bounce ---
  // Vertical acceleration approximated by finite difference. Cap dt to
  // avoid spikes when the game pauses or hits a slow frame.
  const safeDt = Math.max(dt, 1e-4)
  const accelY = (bikeLinvel.y - resp.prevVel.y) / safeDt
  // Critically-damped spring on bouncePitch driven by accelY:
  //   ẍ = -k·x - c·ẋ + f
  // Symplectic Euler step.
  const force = -accelY * RIDER_POSE_TUNING.bounceForceGain
  const accel =
    -RIDER_POSE_TUNING.bounceSpringK * resp.bouncePitch -
    RIDER_POSE_TUNING.bounceSpringDamping * resp.bouncePitchVel +
    force
  resp.bouncePitchVel += accel * dt
  resp.bouncePitch += resp.bouncePitchVel * dt
  // Clamp displacement to keep the spring physical-looking even under
  // extreme inputs (e.g. a debug velocity injection in the calibration
  // scene). Also clip the velocity when we hit the wall so we don't get
  // a bounce-back glitch.
  if (resp.bouncePitch > RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel > 0) resp.bouncePitchVel = 0
  } else if (resp.bouncePitch < -RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = -RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel < 0) resp.bouncePitchVel = 0
  }

  // --- Flow ---
  // Bike yaw rate (rad/s around world Y) → torso roll into the turn.
  const yawRate = bikeAngvel.y
  const flowTarget = clamp(
    yawRate * RIDER_POSE_TUNING.flowRollPerYawRate,
    -RIDER_POSE_TUNING.flowMaxRoll,
    RIDER_POSE_TUNING.flowMaxRoll,
  )
  resp.flowRoll = lerp(resp.flowRoll, flowTarget, RIDER_POSE_TUNING.flowSmoothing)

  // --- Head yaw ---
  // Driven by raw steer input. -1 = full left, +1 = full right.
  const steer = intent?.steer ?? 0
  const headYawTarget = clamp(
    steer * RIDER_POSE_TUNING.headYawMax,
    -RIDER_POSE_TUNING.headYawMax,
    RIDER_POSE_TUNING.headYawMax,
  )
  resp.headYaw = lerp(resp.headYaw, headYawTarget, RIDER_POSE_TUNING.headYawSmoothing)

  // --- Head pitch ---
  // Throttle pulls head forward (into the wind); brake pulls it back.
  const throttle = intent?.throttle ?? 0
  const brake = intent?.brake ?? 0
  const pitchTarget = clamp(
    (throttle - brake * 1.5) * RIDER_POSE_TUNING.headPitchMax,
    -RIDER_POSE_TUNING.headPitchMax,
    RIDER_POSE_TUNING.headPitchMax,
  )
  resp.headPitch = lerp(resp.headPitch, pitchTarget, RIDER_POSE_TUNING.headPitchSmoothing)

  // Stash this tick's velocity for next-tick acceleration finite-diff.
  resp.prevVel.x = bikeLinvel.x
  resp.prevVel.y = bikeLinvel.y
  resp.prevVel.z = bikeLinvel.z
}

export function riderPoseSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const eids = query(sim, [Rider])
  for (const eid of eids) {
    const rider = RiderStore.must(eid)
    rider.stateAge += dt

    if (rider.state !== 'attached') continue

    const bikeRb = phys.world.getRigidBody(rider.bikeRbHandle)
    if (!bikeRb) continue
    const bikePos = bikeRb.translation()
    const bikeRot = bikeRb.rotation() as Quat
    const bikeLinvel = bikeRb.linvel()
    const bikeAngvel = bikeRb.angvel()
    const intent = ControlIntentStore.get(rider.bikeEid)

    tickPoseResponse(rider.poseResponse, bikeLinvel, bikeAngvel, intent, dt)

    for (const name of RIDER_BONE_NAMES) {
      const boneEid = rider.bones[name]
      const rest: RiderBoneRest = rider.restPose[name]
      const handle = RBHandleStore.get(boneEid)
      if (!handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue

      // Position in bike-local space — reactive offsets are rotation-only,
      // so the bone's center position stays at its rest location.
      const worldOffset = rotByQuat(
        bikeRot,
        rest.bikeLocalPos.x,
        rest.bikeLocalPos.y,
        rest.bikeLocalPos.z,
      )
      rb.setNextKinematicTranslation({
        x: bikePos.x + worldOffset.x,
        y: bikePos.y + worldOffset.y,
        z: bikePos.z + worldOffset.z,
      })

      // Rotation: bike_rot · rest_rot · reactive_offset.
      const offset = reactiveOffsetFor(name, rider.poseResponse)
      const localRot = offset === null ? rest.bikeLocalRot : quatMul(rest.bikeLocalRot, offset)
      rb.setNextKinematicRotation(quatMul(bikeRot, localRot))
    }
  }
}

/**
 * Reset a rider to its attached rest pose. If the rider was launched, this
 * tears down the ragdoll: removes its joints + colliders, swaps the bones
 * back to KinematicPositionBased, and clears the bone velocities so the
 * next pose tick places everything at the bike's seat without a one-frame
 * teleport visible.
 *
 * Safe to call when the rider is already attached — it just zeroes the
 * pose-response state so any in-progress bounce/flow lerp lands at zero.
 */
export function resetRider(phys: PhysicsWorld, rider: ReturnType<typeof RiderStore.must>): void {
  if (rider.state === 'launched') {
    // Remove the ragdoll joints. Walk in reverse so any deferred handles
    // in Rapier's joint set don't shift under us.
    for (let i = rider.joints.length - 1; i >= 0; i--) {
      const j = rider.joints[i]
      if (!j || j.jointHandle === null) continue
      try {
        const joint = phys.world.getImpulseJoint(j.jointHandle)
        if (joint) phys.world.removeImpulseJoint(joint, true)
      } catch {
        // Joint may already be invalid; not a reset blocker.
      }
      j.jointHandle = null
    }
    // Swap every bone back to kinematic + drop the collider we attached on
    // launch. Without removing the collider, the rider would still slam
    // into terrain even though the bones now teleport-track the bike.
    const Kinematic = phys.rapier.RigidBodyType.KinematicPositionBased
    for (const dim of rider.boneDims) {
      const rb = phys.world.getRigidBody(dim.rbHandle)
      if (!rb) continue
      // Remove all colliders attached at launch (numColliders > 0 only
      // after launchRider added one each). `rb.collider(0)` returns the
      // Collider directly — no extra handle lookup needed.
      while (rb.numColliders() > 0) {
        const c = rb.collider(0)
        if (!c) break
        phys.world.removeCollider(c, true)
      }
      rb.setBodyType(Kinematic, true)
      // Zero any lingering velocities so the kinematic body doesn't carry
      // momentum into its first frame back.
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
    rider.state = 'attached'
    rider.motorScale = 1
    rider.stateAge = 0
  }
  // Always zero the reactive state on a reset, even if already attached —
  // the bike's velocity was just slammed to zero, so the rider shouldn't
  // be mid-bounce from whatever happened before the reset.
  zeroPoseResponse(rider.poseResponse)
}

/** Convenience: find the rider entity that owns a given bike eid and
 *  reset it. Returns true if a rider was found and reset, false otherwise.
 *  Called from the keyboard respawn handler. */
export function resetRiderForBike(sim: SimWorld, phys: PhysicsWorld, bikeEid: number): boolean {
  const eids = query(sim, [Rider])
  for (const eid of eids) {
    const r = RiderStore.must(eid)
    if (r.bikeEid === bikeEid) {
      resetRider(phys, r)
      return true
    }
  }
  return false
}
