/**
 * Airborne-gated trick system — `src/game/systems/trick-hop.ts`.
 *
 * The sim is the single source of truth for whether a press fires a
 * credible trick. These tests exercise the trick-hop system directly
 * with a minimal Rapier rigid-body mock and assert the
 * `TrickState.trickFiredThisTick` flag plus the supporting state
 * machine (window open/close, pre-press buffer, hop-lockout gating,
 * one-fire-per-airtime dedup).
 *
 * The mock returns a fixed `linvel()` per tick so the test controls
 * vy / horizontal-speed inputs precisely. `applyImpulse` is captured
 * for the small-hop assertions.
 */

import { addComponent, addEntity } from 'bitecs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
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
    tuckTurnMul: 0.45,
  })
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle })
  addComponent(sim, eid, ControlIntent)
  ControlIntentStore.set(eid, intent0())
  addComponent(sim, eid, HoverState)
  HoverStateStore.set(eid, {
    groundDistance: 0,
    isGrounded: true,
    surfaceIsWater: false,
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
    wasGroundedLastTick: true,
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
    tuck: false,
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

describe('trickHopSystem — grounded press without climb context', () => {
  it('fires the small flatground hop and engages the hop-lockout', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Cruising on flat ground: speed + throttle high, vy 0.
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

  it('does nothing on a grounded press while the bike is parked', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // No throttle, no speed — fails the speed/throttle gates, so the
    // press still goes to the small-hop path (no buffer).
    setIntent({ throttle: 0, trickRight: true })
    trickHopSystem(sim, phys)

    // Even a flatground press fires the small hop (lift is always
    // available when grounded + cooldown ready). The trick payoff is
    // what's gated.
    expect(body.impulses.length).toBeGreaterThanOrEqual(1)
    const trick = TrickStateStore.must(eid)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.trickWindowOpen).toBe(false)
  })
})

describe('trickHopSystem — qualifying takeoff opens the trick window', () => {
  it('opens the window on grounded → airborne transition and fires a buffered press at takeoff', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Build a credible climb while still grounded: vy 5, fast, on
    // throttle. One sim tick to seed `vyPeak`.
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)

    // Player presses while still grounded — buffer engages because
    // vyPeak ≥ MIN_VY_PEAK and speed/throttle pass.
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    const trickMid = TrickStateStore.must(eid)
    expect(trickMid.bufferedPressTimerSec).toBeGreaterThan(0)
    expect(trickMid.bufferedPressDir).toBe(+1)
    expect(trickMid.trickFiredThisTick).toBe(false)
    expect(body.impulses).toHaveLength(0)

    // Release the button so the next press can be a fresh edge later.
    // Then leave the ground (qualifying takeoff: surface-driven, vy 5,
    // fast, on throttle).
    setIntent({ throttle: 0.9, trickRight: false })
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickWindowOpen).toBe(true)
    expect(trick.trickWindowTakeoffVy).toBeCloseTo(5, 5)
    expect(trick.trickFiredThisTick).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
    expect(trick.trickFiredStrength).toBeGreaterThan(0)
    expect(trick.trickFiredThisAirborne).toBe(true)
  })

  it('fires immediately on an in-air press when the window is already open', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Climb + take off without pressing — window opens, no fire yet.
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)

    // Now press mid-air — fires immediately, no buffer.
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
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    // First press fires.
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(true)

    // Release + re-press while still airborne — no second fire.
    setIntent({ throttle: 0.9, trickRight: false })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)
    setIntent({ throttle: 0.9, trickLeft: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickFiredThisTick).toBe(false)
  })

  it('closes the window silently on landing', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(true)

    // Land without pressing — window closes, no trick fires.
    body.vy = 0
    HoverStateStore.must(eid).isGrounded = true
    trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.trickWindowOpen).toBe(false)
    expect(trick.trickFiredThisTick).toBe(false)
    expect(trick.trickFiredThisAirborne).toBe(false)
  })
})

describe('trickHopSystem — disqualifying takeoffs', () => {
  it('does not open the window if takeoff vy is below the threshold', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 1.0 // below MIN_VY_PEAK (2.0)
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('does not open the window when speed is below the threshold', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 3 // ~11% of topSpeed 28 — below MIN_SPEED_FRAC (0.25)
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('does not open the window when throttle is below the threshold', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.1 }) // below MIN_THROTTLE (0.2)
    trickHopSystem(sim, phys)
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })

  it('does not open the window if takeoff is self-induced (hop-lockout active)', () => {
    // A small hop's takeoff is the system's own impulse — the
    // hop-lockout flag should stop that from arming a free trick.
    const { eid, setIntent } = spawnBike(sim, handle)

    // Fire a small hop on flat ground.
    body.vx = 22
    body.vy = 0
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).hopLockoutActive).toBe(true)

    // Next tick the bike is now airborne (the small hop carries it
    // off the ground). Even though body.vy may be >= threshold and
    // speed/throttle pass, the lockout closes the window.
    setIntent({ throttle: 0.9, trickRight: false })
    body.vy = 4.5
    HoverStateStore.must(eid).isGrounded = false
    trickHopSystem(sim, phys)

    expect(TrickStateStore.must(eid).trickWindowOpen).toBe(false)
  })
})

describe('trickHopSystem — pre-input buffer', () => {
  it('fires a deferred trick on buffer expiry when the climb context still looks credible', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    // Climb context (vyPeak ≥ threshold) + press while grounded → buffer.
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).bufferedPressTimerSec).toBeGreaterThan(0)

    // Player keeps the throttle on at race speed; vy drops (wave crest
    // passes) but the bike doesn't actually leave the ground — the
    // "rides the wave through the crest" case that used to silently
    // eat the press. Tick past the buffer window; the climb context is
    // still recent enough (vyPeak hasn't gone stale) so the system
    // synthesizes the trick fire on the expiry tick.
    setIntent({ throttle: 0.9, trickRight: false })
    body.vy = 0
    const ticksToRunOut = Math.ceil(PRE_PRESS_BUFFER_SEC / phys.fixedDt) + 1
    for (let i = 0; i < ticksToRunOut; i++) trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.bufferedPressTimerSec).toBe(0)
    expect(trick.bufferedPressDir).toBe(0)
    // Persistent reward markers — `trickFiredThisTick` is a one-shot
    // edge consumed by the very next tick's top-of-loop reset, so we
    // assert against the sticky flags + the captured direction /
    // strength which both persist until the next press.
    expect(trick.trickFiredThisAirborne).toBe(true)
    expect(trick.trickFiredDirection).toBe(+1)
    expect(trick.trickFiredStrength).toBeGreaterThan(0)
    expect(trick.trickWindowOpen).toBe(true)
    // Deferred-takeoff path lifts the bike with the small-hop impulse
    // and engages the hop-lockout — the lift came from the system, not
    // the surface, so the resulting airborne transition must not
    // re-qualify as a free credible takeoff on the very next tick.
    expect(body.impulses.length).toBeGreaterThanOrEqual(1)
    const lastImpulse = body.impulses[body.impulses.length - 1]
    expect(lastImpulse?.y).toBeCloseTo(4.5, 5)
    expect(trick.hopLockoutActive).toBe(true)
  })

  it('falls back to a courtesy small hop when the climb context decays before expiry', () => {
    const { eid, setIntent } = spawnBike(sim, handle)
    body.vx = 22
    body.vy = 5
    setIntent({ throttle: 0.9 })
    trickHopSystem(sim, phys)
    setIntent({ throttle: 0.9, trickRight: true })
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(eid).bufferedPressTimerSec).toBeGreaterThan(0)

    // Player lets off the throttle — `throttleOK` is now false, so the
    // expiry credibility re-check fails and the fallback fires.
    setIntent({ throttle: 0, trickRight: false })
    body.vy = 0
    const ticksToRunOut = Math.ceil(PRE_PRESS_BUFFER_SEC / phys.fixedDt) + 1
    for (let i = 0; i < ticksToRunOut; i++) trickHopSystem(sim, phys)

    const trick = TrickStateStore.must(eid)
    expect(trick.bufferedPressTimerSec).toBe(0)
    expect(trick.bufferedPressDir).toBe(0)
    expect(trick.trickFiredThisTick).toBe(false)
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
    const lowFired = runQualifyingTakeoff(minVy)
    const highFired = runQualifyingTakeoff(highVy)
    expect(highFired).toBeGreaterThan(lowFired)
    expect(lowFired).toBeGreaterThan(0)
    expect(highFired).toBeCloseTo(1, 2)
  })
})

function runQualifyingTakeoff(takeoffVy: number): number {
  const sim = createSimWorld({ seed: 1 })
  const body: BodyState = { vx: 22, vy: takeoffVy, vz: 0, impulses: [] }
  const m = makeMockPhys(body)
  const { eid, setIntent } = spawnBike(sim, m.bodyHandle)
  setIntent({ throttle: 0.9 })
  trickHopSystem(sim, m.phys)
  HoverStateStore.must(eid).isGrounded = false
  trickHopSystem(sim, m.phys)
  setIntent({ throttle: 0.9, trickRight: true })
  trickHopSystem(sim, m.phys)
  return TrickStateStore.must(eid).trickFiredStrength
}
