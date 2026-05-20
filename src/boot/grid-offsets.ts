/**
 * AI starting-grid offsets — typed adapter over `specs/grid-offsets.json`.
 *
 * Single source of truth for the runtime (this module is imported by
 * `spawn-bikes.ts`, `attract-mode.ts`, and the in-app editor's
 * start-helper visualization) and the Blender-side racer-at-start
 * preview (the addon reads the same JSON via Python). When changing
 * values, edit the JSON, not this file.
 *
 * Slot offsets are authored in the start's *local* frame (+Z = bike
 * forward, +X = bike right). `resolveGridSlotWorld` and
 * `resolveGridWorldPositions` apply the start yaw + position so callers
 * get world-space coordinates that follow the start gate's facing —
 * rotate the gate and the whole grid swings with it.
 */

import type { Vec3 } from '@/engine/sim/physics/vec'
import gridOffsetsJson from '../../specs/grid-offsets.json' with { type: 'json' }

export type AiSlot = {
  /** Lateral offset in the start's local frame (+X = bike right). */
  dx: number
  /** Longitudinal offset in the start's local frame (+Z = bike forward,
   *  negative = behind). */
  dz: number
  /** Lateral racing-line bias the AI controller holds, in metres. */
  lineOffset: number
}

const slotsRaw = (gridOffsetsJson as { slots: AiSlot[] }).slots
if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) {
  throw new Error('grid-offsets: specs/grid-offsets.json must have a non-empty `slots` array')
}

/** AI starting-grid slots, in spawn order. Slot 0 is the AI closest to
 *  the pole. The player always spawns at the local origin (pole). */
export const AI_GRID_SLOTS: readonly AiSlot[] = Object.freeze(
  slotsRaw.map((s) => ({ dx: s.dx, dz: s.dz, lineOffset: s.lineOffset })),
)

/**
 * Rotate a local (dx, dz) by `yaw` (rotation around +Y, where 0 = facing
 * +Z) and add to the start origin. Bike spawn y is taken from the start
 * (the grid is purely horizontal).
 */
export function resolveGridSlotWorld(origin: Vec3, yaw: number, dx: number, dz: number): Vec3 {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  return {
    x: origin.x + dx * cosY + dz * sinY,
    y: origin.y,
    z: origin.z + -dx * sinY + dz * cosY,
  }
}

/**
 * Resolve every slot (including the implicit pole at index 0) to a
 * world-space position. The returned array always has length
 * `AI_GRID_SLOTS.length + 1`; entry 0 is the player pole, entries 1..N
 * are the AI slots in order. Useful for the editor's grid-platform
 * visualization and for any boot path that wants the full layout in one
 * pass.
 */
export function resolveGridWorldPositions(origin: Vec3, yaw: number): Vec3[] {
  const out: Vec3[] = [{ x: origin.x, y: origin.y, z: origin.z }]
  for (const slot of AI_GRID_SLOTS) {
    out.push(resolveGridSlotWorld(origin, yaw, slot.dx, slot.dz))
  }
  return out
}
