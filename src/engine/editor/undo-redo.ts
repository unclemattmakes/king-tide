/**
 * Undo stack for the track editor.
 *
 * Snapshots of the draft are pushed before every "commit-worthy" mutation
 * (placement, delete, gizmo drag start). `tryUndo` pops + restores.
 *
 * Restoration mutates the draft in place so any external references (e.g.
 * the helpers map's entityKey lookups) stay valid. The caller passes a
 * `rebuild` callback that's invoked after the in-place restore so it can
 * re-derive helpers / panel state.
 *
 * Extracted from `track-editor.ts` so the orchestrator stays focused on
 * gizmo + I/O wiring.
 */

import type { Track } from '@/game/tracks/types'

const UNDO_LIMIT = 50

export type UndoStack = {
  push(): void
  tryUndo(): boolean
  /** Approximate dirty check: any snapshot has been pushed since the last
   *  `markSaved()`. Close enough for an authoring tool — avoids deep-diffs. */
  isDirty(): boolean
  /** Call after a successful save so subsequent `isDirty()` checks return
   *  false until the next mutation. */
  markSaved(): void
  /** Current depth — exposed for status messages like "Undid (N more)". */
  depth(): number
}

export function createUndoStack(draft: Track, rebuild: () => void): UndoStack {
  const stack: string[] = []
  let savedAtDepth = 0

  function push(): void {
    stack.push(JSON.stringify(draft))
    if (stack.length > UNDO_LIMIT) stack.shift()
  }

  function tryUndo(): boolean {
    const snap = stack.pop()
    if (!snap) return false
    const restored = JSON.parse(snap) as Track
    // Generic in-place full restore: drop every own key of `draft`, then copy
    // all keys from the snapshot. This keeps the SAME `draft` object reference
    // (the helpers map, the panel, and the save path all close over it) while
    // covering EVERY field — including the optional blocks the editor now
    // authors (sky, horizon, terrainShader, waveZones, waveStamps, audio,
    // gateSpacing, floatGates, …). A hand-maintained field list silently fails
    // to revert anything it forgets, so we restore the whole object instead.
    const d = draft as unknown as Record<string, unknown>
    for (const k of Object.keys(d)) delete d[k]
    Object.assign(d, restored)
    // Invariant the rest of the editor relies on: `props` is always an array.
    if (!Array.isArray(draft.props)) draft.props = []
    rebuild()
    return true
  }

  function isDirty(): boolean {
    return stack.length > savedAtDepth
  }

  function markSaved(): void {
    savedAtDepth = stack.length
  }

  function depth(): number {
    return stack.length
  }

  return { push, tryUndo, isDirty, markSaved, depth }
}
