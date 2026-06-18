import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  BoostMeter,
  BoostMeterStore,
  ControlIntent,
  ControlIntentStore,
} from '@/game/components'
import { risingEdge } from '@/game/systems/edge'

/**
 * Burnout-3-style boost meter.
 *
 * Per bike, per fixed tick:
 *   1. Detect the rising edge of `intent.boost`. Held-down does NOT
 *      auto-re-engage after a drain-empty — the player has to release
 *      and re-press once the meter has recharged.
 *   2. On a fresh press with `charge >= ACTIVATION_THRESHOLD`, flip
 *      `active = true`. Below the threshold the press is a no-op so
 *      you can't fire a one-frame burst from a near-empty meter.
 *   3. While active, drain `charge` at `DRAIN_PER_SEC`. End the boost
 *      when the player releases the button OR the charge hits 0.
 *
 * The hover system reads `active` (replacing the old
 * `intent.boost ? stats.boostMul : 1` gate) so the multiplier only
 * applies while the meter is genuinely engaged.
 *
 * `charge` is filled by successful tricks (see `wave-pump-observer` +
 * the trick-event handler in `game-loop.ts`). Boost pads + pickup-fired
 * boosts continue to use the independent `BoostEffect` mechanism so
 * the legacy power-ups keep their distinct one-shot semantics — pads
 * give a fixed-duration multiplier without touching the meter.
 */

/** Charge cost (sec⁻¹) while boost is active. Full meter ⇒ ~3 s of
 *  sustained boost — long enough to read as a real burst and to
 *  carry the bike through a corner exit before the player has to
 *  refill via another trick. */
const DRAIN_PER_SEC = 1 / 3
/** Minimum charge required to engage the boost. Prevents a one-frame
 *  micro-burst at the bottom of the meter. Also: the player gets a
 *  clear "boost ready" cue at this fill level via the HUD. */
const ACTIVATION_THRESHOLD = 0.1

export function boostMeterSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [BikeTag, ControlIntent, BoostMeter])
  for (const eid of eids) {
    const intent = ControlIntentStore.must(eid)
    const meter = BoostMeterStore.must(eid)

    const pressed = risingEdge(intent.boost, meter.prevBoostDown)
    meter.prevBoostDown = intent.boost

    if (meter.active) {
      meter.charge = Math.max(0, meter.charge - DRAIN_PER_SEC * dt)
      // End conditions: player let go, or meter ran dry. Either way
      // the player has to re-press once the next charge arrives.
      if (!intent.boost || meter.charge <= 0) {
        meter.active = false
      }
    } else if (pressed && meter.charge >= ACTIVATION_THRESHOLD) {
      meter.active = true
    }
  }
}

/**
 * Add `amount` to a bike's boost meter charge (capped at 1.0). Called
 * from the trick-event handler in `game-loop.ts` when a credible trick
 * lands. Returns the new charge — callers can read this to drive
 * "full meter!" flair (e.g., a HUD flash) without re-querying.
 */
export function chargeBoostMeter(eid: number, amount: number): number {
  const meter = BoostMeterStore.get(eid)
  if (!meter) return 0
  meter.charge = Math.max(0, Math.min(1, meter.charge + amount))
  return meter.charge
}
