/**
 * Scene-side helper management for the track editor.
 *
 * Owns the per-entity helper map and the spline polyline mesh. The
 * orchestrator calls `rebuild()` whenever the draft's topology changes
 * (placement, deletion, undo, auto-place); during a high-frequency drag
 * the orchestrator can call the cheaper `refreshSplineCurveMesh()` /
 * `refreshBoundGateHelpers()` to avoid the full rebuild.
 *
 * `isSel` and `refreshTints` are kept here too because they consult the
 * helper map directly.
 *
 * Extracted from `track-editor.ts` to keep the orchestrator focused on
 * gizmo wiring + I/O.
 */

import * as THREE from 'three'
import type { Track } from '@/game/tracks/types'
import {
  disposeObj,
  makeAnchorHelper,
  makeAntiGravHelper,
  makeGateHelper,
  makePadHelper,
  makePickupHelper,
  makePropHelper,
  makeSplineCurve,
  makeStartHelper,
} from './editor-helpers'
import { type EntitySel, entityKey } from './editor-ui'
import { editableSplinePoints, recomputeSplineDerived } from './spline-ops'

export type HelpersScene = {
  /** The map orchestrator uses to look up the helper for a selection. */
  helpers: Map<string, THREE.Group>
  /** The scene group that contains every helper. Exposed for raycaster
   *  intersection tests against the editor's own geometry only. */
  group: THREE.Group
  /** Full rebuild — call after any topology change. */
  rebuild(): void
  /** Re-tint selection markers without rebuilding geometry. Pass the
   *  current selection; helpers whose key matches will be tinted as
   *  selected. */
  refreshTints(sel: EntitySel): void
  /** Cheap curve-mesh refresh — used during spline-anchor drag. */
  refreshSplineCurveMesh(): void
  /** Reposition any splineT-bound gate helpers (and the player start if
   *  it's curve-bound) to the draft's current values. Used after the
   *  curve resamples during anchor drag. */
  refreshBoundGateHelpers(): void
  /** Returns true when the given target matches the current selection
   *  passed to the most recent `rebuild()`. Used by the helper factories'
   *  initial-tint flag. */
  isSel(sel: EntitySel, target: NonNullable<EntitySel>): boolean
  /** Tear down: remove all helpers + the group from the scene. */
  dispose(): void
}

export function createHelpersScene(opts: {
  scene: THREE.Scene
  draft: Track
  getSel: () => EntitySel
}): HelpersScene {
  const { scene, draft, getSel } = opts

  const helpersGroup = new THREE.Group()
  helpersGroup.name = 'editor:helpers'
  scene.add(helpersGroup)
  const helpers = new Map<string, THREE.Group>()
  let splinePolyline: THREE.Line | null = null

  function isSel(sel: EntitySel, target: NonNullable<EntitySel>): boolean {
    if (!sel) return false
    if (sel.kind !== target.kind) return false
    if (sel.kind === 'spline' && target.kind === 'spline') {
      return sel.pointIndex === target.pointIndex && sel.splineIndex === target.splineIndex
    }
    if (sel.kind === 'start' && target.kind === 'start') return true
    return (sel as { index: number }).index === (target as { index: number }).index
  }

  function rebuild(): void {
    const sel = getSel()
    recomputeSplineDerived(draft)
    for (const h of helpers.values()) {
      helpersGroup.remove(h)
      disposeObj(h)
    }
    helpers.clear()
    if (splinePolyline) {
      helpersGroup.remove(splinePolyline)
      disposeObj(splinePolyline)
      splinePolyline = null
    }

    {
      const k = 'start'
      const h = makeStartHelper(draft.start, isSel(sel, { kind: 'start' }))
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    for (let i = 0; i < draft.checkpoints.length; i++) {
      const k = `gate:${i}`
      const h = makeGateHelper(draft.checkpoints[i]!, isSel(sel, { kind: 'gate', index: i }))
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    for (let i = 0; i < draft.props.length; i++) {
      const k = `prop:${i}`
      const h = makePropHelper(draft.props[i]!, isSel(sel, { kind: 'prop', index: i }))
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    for (let i = 0; i < draft.pickupSpawns.length; i++) {
      const k = `pickup:${i}`
      const h = makePickupHelper(draft.pickupSpawns[i]!, isSel(sel, { kind: 'pickup', index: i }))
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    for (let i = 0; i < draft.boostPads.length; i++) {
      const k = `pad:${i}`
      const h = makePadHelper(draft.boostPads[i]!, isSel(sel, { kind: 'pad', index: i }))
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    for (let i = 0; i < draft.antiGravZones.length; i++) {
      const k = `antigrav:${i}`
      const h = makeAntiGravHelper(
        draft.antiGravZones[i]!,
        isSel(sel, { kind: 'antiGrav', index: i }),
      )
      h.userData.entityKey = k
      helpers.set(k, h)
      helpersGroup.add(h)
    }
    const main = draft.aiSplines.find((s) => s.id === 'main')
    if (main) {
      const anchors = editableSplinePoints(draft)
      const isAnchored = !!main.anchors
      for (let pi = 0; pi < anchors.length; pi++) {
        const k = `spline:0:${pi}`
        const selected = isSel(sel, { kind: 'spline', splineIndex: 0, pointIndex: pi })
        const h = makeAnchorHelper(anchors[pi]!, selected, isAnchored)
        h.userData.entityKey = k
        helpers.set(k, h)
        helpersGroup.add(h)
      }
      // Smooth curve drawn from the dense (runtime) sample list.
      splinePolyline = makeSplineCurve(main.points)
      helpersGroup.add(splinePolyline)
    }
  }

  function refreshTints(sel: EntitySel): void {
    for (const [k, h] of helpers) {
      const selected = sel != null && k === entityKey(sel)
      const recolor = h.userData.setSelected as ((v: boolean) => void) | undefined
      if (recolor) recolor(selected)
    }
  }

  function refreshSplineCurveMesh(): void {
    if (!splinePolyline) return
    const main = draft.aiSplines.find((s) => s.id === 'main')
    if (!main || main.points.length < 2) return
    const arr = (splinePolyline.geometry.attributes.position as THREE.BufferAttribute)
      .array as Float32Array
    // Rebuild only if the buffer is the right size; otherwise rebuild
    // the whole curve mesh.
    const need = (main.points.length + 1) * 3
    if (arr.length !== need) {
      helpersGroup.remove(splinePolyline)
      disposeObj(splinePolyline)
      splinePolyline = makeSplineCurve(main.points)
      helpersGroup.add(splinePolyline)
      return
    }
    for (let i = 0; i < main.points.length; i++) {
      arr[i * 3] = main.points[i]!.x
      arr[i * 3 + 1] = main.points[i]!.y + 0.2
      arr[i * 3 + 2] = main.points[i]!.z
    }
    arr[main.points.length * 3] = main.points[0]!.x
    arr[main.points.length * 3 + 1] = main.points[0]!.y + 0.2
    arr[main.points.length * 3 + 2] = main.points[0]!.z
    ;(splinePolyline.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  function refreshBoundGateHelpers(): void {
    for (let i = 0; i < draft.checkpoints.length; i++) {
      const cp = draft.checkpoints[i]!
      if (typeof cp.splineT !== 'number') continue
      const h = helpers.get(`gate:${i}`)
      if (!h) continue
      h.position.set(cp.position.x, cp.position.y, cp.position.z)
      h.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
    }
    if (typeof draft.start.splineT === 'number') {
      const h = helpers.get('start')
      if (h) {
        h.position.set(draft.start.position.x, draft.start.position.y, draft.start.position.z)
        const halfA = draft.start.yaw / 2
        h.quaternion.set(0, Math.sin(halfA), 0, Math.cos(halfA))
      }
    }
  }

  function dispose(): void {
    for (const h of helpers.values()) {
      helpersGroup.remove(h)
      disposeObj(h)
    }
    helpers.clear()
    if (splinePolyline) {
      helpersGroup.remove(splinePolyline)
      disposeObj(splinePolyline)
      splinePolyline = null
    }
    scene.remove(helpersGroup)
  }

  return {
    helpers,
    group: helpersGroup,
    rebuild,
    refreshTints,
    refreshSplineCurveMesh,
    refreshBoundGateHelpers,
    isSel,
    dispose,
  }
}
