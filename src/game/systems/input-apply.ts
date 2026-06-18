import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import { emptyIntent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import {
  ControlIntent,
  ControlIntentStore,
  PeerControlled,
  PeerControlledStore,
} from '@/game/components'
import type { SimTuning } from '@/game/sim-step'

// Player-only steer scale. The raw controller signal feels twitchy through
// the chase camera, so the per-peer write attenuates steer before it hits
// the physics step. AI uses the unscaled intent (its PD controller is tuned
// against full-range steer; halving here would make AI sluggish).
//
// With the stickCurve in place (gamepad.ts), the center of the stick is
// already heavily soft-shaped, so this static scale is gentler than the
// old 0.5 — full-stick is closer to what you'd expect on a heavy bike.
const PLAYER_STEER_SCALE = 0.7

/**
 * Player-side release smoothing rates (exponential approach, units 1/s).
 *
 * Modeled after the pitch smoothing in hover.ts (active vs release):
 * pressing the stick chases the target at the ACTIVE rate (snappy), letting
 * go decays at the RELEASE rate (heavy). This is what stops the bike from
 * popping back to neutral the instant the player relaxes their thumb —
 * an arcade-flight feel ported to a hover-bike. AI doesn't go through this
 * function so its intent stays sharp.
 */
const STEER_RATE_ACTIVE = 7
/** Default (loosest) release rate — preserves the historical heavy-decay
 *  feel when `devSettings.steerReleaseTightness === 0`. */
const STEER_RATE_RELEASE = 2.5
/** Release rate the slider reaches just before tightness=1. Past this we
 *  hard-snap (see `applyPeerInputs`) so the player gets a true zero-decay
 *  endpoint instead of an asymptote. ~60 ≈ one-frame collapse at 60Hz. */
const STEER_RATE_RELEASE_MAX = 60
const THROTTLE_RATE_ACTIVE = 9
const THROTTLE_RATE_RELEASE = 3

type Smoothed = { steer: number; throttle: number }
// Per-eid smoothed state for steer / throttle. Lives outside the ECS because
// only PeerControlled (player) bikes route through this function — AI never
// allocates an entry — and because it's pure input-pipeline state, not part
// of the deterministic sim snapshot.
const smoothed = new Map<number, Smoothed>()

// Raw (pre-scale, pre-smoothing) stick steer per peer bike. For systems that
// want the player's DECLARED direction rather than the bike's shaped steering:
// the rider's head-look reads this so the head moves the instant the stick
// does and LEADS the bike, instead of trailing the steer smoothing above.
// Same lifecycle + rationale as `smoothed`.
const rawSteer = new Map<number, number>()

/** The unshaped stick steer for a peer-controlled bike this tick, or
 *  `undefined` for bikes that don't route through `applyPeerInputs` (AI —
 *  whose ControlIntent is already raw — and replay playback). */
export function rawSteerFor(eid: number): number | undefined {
  return rawSteer.get(eid)
}

function approach(current: number, target: number, dt: number, rate: number): number {
  const a = 1 - Math.exp(-rate * dt)
  return current + (target - current) * a
}

/**
 * Write each connected peer's `Intent` into the ControlIntent component of
 * the bike entity tagged with that `peerId`. Bikes without a matching
 * entry get an empty intent — handles the locked-countdown case (caller
 * passes `EMPTY_PEER_INPUTS`) and tolerates packet loss without crashing.
 *
 * Replaces M10.4's `applyPlayerIntent` (single Intent → all PlayerTag bikes).
 * M10.5 split: PlayerTag still flags the local human's bike for camera /
 * HUD / replay code, but the sim dispatches inputs by peer slot via
 * PeerControlled — so a future room with N players sees N independently
 * controlled bikes through this same function with no further changes.
 *
 * Steer is scaled by {@link PLAYER_STEER_SCALE} on the RECEIVING side, not
 * the sending side — the wire format carries raw stick values, so two peers
 * with the same hardware feel the same regardless of who's local vs remote.
 *
 * Steer + throttle also go through asymmetric release smoothing here (see
 * STEER_RATE_*, THROTTLE_RATE_* constants): the bike doesn't snap back to
 * neutral the moment a stick is released, which reads as "heavy" rather
 * than "twitchy." Pitch keeps its own active/release smoothing in the
 * hover system (it had to live there for reasons specific to wave-tracking).
 */
export function applyPeerInputs(
  sim: SimWorld,
  peerInputs: ReadonlyMap<number, Intent>,
  dt: number,
  tuning: SimTuning,
): void {
  const eids = query(sim, [PeerControlled, ControlIntent])
  const seen = new Set<number>()
  for (const eid of eids) {
    seen.add(eid)
    const peer = PeerControlledStore.get(eid)
    if (!peer) continue
    const intent = peerInputs.get(peer.peerId) ?? emptyIntent()
    rawSteer.set(eid, intent.steer)

    const targetSteer = intent.steer * PLAYER_STEER_SCALE
    const targetThrottle = intent.throttle

    let state = smoothed.get(eid)
    if (!state) {
      state = { steer: 0, throttle: 0 }
      smoothed.set(eid, state)
    }

    const steerActive = Math.abs(intent.steer) > 0.02
    const throttleActive = Math.abs(intent.throttle) > 0.02
    if (steerActive) {
      state.steer = approach(state.steer, targetSteer, dt, STEER_RATE_ACTIVE)
    } else {
      // Map tightness 0..1 → release rate. At t≈1 short-circuit to a hard
      // snap so the slider has a true "no decay" endpoint instead of
      // bottoming out at 60/s. Clamped so out-of-range persisted values
      // can't break the math.
      const t = Math.max(0, Math.min(1, tuning.steerReleaseTightness))
      if (t >= 0.999) {
        state.steer = 0
      } else {
        const rate = STEER_RATE_RELEASE + t * (STEER_RATE_RELEASE_MAX - STEER_RATE_RELEASE)
        state.steer = approach(state.steer, 0, dt, rate)
      }
    }
    state.throttle = approach(
      state.throttle,
      targetThrottle,
      dt,
      throttleActive ? THROTTLE_RATE_ACTIVE : THROTTLE_RATE_RELEASE,
    )

    ControlIntentStore.set(eid, {
      ...intent,
      steer: state.steer,
      throttle: state.throttle,
    })
  }
  // Drop state for bikes that no longer exist (between-race teardown,
  // peer dropout). Bounded because the player population per session is
  // tiny, but tidy.
  if (smoothed.size > seen.size) {
    for (const k of smoothed.keys()) if (!seen.has(k)) smoothed.delete(k)
  }
  if (rawSteer.size > seen.size) {
    for (const k of rawSteer.keys()) if (!seen.has(k)) rawSteer.delete(k)
  }
}

/** Pre-allocated empty map for the countdown-lock path so we don't churn
 *  allocations every tick. Frozen as a contract: callers MUST NOT mutate. */
export const EMPTY_PEER_INPUTS: ReadonlyMap<number, Intent> = new Map()
