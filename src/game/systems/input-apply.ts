import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { ControlIntent, ControlIntentStore, PlayerTag } from '@/game/components'

export function applyPlayerIntent(sim: SimWorld, intent: Intent): void {
  const eids = query(sim, [PlayerTag, ControlIntent])
  for (const eid of eids) {
    ControlIntentStore.set(eid, { ...intent })
  }
}
