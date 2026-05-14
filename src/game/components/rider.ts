/**
 * Rider components — active-ragdoll motocross rider attached to a bike.
 *
 * Anatomy: 10 rigid bodies (pelvis, chest, upper/lower arm L/R, upper/lower
 * leg L/R), 9 spherical joints between them, plus a 10th spherical joint
 * anchoring the pelvis to the bike's seat socket.
 *
 * Each bone is its own bitECS entity carrying RBHandle + Transform +
 * RiderBoneTag — so `syncFromPhysics` populates bone transforms each tick
 * and the render system can find them via the standard query.
 *
 * The "Rider" entity itself owns the pose program: target rest pose, joint
 * list with PD-torque gains, attach state, owning bike eid. The rider
 * pose system reads this each tick to drive limbs toward the target pose.
 *
 * On crash, the attach joint is removed and motor stiffness drops to ~0,
 * so the rider goes limp and inherits the bike's pre-crash velocity.
 */

import { createStore } from '@/engine/sim/ecs/store'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'

export const RiderTag = { name: 'RiderTag' as const }
export const RiderBoneTag = { name: 'RiderBoneTag' as const }

/** Canonical bone names. Order matters for `bones[]` arrays in RiderData. */
export type RiderBoneName =
  | 'pelvis'
  /** Lower spine — between pelvis and upper chest. Splitting the spine
   *  into two segments makes the bounce-pitch flex visibly travel up the
   *  torso instead of collapsing into a single hinge. */
  | 'abdomen'
  | 'chest'
  | 'head'
  | 'upper_arm_L'
  | 'lower_arm_L'
  | 'upper_arm_R'
  | 'lower_arm_R'
  | 'upper_leg_L'
  | 'lower_leg_L'
  | 'upper_leg_R'
  | 'lower_leg_R'

export const RIDER_BONE_NAMES: readonly RiderBoneName[] = [
  'pelvis',
  'abdomen',
  'chest',
  'head',
  'upper_arm_L',
  'lower_arm_L',
  'upper_arm_R',
  'lower_arm_R',
  'upper_leg_L',
  'lower_leg_L',
  'upper_leg_R',
  'lower_leg_R',
] as const

/** Canonical anatomical-joint kinds. Each kind reads its target rotation
 *  from `RIDER_POSE_TUNING.restAngles[kind]` so the calibration scene can
 *  rebind values live without re-spawning the rider. */
export type RiderJointKind =
  | 'spine_lower'
  | 'spine_upper'
  | 'neck'
  | 'shoulder_L'
  | 'shoulder_R'
  | 'elbow_L'
  | 'elbow_R'
  | 'hip_L'
  | 'hip_R'
  | 'knee_L'
  | 'knee_R'

/** Spec for a single anatomical joint between two rider bones. Joints
 *  are not instantiated while the rider is attached (the bones are
 *  kinematic and follow the bike pose directly — no constraint solver
 *  cost). On crash, bodies switch to dynamic and joints are created from
 *  these specs at the per-bone anchor positions. */
export type RiderJoint = {
  /** Bone names — for debugging + targeted poses. */
  parentName: RiderBoneName
  childName: RiderBoneName
  /** Anatomical-joint kind. Drives which entry in `RIDER_POSE_TUNING`
   *  determines this joint's rest rotation each tick. */
  kind: RiderJointKind
  /** Bone entity ids. */
  parentEid: number
  childEid: number
  /** Rapier rigid-body handles cached for hot-path use. */
  parentRbHandle: number
  childRbHandle: number
  /** Anchor positions in each body's local frame. The spherical joint
   *  constrains these two world-points to coincide. */
  parentLocal: Vec3
  childLocal: Vec3
  /** Rapier joint handle — null while attached (no joint exists), set
   *  after launch when the ragdoll constraints are created. */
  jointHandle: number | null
  /** Seed target relative rotation captured at spawn. Used as the
   *  on-launch fallback (when the rider becomes a ragdoll the joint is
   *  created at this rest orientation). The live attached-mode pose
   *  reads angles from `RIDER_POSE_TUNING.restAngles[kind]` so the
   *  calibration scene can mutate them without re-spawning. */
  targetRelRot: Quat
}

/** Per-bone rest pose in BIKE-LOCAL coordinates. While the rider is
 *  attached, the pose system computes each bone's world transform every
 *  tick as bike_pose ⊗ bike_local_pose, then calls
 *  setNextKinematicTranslation/Rotation. No PD, no torques, no constraint
 *  solver — just kinematic positioning. */
export type RiderBoneRest = {
  bikeLocalPos: Vec3
  bikeLocalRot: Quat
}

/** Dimensions for a single rider bone — cached on RiderData so the
 *  rider-crash system can create the bone's collider at launch time
 *  without re-deriving it from the bone-anatomy table. */
export type RiderBoneDim = {
  /** The bone's Rapier rigid-body handle. */
  rbHandle: number
  /** Capsule cylindrical half-height (Rapier convention). */
  halfHeight: number
  radius: number
  mass: number
}

export type RiderState = 'attached' | 'launched'

/** Reactive pose-response state — smoothed signals derived from bike state
 *  and player input that the pose system uses to modulate the rest pose
 *  each tick. Gives the rider life beyond a static mannequin pose.
 *
 *  All quantities are in radians (rotation offsets) plus their spring
 *  velocities where needed. Smoothing constants live next to where the
 *  state is consumed (rider-pose.ts). */
export type RiderPoseResponse = {
  /** Bike linvel from the previous tick — used to derive vertical and
   *  horizontal acceleration each step. */
  prevVel: Vec3
  /** Torso pitch offset (radians) from landings / launches. Critically-
   *  damped spring with velocity. Positive = torso pitches forward. */
  bouncePitch: number
  bouncePitchVel: number
  /** Torso yaw offset (radians) — chest pivots from the hips toward the
   *  direction of travel. First-order low-pass toward target derived from
   *  bike yaw rate. Hand IK keeps the grips locked, so as the chest yaws
   *  the elbows bend to absorb the rotation — "loose but in control." */
  flowYaw: number
  /** Head yaw offset (radians) — head leads the steer input. First-order
   *  low-pass toward target derived from ControlIntent.steer. */
  headYaw: number
  /** Head pitch offset (radians) — small forward bias when accelerating
   *  hard, small backward bias when braking. Low-pass. */
  headPitch: number
}

export type RiderData = {
  /** Owning bike entity. */
  bikeEid: number
  /** Bike Rapier RB handle cached so the pose system doesn't need to look
   *  it up via the ECS each tick. */
  bikeRbHandle: number
  /** Anchor offset of pelvis in bike-local space. The kinematic pose
   *  system uses this directly each tick; the launch path uses it to
   *  create the (post-launch) attach joint if/when respawn-attach is
   *  added. */
  seatLocal: Vec3
  state: RiderState
  /** Bone eid by canonical name. */
  bones: Record<RiderBoneName, number>
  /** All anatomical joints between bones. While attached, jointHandle is
   *  null on each — the system only needs the anchor data. On launch,
   *  Rapier spherical joints are instantiated and the handles populated
   *  so a future "limp ragdoll → respawn" path can clean them up. */
  joints: RiderJoint[]
  /** Per-bone rest pose in bike-local space. Drives the kinematic
   *  positioning each tick while attached. */
  restPose: Record<RiderBoneName, RiderBoneRest>
  /** Per-bone dimensions used by the rider-crash system to spawn each
   *  bone's collider at launch time. */
  boneDims: RiderBoneDim[]
  /** Multiplier on motor strength — 1.0 attached, 0 fully launched. While
   *  attached this is unused (bones are kinematic); after launch it ramps
   *  to 0 so any post-launch pose drive (if added later) goes limp. */
  motorScale: number
  /** Seconds since last state change. Used to drive transitions like the
   *  motor-scale ramp after launch. */
  stateAge: number
  /** Smoothed pose-response signals — bounce/flow/headYaw. Per-tick
   *  state owned by riderPoseSystem; reset by resetRider() on respawn. */
  poseResponse: RiderPoseResponse
}

export const Rider = { name: 'Rider' as const }
export const RiderStore = createStore<RiderData>('Rider')

/** Per-bone metadata for rendering — capsule dimensions + which bone this is.
 *  The render system clones a procedural box mesh sized from these. */
export type RiderBoneData = {
  name: RiderBoneName
  /** Cylindrical part halfHeight (Rapier convention). */
  halfHeight: number
  radius: number
  /** Owning rider eid — render system can colour bones per rider, debug per
   *  player, etc. */
  riderEid: number
}

export const RiderBone = { name: 'RiderBone' as const }
export const RiderBoneStore = createStore<RiderBoneData>('RiderBone')
