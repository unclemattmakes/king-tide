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
 *   - Head yaw / pitch — ControlIntent.steer + (throttle - brake).
 *
 * Launched riders are skipped: their bones are dynamic at that point and
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
  Rider,
  type RiderBoneName,
  type RiderPoseResponse,
  RiderStore,
} from '@/game/components/rider'

const IDENT_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 }

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Rotate a vector by a unit quaternion. Inlined here for hot-path use. */
function rotByQuat(q: Quat, vx: number, vy: number, vz: number): Vec3 {
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

/** Build a quaternion that maps the unit `from` vector onto the unit `to`
 *  vector by the shortest rotation. Used by the arm IK to compute world
 *  bone orientations from "down the bone" target directions. */
function quatFromTo(from: Vec3, to: Vec3): Quat {
  const d = from.x * to.x + from.y * to.y + from.z * to.z
  if (d > 0.999999) return { x: 0, y: 0, z: 0, w: 1 }
  if (d < -0.999999) {
    // 180° rotation around any axis perpendicular to `from`.
    let ax = -from.y
    let ay = from.x
    let az = 0
    if (Math.hypot(ax, ay) < 1e-6) {
      ax = 0
      ay = -from.z
      az = from.y
    }
    const len = Math.hypot(ax, ay, az)
    return { x: ax / len, y: ay / len, z: az / len, w: 0 }
  }
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  const w = 1 + d
  const len = Math.hypot(cx, cy, cz, w)
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len }
}

function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function vscale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}
function vlen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}
function vnorm(v: Vec3): Vec3 {
  const L = vlen(v)
  if (L < 1e-6) return { x: 0, y: 1, z: 0 }
  return { x: v.x / L, y: v.y / L, z: v.z / L }
}

/** Rider pose-response tuning. Exposed as a mutable object so the
 *  calibration scene can rebind values live from devtools without a
 *  page reload — `window.__hover.riderTuning = { ... }` style. */
export const RIDER_POSE_TUNING = {
  /** Bounce: critically-damped spring driven by vertical acceleration. */
  bounceSpringK: 22,
  bounceSpringDamping: 7,
  bounceForceGain: 0.04,
  /** Clamp on chest pitch offset (rad). */
  bounceMaxPitch: 0.5,

  /** Flow: low-pass on a target yaw derived from bike yaw rate. */
  flowSmoothing: 0.08,
  /** Conversion factor from bike yaw rate (rad/s) to torso yaw target
   *  (rad). At yawRate = 1 rad/s, the torso pivots ~0.6 rad (~34°) into
   *  the turn. Tuned alongside hand IK — the elbows absorb most of the
   *  visible flex, so we can push this fairly hard without the rider
   *  looking like a noodle. */
  flowYawPerYawRate: 0.6,
  /** Clamp on chest yaw offset (rad). */
  flowMaxYaw: 0.8,

  /** Head yaw: low-pass on ControlIntent.steer. */
  headYawSmoothing: 0.12,
  headYawMax: 0.7,

  /** Head pitch: low-pass on ControlIntent.throttle - brake. */
  headPitchSmoothing: 0.06,
  headPitchMax: 0.18,

  /** Handlebar anchors in bike-local space — the IK targets for the
   *  rider's two hands. Each at the same forward + up offset, mirrored
   *  in X for L/R. Tunable so the calibration scene can sweep these
   *  and see them in-context. */
  handlebarLocal: {
    L: { x: 0.18, y: 0.6, z: 0.42 } as Vec3,
    R: { x: -0.18, y: 0.6, z: 0.42 } as Vec3,
  },
  /** Strength of hand IK — 1 = hard-locked to handlebar, 0 = arms follow
   *  rest pose only (no IK). Future: ramp to 0 during stun / launch
   *  transitions so the arms flop instead of snapping. */
  handIKStrength: 1,
}

function zeroPoseResponse(r: RiderPoseResponse): void {
  r.prevVel.x = 0
  r.prevVel.y = 0
  r.prevVel.z = 0
  r.bouncePitch = 0
  r.bouncePitchVel = 0
  r.flowYaw = 0
  r.headYaw = 0
  r.headPitch = 0
}

/** Per-bone reactive rotation offset that the chain walker right-multiplies
 *  onto the joint's `targetRelRot`. Only chest + head get one. */
function reactiveOffsetFor(name: RiderBoneName, resp: RiderPoseResponse): Quat {
  if (name === 'chest') {
    // Bounce around chest's local X (pitch), flow around chest's local Y (yaw).
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch)
    const yawQ = quatAxisAngle(0, 1, 0, resp.flowYaw)
    return quatMul(yawQ, pitchQ)
  }
  if (name === 'head') {
    const yawQ = quatAxisAngle(0, 1, 0, resp.headYaw)
    const pitchQ = quatAxisAngle(1, 0, 0, resp.headPitch)
    return quatMul(yawQ, pitchQ)
  }
  return IDENT_QUAT
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function tickPoseResponse(
  resp: RiderPoseResponse,
  bikeLinvel: Vec3,
  bikeAngvel: Vec3,
  intent: Intent | undefined,
  dt: number,
): void {
  // Bounce: critically-damped spring driven by vertical accel.
  const safeDt = Math.max(dt, 1e-4)
  const accelY = (bikeLinvel.y - resp.prevVel.y) / safeDt
  const force = -accelY * RIDER_POSE_TUNING.bounceForceGain
  const accel =
    -RIDER_POSE_TUNING.bounceSpringK * resp.bouncePitch -
    RIDER_POSE_TUNING.bounceSpringDamping * resp.bouncePitchVel +
    force
  resp.bouncePitchVel += accel * dt
  resp.bouncePitch += resp.bouncePitchVel * dt
  if (resp.bouncePitch > RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel > 0) resp.bouncePitchVel = 0
  } else if (resp.bouncePitch < -RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = -RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel < 0) resp.bouncePitchVel = 0
  }

  // Flow yaw: low-pass toward bike yaw rate scaled.
  const yawRate = bikeAngvel.y
  const flowTarget = clamp(
    yawRate * RIDER_POSE_TUNING.flowYawPerYawRate,
    -RIDER_POSE_TUNING.flowMaxYaw,
    RIDER_POSE_TUNING.flowMaxYaw,
  )
  resp.flowYaw = lerp(resp.flowYaw, flowTarget, RIDER_POSE_TUNING.flowSmoothing)

  // Head yaw: driven by raw steer input.
  const steer = intent?.steer ?? 0
  const headYawTarget = clamp(
    steer * RIDER_POSE_TUNING.headYawMax,
    -RIDER_POSE_TUNING.headYawMax,
    RIDER_POSE_TUNING.headYawMax,
  )
  resp.headYaw = lerp(resp.headYaw, headYawTarget, RIDER_POSE_TUNING.headYawSmoothing)

  // Head pitch: throttle - brake.
  const throttle = intent?.throttle ?? 0
  const brake = intent?.brake ?? 0
  const pitchTarget = clamp(
    (throttle - brake * 1.5) * RIDER_POSE_TUNING.headPitchMax,
    -RIDER_POSE_TUNING.headPitchMax,
    RIDER_POSE_TUNING.headPitchMax,
  )
  resp.headPitch = lerp(resp.headPitch, pitchTarget, RIDER_POSE_TUNING.headPitchSmoothing)

  resp.prevVel.x = bikeLinvel.x
  resp.prevVel.y = bikeLinvel.y
  resp.prevVel.z = bikeLinvel.z
}

/** World-space rigid pose used by the chain walker. */
type WorldPose = { pos: Vec3; rot: Quat }

/** Run 2-bone IK and overwrite upper / lower arm world poses to land the
 *  hand at `handTargetWorld`. Both arms share the same algorithm with
 *  L/R differing only in which handlebar they aim at.
 *
 *  - `upperArmHalfHeight` / `lowerArmHalfHeight` are the bone capsule's
 *    cylindrical half-heights (Rapier convention). The bone's full length
 *    end-to-end is `2 * halfHeight + 2 * radius`, but for joint-anchor
 *    purposes we treat the bone-length axis as `2 * halfHeight` because
 *    that matches the `parentLocal`/`childLocal` anchors authored in
 *    `buildAnatomy()` (top of arm at +halfHeight, bottom at -halfHeight). */
function solveArmIK(
  shoulderWorld: Vec3,
  handTargetWorld: Vec3,
  upperArmHalfHeight: number,
  lowerArmHalfHeight: number,
  polePerpHint: Vec3,
): { upperArm: WorldPose; lowerArm: WorldPose } {
  const L1 = 2 * upperArmHalfHeight
  const L2 = 2 * lowerArmHalfHeight

  // Distance shoulder → hand, clamped to a reachable range.
  const sToH = vsub(handTargetWorld, shoulderWorld)
  const D = vlen(sToH)
  // Clamp to (|L1-L2|, L1+L2). Tiny epsilons so acos never sees ±1.
  const minD = Math.abs(L1 - L2) + 0.001
  const maxD = L1 + L2 - 0.001
  const clampedD = clamp(D, minD, maxD)

  // Direction shoulder → hand (unit).
  const sToHDir = D > 1e-6 ? vscale(sToH, 1 / D) : ({ x: 0, y: -1, z: 0 } as Vec3)

  // Shoulder offset angle off the shoulder→hand line, toward the elbow.
  const cosShoulder = (L1 * L1 + clampedD * clampedD - L2 * L2) / (2 * L1 * clampedD)
  const shoulderAngle = Math.acos(clamp(cosShoulder, -1, 1))

  // Pole-vector direction perpendicular to sToHDir. We project the hint
  // onto the plane perpendicular to sToHDir, then normalize. If the hint
  // is parallel to sToHDir we fall back to a fixed down-and-back vector.
  const hintDotDir =
    polePerpHint.x * sToHDir.x + polePerpHint.y * sToHDir.y + polePerpHint.z * sToHDir.z
  let perpRaw: Vec3 = {
    x: polePerpHint.x - sToHDir.x * hintDotDir,
    y: polePerpHint.y - sToHDir.y * hintDotDir,
    z: polePerpHint.z - sToHDir.z * hintDotDir,
  }
  if (vlen(perpRaw) < 1e-4) {
    // Fallback: any perpendicular to sToHDir.
    perpRaw = Math.abs(sToHDir.y) < 0.99 ? { x: 0, y: -1, z: 0 } : { x: 0, y: 0, z: -1 }
    const fbDot = perpRaw.x * sToHDir.x + perpRaw.y * sToHDir.y + perpRaw.z * sToHDir.z
    perpRaw = {
      x: perpRaw.x - sToHDir.x * fbDot,
      y: perpRaw.y - sToHDir.y * fbDot,
      z: perpRaw.z - sToHDir.z * fbDot,
    }
  }
  const perp = vnorm(perpRaw)

  // Elbow world position.
  const cosA = Math.cos(shoulderAngle)
  const sinA = Math.sin(shoulderAngle)
  const elbowWorld: Vec3 = {
    x: shoulderWorld.x + L1 * (cosA * sToHDir.x + sinA * perp.x),
    y: shoulderWorld.y + L1 * (cosA * sToHDir.y + sinA * perp.y),
    z: shoulderWorld.z + L1 * (cosA * sToHDir.z + sinA * perp.z),
  }
  // Hand world position — actual point we reach (clamped via clampedD if
  // the target was out of range, so the IK still produces a stable pose
  // when the hand can't quite get there).
  const handReached: Vec3 =
    D > 1e-6
      ? {
          x: shoulderWorld.x + sToHDir.x * clampedD,
          y: shoulderWorld.y + sToHDir.y * clampedD,
          z: shoulderWorld.z + sToHDir.z * clampedD,
        }
      : handTargetWorld

  // Upper arm: +Y in arm-local must point from shoulder toward elbow.
  const upperArmDir = vnorm(vsub(elbowWorld, shoulderWorld))
  const upperArmRot = quatFromTo({ x: 0, y: 1, z: 0 }, upperArmDir)
  // Bone center sits halfway along its +Y axis from the shoulder anchor.
  const upperArmPos: Vec3 = {
    x: shoulderWorld.x + upperArmDir.x * upperArmHalfHeight,
    y: shoulderWorld.y + upperArmDir.y * upperArmHalfHeight,
    z: shoulderWorld.z + upperArmDir.z * upperArmHalfHeight,
  }

  // Lower arm: +Y points from elbow toward hand.
  const lowerArmDir = vnorm(vsub(handReached, elbowWorld))
  const lowerArmRot = quatFromTo({ x: 0, y: 1, z: 0 }, lowerArmDir)
  const lowerArmPos: Vec3 = {
    x: elbowWorld.x + lowerArmDir.x * lowerArmHalfHeight,
    y: elbowWorld.y + lowerArmDir.y * lowerArmHalfHeight,
    z: elbowWorld.z + lowerArmDir.z * lowerArmHalfHeight,
  }

  return {
    upperArm: { pos: upperArmPos, rot: upperArmRot },
    lowerArm: { pos: lowerArmPos, rot: lowerArmRot },
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

    tickPoseResponse(rider.poseResponse, bikeLinvel, bikeAngvel, intent, dt)

    // Walk the kinematic chain. Pelvis is the root, anchored to the seat.
    const poses = new Map<RiderBoneName, WorldPose>()
    const pelvisRest = rider.restPose.pelvis
    const pelvisOffset = rotByQuat(
      bikeRot,
      pelvisRest.bikeLocalPos.x,
      pelvisRest.bikeLocalPos.y,
      pelvisRest.bikeLocalPos.z,
    )
    poses.set('pelvis', {
      pos: {
        x: bikePos.x + pelvisOffset.x,
        y: bikePos.y + pelvisOffset.y,
        z: bikePos.z + pelvisOffset.z,
      },
      rot: quatMul(bikeRot, pelvisRest.bikeLocalRot),
    })

    // Joints are authored parent-before-child in buildAnatomy(), so a
    // single forward pass resolves the whole tree.
    for (const j of rider.joints) {
      const parent = poses.get(j.parentName)
      if (!parent) continue
      const offset = reactiveOffsetFor(j.childName, rider.poseResponse)
      const childRot = quatMul(parent.rot, quatMul(j.targetRelRot, offset))
      const parentAnchorWorld = rotByQuat(
        parent.rot,
        j.parentLocal.x,
        j.parentLocal.y,
        j.parentLocal.z,
      )
      const childAnchorLocal = rotByQuat(childRot, j.childLocal.x, j.childLocal.y, j.childLocal.z)
      const childPos: Vec3 = {
        x: parent.pos.x + parentAnchorWorld.x - childAnchorLocal.x,
        y: parent.pos.y + parentAnchorWorld.y - childAnchorLocal.y,
        z: parent.pos.z + parentAnchorWorld.z - childAnchorLocal.z,
      }
      poses.set(j.childName, { pos: childPos, rot: childRot })
    }

    // Hand IK: anchor each arm's hand to the bike's handlebar.
    if (RIDER_POSE_TUNING.handIKStrength > 0) {
      applyHandIK(rider, poses, bikePos, bikeRot, 'L')
      applyHandIK(rider, poses, bikePos, bikeRot, 'R')
    }

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

function applyHandIK(
  rider: ReturnType<typeof RiderStore.must>,
  poses: Map<RiderBoneName, WorldPose>,
  bikePos: Vec3,
  bikeRot: Quat,
  side: 'L' | 'R',
): void {
  const chest = poses.get('chest')
  if (!chest) return
  const upperName: RiderBoneName = side === 'L' ? 'upper_arm_L' : 'upper_arm_R'
  const lowerName: RiderBoneName = side === 'L' ? 'lower_arm_L' : 'lower_arm_R'

  // Shoulder world position: the chest-side anchor of the shoulder joint.
  const shoulderJoint = rider.joints.find(
    (j) => j.parentName === 'chest' && j.childName === upperName,
  )
  if (!shoulderJoint) return
  const shoulderOffset = rotByQuat(
    chest.rot,
    shoulderJoint.parentLocal.x,
    shoulderJoint.parentLocal.y,
    shoulderJoint.parentLocal.z,
  )
  const shoulderWorld: Vec3 = {
    x: chest.pos.x + shoulderOffset.x,
    y: chest.pos.y + shoulderOffset.y,
    z: chest.pos.z + shoulderOffset.z,
  }

  // Handlebar world target.
  const handleLocal = RIDER_POSE_TUNING.handlebarLocal[side]
  const handleOffset = rotByQuat(bikeRot, handleLocal.x, handleLocal.y, handleLocal.z)
  const handleWorld: Vec3 = {
    x: bikePos.x + handleOffset.x,
    y: bikePos.y + handleOffset.y,
    z: bikePos.z + handleOffset.z,
  }

  // Bone half-heights from boneDims.
  const upperDim = rider.boneDims.find((d) => nameByHandle(rider, d.rbHandle) === upperName)
  const lowerDim = rider.boneDims.find((d) => nameByHandle(rider, d.rbHandle) === lowerName)
  if (!upperDim || !lowerDim) return

  // Pole hint: the elbow should bend so it points roughly DOWN and slightly
  // BACK from the rider's shoulder. In bike-local that's (-Y, -Z); in world
  // we rotate by bike rotation. The IK projects this onto the plane
  // perpendicular to shoulder→handle to pick the elbow side.
  const poleLocal: Vec3 = { x: 0, y: -1, z: -0.4 }
  const poleHint = rotByQuat(bikeRot, poleLocal.x, poleLocal.y, poleLocal.z)

  const ik = solveArmIK(
    shoulderWorld,
    handleWorld,
    upperDim.halfHeight,
    lowerDim.halfHeight,
    poleHint,
  )
  poses.set(upperName, ik.upperArm)
  poses.set(lowerName, ik.lowerArm)
}

/** Resolve a bone's name from its RB handle by walking boneDims order vs
 *  the rider.bones map. Cheap (10-12 entries) and only called during the
 *  IK pass. */
function nameByHandle(
  rider: ReturnType<typeof RiderStore.must>,
  rbHandle: number,
): RiderBoneName | null {
  for (const name of Object.keys(rider.bones) as RiderBoneName[]) {
    const eid = rider.bones[name]
    const h = RBHandleStore.get(eid)
    if (h && h.handle === rbHandle) return name
  }
  return null
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
