import { describe, expect, it } from 'vitest'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type {
  RiderData,
  RiderJoint,
  RiderJointKind,
  RiderPoseResponse,
} from '@/game/components/rider'
import { solveArmIK, walkChain } from '@/game/systems/rider-ik'
import { quatFromTo, rotByQuat, vlen, vsub } from '@/game/systems/rider-pose-math'
import { RIDER_POSE_TUNING } from '@/game/systems/rider-pose-tuning'

/** Rotate the unit `from` vector by a quaternion and compare against `to`. */
function rotateUnit(q: Quat, from: Vec3): Vec3 {
  return rotByQuat(q, from.x, from.y, from.z)
}
function vclose(a: Vec3, b: Vec3, eps = 1e-5): void {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(eps)
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(eps)
  expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(eps)
}

describe('quatFromTo', () => {
  it('returns identity for parallel vectors', () => {
    const q = quatFromTo({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 })
  })

  it('rounds-trips a 90° rotation: rotating `from` by the result lands on `to`', () => {
    const from = { x: 0, y: 1, z: 0 }
    const to = { x: 1, y: 0, z: 0 }
    const q = quatFromTo(from, to)
    vclose(rotateUnit(q, from), to)
  })

  it('handles assorted unit pairs (rotated `from` matches `to`)', () => {
    const pairs: Array<[Vec3, Vec3]> = [
      [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
      ],
      [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: -1 },
      ],
      [
        { x: 0, y: 1, z: 0 },
        { x: 0.6, y: 0.8, z: 0 },
      ],
      [
        { x: 0, y: 1, z: 0 },
        { x: 0.5773, y: 0.5773, z: 0.5773 },
      ],
    ]
    for (const [from, to] of pairs) {
      const tn = vlen(to)
      const toUnit = { x: to.x / tn, y: to.y / tn, z: to.z / tn }
      const q = quatFromTo(from, toUnit)
      vclose(rotateUnit(q, from), toUnit, 1e-4)
    }
  })

  it('antipodal (180°): maps `from` onto its negation about a perpendicular axis', () => {
    const from = { x: 0, y: 1, z: 0 }
    const to = { x: 0, y: -1, z: 0 }
    const q = quatFromTo(from, to)
    // w must be 0 for a true 180° rotation.
    expect(q.w).toBeCloseTo(0, 6)
    // unit quaternion
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6)
    // rotating from lands on to
    vclose(rotateUnit(q, from), to)
    // axis must be perpendicular to `from`
    const axisDotFrom = q.x * from.x + q.y * from.y + q.z * from.z
    expect(axisDotFrom).toBeCloseTo(0, 6)
  })

  it('antipodal for an axis where the primary perpendicular branch degenerates', () => {
    // from along +Z: the first axis attempt (-y, x, 0) is zero, forcing the
    // fallback branch (0, -z, y).
    const from = { x: 0, y: 0, z: 1 }
    const to = { x: 0, y: 0, z: -1 }
    const q = quatFromTo(from, to)
    expect(q.w).toBeCloseTo(0, 6)
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6)
    vclose(rotateUnit(q, from), to)
  })
})

/** Build a minimal rider-shaped object for walkChain (which reads only
 *  `joints` + `poseResponse`). Bypasses Rapier entirely. */
function makeChainRider(joints: Array<Partial<RiderJoint>>): RiderData {
  const zeroResp: RiderPoseResponse = {
    prevVel: { x: 0, y: 0, z: 0 },
    bouncePitch: 0,
    bouncePitchVel: 0,
    flowYaw: 0,
    headYaw: 0,
    headPitch: 0,
    leanRoll: 0,
  }
  const full: RiderJoint[] = joints.map((j) => ({
    parentName: 'pelvis',
    childName: 'abdomen',
    kind: 'spine_lower' as RiderJointKind,
    parentEid: 0,
    childEid: 0,
    parentRbHandle: 0,
    childRbHandle: 0,
    parentLocal: { x: 0, y: 0, z: 0 },
    childLocal: { x: 0, y: 0, z: 0 },
    jointHandle: null,
    targetRelRot: { x: 0, y: 0, z: 0, w: 1 },
    ...j,
  }))
  return { joints: full, poseResponse: zeroResp } as unknown as RiderData
}

describe('walkChain', () => {
  it('anchors the pelvis at seatLocal in the frame', () => {
    const rider = makeChainRider([])
    const origin: Vec3 = { x: 1, y: 2, z: 3 }
    const poses = walkChain(rider, origin, { x: 0, y: 0, z: 0, w: 1 }, false, RIDER_POSE_TUNING)
    const pelvis = poses.get('pelvis')
    expect(pelvis).toBeDefined()
    const seat = RIDER_POSE_TUNING.seatLocal
    vclose(pelvis?.pos ?? { x: 0, y: 0, z: 0 }, {
      x: origin.x + seat.x,
      y: origin.y + seat.y,
      z: origin.z + seat.z,
    })
  })

  it('matches the parent/child joint anchors in world space (chain stays connected)', () => {
    // Single abdomen joint with non-trivial anchors. The shared world point
    // of the joint must coincide whether computed from parent or child.
    const parentLocal: Vec3 = { x: 0, y: 0.1, z: 0 }
    const childLocal: Vec3 = { x: 0, y: -0.1, z: 0 }
    const rider = makeChainRider([
      { parentName: 'pelvis', childName: 'abdomen', kind: 'spine_lower', parentLocal, childLocal },
    ])
    const poses = walkChain(
      rider,
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
      RIDER_POSE_TUNING,
    )
    const pelvis = poses.get('pelvis')
    const abdomen = poses.get('abdomen')
    if (!pelvis || !abdomen) throw new Error('missing poses')
    const pAnchor = rotByQuat(pelvis.rot, parentLocal.x, parentLocal.y, parentLocal.z)
    const pWorld = {
      x: pelvis.pos.x + pAnchor.x,
      y: pelvis.pos.y + pAnchor.y,
      z: pelvis.pos.z + pAnchor.z,
    }
    const cAnchor = rotByQuat(abdomen.rot, childLocal.x, childLocal.y, childLocal.z)
    const cWorld = {
      x: abdomen.pos.x + cAnchor.x,
      y: abdomen.pos.y + cAnchor.y,
      z: abdomen.pos.z + cAnchor.z,
    }
    vclose(pWorld, cWorld)
  })

  it('skips reactive offsets when applyOffsets is false (rest = reactive at zero state)', () => {
    // With a zeroed poseResponse the reactive offsets are all identity, so
    // rest and reactive passes must agree.
    const rider = makeChainRider([
      { parentName: 'pelvis', childName: 'abdomen', kind: 'spine_lower' },
    ])
    const frameRot: Quat = { x: 0, y: 0, z: 0, w: 1 }
    const rest = walkChain(rider, { x: 0, y: 0, z: 0 }, frameRot, false, RIDER_POSE_TUNING)
    const reactive = walkChain(rider, { x: 0, y: 0, z: 0 }, frameRot, true, RIDER_POSE_TUNING)
    const a = rest.get('abdomen')
    const b = reactive.get('abdomen')
    if (!a || !b) throw new Error('missing poses')
    vclose(a.pos, b.pos)
  })
})

describe('solveArmIK', () => {
  const shoulder: Vec3 = { x: 0, y: 0, z: 0 }
  const upperHH = 0.15
  const lowerHH = 0.18
  const L1 = 2 * upperHH
  const L2 = 2 * lowerHH
  const pole: Vec3 = { x: 0, y: -1, z: -0.2 }

  /** The hand "tip" the solver reaches = lower-arm center + lowerHH down its +Y. */
  function handReached(lowerArm: { pos: Vec3; rot: Quat }): Vec3 {
    const down = rotByQuat(lowerArm.rot, 0, lowerHH, 0)
    return { x: lowerArm.pos.x + down.x, y: lowerArm.pos.y + down.y, z: lowerArm.pos.z + down.z }
  }

  it('reaches a target inside the reachable range', () => {
    const target: Vec3 = { x: 0.3, y: -0.2, z: 0.1 }
    expect(vlen(vsub(target, shoulder))).toBeLessThan(L1 + L2)
    const ik = solveArmIK(shoulder, target, upperHH, lowerHH, pole)
    vclose(handReached(ik.lowerArm), target, 1e-4)
  })

  it('keeps the bone lengths consistent (upper = L1, lower = L2)', () => {
    const target: Vec3 = { x: 0.25, y: -0.3, z: 0.0 }
    const ik = solveArmIK(shoulder, target, upperHH, lowerHH, pole)
    // upper arm center is L1/2 from the shoulder; full bone is L1.
    const elbow = {
      x: ik.upperArm.pos.x + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).x,
      y: ik.upperArm.pos.y + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).y,
      z: ik.upperArm.pos.z + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).z,
    }
    expect(vlen(vsub(elbow, shoulder))).toBeCloseTo(L1, 4)
    const hand = handReached(ik.lowerArm)
    expect(vlen(vsub(hand, elbow))).toBeCloseTo(L2, 4)
  })

  it('clamps an out-of-reach target to the arm span', () => {
    const target: Vec3 = { x: 10, y: 0, z: 0 }
    const ik = solveArmIK(shoulder, target, upperHH, lowerHH, pole)
    const hand = handReached(ik.lowerArm)
    const reach = vlen(vsub(hand, shoulder))
    // Reached distance is bounded by the arm span (minus the solver epsilon).
    expect(reach).toBeLessThanOrEqual(L1 + L2 + 1e-3)
    expect(reach).toBeGreaterThan(L1 + L2 - 0.01)
    // The reached point lies on the shoulder→target ray.
    const dir = { x: 1, y: 0, z: 0 }
    vclose({ x: hand.x / reach, y: hand.y / reach, z: hand.z / reach }, dir, 1e-3)
  })

  it('produces a stable pose at the fully-folded minimum distance', () => {
    // target at |L1 - L2| (just inside): arm folds back on itself.
    const target: Vec3 = { x: 0, y: -Math.abs(L1 - L2), z: 0 }
    const ik = solveArmIK(shoulder, target, upperHH, lowerHH, pole)
    for (const v of [ik.upperArm.pos, ik.lowerArm.pos]) {
      expect(Number.isFinite(v.x)).toBe(true)
      expect(Number.isFinite(v.y)).toBe(true)
      expect(Number.isFinite(v.z)).toBe(true)
    }
  })

  it('bends the elbow toward the pole hint side', () => {
    // Symmetric target straight down; pole pushes the elbow toward -z.
    const target: Vec3 = { x: 0, y: -0.4, z: 0 }
    const ik = solveArmIK(shoulder, target, upperHH, lowerHH, { x: 0, y: -1, z: -1 })
    const elbow = {
      x: ik.upperArm.pos.x + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).x,
      y: ik.upperArm.pos.y + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).y,
      z: ik.upperArm.pos.z + rotByQuat(ik.upperArm.rot, 0, upperHH, 0).z,
    }
    expect(elbow.z).toBeLessThan(0)
  })
})
