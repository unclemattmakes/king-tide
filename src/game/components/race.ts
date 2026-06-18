import { createStore } from '@/engine/sim/ecs/store'

/**
 * Race progress for an entity (player or AI). Tracks current lap and the
 * next checkpoint that must be crossed.
 */
export const Racer = { name: 'Racer' as const }
export type RacerData = {
  /** Current lap, 1-indexed. Race finishes when lap > lapsToFinish AND
   *  the finish line (= cp 0) is crossed for the next time. */
  lap: number
  /** Index of the next checkpoint that must be crossed. */
  nextCheckpoint: number
  /** Total checkpoints crossed so far this race (used to compute progress). */
  checkpointsCrossed: number
  /** True once the racer has finished all laps. */
  finished: boolean
  /** Wall-clock seconds since race start (advanced by RaceSystem). */
  raceTime: number
  /** `raceTime` at the most recent checkpoint crossing. Used as the live
   *  standings tie-break: among racers at equal progress, whoever reached
   *  that progress earlier (smaller value) is ahead. Undefined until the
   *  first crossing (start grid). NOT a substitute for `raceTime`, which is
   *  identical for every un-finished racer and so can't break live ties. */
  lastCheckpointTime?: number
  /** Set when the player left the course (crossed the out-of-bounds soft
   *  wall). The run no longer counts — the finish screen records a DNF and
   *  skips ghost / leaderboard saves. Sticky: getting back on course clears
   *  the warning but not the forfeit. Only ever set on the local player by
   *  `outOfBoundsSystem`; always false on AI. */
  forfeited: boolean
}
export const RacerStore = createStore<RacerData>('Racer')
