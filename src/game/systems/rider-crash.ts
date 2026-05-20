/**
 * Rider crash detection + launch.
 *
 * Approach: track each bike's linear velocity per tick. A high-magnitude
 * Δv in a single tick is the proxy for "impact" — it would take a wall,
 * mine, or other bike to bleed off >12 m/s of velocity in 1/60s. False
 * positives from hover-spring snaps are filtered by ignoring vertical-only
 * Δv (those are bouncy landings, not crashes).
 *
 * On launch:
 *   - Switch every rider bone from KinematicPositionBased → Dynamic
 *     (Rapier exposes `setBodyType()` on the rigid body).
 *   - Instantiate the 9 anatomical spherical joints between bones — they
 *     were not active while attached, so the rider tumbles as a connected
 *     ragdoll only from this point onward.
 *   - Apply the bike's pre-crash velocity to every bone, plus an upward
 *     kick and forward boost on the pelvis, plus a forward somersault
 *     spin around the rider's right axis.
 *   - Drop motorScale to 0 (placeholder for any future "limp with residual
 *     motor torque" pose drive — currently unused while launched).
 *
 *  Once launched, this system stops sampling Δv for that bike's rider.
 *  Re-attach / respawn lives in a future system.
 *
 *  Sim-only — no Three.js imports, deterministic given (sim, phys).
 */

import { hasComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { BoostMeter, BoostMeterStore, TrickState, TrickStateStore } from '@/game/components'
import { Rider, RiderStore } from '@/game/components/rider'

/** Δv magnitude (m/s) within a single fixed step that qualifies as a crash.
 *  Top speed is 28 m/s, so anything > ~12 m/s lost in 1/60s is a wall hit. */
const CRASH_DV_THRESHOLD = 12

/** Horizontal-component fraction of Δv that must dominate, so we don't
 *  trigger on pure vertical impacts from drops onto the hover field. */
const HORIZONTAL_DV_RATIO = 0.55

/** Upward velocity (m/s) added to the rider's inherited bike velocity at
 *  launch. Just enough to overcome a 1m drop within the recovery window. */
const LAUNCH_UPKICK = 4

/** Forward-velocity boost (multiplier on the bike's forward speed) applied
 *  to the rider at launch — slightly outpaces the now-decelerating bike so
 *  the rider visibly separates from it. */
const LAUNCH_FORWARD_BOOST = 1.15

/** Angular velocity (rad/s) applied to the pelvis at launch — a forward
 *  somersault about the rider's right axis. */
const LAUNCH_PITCH_SPIN = 6

/** Per-bike Δv tracker. Keyed by bike eid. Velocities sampled at end of
 *  each tick; on the next tick we compare against the new velocity. */
type VelSample = { x: number; y: number; z: number }
const prevVel = new Map<number, VelSample>()

export function riderCrashSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  void dt // not currently used; motor ramp lives in the (future) launched-pose system
  const riderEids = query(sim, [Rider])
  const live = new Set<number>()

  for (const eid of riderEids) {
    const rider = RiderStore.must(eid)

    // Already launched — nothing to do; Rapier owns the ragdoll bodies.
    if (rider.state === 'launched') continue

    const bikeRb = phys.world.getRigidBody(rider.bikeRbHandle)
    if (!bikeRb) continue
    live.add(rider.bikeEid)

    const v = bikeRb.linvel()
    const prev = prevVel.get(rider.bikeEid)

    // Suppress crash detection while the bike is mid-trick OR while
    // the boost meter is active. Both fire one-shot forward impulses
    // on top of potentially-rising vertical velocity (trick lands
    // ~7 m/s, boost activation ~14 m/s); combined Δv otherwise trips
    // the crash heuristic and ejects the rider — exactly the opposite
    // of "you nailed it". The trick gate covers the spin lifetime;
    // the boost gate covers the meter drain (up to ~2 s).
    const trick = hasComponent(sim, rider.bikeEid, TrickState)
      ? (TrickStateStore.get(rider.bikeEid) ?? null)
      : null
    const midTrick = trick !== null && trick.spinPhase > 0
    const meter = hasComponent(sim, rider.bikeEid, BoostMeter)
      ? (BoostMeterStore.get(rider.bikeEid) ?? null)
      : null
    const boosting = meter?.active === true

    if (prev && !midTrick && !boosting) {
      const dvx = v.x - prev.x
      const dvy = v.y - prev.y
      const dvz = v.z - prev.z
      const dv = Math.hypot(dvx, dvy, dvz)
      const dvHoriz = Math.hypot(dvx, dvz)

      if (dv > CRASH_DV_THRESHOLD && dvHoriz > dv * HORIZONTAL_DV_RATIO) {
        launchRider(rider, prev, bikeRb.rotation(), phys)
      }
    }

    // Always store the current velocity for next-tick comparison.
    prevVel.set(rider.bikeEid, { x: v.x, y: v.y, z: v.z })
  }

  // Prune entries for bikes whose riders are launched or destroyed, so
  // the map doesn't accrete forever in long sessions.
  for (const bikeEid of prevVel.keys()) {
    if (!live.has(bikeEid)) prevVel.delete(bikeEid)
  }
}

/** Switch every rider bone to Dynamic, create the connecting joints, and
 *  apply launch velocity + somersault. After this call the rider is a
 *  free ragdoll owned by Rapier's iterative solver. */
function launchRider(
  rider: ReturnType<typeof RiderStore.must>,
  preCrashVel: VelSample,
  bikeRot: { x: number; y: number; z: number; w: number },
  phys: PhysicsWorld,
): void {
  // 1) Switch every bone to Dynamic and attach a capsule collider so the
  //    ragdoll interacts with terrain / bikes / props from this moment.
  const Dynamic = phys.rapier.RigidBodyType.Dynamic
  // Rider-bone collision groups — group bit 1<<1, filter excludes that bit
  // so rider↔rider passes through but terrain / bikes / props all collide.
  const RIDER_GROUP = 1 << 1
  const RIDER_COLLIDE_WITH = 0xffff & ~RIDER_GROUP
  const RIDER_GROUPS = ((RIDER_GROUP & 0xffff) << 16) | (RIDER_COLLIDE_WITH & 0xffff)

  for (const dim of rider.boneDims) {
    const handle = dim.rbHandle
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    rb.setBodyType(Dynamic, true)
    const desc = phys.rapier.ColliderDesc.capsule(dim.halfHeight, dim.radius)
      .setMass(dim.mass)
      .setFriction(0.4)
      .setRestitution(0.0)
      .setCollisionGroups(RIDER_GROUPS)
    phys.world.createCollider(desc, rb)
  }

  // 2) Create spherical joints between bones at the anchor positions.
  for (const j of rider.joints) {
    if (j.jointHandle !== null) continue // safety: idempotent
    const parentRb = phys.world.getRigidBody(j.parentRbHandle)
    const childRb = phys.world.getRigidBody(j.childRbHandle)
    if (!parentRb || !childRb) continue
    const data = phys.rapier.JointData.spherical(j.parentLocal, j.childLocal)
    const joint = phys.world.createImpulseJoint(data, parentRb, childRb, true)
    j.jointHandle = joint.handle
  }

  // 3) Apply launch velocity to every bone — pre-crash velocity plus a
  //    forward boost so the rider visibly outpaces the now-decelerating
  //    bike. Pelvis gets an extra up-kick + somersault.
  const launchVx = preCrashVel.x * LAUNCH_FORWARD_BOOST
  const launchVz = preCrashVel.z * LAUNCH_FORWARD_BOOST
  const launchVy = Math.max(preCrashVel.y, 0) + LAUNCH_UPKICK

  for (const j of rider.joints) {
    // Apply once per unique body — the parent of the first iteration
    // covers pelvis; subsequent loops handle every child.
    const parentRb = phys.world.getRigidBody(j.parentRbHandle)
    if (parentRb) parentRb.setLinvel({ x: launchVx, y: launchVy, z: launchVz }, true)
    const childRb = phys.world.getRigidBody(j.childRbHandle)
    if (childRb) childRb.setLinvel({ x: launchVx, y: launchVy, z: launchVz }, true)
  }

  // 4) Pelvis somersault — pitch about the bike's right axis, which is
  //    the rider's right axis at the moment of launch. Compute right
  //    = bikeRot * (1,0,0).
  const pelvisRb =
    rider.joints[0] !== undefined ? phys.world.getRigidBody(rider.joints[0].parentRbHandle) : null
  if (pelvisRb) {
    const rx = 1 - 2 * (bikeRot.y * bikeRot.y + bikeRot.z * bikeRot.z)
    const ry = 2 * (bikeRot.x * bikeRot.y + bikeRot.w * bikeRot.z)
    const rz = 2 * (bikeRot.x * bikeRot.z - bikeRot.w * bikeRot.y)
    pelvisRb.setAngvel(
      {
        x: rx * LAUNCH_PITCH_SPIN,
        y: ry * LAUNCH_PITCH_SPIN,
        z: rz * LAUNCH_PITCH_SPIN,
      },
      true,
    )
  }

  rider.state = 'launched'
  rider.stateAge = 0
  rider.motorScale = 0
}
