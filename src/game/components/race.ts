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
}
export const RacerStore = createStore<RacerData>('Racer')
