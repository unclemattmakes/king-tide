/**
 * Rider pose system — kinematic chain walker with reactive offsets and
 * hand IK to the bike's handlebars.
 *
 * Pipeline per fixed step:
 *   1. Pelvis world pose = bike_pose ⊗ (SEAT_LOCAL, identity).
 *   2. Walk the joint list in parent-before-child order. Each child's
 *      world pose is derived from its parent: anchor matching on the
 *      joint position, target relative rotation modulated by per-bone
 *      reactive offsets.
 *   3. Run 2-bone IK for each arm so the hand lands on the bike's
 *      handlebar anchor regardless of the chest's current yaw. The
 *      shoulder moves with the chest, the hand stays planted, and the
 *      elbow bends to compensate.
 *   4. setNextKinematicTranslation / setNextKinematicRotation on every
 *      bone's rigid body.
 *
 * The chain walker is the load-bearing fix for the "torso looks like it
 * lags in translation" symptom from the calibration scene. With each
 * bone's world transform derived from its parent (not stored against the
 * bike directly), any reactive rotation on the chest carries the head,
 * arms, and IK targets along with it — the visual chain stays connected.
 *
 * Reactive offsets:
 *   - Chest pitch (bounce) — vertical accel drives a critically-damped
 *     spring. Hard landings flex the torso forward, then settle.
 *   - Chest yaw (flow) — bike yaw rate drives a low-pass yaw offset.
 *     The whole upper body pivots from the hips toward the turn.
 *   - Head yaw / pitch — raw stick steer (pre the player steer scale +
 *     smoothing, so the head leads the bike) + (throttle - brake).
 *
 * Launched riders are skipped: their bones are dynamic at that point and
 * are owned by Rapier's iterative solver.
 *
 * STRUCTURE: the hand-rolled quat/vector math lives in `rider-pose-math.ts`;
 * the tuning table in `rider-pose-tuning.ts`; the 2-bone IK + chain walker in
 * `rider-ik.ts`. This file is the ECS system that wires them together and
 * re-exports the symbols other modules import from here.
 *
 * TUNING is read PER-ENTITY (`RiderData.tuning`), falling back to the shared
 * mutable `RIDER_POSE_TUNING` global. The global is kept as a DEV OVERRIDE so
 * the calibration / rider-editor scenes can rebind values live from devtools
 * without a page reload.
 */

import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { ControlIntentStore, DriftStateStore, RBHandleStore } from '@/game/components'
import {
  Rider,
  type RiderBoneName,
  type RiderPoseResponse,
  RiderStore,
} from '@/game/components/rider'
import { rawSteerFor } from '@/game/systems/input-apply'
import {
  applyLimbIK,
  boneHalfHeights,
  tipOfBone,
  type WorldPose,
  walkChain,
} from '@/game/systems/rider-ik'
import { clamp, IDENT_QUAT, lerp, rotByQuat } from '@/game/systems/rider-pose-math'
import { RIDER_POSE_TUNING, type RiderTuning } from '@/game/systems/rider-pose-tuning'

// Re-export the public surface that other modules import from this path so
// no importer has to change after the split.
export { RIDER_POSE_TUNING, type RiderTuning } from '@/game/systems/rider-pose-tuning'

function zeroPoseResponse(r: RiderPoseResponse): void {
  r.prevVel.x = 0
  r.prevVel.y = 0
  r.prevVel.z = 0
  r.bouncePitch = 0
  r.bouncePitchVel = 0
  r.flowYaw = 0
  r.headYaw = 0
  r.headPitch = 0
  r.leanRoll = 0
}

/**
 * Target torso roll (radians) for the rider's drift bank. Pure +
 * exported so the lean curve is unit-pinned.
 *
 *  - `driftDir` 0 (not drifting) → 0 (the rider returns upright).
 *  - Otherwise leans toward the drift direction with a magnitude that
 *    grows when `steer` points INTO the drift and shrinks on
 *    counter-steer (`intoSigned = steer × driftDir`, range ≈ ±0.7
 *    after the player steer pre-scale).
 *
 * Sign: a left drift (`driftDir = -1`) returns a NEGATIVE roll, which
 * `quatAxisAngle(0,0,1,·)` on `spine_lower` (chest-forward axis) banks
 * the torso to the rider's left — into the corner. (Playtest confirmed
 * the initial `-1` banked the wrong way; `+1` leans into the turn.)
 */
const DRIFT_LEAN_SIGN = 1
export function driftLeanTarget(
  driftDir: number,
  steer: number,
  tuning: RiderTuning = RIDER_POSE_TUNING,
): number {
  if (driftDir === 0) return 0
  const t = tuning
  const intoSigned = steer * driftDir
  const mag = clamp(
    t.driftLeanBase + t.driftLeanIntoGain * intoSigned,
    t.driftLeanMin,
    t.driftLeanMax,
  )
  return DRIFT_LEAN_SIGN * driftDir * mag
}

function tickPoseResponse(
  resp: RiderPoseResponse,
  bikeLinvel: Vec3,
  bikeAngvel: Vec3,
  intent: Intent | undefined,
  /** Unshaped stick steer for the head-look (player: raw input, pre the
   *  PLAYER_STEER_SCALE + smoothing the bike's steering goes through; AI:
   *  same as `intent.steer`). The head must lead the bike, so it can't
   *  read the bike's own filtered steer. */
  lookSteer: number,
  driftDir: number,
  dt: number,
  tuning: RiderTuning,
): void {
  // Bounce: critically-damped spring driven by vertical accel.
  const safeDt = Math.max(dt, 1e-4)
  const accelY = (bikeLinvel.y - resp.prevVel.y) / safeDt
  const force = -accelY * tuning.bounceForceGain
  const accel =
    -tuning.bounceSpringK * resp.bouncePitch -
    tuning.bounceSpringDamping * resp.bouncePitchVel +
    force
  resp.bouncePitchVel += accel * dt
  resp.bouncePitch += resp.bouncePitchVel * dt
  if (resp.bouncePitch > tuning.bounceMaxPitch) {
    resp.bouncePitch = tuning.bounceMaxPitch
    if (resp.bouncePitchVel > 0) resp.bouncePitchVel = 0
  } else if (resp.bouncePitch < -tuning.bounceMaxPitch) {
    resp.bouncePitch = -tuning.bounceMaxPitch
    if (resp.bouncePitchVel < 0) resp.bouncePitchVel = 0
  }

  // Flow yaw: low-pass toward bike yaw rate scaled.
  const yawRate = bikeAngvel.y
  const flowTarget = clamp(
    yawRate * tuning.flowYawPerYawRate,
    -tuning.flowMaxYaw,
    tuning.flowMaxYaw,
  )
  resp.flowYaw = lerp(resp.flowYaw, flowTarget, tuning.flowSmoothing)

  // Head yaw: driven by the RAW stick (`lookSteer`), attack/release
  // asymmetric — the head whips toward where the player is steering
  // (deeper deflection or a direction flip both attack) and drifts back
  // when the stick releases.
  const headYawTarget = clamp(lookSteer * tuning.headYawMax, -tuning.headYawMax, tuning.headYawMax)
  const headYawFlip = headYawTarget * resp.headYaw < 0
  const headYawRate =
    headYawFlip || Math.abs(headYawTarget) > Math.abs(resp.headYaw)
      ? tuning.headYawAttack
      : tuning.headYawRelease
  resp.headYaw = lerp(resp.headYaw, headYawTarget, headYawRate)

  // Head pitch: throttle - brake.
  const throttle = intent?.throttle ?? 0
  const brake = intent?.brake ?? 0
  const pitchTarget = clamp(
    (throttle - brake * 1.5) * tuning.headPitchMax,
    -tuning.headPitchMax,
    tuning.headPitchMax,
  )
  resp.headPitch = lerp(resp.headPitch, pitchTarget, tuning.headPitchSmoothing)

  // Drift bank: low-pass toward the lean target (0 when not drifting,
  // so the torso eases back upright on release). Stays on the bike's
  // SHAPED steer — driftLeanIntoGain is tuned against its ±0.7 range.
  const leanTarget = driftLeanTarget(driftDir, intent?.steer ?? 0, tuning)
  resp.leanRoll = lerp(resp.leanRoll, leanTarget, tuning.driftLeanSmoothing)

  resp.prevVel.x = bikeLinvel.x
  resp.prevVel.y = bikeLinvel.y
  resp.prevVel.z = bikeLinvel.z
}

/** Bike-local IK end-effector targets (hand + foot tips) derived from the
 *  static REST pose. Walking from frame=(origin, identity) keeps every pose
 *  in bike-local; skipping reactive offsets gives the static rest pose. */
type LimbTipTargets = {
  handLocalL: Vec3
  handLocalR: Vec3
  footLocalL: Vec3
  footLocalR: Vec3
}

const ZERO_POSE: WorldPose = { pos: { x: 0, y: 0, z: 0 }, rot: IDENT_QUAT }

function deriveLimbTipTargets(
  rider: ReturnType<typeof RiderStore.must>,
  halfHeights: Map<RiderBoneName, number>,
  tuning: RiderTuning,
): LimbTipTargets {
  // Pass 1 — REST pose in bike-local space. Used to derive IK end-effector
  // targets. Walking from frame=(origin, identity) means every pose is in
  // bike-local. Skipping reactive offsets gives the static rest pose.
  const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }
  const restPoses = walkChain(rider, ORIGIN, IDENT_QUAT, false, tuning)

  const lowerArmHH_L = halfHeights.get('lower_arm_L') ?? 0.18
  const lowerArmHH_R = halfHeights.get('lower_arm_R') ?? 0.18
  const lowerLegHH_L = halfHeights.get('lower_leg_L') ?? 0.24
  const lowerLegHH_R = halfHeights.get('lower_leg_R') ?? 0.24
  return {
    handLocalL: tipOfBone(restPoses.get('lower_arm_L') ?? ZERO_POSE, lowerArmHH_L),
    handLocalR: tipOfBone(restPoses.get('lower_arm_R') ?? ZERO_POSE, lowerArmHH_R),
    footLocalL: tipOfBone(restPoses.get('lower_leg_L') ?? ZERO_POSE, lowerLegHH_L),
    footLocalR: tipOfBone(restPoses.get('lower_leg_R') ?? ZERO_POSE, lowerLegHH_R),
  }
}

/** Apply hand + foot IK in place on the reactive (world-space) pose map.
 *  Converts the rest-derived bike-local limb tips → world and bends each
 *  limb to land on them. */
function applyAllLimbIK(
  rider: ReturnType<typeof RiderStore.must>,
  poses: Map<RiderBoneName, WorldPose>,
  halfHeights: Map<RiderBoneName, number>,
  bikePos: Vec3,
  bikeRot: Quat,
  tips: LimbTipTargets,
  tuning: RiderTuning,
): void {
  // Convert each rest-derived limb-tip target from bike-local → world.
  const toWorld = (local: Vec3): Vec3 => {
    const r = rotByQuat(bikeRot, local.x, local.y, local.z)
    return { x: bikePos.x + r.x, y: bikePos.y + r.y, z: bikePos.z + r.z }
  }
  const handTargetL = toWorld(tips.handLocalL)
  const handTargetR = toWorld(tips.handLocalR)
  const footTargetL = toWorld(tips.footLocalL)
  const footTargetR = toWorld(tips.footLocalR)

  // Pole hints — "preferred elbow / knee bend direction" in bike-local
  // space (tunable via the rider editor), rotated into world by bike
  // orientation. The IK projects this onto the plane perpendicular to
  // shoulder→hand (or hip→foot) and bends toward it. See the
  // `armPole` / `legPole` notes on RIDER_POSE_TUNING for the sign.
  const armPoleLocal = tuning.armPole
  const legPoleLocal = tuning.legPole
  const armPole = rotByQuat(bikeRot, armPoleLocal.x, armPoleLocal.y, armPoleLocal.z)
  const legPole = rotByQuat(bikeRot, legPoleLocal.x, legPoleLocal.y, legPoleLocal.z)

  if (tuning.handIKStrength > 0) {
    applyLimbIK(
      rider,
      poses,
      halfHeights,
      'chest',
      'upper_arm_L',
      'lower_arm_L',
      handTargetL,
      armPole,
    )
    applyLimbIK(
      rider,
      poses,
      halfHeights,
      'chest',
      'upper_arm_R',
      'lower_arm_R',
      handTargetR,
      armPole,
    )
  }
  if (tuning.footIKStrength > 0) {
    applyLimbIK(
      rider,
      poses,
      halfHeights,
      'pelvis',
      'upper_leg_L',
      'lower_leg_L',
      footTargetL,
      legPole,
    )
    applyLimbIK(
      rider,
      poses,
      halfHeights,
      'pelvis',
      'upper_leg_R',
      'lower_leg_R',
      footTargetR,
      legPole,
    )
  }
}

export function riderPoseSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const eids = query(sim, [Rider])
  for (const eid of eids) {
    const rider = RiderStore.must(eid)
    rider.stateAge += dt

    if (rider.state !== 'attached') continue

    const bikeRb = phys.world.getRigidBody(rider.bikeRbHandle)
    if (!bikeRb) continue
    const bikePos = bikeRb.translation() as Vec3
    const bikeRot = bikeRb.rotation() as Quat
    const bikeLinvel = bikeRb.linvel()
    const bikeAngvel = bikeRb.angvel()
    const intent = ControlIntentStore.get(rider.bikeEid)
    const driftDir = DriftStateStore.get(rider.bikeEid)?.driftDir ?? 0
    // Head-look source: the raw stick when this bike routes through the
    // player input pipeline, else the bike's ControlIntent (AI / replay —
    // already unshaped).
    const lookSteer = rawSteerFor(rider.bikeEid) ?? intent?.steer ?? 0

    // Per-entity tuning, falling back to the shared dev-override global.
    const tuning = rider.tuning ?? RIDER_POSE_TUNING

    tickPoseResponse(
      rider.poseResponse,
      bikeLinvel,
      bikeAngvel,
      intent,
      lookSteer,
      driftDir,
      dt,
      tuning,
    )

    const halfHeights = boneHalfHeights(rider)

    // Pass 1 — bike-local REST pose → IK end-effector targets.
    const tips = deriveLimbTipTargets(rider, halfHeights, tuning)

    // Pass 2 — REACTIVE pose in world space. Reactive offsets applied;
    // pelvis world transform = bike transform * seat anchor.
    const poses = walkChain(rider, bikePos, bikeRot, true, tuning)

    applyAllLimbIK(rider, poses, halfHeights, bikePos, bikeRot, tips, tuning)

    // Write out world poses to Rapier.
    for (const [name, pose] of poses) {
      const boneEid = rider.bones[name]
      const handle = RBHandleStore.get(boneEid)
      if (!handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue
      rb.setNextKinematicTranslation(pose.pos)
      rb.setNextKinematicRotation(pose.rot)
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
    const Kinematic = phys.rapier.RigidBodyType.KinematicPositionBased
    for (const dim of rider.boneDims) {
      const rb = phys.world.getRigidBody(dim.rbHandle)
      if (!rb) continue
      while (rb.numColliders() > 0) {
        const c = rb.collider(0)
        if (!c) break
        phys.world.removeCollider(c, true)
      }
      rb.setBodyType(Kinematic, true)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
    rider.state = 'attached'
    rider.motorScale = 1
    rider.stateAge = 0
  }
  zeroPoseResponse(rider.poseResponse)
}

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
