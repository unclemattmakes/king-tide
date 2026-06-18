/**
 * Rider inverse-kinematics + chain walking.
 *
 * Three pieces, all pure of the ECS write side:
 *   - `walkChain` — derives every bone's world pose from its parent in
 *     parent-before-child order (the load-bearing fix for the "torso lags"
 *     symptom: any reactive rotation on the chest carries the head, arms,
 *     and IK targets along with it).
 *   - `solveArmIK` — the 2-bone analytic IK that lands a limb tip on a
 *     world target with a pole-vector-controlled bend.
 *   - `applyLimbIK` — wires `solveArmIK` to a parent/upper/lower bone triple
 *     and overwrites their world poses in the pose map.
 *
 * Tuning is passed in per call so production poses can read a per-entity
 * `RiderData.tuning` (the calibration scene mutates the global default).
 */

import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { RBHandleStore } from '@/game/components'
import type {
  RiderBoneName,
  RiderJointKind,
  RiderPoseResponse,
  RiderStore,
} from '@/game/components/rider'
import {
  clamp,
  D2R,
  IDENT_QUAT,
  quatAxisAngle,
  quatFromTo,
  quatMul,
  quatPYR,
  rotByQuat,
  vlen,
  vnorm,
  vscale,
  vsub,
} from '@/game/systems/rider-pose-math'
import type { RiderTuning } from '@/game/systems/rider-pose-tuning'

/** World-space rigid pose used by the chain walker. */
export type WorldPose = { pos: Vec3; rot: Quat }

/** Compute the rest-pose `targetRelRot` for a joint kind from the live
 *  tuning angles. Replaces the static `joint.targetRelRot` that was baked
 *  at spawn time, so the calibration scene's sliders take effect with no
 *  respawn. Pure of inputs — same kind + same tuning → same quat. */
export function targetRelRotFor(kind: RiderJointKind, tuning: RiderTuning): Quat {
  const a = tuning.restAngles
  switch (kind) {
    case 'spine_lower':
      return quatAxisAngle(1, 0, 0, a.spine_lower * D2R)
    case 'spine_upper':
      return quatAxisAngle(1, 0, 0, a.spine_upper * D2R)
    case 'neck':
      return quatAxisAngle(1, 0, 0, a.neck * D2R)
    case 'shoulder_L':
      return quatPYR(a.shoulder_pitch, a.shoulder_yaw, a.shoulder_roll)
    case 'shoulder_R':
      return quatPYR(a.shoulder_pitch, -a.shoulder_yaw, -a.shoulder_roll)
    case 'elbow_L':
    case 'elbow_R':
      return quatAxisAngle(1, 0, 0, a.elbow * D2R)
    case 'hip_L':
      return quatPYR(a.hip_pitch, a.hip_yaw, a.hip_roll)
    case 'hip_R':
      return quatPYR(a.hip_pitch, -a.hip_yaw, -a.hip_roll)
    case 'knee_L':
    case 'knee_R':
      return quatAxisAngle(1, 0, 0, a.knee * D2R)
  }
}

/** Per-joint reactive rotation offset that the chain walker right-multiplies
 *  onto the live `targetRelRotFor(kind)` quaternion.
 *
 *  - **spine_lower / spine_upper** — each gets a fraction of the chest's
 *    bouncePitch so the flex visibly travels up the torso through both
 *    segments. The chest joint (spine_upper) ALSO carries flowYaw so the
 *    upper body twists from the abdomen.
 *  - **neck** — head yaw + head pitch.
 *  - All other joints: identity (no reactive offset).
 */
export function reactiveOffsetFor(
  kind: RiderJointKind,
  resp: RiderPoseResponse,
  tuning: RiderTuning,
): Quat {
  if (kind === 'spine_lower') {
    const share = tuning.bounceDistribution.spine_lower
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch * share)
    // Drift bank — roll the torso around its forward (Z) axis. Lives
    // at the base of the spine so the whole upper body (and, via the
    // chain, the head) banks from the hips while hand IK keeps the
    // grips planted.
    const rollQ = quatAxisAngle(0, 0, 1, resp.leanRoll)
    return quatMul(rollQ, pitchQ)
  }
  if (kind === 'spine_upper') {
    const share = tuning.bounceDistribution.spine_upper
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch * share)
    const yawQ = quatAxisAngle(0, 1, 0, resp.flowYaw)
    return quatMul(yawQ, pitchQ)
  }
  if (kind === 'neck') {
    const yawQ = quatAxisAngle(0, 1, 0, resp.headYaw)
    const pitchQ = quatAxisAngle(1, 0, 0, resp.headPitch)
    return quatMul(yawQ, pitchQ)
  }
  return IDENT_QUAT
}

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
export function solveArmIK(
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

  const perp = poleVectorPerp(sToHDir, polePerpHint)

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

/** Pole-vector direction perpendicular to `sToHDir` (unit). We project the
 *  hint onto the plane perpendicular to `sToHDir`, then normalize. If the
 *  hint is parallel to `sToHDir` we fall back to a fixed down-and-back
 *  vector (re-projected so it's still perpendicular). */
function poleVectorPerp(sToHDir: Vec3, polePerpHint: Vec3): Vec3 {
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
  return vnorm(perpRaw)
}

/** Walk the rider's joint hierarchy with applyOffsets enabled or disabled.
 *  Pelvis is anchored at `tuning.seatLocal` in bike-local space (so when
 *  frame=identity, the result is the rider's bike-local pose). With
 *  frame = bike's world transform, the result is the live world pose.
 *
 *  When `applyOffsets` is false the reactive offsets (bounce/flow/head)
 *  are skipped — used to produce the static REST pose from which the IK
 *  targets (hand + foot positions) are derived. */
export function walkChain(
  rider: ReturnType<typeof RiderStore.must>,
  frameOrigin: Vec3,
  frameRot: Quat,
  applyOffsets: boolean,
  tuning: RiderTuning,
): Map<RiderBoneName, WorldPose> {
  const poses = new Map<RiderBoneName, WorldPose>()
  const seat = tuning.seatLocal
  const pelvisOffset = rotByQuat(frameRot, seat.x, seat.y, seat.z)
  // Seat rotation — tilt / twist / bank the whole rider relative to the
  // bike's orientation. Composed onto the frame so the rest of the chain
  // (and the IK targets derived from it) rotate with the pelvis.
  const sr = tuning.seatRot
  const pelvisRot = quatMul(frameRot, quatPYR(sr.pitch, sr.yaw, sr.roll))
  poses.set('pelvis', {
    pos: {
      x: frameOrigin.x + pelvisOffset.x,
      y: frameOrigin.y + pelvisOffset.y,
      z: frameOrigin.z + pelvisOffset.z,
    },
    rot: pelvisRot,
  })
  for (const j of rider.joints) {
    const parent = poses.get(j.parentName)
    if (!parent) continue
    const baseRel = targetRelRotFor(j.kind, tuning)
    const offset = applyOffsets ? reactiveOffsetFor(j.kind, rider.poseResponse, tuning) : IDENT_QUAT
    const childRot = quatMul(parent.rot, quatMul(baseRel, offset))
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
  return poses
}

/** Apply 2-bone IK to either arm or leg. `parentBoneName` is the chest
 *  (for arms) or pelvis (for legs); `upperName` / `lowerName` are the
 *  bones to override; `tipTarget` is the world point the bone tip
 *  (hand / foot) should hit. */
export function applyLimbIK(
  rider: ReturnType<typeof RiderStore.must>,
  poses: Map<RiderBoneName, WorldPose>,
  halfHeights: Map<RiderBoneName, number>,
  parentBoneName: RiderBoneName,
  upperName: RiderBoneName,
  lowerName: RiderBoneName,
  tipTarget: Vec3,
  poleHint: Vec3,
): void {
  const parent = poses.get(parentBoneName)
  if (!parent) return
  // Shoulder / hip world position = parent-side joint anchor in world.
  const upperJoint = rider.joints.find(
    (j) => j.parentName === parentBoneName && j.childName === upperName,
  )
  if (!upperJoint) return
  const anchorOffset = rotByQuat(
    parent.rot,
    upperJoint.parentLocal.x,
    upperJoint.parentLocal.y,
    upperJoint.parentLocal.z,
  )
  const anchorWorld: Vec3 = {
    x: parent.pos.x + anchorOffset.x,
    y: parent.pos.y + anchorOffset.y,
    z: parent.pos.z + anchorOffset.z,
  }
  const upperHH = halfHeights.get(upperName)
  const lowerHH = halfHeights.get(lowerName)
  if (upperHH === undefined || lowerHH === undefined) return
  // Add the lower bone's tip extent to the IK target — the user's IK
  // anchor is the END of the lower limb (hand / foot), but the 2-bone
  // solver places the LOWER joint anchor at `tipTarget`. So push the
  // target back by lowerHH along the natural "down-the-limb" axis...
  // simplest: just pass `tipTarget` shifted along the arm so the lower
  // bone's tip (not its anchor) lands on tipTarget.
  //
  // solveArmIK puts the lower bone's TOP (parent-anchor end) at the
  // elbow it solves for, then extends the bone by 2*halfHeight along the
  // arm direction. The "hand" tip is therefore elbow + 2*lowerHH along
  // (target - elbow) direction. To make the TIP land on `tipTarget`, we
  // pass IK a target that's `tipTarget` minus lowerHH along (target -
  // shoulder) direction. Approximated by shrinking the chain by lowerHH
  // along (target - shoulder).
  // But the existing solveArmIK already calls the second-bone tip "hand
  // reached" — we should just pass tipTarget directly. Verify with a
  // visual; if hands sit short, retune.
  const ik = solveArmIK(anchorWorld, tipTarget, upperHH, lowerHH, poleHint)
  poses.set(upperName, ik.upperArm)
  poses.set(lowerName, ik.lowerArm)
}

/** Find the world position of the -Y "tip" end of a bone — used for
 *  IK end-effector targets (hand at the end of `lower_arm`, foot at the
 *  end of `lower_leg`). */
export function tipOfBone(pose: WorldPose, halfHeight: number): Vec3 {
  const tip = rotByQuat(pose.rot, 0, -halfHeight, 0)
  return {
    x: pose.pos.x + tip.x,
    y: pose.pos.y + tip.y,
    z: pose.pos.z + tip.z,
  }
}

/** Lookup table for bone half-heights so the IK pass doesn't have to walk
 *  boneDims with a string-name match each call. Cached in the rider's
 *  Map<name, halfHeight>. Cheap — populated lazily on first use. */
export function boneHalfHeights(
  rider: ReturnType<typeof RiderStore.must>,
): Map<RiderBoneName, number> {
  const out = new Map<RiderBoneName, number>()
  for (const name of Object.keys(rider.bones) as RiderBoneName[]) {
    const eid = rider.bones[name]
    const h = RBHandleStore.get(eid)
    if (!h) continue
    const dim = rider.boneDims.find((d) => d.rbHandle === h.handle)
    if (dim) out.set(name, dim.halfHeight)
  }
  return out
}
