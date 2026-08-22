/**
 * BoostEffect merge — the single implementation of the "stronger
 * multiplier wins, longer remaining wins, never downgrade" stacking
 * rule shared by every BoostEffect source: boost pads
 * (`boost-pad.ts`), drift mini-turbo releases (`drift.ts`), and
 * clean-jump auto-vents (`launch-grade.ts`). The rule is
 * gameplay-balance-critical — pad-into-drift-into-jump only behaves
 * uniformly (and deterministically across player + AI) while all
 * sources share one merge — so it lives here instead of being
 * repeated per system.
 *
 * Semantics: a stronger incoming multiplier upgrades an active effect;
 * a weaker one leaves it intact; durations never stack — the longer of
 * (remaining, incoming) survives.
 */

import { addComponent } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BoostEffect, BoostEffectStore } from '@/game/components/pickup'

export function mergeBoostEffect(
  sim: SimWorld,
  eid: number,
  multiplier: number,
  durationS: number,
): void {
  if (!BoostEffectStore.has(eid)) addComponent(sim, eid, BoostEffect)
  const current = BoostEffectStore.get(eid)
  const useMultiplier =
    current && current.remaining > 0 ? Math.max(current.multiplier, multiplier) : multiplier
  const useRemaining = current && current.remaining > durationS ? current.remaining : durationS
  BoostEffectStore.set(eid, { remaining: useRemaining, multiplier: useMultiplier })
}
