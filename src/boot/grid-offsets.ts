/**
 * AI starting-grid offsets — typed adapter over `specs/grid-offsets.json`.
 *
 * Single source of truth for the runtime (this module is imported by
 * `spawn-bikes.ts`) and the Blender-side racer-at-start preview (the
 * addon reads the same JSON via Python). When changing values, edit the
 * JSON, not this file.
 */

import gridOffsetsJson from '../../specs/grid-offsets.json' with { type: 'json' }

export type AiSlot = {
  /** Offset along world +X from the player start position (metres). */
  dx: number
  /** Offset along world +Z from the player start position (metres). */
  dz: number
  /** Lateral racing-line bias the AI controller holds, in metres. */
  lineOffset: number
}

const slotsRaw = (gridOffsetsJson as { slots: AiSlot[] }).slots
if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) {
  throw new Error('grid-offsets: specs/grid-offsets.json must have a non-empty `slots` array')
}

/** AI starting-grid slots, ordered. Slot 0 is the closest-to-player slot. */
export const AI_GRID_SLOTS: readonly AiSlot[] = Object.freeze(
  slotsRaw.map((s) => ({ dx: s.dx, dz: s.dz, lineOffset: s.lineOffset })),
)
