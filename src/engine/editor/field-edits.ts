/**
 * Pure scalar / flag edits for the track editor's typed-entry inputs.
 *
 * The properties panel renders `<input>` controls whose `data-*` attribute
 * carries a logical field path (`pos.x`, `halfWidth`, `size.z`, `heightMult`,
 * …). These functions map that path onto the selected draft entity. Keeping
 * them DOM-free and side-effect-local (they only mutate the passed draft /
 * prop) makes the dispatch unit-testable without standing up the editor.
 *
 * The orchestrator (`track-editor.ts`) wraps each call in an undo snapshot +
 * helper rebuild; these functions just write the value.
 */

import { SurfaceType, type SurfaceTypeValue } from '@/engine/sim/surface-types'
import type { Prop, Track, WaveRiderDof } from '@/game/tracks/types'
import type { EntitySel } from './editor-ui'

const DEG2RAD = Math.PI / 180

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/** Assign `${prefix}.{x|y|z}` onto a Vec3; returns true if it matched. */
function setVec3(
  v: { x: number; y: number; z: number },
  prefix: string,
  field: string,
  value: number,
): boolean {
  if (field === `${prefix}.x`) {
    v.x = value
    return true
  }
  if (field === `${prefix}.y`) {
    v.y = value
    return true
  }
  if (field === `${prefix}.z`) {
    v.z = value
    return true
  }
  return false
}

/**
 * Write `value` into the field identified by `field` on the entity the
 * selection points at. Unknown fields are ignored. Spline-bound gate/start
 * pose fields (`pos.x`/`pos.z`) are re-derived from the curve by the caller's
 * `recomputeSplineDerived`, so this only writes the freely-editable axes.
 */
export function applyNumEdit(
  draft: Track,
  sel: NonNullable<EntitySel>,
  field: string,
  value: number,
): void {
  switch (sel.kind) {
    case 'start': {
      const s = draft.start
      if (setVec3(s.position, 'pos', field, value)) return
      if (field === 'yawDeg') s.yaw = value * DEG2RAD
      return
    }
    case 'gate': {
      const cp = draft.checkpoints[sel.index]
      if (!cp) return
      if (setVec3(cp.position, 'pos', field, value)) return
      if (field === 'halfWidth') cp.halfWidth = clamp(value, 0.5, 200)
      else if (field === 'height') cp.height = clamp(value, 0.5, 50)
      else if (field === 'splineT' && typeof cp.splineT === 'number')
        cp.splineT = ((value % 1) + 1) % 1
      return
    }
    case 'pickup': {
      const p = draft.pickupSpawns[sel.index]
      if (p) setVec3(p, 'pos', field, value)
      return
    }
    case 'pad': {
      const pad = draft.boostPads[sel.index]
      if (!pad) return
      if (setVec3(pad.position, 'pos', field, value)) return
      if (field === 'halfWidth') pad.halfWidth = clamp(value, 0.5, 50)
      else if (field === 'halfHeight') pad.halfHeight = clamp(value, 0.5, 50)
      else if (field === 'halfDepth') pad.halfDepth = clamp(value, 0.5, 100)
      else if (field === 'strength') pad.strength = clamp(value, 1, 5)
      return
    }
    case 'antiGrav': {
      const z = draft.antiGravZones[sel.index]
      if (!z) return
      if (setVec3(z.position, 'pos', field, value)) return
      if (field === 'halfWidth') z.halfWidth = clamp(value, 0.5, 200)
      else if (field === 'halfHeight') z.halfHeight = clamp(value, 0.5, 100)
      else if (field === 'halfDepth') z.halfDepth = clamp(value, 0.5, 400)
      return
    }
    case 'waveZone': {
      const z = draft.waveZones[sel.index]
      if (!z) return
      if (setVec3(z.position, 'pos', field, value)) return
      if (field === 'halfWidth') z.halfWidth = clamp(value, 0.5, 600)
      else if (field === 'halfHeight') z.halfHeight = clamp(value, 0.5, 200)
      else if (field === 'halfDepth') z.halfDepth = clamp(value, 0.5, 600)
      else if (field === 'heightMult') z.heightMult = clamp(value, 0.05, 8)
      else if (field === 'freqMult') z.freqMult = clamp(value, 0.1, 8)
      else if (field === 'blendRadiusM') z.blendRadiusM = clamp(value, 0.5, 200)
      else if (field === 'directionDeg') z.directionDeg = clamp(value, -180, 180)
      else if (field === 'surgePeriodS') {
        z.surgePeriodS = Math.max(0.5, value)
        // The loader requires both surge fields together — materialise the
        // amplitude when the period is first set.
        if (typeof z.surgeAmplitude !== 'number') z.surgeAmplitude = 1
      } else if (field === 'surgeAmplitude') z.surgeAmplitude = value
      return
    }
    case 'prop': {
      const p = draft.props[sel.index]
      if (!p) return
      if (setVec3(p.position, 'pos', field, value)) return
      // Size components stay strictly positive so geometry never degenerates.
      if (field === 'size.x') p.size.x = clamp(value, 0.01, 400)
      else if (field === 'size.y') p.size.y = clamp(value, 0.01, 400)
      else if (field === 'size.z') p.size.z = clamp(value, 0.01, 400)
      return
    }
    case 'spline': {
      const sp = draft.aiSplines[sel.splineIndex]
      if (!sp) return
      const arr = sp.anchors ?? sp.points
      const p = arr[sel.pointIndex]
      if (p) setVec3(p, 'pos', field, value)
      return
    }
  }
}

const SURFACE_SET = new Set<string>(Object.values(SurfaceType))

/**
 * Apply a flag edit to a placed prop. `value` is typed per the control:
 * checkbox → boolean, select/text/color → string, clear-button → null.
 */
export function applyPropFlag(prop: Prop, field: string, value: string | boolean | null): void {
  switch (field) {
    case 'color':
      if (value == null || value === '') delete prop.color
      else prop.color = String(value)
      return
    case 'surface':
      // 'default' is the implicit baseline — store only a real override.
      if (value === 'default' || value == null || !SURFACE_SET.has(String(value)))
        delete prop.surface
      else prop.surface = value as SurfaceTypeValue
      return
    case 'waterline':
      // Default is ON; persist only the opt-out.
      if (value === false) prop.waterline = false
      else delete prop.waterline
      return
    case 'waveRider':
      if (value === true) prop.waveRider = prop.waveRider ?? { dof: 'locked' }
      else delete prop.waveRider
      return
    case 'waveRiderDof':
      if (prop.waveRider && (value === 'locked' || value === 'yaw'))
        prop.waveRider.dof = value as WaveRiderDof
      return
    case 'animated':
      if (value === true) prop.animated = true
      else delete prop.animated
      return
    case 'clip':
      if (value == null || value === '') delete prop.clip
      else prop.clip = String(value)
      return
    case 'loop':
      // Default is loop=true; persist only the opt-out.
      if (value === false) prop.loop = false
      else delete prop.loop
      return
  }
}
