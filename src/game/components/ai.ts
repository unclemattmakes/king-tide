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
  /**
   * Lateral offset (m) perpendicular to the racing line. Each AI gets a
   * slightly different value so they don't all converge on the same point.
   * Positive = right of travel direction.
   */
  lineOffset: number
}
export const AIControllerStore = createStore<AIControllerData>('AIController')

export function defaultAIController(
  splineId: string,
  opts?: { lineOffset?: number },
): AIControllerData {
  return {
    splineId,
    lastClosestIndex: 0,
    lookAhead: 12,
    topSpeedFactor: 1,
    lineOffset: opts?.lineOffset ?? 0,
  }
}
