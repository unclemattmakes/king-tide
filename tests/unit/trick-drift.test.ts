/**
 * Post-hop drift (MK8-style mini-turbo) — state machine + payoff tests.
 *
 * The drift activates on the airborne→grounded transition after a hop,
 * provided the same trick button is still held continuously and the
 * player has commit-level steering. While drifting, a charge timer
 * fills; release the button to spend the charge as a `BoostEffect`
 * mini-turbo (two tiers + a no-payoff bail-out).
 *
 * These tests drive `trickHopSystem` directly with hand-rolled
 * HoverState + ControlIntent, skipping the real physics step. We need
 * the rigid body to read mass + apply impulses, so a real
 * PhysicsWorld is used, but airborne/grounded is forced by writing
 * `HoverState.isGrounded` rather than running hoverSystem. That keeps
 * the test self-contained — we're testing the drift state machine,
 * not the surface probe.
 */

import { addComponent, hasComponent } from 'bitecs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld, type PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  ControlIntentStore,
  HoverStateStore,
  RBHandleStore,
  TrickStateStore,
} from '@/game/components'
import { BoostEffect, BoostEffectStore } from '@/game/components/pickup'
import { createBike, createGround } from '@/game/entities/bike'
import {
  DRIFT_STEER_DEADZONE,
  DRIFT_TIER1_SEC,
  DRIFT_TIER2_SEC,
  DRIFT_TURBO_TIER1_DUR,
  DRIFT_TURBO_TIER1_MUL,
  DRIFT_TURBO_TIER2_DUR,
  DRIFT_TURBO_TIER2_MUL,
  driftTier,
  trickHopSystem,
} from '@/game/systems/trick-hop'

async function makeWorlds(): Promise<{ sim: SimWorld; phys: PhysicsWorld; bikeEid: number }> {
  const sim = createSimWorld()
  const phys = await createPhysicsWorld()
  createGround(phys)
  const bikeEid = createBike(sim, phys, {
    position: { x: 0, y: 2, z: 0 },
    yaw: 0,
    isPlayer: true,
  })
  // Default a moving, throttled bike — drift gates on speed + steer
  // and we want the gates open by default.
  const intent = ControlIntentStore.must(bikeEid)
  intent.throttle = 1
  intent.steer = 0.8 // right turn, well above DRIFT_STEER_DEADZONE
  // Inject a forward-X linvel so the speed gate (>= DRIFT_MIN_SPEED) passes.
  const rb = phys.world.getRigidBody(RBHandleStore.must(bikeEid).handle)
  if (!rb) throw new Error('test bike has no rigid body')
  rb.setLinvel({ x: 15, y: 0, z: 0 }, true)
  return { sim, phys, bikeEid }
}

function press(bikeEid: number, btn: 'left' | 'right'): void {
  const intent = ControlIntentStore.must(bikeEid)
  intent.trickLeft = btn === 'left'
  intent.trickRight = btn === 'right'
}

function setGrounded(bikeEid: number, grounded: boolean): void {
  const hover = HoverStateStore.must(bikeEid)
  hover.isGrounded = grounded
}

/**
 * Drive the system through a full hop → land → drift charge sequence.
 * Returns the bike's TrickState after the requested number of charge
 * ticks. The bike is on the ground for the press tick, airborne for
 * the next tick (simulating the hop arc), then grounded again to
 * trigger the drift handoff, then `chargeTicks` of grounded drift.
 *
 * NOTE: this helper RESETS linvel to a held-cruise value each sustain
 * tick. Without a `phys.step()` (we don't run one — we're testing the
 * state machine, not full physics) the bike's velocity isn't
 * integrated, and the drift outward-push impulse linearly bleeds
 * linvel until the speed-gate trips a false break. Real gameplay
 * doesn't see this because hoverSystem re-applies forward thrust
 * each tick. Mirroring that here with a manual linvel reset keeps
 * the drift state machine the only thing under test.
 */
function hopThenDrift(
  sim: SimWorld,
  phys: PhysicsWorld,
  bikeEid: number,
  btn: 'left' | 'right',
  chargeTicks: number,
  heldLinvel: { x: number; y: number; z: number } = { x: 15, y: 0, z: 0 },
): void {
  const handle = RBHandleStore.must(bikeEid).handle
  const rb = phys.world.getRigidBody(handle)
  if (!rb) throw new Error('test bike has no rigid body')
  // Tick 0: press button while grounded → hop fires, lockout engages.
  setGrounded(bikeEid, true)
  press(bikeEid, btn)
  rb.setLinvel(heldLinvel, true)
  trickHopSystem(sim, phys)
  // Tick 1: airborne — lockout sees the air transition.
  setGrounded(bikeEid, false)
  rb.setLinvel(heldLinvel, true)
  trickHopSystem(sim, phys)
  // Tick 2: grounded again → drift handoff fires.
  setGrounded(bikeEid, true)
  rb.setLinvel(heldLinvel, true)
  trickHopSystem(sim, phys)
  // Subsequent ticks: drift sustain (button stays held).
  for (let i = 0; i < chargeTicks; i++) {
    rb.setLinvel(heldLinvel, true)
    trickHopSystem(sim, phys)
  }
}

describe('post-hop drift state machine', () => {
  let sim: SimWorld
  let phys: PhysicsWorld
  let bikeEid: number

  beforeEach(async () => {
    const w = await makeWorlds()
    sim = w.sim
    phys = w.phys
    bikeEid = w.bikeEid
  })

  it('arms driftArmedButton on a hop press', () => {
    setGrounded(bikeEid, true)
    press(bikeEid, 'right')
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftArmedButton).toBe(1)
    expect(trick.hopLockoutActive).toBe(true)
  })

  it('left button arms with -1', () => {
    setGrounded(bikeEid, true)
    press(bikeEid, 'left')
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(bikeEid).driftArmedButton).toBe(-1)
  })

  it('both buttons same tick — no drift arming (reserved for barrel roll)', () => {
    setGrounded(bikeEid, true)
    const intent = ControlIntentStore.must(bikeEid)
    intent.trickLeft = true
    intent.trickRight = true
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(bikeEid).driftArmedButton).toBe(0)
  })

  it('activates drift on landing when button is still held with committed steer', () => {
    hopThenDrift(sim, phys, bikeEid, 'right', 0)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(true)
    expect(trick.driftDirection).toBe(1) // matches positive steer
    // The activation tick falls through to the sustain branch (which
    // increments chargeSec by dt) once driftActive flips true mid-tick.
    // That's by design — no point holding chargeSec at 0 for one tick
    // when the player has already committed.
    expect(trick.driftChargeSec).toBeCloseTo(phys.fixedDt, 5)
  })

  it('drift direction tracks steer sign at landing', () => {
    const intent = ControlIntentStore.must(bikeEid)
    intent.steer = -0.7 // left
    hopThenDrift(sim, phys, bikeEid, 'right', 0)
    expect(TrickStateStore.must(bikeEid).driftDirection).toBe(-1)
  })

  it('does NOT activate when the player released the button before landing', () => {
    setGrounded(bikeEid, true)
    press(bikeEid, 'right')
    trickHopSystem(sim, phys)
    setGrounded(bikeEid, false)
    // Mid-air release.
    press(bikeEid, 'right')
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    setGrounded(bikeEid, true)
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    expect(trick.driftArmedButton).toBe(0)
  })

  it('does NOT activate when steer is below the deadzone', () => {
    const intent = ControlIntentStore.must(bikeEid)
    intent.steer = DRIFT_STEER_DEADZONE - 0.1
    hopThenDrift(sim, phys, bikeEid, 'right', 0)
    expect(TrickStateStore.must(bikeEid).driftActive).toBe(false)
  })

  it('does NOT activate when the bike is too slow', () => {
    // Below DRIFT_MIN_SPEED — drift should reject the handoff.
    hopThenDrift(sim, phys, bikeEid, 'right', 0, { x: 2, y: 0, z: 0 })
    expect(TrickStateStore.must(bikeEid).driftActive).toBe(false)
  })

  it('charges driftChargeSec by fixedDt each sustain tick', () => {
    hopThenDrift(sim, phys, bikeEid, 'right', 6)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(true)
    // The activation tick falls through to sustain and adds 1 dt, then
    // each of the 6 explicit sustain ticks adds another dt → 7 total.
    expect(trick.driftChargeSec).toBeCloseTo(7 * phys.fixedDt, 5)
  })

  it('clean release below tier-1 awards no boost', () => {
    // Charge for just ~0.5s (below DRIFT_TIER1_SEC = 1.0).
    const ticks = Math.floor(0.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    // Release.
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    // No BoostEffect awarded.
    expect(hasComponent(sim, bikeEid, BoostEffect)).toBe(false)
    // driftReleaseSerial doesn't bump for sub-tier releases (would
    // fire FX for nothing).
    expect(trick.driftReleaseTier).toBe(0)
  })

  it('clean release in tier-1 band awards the small mini-turbo', () => {
    // Charge for ~1.5s (between TIER1=1.0 and TIER2=2.4).
    const ticks = Math.floor(1.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    const beforeSerial = TrickStateStore.must(bikeEid).driftReleaseSerial
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    // BoostEffect attached with tier-1 parameters.
    expect(hasComponent(sim, bikeEid, BoostEffect)).toBe(true)
    const boost = BoostEffectStore.must(bikeEid)
    expect(boost.multiplier).toBe(DRIFT_TURBO_TIER1_MUL)
    expect(boost.remaining).toBe(DRIFT_TURBO_TIER1_DUR)
    // Release tier signal set; serial bumped.
    expect(trick.driftReleaseTier).toBe(1)
    expect(trick.driftReleaseSerial).toBe((beforeSerial + 1) >>> 0)
  })

  it('clean release in tier-2 band awards the bigger mini-turbo', () => {
    // Charge for ~3s — well past DRIFT_TIER2_SEC = 2.4.
    const ticks = Math.floor(3.0 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    expect(trick.driftReleaseTier).toBe(2)
    const boost = BoostEffectStore.must(bikeEid)
    expect(boost.multiplier).toBe(DRIFT_TURBO_TIER2_MUL)
    expect(boost.remaining).toBe(DRIFT_TURBO_TIER2_DUR)
  })

  it('release-tier signal clears on the next sim tick', () => {
    const ticks = Math.floor(1.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(bikeEid).driftReleaseTier).toBe(1)
    // Next tick should clear the one-shot signal so a render frame
    // that runs zero sim steps doesn't see a stale value re-fire FX.
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(bikeEid).driftReleaseTier).toBe(0)
    // Serial does NOT decrement — render side keys off "did this change
    // since I last looked" not "is the tier non-zero".
    expect(TrickStateStore.must(bikeEid).driftReleaseSerial).toBe(1)
  })

  it('going airborne mid-drift breaks without payoff', () => {
    const ticks = Math.floor(1.5 / phys.fixedDt) // would be tier-1 if released cleanly
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    expect(TrickStateStore.must(bikeEid).driftActive).toBe(true)
    // Force airborne — drift should break with no payoff.
    setGrounded(bikeEid, false)
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    expect(trick.driftReleaseTier).toBe(0)
    expect(hasComponent(sim, bikeEid, BoostEffect)).toBe(false)
  })

  it('hard opposite-steer mid-drift breaks without payoff', () => {
    const ticks = Math.floor(1.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    expect(TrickStateStore.must(bikeEid).driftDirection).toBe(1)
    // Jam left stick the other way — should cancel.
    ControlIntentStore.must(bikeEid).steer = -0.9
    trickHopSystem(sim, phys)
    const trick = TrickStateStore.must(bikeEid)
    expect(trick.driftActive).toBe(false)
    expect(trick.driftReleaseTier).toBe(0)
    expect(hasComponent(sim, bikeEid, BoostEffect)).toBe(false)
  })

  it('feathered opposite-steer below the break threshold does NOT cancel', () => {
    const ticks = Math.floor(0.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    // Light opposite touch — well below DRIFT_OPPOSITE_STEER_BREAK.
    ControlIntentStore.must(bikeEid).steer = -0.2
    trickHopSystem(sim, phys)
    expect(TrickStateStore.must(bikeEid).driftActive).toBe(true)
  })

  it('drift release stacks with an existing BoostEffect — takes the longer + stronger', () => {
    // Pre-populate a weak/long pickup boost. addComponent first so the
    // store entry actually attaches (createStore.set without an
    // existing component is a no-op for has-tag-guarded callers).
    if (!hasComponent(sim, bikeEid, BoostEffect)) {
      addComponent(sim, bikeEid, BoostEffect)
    }
    BoostEffectStore.set(bikeEid, { remaining: 5, multiplier: 1.2 })
    const ticks = Math.floor(1.5 / phys.fixedDt)
    hopThenDrift(sim, phys, bikeEid, 'right', ticks)
    ControlIntentStore.must(bikeEid).trickRight = false
    trickHopSystem(sim, phys)
    const boost = BoostEffectStore.must(bikeEid)
    // Drift multiplier (1.45) wins; pickup duration (5s) wins.
    expect(boost.multiplier).toBeCloseTo(DRIFT_TURBO_TIER1_MUL, 5)
    expect(boost.remaining).toBe(5)
  })
})

describe('drift activates without an airborne phase (flat-ground hop)', () => {
  it('activates on the first grounded tick after press when button + steer held', async () => {
    // The bike never goes airborne — a small flatground hop's 4.5 m/s
    // impulse doesn't always clear the hover spring's grounded
    // threshold. Drift must still engage so MK8-style "press hop +
    // hold for drift on flat road" works.
    const w = await makeWorlds()
    const intent = ControlIntentStore.must(w.bikeEid)
    intent.throttle = 1
    intent.steer = 0.8
    intent.trickRight = true

    // Tick 0: press while grounded → hop fires, drift armed, but
    // safety-ticks gate blocks same-tick activation.
    setGrounded(w.bikeEid, true)
    trickHopSystem(w.sim, w.phys)
    expect(TrickStateStore.must(w.bikeEid).driftArmedButton).toBe(1)
    expect(TrickStateStore.must(w.bikeEid).driftActive).toBe(false)

    // Tick 1: still grounded (small hop, never left), button still
    // held → drift should activate.
    const rb = w.phys.world.getRigidBody(RBHandleStore.must(w.bikeEid).handle)
    if (!rb) throw new Error('bike rb missing')
    rb.setLinvel({ x: 15, y: 0, z: 0 }, true)
    trickHopSystem(w.sim, w.phys)
    expect(TrickStateStore.must(w.bikeEid).driftActive).toBe(true)
    expect(TrickStateStore.must(w.bikeEid).driftDirection).toBe(1)
  })

  it('keeps the arm pending while the player drives straight, activates when they steer in', async () => {
    // The player can press hop and hold the button while approaching
    // a corner without committing steer yet — drift activates the
    // moment they start the turn, not at the hop press.
    const w = await makeWorlds()
    const intent = ControlIntentStore.must(w.bikeEid)
    intent.throttle = 1
    intent.steer = 0 // no commit yet
    intent.trickRight = true

    const rb = w.phys.world.getRigidBody(RBHandleStore.must(w.bikeEid).handle)
    if (!rb) throw new Error('bike rb missing')

    setGrounded(w.bikeEid, true)
    trickHopSystem(w.sim, w.phys) // press tick
    // Drive straight for a few ticks — drift stays armed but inactive.
    for (let i = 0; i < 5; i++) {
      rb.setLinvel({ x: 15, y: 0, z: 0 }, true)
      trickHopSystem(w.sim, w.phys)
    }
    expect(TrickStateStore.must(w.bikeEid).driftArmedButton).toBe(1)
    expect(TrickStateStore.must(w.bikeEid).driftActive).toBe(false)

    // Now steer in — drift should engage next tick.
    intent.steer = 0.9
    rb.setLinvel({ x: 15, y: 0, z: 0 }, true)
    trickHopSystem(w.sim, w.phys)
    expect(TrickStateStore.must(w.bikeEid).driftActive).toBe(true)
    expect(TrickStateStore.must(w.bikeEid).driftDirection).toBe(1)
  })
})

describe('driftTier classification', () => {
  it('zero for sub-tier-1 charge', () => {
    expect(driftTier(0)).toBe(0)
    expect(driftTier(DRIFT_TIER1_SEC - 0.01)).toBe(0)
  })

  it('one at the tier-1 boundary', () => {
    expect(driftTier(DRIFT_TIER1_SEC)).toBe(1)
    expect(driftTier((DRIFT_TIER1_SEC + DRIFT_TIER2_SEC) / 2)).toBe(1)
    expect(driftTier(DRIFT_TIER2_SEC - 0.01)).toBe(1)
  })

  it('two at the tier-2 boundary', () => {
    expect(driftTier(DRIFT_TIER2_SEC)).toBe(2)
    expect(driftTier(DRIFT_TIER2_SEC + 5)).toBe(2)
  })
})
