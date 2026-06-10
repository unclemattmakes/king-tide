/**
 * Snapshot-interpolation buffer for remote kinematic bikes
 * (`src/game/systems/remote-interp.ts`).
 *
 * Pins the wall-clock interpolation math the smooth-remote-bikes feel
 * rides on: buffer seeding/sliding, the 100 ms render delay midpoint,
 * the extrapolation clamp during packet gaps, the dynamic-body skip
 * (host-changeover edge), lifecycle clears, and shortest-arc slerp
 * (a quaternion and its negation are the same orientation — naive lerp
 * through the long way reads as a 360° spin).
 *
 * Rapier is mocked (no WASM): the module only reads `bodyType()` and
 * writes `setNextKinematicTranslation/Rotation`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { BikeSnapshotRecord } from '../../src/engine/net/transform-snapshot'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '../../src/engine/sim/physics/vec'
import { RBHandleStore } from '../../src/game/components'
import {
  clearRemoteInterp,
  pushRemoteSnapshot,
  resetRemoteInterp,
  tickRemoteInterp,
} from '../../src/game/systems/remote-interp'

const KINEMATIC = 2
const DYNAMIC = 0

type MockBody = {
  bodyType: () => number
  setNextKinematicTranslation: (p: Vec3) => void
  setNextKinematicRotation: (q: Quat) => void
  lastPos: Vec3 | null
  lastRot: Quat | null
}

function makeBody(type: number): MockBody {
  const body: MockBody = {
    bodyType: () => type,
    setNextKinematicTranslation(p) {
      body.lastPos = { ...p }
    },
    setNextKinematicRotation(q) {
      body.lastRot = { ...q }
    },
    lastPos: null,
    lastRot: null,
  }
  return body
}

function mockPhys(bodies: Map<number, MockBody>): PhysicsWorld {
  return {
    world: { getRigidBody: (h: number) => bodies.get(h) ?? null },
    rapier: { RigidBodyType: { KinematicPositionBased: KINEMATIC, Dynamic: DYNAMIC } },
    fixedDt: 1 / 60,
  } as unknown as PhysicsWorld
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

function record(pos: Vec3, rot: Quat = IDENTITY): BikeSnapshotRecord {
  return {
    ownerPeerId: 1,
    bikeKind: 0,
    bikeIndex: 0,
    flags: 0,
    position: pos,
    rotation: rot,
    velocity: { x: 0, y: 0, z: 0 },
  }
}

// Unique eid/handle per test so the module-global buffer map and the
// shared RBHandleStore can't bleed state across cases.
let nextId = 9000

describe('remote-interp', () => {
  let eid: number
  let body: MockBody
  let phys: PhysicsWorld

  beforeEach(() => {
    resetRemoteInterp()
    nextId += 1
    eid = nextId
    body = makeBody(KINEMATIC)
    RBHandleStore.set(eid, { handle: eid })
    phys = mockPhys(new Map([[eid, body]]))
  })

  it('first push seeds both slots — tick lands exactly on the sample', () => {
    pushRemoteSnapshot(eid, record({ x: 3, y: 1, z: -2 }), 1000)
    tickRemoteInterp(phys, 1500)
    expect(body.lastPos).toEqual({ x: 3, y: 1, z: -2 })
  })

  it('interpolates the wall-clock midpoint between two snapshots', () => {
    // Samples 50 ms apart (20 Hz cadence). Render time = now - 100 ms;
    // now = 1125 → renderTime 1025 → halfway through [1000, 1050].
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }), 1000)
    pushRemoteSnapshot(eid, record({ x: 10, y: 2, z: -4 }), 1050)
    tickRemoteInterp(phys, 1125)
    expect(body.lastPos?.x).toBeCloseTo(5, 6)
    expect(body.lastPos?.y).toBeCloseTo(1, 6)
    expect(body.lastPos?.z).toBeCloseTo(-2, 6)
  })

  it('clamps extrapolation to half an interval past the latest sample', () => {
    // Pin of MAX_EXTRAPOLATE_T = 1.5: a long gap must coast to
    // prev + 1.5×(next−prev) and freeze there, not fling to infinity.
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }), 1000)
    pushRemoteSnapshot(eid, record({ x: 10, y: 0, z: 0 }), 1050)
    tickRemoteInterp(phys, 5000)
    expect(body.lastPos?.x).toBeCloseTo(15, 6)
    tickRemoteInterp(phys, 9000) // still frozen at the clamp
    expect(body.lastPos?.x).toBeCloseTo(15, 6)
  })

  it('clamps to the prev sample when render time predates the buffer', () => {
    pushRemoteSnapshot(eid, record({ x: 4, y: 0, z: 0 }), 1000)
    pushRemoteSnapshot(eid, record({ x: 8, y: 0, z: 0 }), 1050)
    // now=1010 → renderTime=910, before prev's receivedAt → t clamps to 0.
    tickRemoteInterp(phys, 1010)
    expect(body.lastPos?.x).toBeCloseTo(4, 6)
  })

  it('slides the buffer: prev takes next, next takes the new sample', () => {
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }), 1000)
    pushRemoteSnapshot(eid, record({ x: 10, y: 0, z: 0 }), 1050)
    pushRemoteSnapshot(eid, record({ x: 20, y: 0, z: 0 }), 1100)
    // renderTime 1075 → halfway through the [1050, 1100] pair → 15.
    tickRemoteInterp(phys, 1175)
    expect(body.lastPos?.x).toBeCloseTo(15, 6)
  })

  it('skips dynamic bodies (host-changeover edge is applySnapshot territory)', () => {
    const dynBody = makeBody(DYNAMIC)
    const dynEid = ++nextId
    RBHandleStore.set(dynEid, { handle: dynEid })
    const dynPhys = mockPhys(new Map([[dynEid, dynBody]]))
    pushRemoteSnapshot(dynEid, record({ x: 1, y: 1, z: 1 }), 1000)
    tickRemoteInterp(dynPhys, 1500)
    expect(dynBody.lastPos).toBeNull()
    expect(dynBody.lastRot).toBeNull()
  })

  it('clearRemoteInterp stops further writes for that entity', () => {
    pushRemoteSnapshot(eid, record({ x: 1, y: 0, z: 0 }), 1000)
    clearRemoteInterp(eid)
    tickRemoteInterp(phys, 1500)
    expect(body.lastPos).toBeNull()
  })

  it('slerps the short way: a 90° yaw midpoint is a 45° yaw', () => {
    const yaw90: Quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }, IDENTITY), 1000)
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }, yaw90), 1050)
    tickRemoteInterp(phys, 1125) // midpoint
    const r = body.lastRot
    expect(r).not.toBeNull()
    expect(r?.y).toBeCloseTo(Math.sin(Math.PI / 8), 5)
    expect(r?.w).toBeCloseTo(Math.cos(Math.PI / 8), 5)
  })

  it('treats q and −q as the same orientation (no long-way spin)', () => {
    // −identity is the identity orientation; the midpoint must stay
    // identity (|w| ≈ 1), not pass through a degenerate half-spin.
    const negIdentity: Quat = { x: -0, y: -0, z: -0, w: -1 }
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }, IDENTITY), 1000)
    pushRemoteSnapshot(eid, record({ x: 0, y: 0, z: 0 }, negIdentity), 1050)
    tickRemoteInterp(phys, 1125)
    const r = body.lastRot
    expect(r).not.toBeNull()
    expect(Math.abs(r?.w ?? 0)).toBeCloseTo(1, 5)
    expect(r?.x ?? 1).toBeCloseTo(0, 5)
    expect(r?.y ?? 1).toBeCloseTo(0, 5)
    expect(r?.z ?? 1).toBeCloseTo(0, 5)
  })
})
