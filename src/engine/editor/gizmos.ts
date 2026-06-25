/**
 * Gizmo write-back + axis gating for the track editor.
 *
 * The orchestrator owns the `TransformControls` instance and the helpers
 * map; this module is the per-entity-kind dispatch table for:
 *   - which gizmo axes are shown for a given selection + mode (`configureGizmoAxes`),
 *   - whether a selection supports a given mode at all (`selSupportsMode`),
 *   - how to write a helper's pose back into the draft during a drag
 *     (`writeHelperPoseToDraft`),
 *   - how to bake a finished scale drag into the entity's dimension fields
 *     (`bakeScaleToDraft`).
 *
 * Spline-bound gates project onto the nearest point of the curve and
 * snap-update the helper in place during drag; the orchestrator is
 * responsible for the curve-mesh refresh and the bound-gate helper
 * refresh that follow.
 *
 * Extracted from `track-editor.ts` to isolate the per-kind branching.
 */

import type * as THREE from 'three'
import type { TransformControls } from 'three/addons/controls/TransformControls.js'
import { nearestT, pointAtT, tangentAtT } from '@/game/tracks/catmull-rom'
import type { Track } from '@/game/tracks/types'
import { yawFromQuaternion } from './editor-helpers'
import type { EntitySel, GizmoMode } from './editor-ui'

/** Entity kinds — derived from a helper's `userData.entityKey` prefix. */
export type EntityKind =
  | 'gate'
  | 'pad'
  | 'antiGrav'
  | 'waveZone'
  | 'pickup'
  | 'prop'
  | 'start'
  | 'spline'

export function entityKindFromKey(k: string): EntityKind {
  if (k.startsWith('gate')) return 'gate'
  if (k.startsWith('pad')) return 'pad'
  if (k.startsWith('antigrav')) return 'antiGrav'
  if (k.startsWith('wavezone')) return 'waveZone'
  if (k.startsWith('pickup')) return 'pickup'
  if (k.startsWith('prop')) return 'prop'
  if (k === 'start') return 'start'
  return 'spline'
}

/**
 * Configure which axes the gizmo shows based on the selected helper and
 * the current mode. Mirrors the original closure's per-kind axis-gating.
 *
 * - Pickups / spline points are translate-only (all three axes for translation).
 * - Start / gates / pads rotate around Y only (yaw); props rotate freely.
 * - Gates scale on X (halfWidth) + Y (height); pads scale on X (halfWidth)
 *   + Z (halfDepth); props scale on all three axes.
 */
export function configureGizmoAxes(tc: TransformControls, kind: EntityKind, mode: GizmoMode): void {
  if (kind === 'pickup' || kind === 'spline') {
    // Translate-only entities. Show all three axes for translation.
    tc.showX = true
    tc.showY = true
    tc.showZ = true
    return
  }
  if (mode === 'rotate') {
    // Start / gates / pads rotate around Y only (yaw). Props, anti-grav, and
    // wave zones rotate around all three axes — anti-grav needs full rotation
    // to match a banked road; wave zones can be yawed (swell bearing) and the
    // extra freedom is harmless.
    if (kind === 'prop' || kind === 'antiGrav' || kind === 'waveZone') {
      tc.showX = true
      tc.showY = true
      tc.showZ = true
    } else {
      tc.showX = false
      tc.showY = true
      tc.showZ = false
    }
    return
  }
  if (mode === 'scale') {
    // Gates: scale X (halfWidth), Y (height). Pads + anti-grav + props:
    // scale on all three axes (X = halfWidth, Y = halfHeight, Z = halfDepth).
    if (kind === 'gate') {
      tc.showX = true
      tc.showY = true
      tc.showZ = false
    } else {
      tc.showX = true
      tc.showY = true
      tc.showZ = true
    }
    return
  }
  // translate
  tc.showX = true
  tc.showY = true
  tc.showZ = true
}

/** Returns whether the currently-selected entity supports a given gizmo
 *  mode. Spline-bound gates derive their rotation from the curve, so
 *  rotate is disabled for those. */
export function selSupportsMode(draft: Track, sel: EntitySel, m: GizmoMode): boolean {
  if (!sel) return true
  if (sel.kind === 'pickup' || sel.kind === 'spline') return m === 'translate'
  if (sel.kind === 'gate') {
    const cp = draft.checkpoints[sel.index]
    if (cp && typeof cp.splineT === 'number' && m === 'rotate') return false
  }
  // Start: translate + rotate (yaw); no scale. Spline-bound starts get
  // their yaw from the curve tangent — the rotate gizmo is disabled the
  // same way it is for spline-bound gates.
  if (sel.kind === 'start') {
    if (m === 'scale') return false
    if (m === 'rotate' && typeof draft.start.splineT === 'number') return false
  }
  return true
}

/**
 * Write the helper's current pose back into the draft for the given
 * selection. Returns true when the selection was a spline anchor — the
 * caller uses this to trigger geometry-only refreshes of the spline
 * curve mesh and bound-gate helpers during drag.
 */
export function writeHelperPoseToDraft(
  draft: Track,
  h: THREE.Object3D,
  s: NonNullable<EntitySel>,
): { splineMoved: boolean } {
  if (s.kind === 'gate') {
    const cp = draft.checkpoints[s.index]
    if (!cp) return { splineMoved: false }
    if (typeof cp.splineT === 'number') {
      // Spline-bound: project the gizmo's xz onto the nearest point on
      // the curve, snap the helper there, and update splineT. y stays
      // freely editable (gates can sit at different heights).
      const main = draft.aiSplines.find((s2) => s2.id === 'main')
      if (main && main.points.length >= 2) {
        const t = nearestT({ x: h.position.x, y: 0, z: h.position.z }, main.points)
        cp.splineT = t
        const p = pointAtT(main.points, t)
        const tan = tangentAtT(main.points, t)
        cp.position.x = p.x
        cp.position.y = h.position.y
        cp.position.z = p.z
        const yaw = Math.atan2(tan.x, tan.z)
        const halfA = yaw / 2
        cp.rotation = { x: 0, y: Math.sin(halfA), z: 0, w: Math.cos(halfA) }
        // Snap the helper to the resolved pose so the user sees the
        // gate sticking to the curve mid-drag.
        h.position.set(p.x, h.position.y, p.z)
        h.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
      }
      return { splineMoved: false }
    }
    cp.position.x = h.position.x
    cp.position.y = h.position.y
    cp.position.z = h.position.z
    cp.rotation.x = h.quaternion.x
    cp.rotation.y = h.quaternion.y
    cp.rotation.z = h.quaternion.z
    cp.rotation.w = h.quaternion.w
    return { splineMoved: false }
  }
  if (s.kind === 'pickup') {
    const p = draft.pickupSpawns[s.index]
    if (!p) return { splineMoved: false }
    p.x = h.position.x
    p.y = h.position.y
    p.z = h.position.z
    return { splineMoved: false }
  }
  if (s.kind === 'pad') {
    const pad = draft.boostPads[s.index]
    if (!pad) return { splineMoved: false }
    pad.position.x = h.position.x
    pad.position.y = h.position.y
    pad.position.z = h.position.z
    pad.rotation.x = h.quaternion.x
    pad.rotation.y = h.quaternion.y
    pad.rotation.z = h.quaternion.z
    pad.rotation.w = h.quaternion.w
    return { splineMoved: false }
  }
  if (s.kind === 'antiGrav') {
    const z = draft.antiGravZones[s.index]
    if (!z) return { splineMoved: false }
    z.position.x = h.position.x
    z.position.y = h.position.y
    z.position.z = h.position.z
    z.rotation.x = h.quaternion.x
    z.rotation.y = h.quaternion.y
    z.rotation.z = h.quaternion.z
    z.rotation.w = h.quaternion.w
    return { splineMoved: false }
  }
  if (s.kind === 'waveZone') {
    const z = draft.waveZones[s.index]
    if (!z) return { splineMoved: false }
    z.position.x = h.position.x
    z.position.y = h.position.y
    z.position.z = h.position.z
    z.rotation.x = h.quaternion.x
    z.rotation.y = h.quaternion.y
    z.rotation.z = h.quaternion.z
    z.rotation.w = h.quaternion.w
    return { splineMoved: false }
  }
  if (s.kind === 'spline') {
    // Edits the editable array (anchors when present, points for legacy).
    const sp = draft.aiSplines[s.splineIndex]
    if (!sp) return { splineMoved: false }
    const arr = sp.anchors ?? sp.points
    const p = arr[s.pointIndex]
    if (!p) return { splineMoved: false }
    p.x = h.position.x
    p.y = h.position.y
    p.z = h.position.z
    return { splineMoved: true }
  }
  if (s.kind === 'prop') {
    const p = draft.props[s.index]
    if (!p) return { splineMoved: false }
    p.position.x = h.position.x
    p.position.y = h.position.y
    p.position.z = h.position.z
    p.rotation.x = h.quaternion.x
    p.rotation.y = h.quaternion.y
    p.rotation.z = h.quaternion.z
    p.rotation.w = h.quaternion.w
    return { splineMoved: false }
  }
  // start
  // Start stores yaw as a number; derive it from the helper's Y rotation
  // (or, when bound to the main spline, from the curve tangent so the
  // platform always faces along the racing line).
  if (typeof draft.start.splineT === 'number') {
    const main = draft.aiSplines.find((s2) => s2.id === 'main')
    if (main && main.points.length >= 2) {
      const t = nearestT({ x: h.position.x, y: 0, z: h.position.z }, main.points)
      draft.start.splineT = t
      const p = pointAtT(main.points, t)
      const tan = tangentAtT(main.points, t)
      draft.start.position.x = p.x
      draft.start.position.y = h.position.y
      draft.start.position.z = p.z
      draft.start.yaw = Math.atan2(tan.x, tan.z)
      // Snap the helper to the resolved pose mid-drag so the user sees
      // the start sliding along the spline rather than free-floating.
      const halfA = draft.start.yaw / 2
      h.position.set(p.x, h.position.y, p.z)
      h.quaternion.set(0, Math.sin(halfA), 0, Math.cos(halfA))
      return { splineMoved: false }
    }
  }
  draft.start.position.x = h.position.x
  draft.start.position.y = h.position.y
  draft.start.position.z = h.position.z
  draft.start.yaw = yawFromQuaternion(h.quaternion)
  return { splineMoved: false }
}

/**
 * Bake the helper's current `scale` into the selected entity's dimension
 * fields. Called on gizmo drag-end for scale mode; the caller resets the
 * helper to (1,1,1) by rebuilding helpers afterwards.
 */
export function bakeScaleToDraft(draft: Track, h: THREE.Object3D, s: NonNullable<EntitySel>): void {
  const sx = h.scale.x
  const sy = h.scale.y
  const sz = h.scale.z
  if (s.kind === 'gate') {
    const cp = draft.checkpoints[s.index]
    if (cp) {
      cp.halfWidth = clampPositive(cp.halfWidth * sx, 0.5, 200)
      cp.height = clampPositive(cp.height * sy, 0.5, 50)
    }
  } else if (s.kind === 'pad') {
    const pad = draft.boostPads[s.index]
    if (pad) {
      pad.halfWidth = clampPositive(pad.halfWidth * sx, 0.5, 50)
      pad.halfHeight = clampPositive(pad.halfHeight * sy, 0.5, 50)
      pad.halfDepth = clampPositive(pad.halfDepth * sz, 0.5, 100)
    }
  } else if (s.kind === 'antiGrav') {
    const z = draft.antiGravZones[s.index]
    if (z) {
      z.halfWidth = clampPositive(z.halfWidth * sx, 0.5, 200)
      z.halfHeight = clampPositive(z.halfHeight * sy, 0.5, 100)
      z.halfDepth = clampPositive(z.halfDepth * sz, 0.5, 400)
    }
  } else if (s.kind === 'waveZone') {
    const z = draft.waveZones[s.index]
    if (z) {
      z.halfWidth = clampPositive(z.halfWidth * sx, 0.5, 600)
      z.halfHeight = clampPositive(z.halfHeight * sy, 0.5, 200)
      z.halfDepth = clampPositive(z.halfDepth * sz, 0.5, 600)
    }
  } else if (s.kind === 'prop') {
    const p = draft.props[s.index]
    if (p) {
      p.size.x = clampPositive(p.size.x * sx, 0.1, 200)
      p.size.y = clampPositive(p.size.y * sy, 0.1, 200)
      p.size.z = clampPositive(p.size.z * sz, 0.05, 200)
    }
  }
}

function clampPositive(n: number, min: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return min
  if (n < min) return min
  if (n > max) return max
  return n
}
