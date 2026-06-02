import { addComponent, addEntity } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { emptyIntent } from '../../src/engine/input/intent'
import { makePoseBuffer, type ReplayBikePose } from '../../src/engine/replay/player'
import { createReplayStateReconstructor } from '../../src/engine/replay/state-reconstructor'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { createWaveField } from '../../src/engine/sim/water/wave-field'
import {
  ControlIntent,
  ControlIntentStore,
  DriftState,
  DriftStateStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
} from '../../src/game/components'

type LinvelSpy = { x: number; y: number; z: number }

/**
 * Build a sim with one fake bike entity wired up with the components the
 * reconstructor writes to, plus a mock `PhysicsWorld` that records the
 * most recent `setLinvel` call instead of running a real Rapier world.
 */
function makeFixture(): {
  sim: SimWorld
  phys: PhysicsWorld
  eid: number
  linvel: LinvelSpy
} {
  const sim = createSimWorld({ seed: 0 })
  const eid = addEntity(sim)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle: 1 })
  addComponent(sim, eid, HoverState)
  HoverStateStore.set(eid, {
    groundDistance: 0,
    isGrounded: false,
    noseGrounded: false,
    baseGrounded: false,
    surfaceIsWater: false,
    // SurfaceType.DEFAULT is `0`; using the raw value avoids dragging
    // that import in just for the fixture.
    surfaceType: 0 as never,
    forwardSlope: 0,
    diveHoldS: 0,
    releaseKickS: 0,
  })
  addComponent(sim, eid, ControlIntent)
  ControlIntentStore.set(eid, emptyIntent())
  addComponent(sim, eid, DriftState)
  DriftStateStore.set(eid, {
    driftDir: 0,
    chargeS: 0,
    highestTier: 0,
    sinceReleaseS: 0,
    ungroundedDuringDriftS: 0,
    prevLeftDown: false,
    prevRightDown: false,
    releasedThisTick: false,
    releasedTier: 0,
  })

  const linvel: LinvelSpy = { x: 0, y: 0, z: 0 }
  const fakeRb = {
    setLinvel(v: { x: number; y: number; z: number }, _wake: boolean) {
      linvel.x = v.x
      linvel.y = v.y
      linvel.z = v.z
    },
  }
  const phys = {
    world: {
      getRigidBody(_handle: number) {
        return fakeRb
      },
    },
  } as unknown as PhysicsWorld
  return { sim, phys, eid, linvel }
}

function pose(
  x: number,
  y: number,
  z: number,
  state: Partial<
    Pick<ReplayBikePose, 'pitch' | 'throttle' | 'boost' | 'driftDir' | 'driftTier'>
  > = {},
): ReplayBikePose {
  return {
    x,
    y,
    z,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    pitch: state.pitch ?? 0,
    throttle: state.throttle ?? 0,
    boost: state.boost ?? false,
    driftDir: state.driftDir ?? 0,
    driftTier: state.driftTier ?? 0,
  }
}

describe('replay state reconstructor — v1 (legacy / pose-only) fallback', () => {
  it('first tick primes prev-pose without computing velocity (no spike)', () => {
    const { sim, phys, eid, linvel } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 1.2, 0)
    r.tick(1 / 60, buf)
    expect(linvel.x).toBe(0)
    expect(linvel.y).toBe(0)
    expect(linvel.z).toBe(0)
    expect(HoverStateStore.get(eid)?.isGrounded).toBe(false)
  })

  it('synthesises forward velocity from consecutive poses', () => {
    const { sim, phys, eid, linvel } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 1.2, 0)
    r.tick(1 / 60, buf)
    buf[0] = pose(0, 1.2, 10)
    r.tick(1 / 60, buf)
    expect(linvel.z).toBeCloseTo(600, 1)
    expect(linvel.x).toBeCloseTo(0, 5)
  })

  it('marks the bike as grounded over water when within hover-zone height', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(5, 1.2, 5)
    r.tick(1 / 60, buf)
    buf[0] = pose(5, 1.2, 6)
    r.tick(1 / 60, buf)
    const hover = HoverStateStore.get(eid)!
    expect(hover.isGrounded).toBe(true)
    expect(hover.surfaceIsWater).toBe(true)
    expect(hover.groundDistance).toBeCloseTo(1.2, 5)
  })

  it('marks the bike as airborne (not grounded) well above the surface', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 5, 0)
    r.tick(1 / 60, buf)
    buf[0] = pose(0, 5, 1)
    r.tick(1 / 60, buf)
    expect(HoverStateStore.get(eid)?.isGrounded).toBe(false)
  })

  it('sets throttle = 1 when the bike is moving and 0 when stationary', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 1.2, 0)
    r.tick(1 / 60, buf)
    buf[0] = pose(0, 1.2, 0.5)
    r.tick(1 / 60, buf)
    expect(ControlIntentStore.get(eid)?.throttle).toBe(1)

    buf[0] = pose(0, 1.2, 0.5)
    r.tick(1 / 60, buf)
    expect(ControlIntentStore.get(eid)?.throttle).toBe(0)
  })

  it('uses terrain height when bike is over land (heightmap-aware)', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const terrainHeightmap = {
      texture: {} as never,
      worldMin: { x: -10, y: -10 } as never,
      worldMax: { x: 10, y: 10 } as never,
      resolution: 2,
      raw: new Float32Array([8, 8, 8, 8]),
    }
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 9, 0)
    r.tick(1 / 60, buf)
    buf[0] = pose(0, 9, 1)
    r.tick(1 / 60, buf)
    const hover = HoverStateStore.get(eid)!
    expect(hover.surfaceIsWater).toBe(false)
    expect(hover.isGrounded).toBe(true)
    expect(hover.groundDistance).toBeCloseTo(1.0, 5)
  })

  it('leaves drift / boost / pitch at neutral defaults (no false-fire on legacy)', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: true,
    })
    const buf = makePoseBuffer(1)
    // Recorded state slots would normally feed drift / boost / pitch.
    // On v1 they must be ignored.
    buf[0] = pose(5, 1.2, 5, { driftDir: 1, driftTier: 2, boost: true, pitch: 0.7 })
    r.tick(1 / 60, buf)
    buf[0] = pose(5, 1.2, 6, { driftDir: 1, driftTier: 2, boost: true, pitch: 0.7 })
    r.tick(1 / 60, buf)
    const intent = ControlIntentStore.get(eid)!
    const drift = DriftStateStore.get(eid)!
    expect(intent.boost).toBe(false)
    expect(intent.pitch).toBe(0)
    expect(drift.driftDir).toBe(0)
    expect(drift.highestTier).toBe(0)
  })
})

describe('replay state reconstructor — v2 (recorded input state)', () => {
  it('forwards recorded pitch / throttle / boost into ControlIntent', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: false,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 1.2, 0, { throttle: 0.85, pitch: -0.4, boost: true })
    r.tick(1 / 60, buf) // prime
    buf[0] = pose(0, 1.2, 1, { throttle: 0.85, pitch: -0.4, boost: true })
    r.tick(1 / 60, buf)
    const intent = ControlIntentStore.get(eid)!
    expect(intent.throttle).toBeCloseTo(0.85)
    expect(intent.pitch).toBeCloseTo(-0.4)
    expect(intent.boost).toBe(true)
  })

  it('forwards recorded drift dir + tier into DriftState', () => {
    const { sim, phys, eid } = makeFixture()
    const waveField = createWaveField([], { baseY: 0 })
    const r = createReplayStateReconstructor({
      sim,
      phys,
      bikeEids: [eid],
      waveField,
      terrainHeightmap: null,
      isLegacyV1: false,
    })
    const buf = makePoseBuffer(1)
    buf[0] = pose(0, 1.2, 0, { driftDir: -1, driftTier: 2 })
    r.tick(1 / 60, buf)
    buf[0] = pose(0, 1.2, 1, { driftDir: -1, driftTier: 2 })
    r.tick(1 / 60, buf)
    const drift = DriftStateStore.get(eid)!
    expect(drift.driftDir).toBe(-1)
    expect(drift.highestTier).toBe(2)
  })
})
