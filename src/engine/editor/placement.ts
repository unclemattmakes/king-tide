/**
 * Place + delete entity operations for the track editor.
 *
 * The orchestrator handles raycasting + undo snapshots; this module owns
 * the per-kind branching for "add a new entity at this ground hit" and
 * "remove the currently-selected entity from the draft".
 *
 * Both functions return the new selection so the caller can attach the
 * gizmo to it. The orchestrator is then responsible for rebuilding
 * helpers.
 *
 * Extracted from `track-editor.ts` so the per-kind branching lives
 * next to the matching gizmo write-back in `gizmos.ts`.
 */

import { nearestT } from '@/game/tracks/catmull-rom'
import type { Checkpoint, PropType, Track } from '@/game/tracks/types'
import { defaultPropDropY, defaultPropSize } from './editor-helpers'
import { type EntitySel, type PlaceTool, PROP_PLACE_TOOLS } from './editor-ui'
import { nearestAnchorInsertIndex } from './spline-ops'

export type PlaceAtOptions = {
  draft: Track
  hit: { x: number; y: number; z: number }
  tool: PlaceTool
  /** For the +Asset placer — the manifest id chosen in the panel dropdown. */
  pickedAssetId: string
}

/**
 * Mutate `draft` to add a new entity at `hit` based on `tool`. Returns the
 * selection to focus on the new entity, or null if the tool didn't apply
 * (eg +Asset with no picked id, or +Spline-pt with no main spline).
 */
export function placeAt(opts: PlaceAtOptions): EntitySel {
  const { draft, hit, tool, pickedAssetId } = opts
  if (tool === 'gate') {
    const idx = draft.checkpoints.length
    const main = draft.aiSplines.find((s) => s.id === 'main')
    const cp: Checkpoint = {
      index: idx,
      position: { x: hit.x, y: 1.5, z: hit.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 8,
      height: 4,
    }
    if (main && main.points.length >= 2) {
      // Auto-bind to the main spline at the click's nearest curve point.
      cp.splineT = nearestT({ x: hit.x, y: 0, z: hit.z }, main.points)
    }
    draft.checkpoints.push(cp)
    return { kind: 'gate', index: idx }
  }
  if (tool === 'pickup') {
    draft.pickupSpawns.push({ x: hit.x, y: 1.2, z: hit.z })
    return { kind: 'pickup', index: draft.pickupSpawns.length - 1 }
  }
  if (tool === 'pad') {
    // Place the trigger volume so its bottom face sits at the click point —
    // pad centre is halfHeight above that. New pads default to a 4 m
    // half-height (8 m total) so an airborne bike a few metres up still
    // triggers as it passes through.
    const halfHeight = 4
    draft.boostPads.push({
      position: { x: hit.x, y: hit.y + halfHeight, z: hit.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 3,
      halfHeight,
      halfDepth: 6,
      strength: 1.5,
    })
    return { kind: 'pad', index: draft.boostPads.length - 1 }
  }
  if (tool === 'antiGrav') {
    // Center the zone box ~4m above the ground so the bike (which hovers
    // around 1.6m) sits comfortably inside it, with the box's local floor
    // a bit below the road. Authors rotate/scale from there.
    draft.antiGravZones.push({
      position: { x: hit.x, y: 4, z: hit.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 8,
      halfHeight: 5,
      halfDepth: 12,
    })
    return { kind: 'antiGrav', index: draft.antiGravZones.length - 1 }
  }
  if (PROP_PLACE_TOOLS.includes(tool)) {
    const propType = tool as PropType
    const size = defaultPropSize(propType)
    // Drop the prop above the click so it sits on top of the ground at y=0.
    const dropY = defaultPropDropY(propType, size)
    draft.props.push({
      type: propType,
      position: { x: hit.x, y: dropY, z: hit.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size,
    })
    return { kind: 'prop', index: draft.props.length - 1 }
  }
  if (tool === 'asset') {
    if (!pickedAssetId) return null
    // Asset props use `size` as a uniform-ish scale (1,1,1 = native size).
    // The runtime applies it to the cloned GLB and to the collider dims.
    draft.props.push({
      type: 'asset',
      assetId: pickedAssetId,
      position: { x: hit.x, y: 0, z: hit.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 1, y: 1, z: 1 },
    })
    return { kind: 'prop', index: draft.props.length - 1 }
  }
  if (tool === 'spline') {
    const main = draft.aiSplines.find((s) => s.id === 'main')
    if (!main) return null
    // For Catmull-Rom-anchored splines: insert into anchors at the
    // segment closest to the click so the curve stays continuous.
    // For legacy point-only splines: append to points (preserving the
    // old behavior).
    if (main.anchors && main.anchors.length >= 2) {
      const insertIdx = nearestAnchorInsertIndex(hit, main.anchors)
      main.anchors.splice(insertIdx, 0, { x: hit.x, y: 0.5, z: hit.z })
      return { kind: 'spline', splineIndex: 0, pointIndex: insertIdx }
    }
    main.points.push({ x: hit.x, y: 0.5, z: hit.z })
    return { kind: 'spline', splineIndex: 0, pointIndex: main.points.length - 1 }
  }
  return null
}

/**
 * Mutate `draft` to delete the selected entity. Returns true if a
 * deletion happened; false if the selection is empty or refers to the
 * start (which is a singleton and cannot be deleted).
 */
export function deleteSelected(draft: Track, sel: EntitySel): boolean {
  if (!sel) return false
  if (sel.kind === 'start') return false // start is a singleton — cannot be deleted
  if (sel.kind === 'gate') {
    draft.checkpoints.splice(sel.index, 1)
    for (const [i, cp] of draft.checkpoints.entries()) cp.index = i
    return true
  }
  if (sel.kind === 'pickup') {
    draft.pickupSpawns.splice(sel.index, 1)
    return true
  }
  if (sel.kind === 'pad') {
    draft.boostPads.splice(sel.index, 1)
    return true
  }
  if (sel.kind === 'antiGrav') {
    draft.antiGravZones.splice(sel.index, 1)
    return true
  }
  if (sel.kind === 'prop') {
    draft.props.splice(sel.index, 1)
    return true
  }
  // spline
  const sp = draft.aiSplines[sel.splineIndex]
  if (sp) {
    const arr = sp.anchors ?? sp.points
    if (arr.length > 2) arr.splice(sel.pointIndex, 1)
  }
  return true
}
