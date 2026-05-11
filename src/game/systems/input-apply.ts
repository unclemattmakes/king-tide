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

// Player-only steer scale. The raw controller signal feels twitchy through
// the chase camera, so the per-peer write attenuates steer before it hits
// the physics step. AI uses the unscaled intent (its PD controller is tuned
// against full-range steer; halving here would make AI sluggish).
const PLAYER_STEER_SCALE = 0.5

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
 */
export function applyPeerInputs(sim: SimWorld, peerInputs: ReadonlyMap<number, Intent>): void {
  const eids = query(sim, [PeerControlled, ControlIntent])
  for (const eid of eids) {
    const peer = PeerControlledStore.get(eid)
    if (!peer) continue
    const intent = peerInputs.get(peer.peerId) ?? emptyIntent()
    ControlIntentStore.set(eid, {
      ...intent,
      steer: intent.steer * PLAYER_STEER_SCALE,
    })
  }
}

/** Pre-allocated empty map for the countdown-lock path so we don't churn
 *  allocations every tick. Frozen as a contract: callers MUST NOT mutate. */
export const EMPTY_PEER_INPUTS: ReadonlyMap<number, Intent> = new Map()
