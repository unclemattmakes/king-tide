/**
 * Type declarations for the JS-side QA matrix. The matrix lives in
 * `matrix.mjs` so the orchestrator (`runner.mjs`) can import it
 * without a build step; this file gives Playwright specs a typed
 * surface for the same source.
 */

export type QaBikeId = 'cruiser' | 'racer' | 'stunt'

export interface QaPerfBudget {
  fpsFloor?: number
  p95CeilingMs?: number
  /** Per-cell boot ceiling (ms to `__hover.ready`). Falls back to
   *  `GLOBAL_PERF_BUDGET.bootMsCeiling`. */
  bootMs?: number
}

export interface QaCell {
  id: string
  bike: QaBikeId
  enabled: boolean
  perfBudget?: QaPerfBudget
  note?: string
}

export interface QaSoakCell {
  id: string
  bike: QaBikeId
  durationSec: number
}

export const GLOBAL_PERF_BUDGET: Readonly<{
  fpsFloor: number
  p95CeilingMs: number
  bootMsCeiling: number
}>
export const QA_MATRIX: readonly QaCell[]
export const SOAK_TRACKS: readonly QaSoakCell[]
export function enabledCells(): QaCell[]
