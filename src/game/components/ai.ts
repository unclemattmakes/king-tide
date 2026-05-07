import { createStore } from '@/engine/sim/ecs/store'

export const AITag = { name: 'AITag' as const }

/**
 * Per-AI controller state. The system reads the spline by id from the active
 * track each tick — keeping the spline OUT of the component so we don't
 * duplicate state.
 */
export const AIController = { name: 'AIController' as const }
export type AIControllerData = {
  /** Which AI spline to follow. */
  splineId: string
  /** Cached index of the closest spline point — speeds up the next tick's search. */
  lastClosestIndex: number
  /** Look-ahead distance along the spline, meters. */
  lookAhead: number
  /** Desired top-speed factor (mutated by rubber-band). */
  topSpeedFactor: number
}
export const AIControllerStore = createStore<AIControllerData>('AIController')

export function defaultAIController(splineId: string): AIControllerData {
  return {
    splineId,
    lastClosestIndex: 0,
    lookAhead: 12,
    topSpeedFactor: 1,
  }
}
