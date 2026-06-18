/**
 * Tiny dependency-free helpers for the button-edge / timer idioms that
 * recur across the feel systems (boost-meter, trick-hop, drift). Keeping
 * them here means one tested definition instead of the same `curr && !prev`
 * and `Math.max(0, x - dt)` open-coded in five places.
 *
 * Pure + deterministic — safe in the sim layer.
 */

/** True only on the tick a button transitions from up → down. */
export function risingEdge(curr: boolean, prev: boolean): boolean {
  return curr && !prev
}

/** True only on the tick a button transitions from down → up. */
export function fallingEdge(curr: boolean, prev: boolean): boolean {
  return !curr && prev
}

/** Decrement a countdown timer toward zero, never going negative. */
export function tickDown(value: number, dt: number): number {
  return value > 0 ? Math.max(0, value - dt) : 0
}
