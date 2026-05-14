/**
 * Rider entity factory — builds a powered-ragdoll motocross rider attached
 * to a given bike.
 *
 * Strategy (kinematic-while-attached + dynamic-on-crash):
 *   - 10 KinematicPositionBased rigid bodies, sized to the rest pose.
 *     During normal riding they receive setNextKinematicTranslation/Rotation
 *     each tick driven by the bike's pose ⊗ the bone's bike-local rest pose.
 *     Rapier doesn't solve constraints for kinematic bodies, so the
 *     5-rider-on-grid scenario runs at full frame rate.
 *   - NO joints exist while attached. They're instantiated only on launch.
 *   - One the rider-crash system detects an impact, it switches every bone
 *     to Dynamic, creates 9 spherical joints between bones at the same
 *     anchor points the rest pose uses, applies a launch impulse, and
 *     ramps the (unused) motor scale to 0. From that moment Rapier owns
 *     the rider — it's a free ragdoll falling off the bike.
 *
 * Spawn pose: motocross-seated (chest 22° forward, hips 78°, knees 80°,
 * shoulders 85°, elbows 70°). All target rotations live in `buildAnatomy()`.
 */

import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { type Quat, quatRotate, type Vec3 } from '@/engine/sim/physics/vec'
import { RBHandle, RBHandleStore, Transform, TransformStore } from '@/game/components'
import {
  Rider,
  RiderBone,
  type RiderBoneData,
  type RiderBoneDim,
  type RiderBoneName,
  type RiderBoneRest,
  RiderBoneStore,
  RiderBoneTag,
  type RiderData,
  type RiderJoint,
  RiderStore,
  RiderTag,
} from '@/game/components/rider'

/** Seat offset relative to the bike's physics rigid body, in bike-local
 *  coords. The bike's physics capsule has halfHeight=0.6 and radius=0.45,
 *  so its top is at y≈+1.05. The seat socket in the GLB lives a bit above
 *  that. Hardcoded here for now; phase 2 reads from the GLB's seat socket. */
const SEAT_LOCAL: Vec3 = { x: 0, y: 0.6, z: -0.05 }

/** Rider physics dimensions. Scaled ~2× human so the rider visually matches
 *  the bike's 2× visual scale without needing per-bone visual scaling. */
type BoneDim = {
  halfHeight: number
  radius: number
  /** Mass in kg. */
  mass: number
  /** Local +Y of the bone capsule, in bone rest space. The rider walks
   *  the bone hierarchy in rest pose by offsetting along this axis from
   *  each parent's child joint position. Default: capsule axis is Y. */
}

const BONES: Record<RiderBoneName, BoneDim> = {
  pelvis: { halfHeight: 0.18, radius: 0.18, mass: 8 },
  chest: { halfHeight: 0.35, radius: 0.22, mass: 18 },
  upper_arm_L: { halfHeight: 0.18, radius: 0.07, mass: 2.5 },
  lower_arm_L: { halfHeight: 0.18, radius: 0.06, mass: 1.8 },
  upper_arm_R: { halfHeight: 0.18, radius: 0.07, mass: 2.5 },
  lower_arm_R: { halfHeight: 0.18, radius: 0.06, mass: 1.8 },
  upper_leg_L: { halfHeight: 0.24, radius: 0.1, mass: 6 },
  lower_leg_L: { halfHeight: 0.24, radius: 0.08, mass: 4 },
  upper_leg_R: { halfHeight: 0.24, radius: 0.1, mass: 6 },
  lower_leg_R: { halfHeight: 0.24, radius: 0.08, mass: 4 },
}

/** Anatomical rest layout (parent_name → child_name + offsets).
 *  All positions are in PARENT-local space, in the rest pose.
 *
 *  Convention: bone capsule's long axis is local +Y. parentLocal is the
 *  point on the parent body where the joint sits; childLocal is the same
 *  point in the child body's frame. Both are anchor points for the
 *  spherical joint. */
type AnatomyEdge = {
  parent: RiderBoneName
  child: RiderBoneName
  parentLocal: Vec3
  childLocal: Vec3
  /** Target relative rotation of child in parent's frame for the seated
   *  motocross stance. Identity for v1; tuned visually later. */
  targetRelRot: Quat
  /** Per-joint PD gains. Hips/shoulders need to be stiff to keep the
   *  rider on the bike; neck/elbows can be softer. */
  kp: number
  kd: number
}

/** Quaternion from axis (unit) + angle (radians). */
function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle * 0.5
  const s = Math.sin(h)
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) }
}

/** Quaternion multiplication: out = a * b. */
function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Seated motocross target pose — child rotation in parent frame.
 *
 *  Convention used throughout: bone local +Y points "down the bone" from
 *  the joint attached to the parent. In rest (T-pose), arms hang straight
 *  down (upper_arm +Y = world -Y), legs straight down, chest +Y = world
 *  +Y. So a rotation of +90° around X (right-hand rule) pitches the bone
 *  forward (its +Y now points toward world +Z). Negative X pitches back.
 */
function buildAnatomy(): AnatomyEdge[] {
  // Forward pitch helpers (rotation around bone X axis).
  const pitch = (deg: number) => quatFromAxisAngle(1, 0, 0, (deg * Math.PI) / 180)
  // Roll around bone Y (for arm "outward from torso" angle).
  const roll = (deg: number) => quatFromAxisAngle(0, 1, 0, (deg * Math.PI) / 180)
  // Yaw around bone Z (rarely used here).

  // pelvis rest: capsule along Z (front-back). Pelvis +Y is the rider's up.
  // chest rest: capsule along Y, sits atop pelvis.
  // upper limbs: capsule along Y, hanging from joint.
  // Spine: chest pitches forward 22°. (Motocross "attack" lean.)
  const spinePitch = pitch(22)
  // Hips: legs swing forward to reach the footpegs. ~70° forward pitch.
  const hipPitch = pitch(78)
  // Knees: lower leg bends back ~80° relative to upper leg (so it points
  // mostly down again from the bent knee).
  const kneePitch = pitch(-80)
  // Shoulders: arms reach forward + slightly outward.
  // upper_arm rest = pointing down (+Y down in world). To reach the bars,
  // pitch the arm forward ~80°, then roll outward ~12° for the L/R split.
  const shoulderPitchL = quatMul(pitch(85), roll(15))
  const shoulderPitchR = quatMul(pitch(85), roll(-15))
  // Elbows: bent ~70° so forearm + hand reach forward to grips.
  const elbowPitch = pitch(-70)

  // Gains are intentionally on the low side; the rider PD controller is
  // discrete (one torque impulse per fixed step) and overshooting in the
  // first few ticks compounds quickly. Tune up after visual confirmation
  // that the base case (rider holds pose under gravity) is stable.
  return [
    // SPINE
    {
      parent: 'pelvis',
      child: 'chest',
      // pelvis local: top of pelvis (+Y a bit). Pelvis is squat, so top ~0.18.
      parentLocal: { x: 0, y: 0.18, z: 0 },
      // chest local: bottom of chest capsule (-Y by half-length).
      childLocal: { x: 0, y: -0.35, z: 0 },
      targetRelRot: spinePitch,
      kp: 80,
      kd: 16,
    },
    // SHOULDERS
    {
      parent: 'chest',
      child: 'upper_arm_L',
      parentLocal: { x: 0.22, y: 0.3, z: 0 },
      childLocal: { x: 0, y: 0.18, z: 0 },
      targetRelRot: shoulderPitchL,
      kp: 40,
      kd: 8,
    },
    {
      parent: 'chest',
      child: 'upper_arm_R',
      parentLocal: { x: -0.22, y: 0.3, z: 0 },
      childLocal: { x: 0, y: 0.18, z: 0 },
      targetRelRot: shoulderPitchR,
      kp: 40,
      kd: 8,
    },
    // ELBOWS
    {
      parent: 'upper_arm_L',
      child: 'lower_arm_L',
      parentLocal: { x: 0, y: -0.18, z: 0 },
      childLocal: { x: 0, y: 0.18, z: 0 },
      targetRelRot: elbowPitch,
      kp: 25,
      kd: 5,
    },
    {
      parent: 'upper_arm_R',
      child: 'lower_arm_R',
      parentLocal: { x: 0, y: -0.18, z: 0 },
      childLocal: { x: 0, y: 0.18, z: 0 },
      targetRelRot: elbowPitch,
      kp: 25,
      kd: 5,
    },
    // HIPS
    {
      parent: 'pelvis',
      child: 'upper_leg_L',
      parentLocal: { x: 0.13, y: -0.05, z: 0 },
      childLocal: { x: 0, y: 0.24, z: 0 },
      targetRelRot: hipPitch,
      kp: 100,
      kd: 18,
    },
    {
      parent: 'pelvis',
      child: 'upper_leg_R',
      parentLocal: { x: -0.13, y: -0.05, z: 0 },
      childLocal: { x: 0, y: 0.24, z: 0 },
      targetRelRot: hipPitch,
      kp: 100,
      kd: 18,
    },
    // KNEES
    {
      parent: 'upper_leg_L',
      child: 'lower_leg_L',
      parentLocal: { x: 0, y: -0.24, z: 0 },
      childLocal: { x: 0, y: 0.24, z: 0 },
      targetRelRot: kneePitch,
      kp: 50,
      kd: 10,
    },
    {
      parent: 'upper_leg_R',
      child: 'lower_leg_R',
      parentLocal: { x: 0, y: -0.24, z: 0 },
      childLocal: { x: 0, y: 0.24, z: 0 },
      targetRelRot: kneePitch,
      kp: 50,
      kd: 10,
    },
  ]
  // (Markers above kept verbose for readability; this is hot-path-cold
  // factory code, builds once per bike spawn.)
}

/** Walk the anatomy in rest pose, producing world-space spawn positions
 *  for each bone given the pelvis spawn position + rotation. */
function computeRestPositions(
  edges: AnatomyEdge[],
  pelvisWorldPos: Vec3,
  pelvisWorldRot: Quat,
): Record<RiderBoneName, { pos: Vec3; rot: Quat }> {
  const out: Partial<Record<RiderBoneName, { pos: Vec3; rot: Quat }>> = {}
  out.pelvis = { pos: pelvisWorldPos, rot: pelvisWorldRot }

  // Process edges in order: parent's pose must already be set. The edge
  // list above is authored parent-before-child.
  for (const e of edges) {
    const parent = out[e.parent]
    if (!parent) {
      throw new Error(`rider: parent ${e.parent} not yet placed when laying out child ${e.child}`)
    }
    const childRot = quatMul(parent.rot, e.targetRelRot)
    // World offset from parent center to joint anchor on parent.
    const parentJointWorld = quatRotate(parent.rot, e.parentLocal)
    // World offset from joint anchor to child center (childLocal is in
    // child's frame and points FROM the joint TO the child center;
    // childLocal is the anchor on the child, so child_center = joint -
    // child_rot * childLocal).
    const childAnchorWorld = quatRotate(childRot, e.childLocal)
    const childPos: Vec3 = {
      x: parent.pos.x + parentJointWorld.x - childAnchorWorld.x,
      y: parent.pos.y + parentJointWorld.y - childAnchorWorld.y,
      z: parent.pos.z + parentJointWorld.z - childAnchorWorld.z,
    }
    out[e.child] = { pos: childPos, rot: childRot }
  }

  return out as Record<RiderBoneName, { pos: Vec3; rot: Quat }>
}

/** Create a single rider bone entity. Bones are spawned KINEMATIC so the
 *  pose system can position them directly each tick without paying for
 *  constraint solver work. On crash the body type is swapped to dynamic
 *  and joints are created at that moment.
 *
 *  Capsule's long axis is local +Y (Rapier convention). */
function createBone(
  sim: SimWorld,
  phys: PhysicsWorld,
  riderEid: number,
  name: RiderBoneName,
  dim: BoneDim,
  worldPos: Vec3,
  worldRot: Quat,
): number {
  const eid = addEntity(sim)
  const rbDesc = phys.rapier.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(worldPos.x, worldPos.y, worldPos.z)
    .setRotation(worldRot)
    // CCD not needed for kinematic bodies (they don't move via velocity).
    .setCcdEnabled(false)
  const rb = phys.world.createRigidBody(rbDesc)

  // No collider while attached. Kinematic bones are pure transform
  // targets; they should never push the bike or other bodies around. The
  // rider-crash system attaches a fresh capsule collider at launch so
  // the ragdoll interacts with terrain + bikes + props from that point.
  //
  // (`setEnabled(false)` on a ColliderDesc was tried first but in
  //  Rapier 0.19.3 a disabled collider still appears to contribute
  //  contact-resolution impulses to the parent bike via the broadphase
  //  during overlap. Outright skipping collider creation sidesteps that
  //  class of bug entirely.)

  addComponent(sim, eid, RiderBoneTag)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle: rb.handle })
  addComponent(sim, eid, Transform)
  TransformStore.set(eid, {
    x: worldPos.x,
    y: worldPos.y,
    z: worldPos.z,
    qx: worldRot.x,
    qy: worldRot.y,
    qz: worldRot.z,
    qw: worldRot.w,
  })
  addComponent(sim, eid, RiderBone)
  const data: RiderBoneData = {
    name,
    halfHeight: dim.halfHeight,
    radius: dim.radius,
    riderEid,
  }
  RiderBoneStore.set(eid, data)
  return eid
}

export type CreateRiderOpts = {
  bikeEid: number
  bikeRbHandle: number
  /** Bike world-space position + rotation at spawn. The rider is placed
   *  above the bike's seat anchor in bike-local space. */
  bikePos: Vec3
  bikeRot: Quat
}

export function createRider(sim: SimWorld, phys: PhysicsWorld, opts: CreateRiderOpts): number {
  const riderEid = addEntity(sim)
  addComponent(sim, riderEid, RiderTag)

  const edges = buildAnatomy()

  // Compute the rest pose in BIKE-LOCAL coordinates first. Pelvis sits at
  // SEAT_LOCAL with identity rotation (relative to bike). Walk the bone
  // chain from there. This bike-local pose is stored on RiderData and
  // re-used each tick: world_pose = bike_pose ⊗ bike_local_pose.
  const localRest = computeRestPositions(edges, SEAT_LOCAL, { x: 0, y: 0, z: 0, w: 1 })

  // Convert bike-local rest pose into world-space spawn positions so the
  // bones start at the right place.
  const restPose: Partial<Record<RiderBoneName, RiderBoneRest>> = {}
  const worldRest: Partial<Record<RiderBoneName, { pos: Vec3; rot: Quat }>> = {}
  for (const name of Object.keys(BONES) as RiderBoneName[]) {
    const local = localRest[name]
    restPose[name] = { bikeLocalPos: local.pos, bikeLocalRot: local.rot }
    const worldPos = quatRotate(opts.bikeRot, local.pos)
    worldRest[name] = {
      pos: {
        x: opts.bikePos.x + worldPos.x,
        y: opts.bikePos.y + worldPos.y,
        z: opts.bikePos.z + worldPos.z,
      },
      rot: quatMul(opts.bikeRot, local.rot),
    }
  }

  // Spawn each bone (kinematic).
  const bones: Partial<Record<RiderBoneName, number>> = {}
  const boneDims: RiderBoneDim[] = []
  for (const name of Object.keys(BONES) as RiderBoneName[]) {
    const dim = BONES[name]
    const w = worldRest[name] as { pos: Vec3; rot: Quat }
    const eid = createBone(sim, phys, riderEid, name, dim, w.pos, w.rot)
    bones[name] = eid
    boneDims.push({
      rbHandle: RBHandleStore.must(eid).handle,
      halfHeight: dim.halfHeight,
      radius: dim.radius,
      mass: dim.mass,
    })
  }

  // Build joint specs (NO Rapier joints created yet — bones are kinematic).
  // Each spec retains the anchor positions and target relative rotation so
  // riderCrashSystem can instantiate the actual joints at launch time.
  const joints: RiderJoint[] = []
  for (const e of edges) {
    const parentEid = bones[e.parent]
    const childEid = bones[e.child]
    if (parentEid === undefined || childEid === undefined) {
      throw new Error(`rider: missing bone for joint ${e.parent}->${e.child}`)
    }
    joints.push({
      parentName: e.parent,
      childName: e.child,
      parentEid,
      childEid,
      parentRbHandle: RBHandleStore.must(parentEid).handle,
      childRbHandle: RBHandleStore.must(childEid).handle,
      parentLocal: e.parentLocal,
      childLocal: e.childLocal,
      jointHandle: null,
      targetRelRot: e.targetRelRot,
    })
  }

  addComponent(sim, riderEid, Rider)
  const data: RiderData = {
    bikeEid: opts.bikeEid,
    bikeRbHandle: opts.bikeRbHandle,
    seatLocal: SEAT_LOCAL,
    state: 'attached',
    bones: bones as Record<RiderBoneName, number>,
    joints,
    restPose: restPose as Record<RiderBoneName, RiderBoneRest>,
    boneDims,
    motorScale: 1,
    stateAge: 0,
  }
  RiderStore.set(riderEid, data)
  return riderEid
}
