import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { ControlIntent, ControlIntentStore, PlayerTag } from '@/game/components'

// Player-only steer scale. The raw controller signal feels twitchy through
// the chase camera, so the player path attenuates steer before it hits the
// physics step. AI uses the unscaled intent (its PD controller is tuned
// against full-range steer; halving here would make AI sluggish).
const PLAYER_STEER_SCALE = 0.5

export function applyPlayerIntent(sim: SimWorld, intent: Intent): void {
  const eids = query(sim, [PlayerTag, ControlIntent])
  for (const eid of eids) {
    ControlIntentStore.set(eid, { ...intent, steer: intent.steer * PLAYER_STEER_SCALE })
  }
}
