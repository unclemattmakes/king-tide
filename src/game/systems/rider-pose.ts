/**
 * Rider pose system — drives the attached rider's bones to their target
 * stance by directly positioning each bone every fixed step.
 *
 * Bones are KinematicPositionBased while attached, so the constraint
 * solver never touches them. Each tick we compute:
 *
 *   world_pose = bike_pose ⊗ bike_local_rest_pose
 *
 * and call setNextKinematicTranslation / setNextKinematicRotation on the
 * bone's rigid body. Rapier interpolates between current and next position
 * for collision response with dynamic bodies (relevant after launch when
 * another rider gets thrown into us), but does no constraint work for the
 * bones themselves.
 *
 * Launched riders are skipped — their bones are dynamic at that point and
 * are owned by Rapier's iterative solver.
 */

import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat } from '@/engine/sim/physics/vec'
import { RBHandleStore } from '@/game/components'
import { RIDER_BONE_NAMES, Rider, RiderStore } from '@/game/components/rider'

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

    for (const name of RIDER_BONE_NAMES) {
      const boneEid = rider.bones[name]
      const rest = rider.restPose[name]
      const handle = RBHandleStore.get(boneEid)
      if (!handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue

      // World pose = bike_pose ⊗ bike_local_pose.
      const localPos = rest.bikeLocalPos
      const worldOffset = rotByQuat(bikeRot, localPos.x, localPos.y, localPos.z)
      rb.setNextKinematicTranslation({
        x: bikePos.x + worldOffset.x,
        y: bikePos.y + worldOffset.y,
        z: bikePos.z + worldOffset.z,
      })
      rb.setNextKinematicRotation(quatMul(bikeRot, rest.bikeLocalRot))
    }
  }
}
