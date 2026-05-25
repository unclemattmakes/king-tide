import { addComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  ControlIntent,
  type ControlIntentData,
  ControlIntentStore,
  DriftState,
  type DriftStateData,
  DriftStateStore,
  HoverState,
  type HoverStateData,
  HoverStateStore,
} from '@/game/components'
import { BoostEffect, BoostEffectStore } from '@/game/components/pickup'
import { driftBoostParams, tierFor } from './drift-tiers'

/**
 * Mario-Kart-style mini-turbo drift system. See
 * [docs/drift-deep-dive.md](../../../docs/drift-deep-dive.md) and
 * [ADR 0005](../../../docs/adr/0005-drift-mechanic.md).
 *
 * The control surface overloads the existing trick buttons:
 *   - Tap Z (trickLeft) / C (trickRight) → existing trick / small hop.
 *   - HOLD Z or C while grounded + steering into the matching
 *     direction → drift in that direction.
 *   - Release the held button → fire a mini-turbo `BoostEffect` whose
 *     strength depends on how long the drift charged.
 *
 * Per bike, per fixed tick:
 *   1. Decay `sinceReleaseS`; clear the one-shot `releasedThisTick` flag.
 *   2. If currently drifting:
 *        - Check cancel conditions (button released, ungrounded too
 *          long, brake held). On cancel, fire the boost iff
 *          `highestTier > 0` and reset.
 *        - Otherwise, charge if committed-steer + grounded; update the
 *          highest tier reached.
 *   3. Else (idle):
 *        - Detect a held button + grounded + committed steer + past
 *          cooldown → enter drift state.
 *
 * The system never applies its own torques or impulses — `hover.ts`
 * reads `DriftState.driftDir` and modulates the ground-branch lateral
 * drag + yaw torque. This keeps the physics modulation co-located
 * with the rest of the bike's ground feel.
 */

// ============================================================================
// Tuning constants — exported for the unit test suite + the design doc
// ============================================================================

// The charge curve + boost payloads (`tierFor`, `driftBoostParams`, and
// the TIER_*/DRIFT_BOOST_* constants) live in the dependency-free
// ./drift-tiers leaf so the making-of demo can import them without
// pulling in this module's ECS graph. `driftSystem` uses tierFor /
// driftBoostParams (imported above); everything is re-exported here so
// existing call sites + the unit test keep importing from this module.
export {
  DRIFT_BOOST_DURATION_T1,
  DRIFT_BOOST_DURATION_T2,
  DRIFT_BOOST_DURATION_T3,
  DRIFT_BOOST_MUL_T1,
  DRIFT_BOOST_MUL_T2,
  DRIFT_BOOST_MUL_T3,
  driftBoostParams,
  TIER_1_THRESHOLD_S,
  TIER_2_THRESHOLD_S,
  TIER_3_THRESHOLD_S,
  tierFor,
} from './drift-tiers'

/** Seconds the player must wait after releasing a drift before a new
 *  drift can activate. Stops re-press snake — combined with the
 *  TIER_1 floor, charging two MTs requires distinct corners. */
export const DRIFT_COOLDOWN_S = 0.25

/** Tolerated ungrounded time (s) inside an active drift before it
 *  cancels. Brief probe-jitter from lumpy terrain mustn't kill a
 *  drift; ramping off a clean lip should. */
export const UNGROUNDED_CANCEL_S = 0.3

/** Recovery rate (×dt) for `ungroundedDuringDriftS` once the bike is
 *  grounded again — so a flicker doesn't permanently bias the counter. */
export const GROUNDED_RECOVERY_RATE = 2.0

/** Minimum |steer| magnitude for "committed" — below this, the
 *  player isn't actually steering into the corner. */
export const STEER_COMMIT_THRESHOLD = 0.1

/** Brake input above this cancels the drift (player slams brakes). */
export const BRAKE_CANCEL_THRESHOLD = 0.5

// ============================================================================
// Pure helpers — load-bearing for the unit-test suite
// ============================================================================

/** Test whether the player's intent + hover state would START a drift
 *  this tick. Pure — no side effects. Used in `driftSystem` AND in
 *  the unit test, so the threshold semantics are pinned in one place.
 *
 *  Activation requires: a single trick button held (not both), the
 *  bike grounded, the player's steer committed in the matching
 *  direction, and the post-release cooldown elapsed. */
export function shouldStartDrift(
  intent: ControlIntentData,
  hover: HoverStateData,
  sinceReleaseS: number,
): { dir: -1 | 1 } | null {
  if (!hover.isGrounded) return null
  if (sinceReleaseS < DRIFT_COOLDOWN_S) return null
  const heldLeft = intent.trickLeft && !intent.trickRight
  const heldRight = intent.trickRight && !intent.trickLeft
  if (!heldLeft && !heldRight) return null
  const dir: -1 | 1 = heldLeft ? -1 : 1
  if (Math.sign(intent.steer) !== dir) return null
  if (Math.abs(intent.steer) < STEER_COMMIT_THRESHOLD) return null
  return { dir }
}

/** Test whether an active drift should END this tick, and why. Pure.
 *  Returns the cancel reason or null if drift should continue. */
export function shouldEndDrift(
  intent: ControlIntentData,
  state: DriftStateData,
): 'released' | 'braked' | 'ungrounded' | null {
  if (state.driftDir === 0) return null
  // Button-release cancel — drift only persists while the matching
  // button is held. Pressing the OPPOSITE button is treated the same
  // way as releasing (an unambiguous "cancel" gesture; the player
  // can re-press into a fresh drift on the next tick).
  const stillHeld =
    state.driftDir === -1
      ? intent.trickLeft && !intent.trickRight
      : intent.trickRight && !intent.trickLeft
  if (!stillHeld) return 'released'
  if (intent.brake > BRAKE_CANCEL_THRESHOLD) return 'braked'
  if (state.ungroundedDuringDriftS > UNGROUNDED_CANCEL_S) return 'ungrounded'
  return null
}

// ============================================================================
// Main system
// ============================================================================

export function driftSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [BikeTag, ControlIntent, HoverState, DriftState])
  for (const eid of eids) {
    const intent = ControlIntentStore.must(eid)
    const hover = HoverStateStore.must(eid)
    const state = DriftStateStore.must(eid)

    // Clear the one-shot release flag from last tick — render reads it
    // the same frame it's set, so by the next sim tick the edge is stale.
    state.releasedThisTick = false

    // Edge-detect bookkeeping. The drift activation / cancel checks
    // below only need the held-state booleans, but tracking the
    // previous-tick state lets a future tutorial / accessibility hint
    // detect a fresh press vs sustained hold without re-querying.
    state.prevLeftDown = intent.trickLeft
    state.prevRightDown = intent.trickRight

    // Tick the post-release cooldown forward.
    state.sinceReleaseS += dt

    if (state.driftDir !== 0) {
      // ── Active drift ────────────────────────────────────────────
      // Track ungrounded time first so shouldEndDrift sees a fresh value.
      if (!hover.isGrounded) {
        state.ungroundedDuringDriftS += dt
      } else if (state.ungroundedDuringDriftS > 0) {
        state.ungroundedDuringDriftS = Math.max(
          0,
          state.ungroundedDuringDriftS - dt * GROUNDED_RECOVERY_RATE,
        )
      }

      const cancelReason = shouldEndDrift(intent, state)
      if (cancelReason) {
        // Release: fire boost if any tier was charged.
        if (state.highestTier > 0) {
          fireMiniTurbo(sim, eid, state.highestTier)
          state.releasedThisTick = true
          state.releasedTier = state.highestTier
        }
        state.driftDir = 0
        state.chargeS = 0
        state.highestTier = 0
        state.ungroundedDuringDriftS = 0
        state.sinceReleaseS = 0
        continue
      }

      // Charge accumulator. Only ticks when the player is committed —
      // counter-steering pauses the charge but doesn't cancel the drift.
      const committed =
        Math.sign(intent.steer) === state.driftDir &&
        Math.abs(intent.steer) >= STEER_COMMIT_THRESHOLD
      if (committed && hover.isGrounded) {
        state.chargeS += dt
        const tier = tierFor(state.chargeS)
        if (tier > state.highestTier) state.highestTier = tier
      }
      continue
    }

    // ── Idle — check activation ───────────────────────────────────
    const start = shouldStartDrift(intent, hover, state.sinceReleaseS)
    if (start) {
      state.driftDir = start.dir
      state.chargeS = 0
      state.highestTier = 0
      state.ungroundedDuringDriftS = 0
    }
  }
}

/**
 * Apply a mini-turbo as a `BoostEffect`. Stacks with existing boosts via
 * `boost-pad.ts`'s "stronger wins, longer duration wins" merge rule, so
 * a drift release into a boost pad cleanly extends the pad's effect
 * without prematurely truncating it.
 */
function fireMiniTurbo(sim: SimWorld, eid: number, tier: number): void {
  const params = driftBoostParams(tier)
  if (!params) return
  if (!BoostEffectStore.has(eid)) addComponent(sim, eid, BoostEffect)
  const current = BoostEffectStore.get(eid)
  const multiplier =
    current && current.remaining > 0
      ? Math.max(current.multiplier, params.multiplier)
      : params.multiplier
  const remaining =
    current && current.remaining > params.durationS ? current.remaining : params.durationS
  BoostEffectStore.set(eid, { remaining, multiplier })
}
