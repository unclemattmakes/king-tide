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
    // Mutate draft fields in-place so any external references stay valid.
    draft.id = restored.id
    draft.name = restored.name
    draft.lapsToFinish = restored.lapsToFinish
    draft.start = restored.start
    draft.checkpoints = restored.checkpoints
    draft.aiSplines = restored.aiSplines
    draft.pickupSpawns = restored.pickupSpawns
    draft.boostPads = restored.boostPads
    draft.antiGravZones = Array.isArray(restored.antiGravZones) ? restored.antiGravZones : []
    draft.props = Array.isArray(restored.props) ? restored.props : []
    if (restored.water) draft.water = restored.water
    if (restored.environmentGlb) draft.environmentGlb = restored.environmentGlb
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
