/**
 * Geometric trick system — `src/game/systems/trick-hop.ts`.
 *
 * The sim is the single source of truth for whether a press fires a
 * credible trick. The window is armed by the bike's *pose*: leaving the
 * fully-planted stance (nose-up pop or full takeoff) opens it; re-planting
 * closes it. These tests drive the system directly with a minimal Rapier
 * rigid-body mock and a hand-set `HoverState` (center / nose / base
 * contact), asserting the `TrickState.trickFiredThisTick` flag plus the
 * supporting state machine (window open/close, pre-press buffer,
 * hop-lockout gating, one-fire-per-airtime dedup).
 *
 * The mock returns a fixed `linvel()` per tick so the test controls
 * vy / horizontal-speed inputs precisely. `applyImpulse` is captured
 * for the courtesy-hop assertions.
 */

import { addComponent, addEntity } from 'bitecs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { SurfaceType } from '../../src/engine/sim/surface-types'
import { PRE_PRESS_BUFFER_SEC } from '../../src/engine/wave-pump-observer'
import {
  BikeStats,
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
  TrickState,
  TrickStateStore,
} from '../../src/game/components'
import { trickHopSystem } from '../../src/game/systems/trick-hop'

type BodyState = {
  vx: number
  vy: number
  vz: number
  /** Captured impulses applied via `applyImpulse`. */
  impulses: { x: number; y: number; z: number }[]
}

function makeMockPhys(body: BodyState): { phys: PhysicsWorld; bodyHandle: number } {
  const handle = 1
  const rb = {
    isDynamic: () => true,
    mass: () => 1,
    linvel: () => ({ x: body.vx, y: body.vy, z: body.vz }),
    applyImpulse: (v: { x: number; y: number; z: number }) => {
      body.impulses.push({ ...v })
    },
  }
  const world = {
    getRigidBody: (h: number) => (h === handle ? rb : null),
  }
  return {
    bodyHandle: handle,
    phys: {
      world,
      fixedDt: 1 / 60,
    } as unknown as PhysicsWorld,
  }
}

/**
 * Set the bike's contact state. `center` is the hover `isGrounded`; nose
 * and base default to `center` so the common "fully planted" / "fully
 * airborne" cases are one argument. A nose-up pop is `setGround(eid, true,
 * false, true)`.
 */
function setGround(eid: number, center: boolean, nose = center, base = center): void {
  const h = HoverStateStore.must(eid)
  h.isGrounded = center
  h.noseGrounded = nose
  h.baseGrounded = base
}

function spawnBike(
  sim: SimWorld,
  handle: number,
): { eid: number; setIntent: (over: Partial<ReturnType<typeof intent0>>) => void } {
  const eid = addEntity(sim)
  addComponent(sim, eid, BikeTag)
  addComponent(sim, eid, BikeStats)
  BikeStatsStore.set(eid, {
    hoverHeight: 1,
    hoverSpring: 100,
    hoverDamp: 10,
    accel: 30,
    topSpeed: 28,
    turnTorque: 10,
    lateralDrag: 10,
    reverseScale: 0.5,
    boostMul: 1.5,
    mass: 1,
    surfaceFollow: 0.5,
    tuckSpeedBoost: 1.15,
    tuckDragMul: 0.5,
  })
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle })
  addComponent(sim, eid, ControlIntent)
  ControlIntentStore.set(eid, intent0())
  addComponent(sim, eid, HoverState)
  HoverStateStore.set(eid, {
    groundDistance: 0,
    isGrounded: true,
    noseGrounded: true,
    baseGrounded: true,
    surfaceIsWater: false,
    surfaceType: SurfaceType.DEFAULT,
    forwardSlope: 0,
    diveHoldS: 0,
    releaseKickS: 0,
  })
  addComponent(sim, eid, TrickState)
  TrickStateStore.set(eid, {
    cooldownSec: 0,
    spinPhase: 0,
    spinAxisX: 0,
    spinAxisY: 0,
    spinAxisZ: 0,
    spinDurationSec: 0,
    prevLeftDown: false,
    prevRightDown: false,
    vyPeak: 0,
    vyPeakTicksAgo: 0,
    hopLockoutActive: false,
    hopLockoutAirborneSeen: false,
    hopLockoutSafetyTicks: 0,
    trickWindowOpen: false,
    trickWindowTakeoffVy: 0,
    trickFiredThisAirborne: false,
    bufferedPressTimerSec: 0,
    bufferedPressDir: 0,
    trickFiredThisTick: false,
    trickFiredStrength: 0,
    trickFiredDirection: 0,
  })

  return {
    eid,
    setIntent: (over) => {
      const cur = ControlIntentStore.must(eid)
      Object.assign(cur, over)
    },
  }
}

function intent0() {
  return {
    throttle: 0,
    steer: 0,
    brake: 0,
    fire: false,
    boost: false,
    pitch: 0,
    trickLeft: false,
    trickRight: false,
  }
}

let sim: SimWorld
let body: BodyState
let phys: PhysicsWorld
let handle: number

beforeEach(() => {
  sim = createSimWorld({ seed: 1 })
  body = { vx: 0, vy: 0, vz: 0, impulses: [] }
  const m = makeMockPhys(body)
  phys = m.phys
  handle = m.bodyHandle
})

describe('trickHopSystem — grounded press while fully planted', () => {
  it('fires the small flatground hop and engages the hop-lockout', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Cruising on flat ground (fully planted): speed + throttle high, vy 0,
    // so no climb context to buffer against.
    body.vx = 22
    body.vy = 0
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)

    expect(body.impulses).toHaveLength(1)
    const firstImpulse = body.impulses[0]
    expect(firstImpulse?.y).toBeGreaterThan(0)
    expect(firstImpulse?.y).toBeCloseTo(4.5, 5)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.hopLockoutActive).toBe(true)
    expect(trick.trickWindowOpen).toBe(false)
    expect(trick.cooldownSec).toBeGreaterThan(0)
  })

  it('does nothing trick-worthy on a grounded press while the bike is parked', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // No throttle, no speed — fails the gates, so the press still goes to
    // the courtesy-hop path (no buffer, no trick).
    setIntent({ throttle: 0, trickRight: true })
    trickHopSystem(sim, phys)

    expect(body.impulses.length).toBeGreaterThanOrEqual(1)
    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.trickWindowOpen).toBe(false)
  })
})

describe('trickHopSystem — leaving the planted stance arms the window', () => {
  it('opens the window on the pop and fires a buffered press at the pop', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Seed a credible climb while planted: vy 5, fast, on throttle.
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)

    // Press while still planted — buffer engages (climb context + gates).
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    const trickMid = TrickStateStore.must(eid)
    expect(trickMid.bufferedPressTimerSec).toBeGreaterThan(0)
    expect(trickMid.bufferedPressDir).toBe(+1)
    expect(trickMid.trickFiredThisTick).toBe(false)
    expect(body.impulses).toHaveLength(0)

    // Release the button, then pop: nose lifts off, base + center still
    // read grounded for a tick (full takeoff in the same motion). Leaving
    // the planted stance arms the window and consumes the buffer.
    setIntent({ throttle: 0.9, trickRight: false })
    setGround(eid, false)
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickWindowOpen).toBe(true)
    expect(trick.trickWindowTakeoffVy).toBeCloseTo(5, 5)
    expect(trick.trickFiredThisTick).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
    expect(trick.trickFiredStrength).toBeGreaterThan(0)
    expect(trick.trickFiredThisAirborne).toBe(true)
    // The pop came from terrain, not a courtesy hop — no impulse applied.
    expect(body.impulses).toHaveLength(0)
  })

  it('arms on a nose-up pop while the base is still grounded', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 3
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)

    // Classic pop: center + base still grounded, nose lifts off a lip.
    setGround(eid, true, false, true)
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    // Press during the pop (nose airborne, base grounded) — fires.
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
  })

  it('arms while riding up a ramp / sandbar transition at speed (kicker)', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Grounded, nose still down (climbing — the nose samples the rising
    // slope ahead), but on a clear upslope at speed.
    body.vx = 22
    body.vy = 2
    setIntent({ throttle: 0.9 })
    HoverStateStore.must(eid).forwardSlope = 0.2 // ≈ 11°, above the kicker gate
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    // Press while climbing the ramp — fires (the loft then pops the bike).
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(true)
  })

  it('arms while dropping off a ledge / embankment at speed (negative slope)', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Grounded, following a downward embankment — negative slope of the
    // same magnitude as the kicker gate. The old up-only arm missed this.
    body.vx = 22
    body.vy = -1
    setIntent({ throttle: 0.9 })
    HoverStateStore.must(eid).forwardSlope = -0.2 // ≈ −11°, a real drop
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(true)
  })

  it('does not arm on a gentle grade below the kicker slope', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 0.5
    setIntent({ throttle: 0.9 })
    HoverStateStore.must(eid).forwardSlope = 0.05 // below TRICK_RAMP_SLOPE_MIN
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('fires immediately on an in-air press when the window is already open', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)

    setIntent({ throttle: 0.9, trickLeft: true })
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(true)
    expect(trick.trickFiredDirection).toBe(-1)
  })

  it('only fires once per airtime — second press while still airborne does nothing', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)

    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(true)

    setIntent({ throttle: 0.9, trickRight: false })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)
    setIntent({ throttle: 0.9, trickLeft: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)
    // No courtesy hop fired during the open episode either.
    expect(body.impulses).toHaveLength(0)
  })

  it('closes the window silently on re-planting', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    // Land without pressing: fully planted again → window closes.
    body.vy = 0
    setGround(eid, true)
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickWindowOpen).toBe(false)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.trickFiredThisAirborne).toBe(false)
  })
})

describe('trickHopSystem — eligibility gates', () => {
  it('opens the window on a low-vy pop and floors the reward (geometry, not vy, gates eligibility)', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // vy well below the old 2.0 threshold — under the geometric model the
    // pop still arms the window.
    body.vx = 22
    body.vy = 1.0
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(true)
    // Floored to the "I made it count" minimum even though vy < threshold.
    expect(trick.trickFiredStrength).toBeCloseTo(0.4, 2)
  })

  it('does not open the window when speed is below the threshold', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 3 // ~11% of topSpeed 28 — below MIN_SPEED_FRAC (0.25)
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('does not open the window when throttle is below the threshold', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.1 }) // below MIN_THROTTLE (0.2)
    trickHopSystem(sim, phys)
    setGround(eid, false)
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('does not open the window if the launch is self-induced (hop-lockout active)', () => {
    // A courtesy hop's lift is the system's own impulse — the hop-lockout
    // flag must stop that from arming a free trick.
    const { eid, setIntent } = spawnBike(sim, handle)

    // Fire a courtesy hop on flat ground.
    body.vx = 22
    body.vy = 0
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).hopLockoutActive).toBe(true)

    // Next tick the hop carries the bike off the ground. Even with speed /
    // throttle passing, the lockout blocks the arm.
    setIntent({ throttle: 0.9, trickRight: false })
    body.vy = 4.5
    setGround(eid, false)
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })
})

describe('trickHopSystem — pre-input buffer', () => {
  it('fires the trick when a pop arrives inside the buffer window', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).bufferedPressTimerSec).toBeGreaterThan(0)

    // Pop one tick later, still inside the 200 ms buffer — the held press
    // fires the trick at the pop.
    setIntent({ throttle: 0.9, trickRight: false })
    setGround(eid, false)
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
    expect(trick.trickWindowOpen).toBe(true)
    expect(trick.bufferedPressTimerSec).toBe(0)
    expect(trick.bufferedPressDir).toBe(0)
    // No courtesy hop — the launch was the terrain pop.
    expect(body.impulses).toHaveLength(0)
  })

  it('fires a deferred trick on buffer expiry when the climb context still holds', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).bufferedPressTimerSec).toBeGreaterThan(0)

    // Wave-crest case: the bike rides through without the center leaving
    // the surface and the nose never clears the cutoff, so no geometric
    // pop arrives. But throttle stays on at speed and vyPeak is still
    // fresh, so the climb context the prompt promised holds — the buffer
    // synthesizes the launch and fires the trick on expiry.
    setIntent({ throttle: 0.9, trickRight: false })
    body.vy = 0
    const ticksToRunOut = Math.ceil(PRE_PRESS_BUFFER_SEC / phys.fixedDt) + 1
    for (let i = 0; i < ticksToRunOut; i++) trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.bufferedPressTimerSec).toBe(0)
    expect(trick.bufferedPressDir).toBe(0)
    // One-shot fire flag is cleared the next tick; assert the sticky
    // markers that persist until the next press.
    expect(trick.trickFiredThisAirborne).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
    expect(trick.trickFiredStrength).toBeGreaterThan(0)
    expect(trick.trickWindowOpen).toBe(true)
    expect(trick.hopLockoutActive).toBe(true)
    // Synthesized lift applied so the bike visibly leaves the surface.
    expect(body.impulses.length).toBeGreaterThanOrEqual(1)
    const lastImpulse = body.impulses[body.impulses.length - 1]
    expect(lastImpulse?.y).toBeCloseTo(4.5, 5)
  })

  it('falls back to a courtesy hop when the climb context decays before expiry', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).bufferedPressTimerSec).toBeGreaterThan(0)

    // Player lets off the throttle — `throttleOK` is false at expiry, so
    // the credibility re-check fails and the courtesy hop fires instead.
    setIntent({ throttle: 0, trickRight: false })
    body.vy = 0
    const ticksToRunOut = Math.ceil(PRE_PRESS_BUFFER_SEC / phys.fixedDt) + 1
    for (let i = 0; i < ticksToRunOut; i++) trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.bufferedPressTimerSec).toBe(0)
    expect(trick.bufferedPressDir).toBe(0)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.trickFiredThisAirborne).toBe(false)
    expect(trick.hopLockoutActive).toBe(true)
    expect(body.impulses.length).toBeGreaterThanOrEqual(1)
    const lastImpulse = body.impulses[body.impulses.length - 1]
    expect(lastImpulse?.y).toBeCloseTo(4.5, 5)
  })
})

describe('trickHopSystem — reward magnitude', () => {
  it('scales fired-trick strength with takeoff vy', () => {
    const minVy = 2.0
    const highVy = 8
    const lowFired = runPop(minVy)
    const highFired = runPop(highVy)
    expect(highFired).toBeGreaterThan(lowFired)
    expect(lowFired).toBeGreaterThan(0)
    expect(highFired).toBeCloseTo(1, 2)
  })
})

function runPop(takeoffVy: number): number {
  const localSim = createSimWorld({ seed: 1 })
  const localBody: BodyState = { vx: 22, vy: takeoffVy, vz: 0, impulses: [] }
  const m = makeMockPhys(localBody)
  const { eid, setIntent } = spawnBike(localSim, m.bodyHandle)
  setIntent({ throttle: 0.9 })
  trickHopSystem(localSim, m.phys) // seed vyPeak while planted
  setGround(eid, false) // pop / full takeoff
  trickHopSystem(localSim, m.phys) // arm
  setIntent({ throttle: 0.9, trickRight: true })
  trickHopSystem(localSim, m.phys) // press → fire
  return TrickStateStore.must(eid).trickFiredStrength
}
