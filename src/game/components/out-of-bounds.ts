import { createStore } from '@/engine/sim/ecs/store'

/**
 * Out-of-bounds escalation state for the local player's bike. Written by
 * `outOfBoundsSystem` each fixed tick; the render/loop layer reflects it
 * (warning popup, autopilot, shark cutscene) but never owns the transitions.
 *
 * See docs/out-of-bounds-design.md.
 */
export type OobPhase =
  /** Within the leash — nothing to do. */
  | 'in'
  /** Phase 1: past the soft wall. Popup + autopilot + race credit forfeited. */
  | 'warn'
  /** The "incoming" wind-up beat before the attack resolves. */
  | 'brace'
  /** Resolved. The loop plays the consequence (respawn / shark) and then
   *  calls `resolveOob` to return the entity to 'in'. */
  | 'lethal'

/** How a resolved lethal phase reads: 'hit' = caught (respawn / shark eats),
 *  'nearmiss' = recovered in time (no respawn; shark breaches and misses). */
export type OobLethalKind = 'hit' | 'nearmiss'

export const OutOfBounds = { name: 'OutOfBounds' as const }
export type OutOfBoundsData = {
  phase: OobPhase
  /** Seconds left in WARN before escalation. */
  graceRemaining: number
  /** Seconds left in BRACE before the attack resolves. */
  braceRemaining: number
  /** Current 3D distance (m) from the bike to the nearest racing-line sample.
   *  3D so a vertical joyride ("to the moon") trips the same leash. */
  distance: number
  /** Per-track soft / hard leash distances (m). Cached here each tick for the
   *  HUD ring fill and the recovery math. */
  softLeash: number
  hardLeash: number
  /** Low-pass-filtered inward speed (m/s toward the line). Positive = closing
   *  on the racing line. Drives the near-miss test. */
  inwardSpeed: number
  /** Set when the lethal phase resolves: 'hit' or 'nearmiss'. */
  lethalKind: OobLethalKind | null
  /** One-shot edge: true on the tick the phase enters 'lethal'. The loop
   *  consumes it (kicks off the consequence), clears it, and later calls
   *  `resolveOob`. Not auto-cleared by the system, so a multi-step render
   *  frame can't drop the edge. */
  lethalTriggeredThisTick: boolean
}

export const OutOfBoundsStore = createStore<OutOfBoundsData>('OutOfBounds')

export function initialOob(): OutOfBoundsData {
  return {
    phase: 'in',
    graceRemaining: 0,
    braceRemaining: 0,
    distance: 0,
    softLeash: Number.POSITIVE_INFINITY,
    hardLeash: Number.POSITIVE_INFINITY,
    inwardSpeed: 0,
    lethalKind: null,
    lethalTriggeredThisTick: false,
  }
}
