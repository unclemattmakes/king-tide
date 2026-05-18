/**
 * Visualization of every anti-gravity source on the track — the dense
 * spline polyline plus "up" arrows at regular intervals so the curve's
 * authored banking is legible while driving. Also outlines volume zones
 * as wireframe boxes.
 *
 * Toggle from `main.ts`:
 *   - F3 key (per-session)
 *   - `?debug=anti-grav` URL param (boot-time)
 *   - `window.__hover.toggleAntiGravDebug()` (programmatic)
 *
 * Cheap-when-off — single `visible=false` on the group, no per-frame
 * cost. Geometry is built once at construction from the track data
 * (anti-grav authoring is static at runtime).
 */

import * as THREE from 'three'
import { curveUpAtT, tangent3dAtT } from '@/game/tracks/catmull-rom'
import { quatRotate } from '@/engine/sim/physics/vec'
import type { Track } from '@/game/tracks/types'

/** Arrow visualization spacing — one arrow every ~3m of arc length. */
const ARROW_SPACING_M = 3
/** Arrow shaft length in metres. */
const ARROW_LEN = 2.5
/** Side stroke length on each arrow head (chevron, not a real cone). */
const ARROW_HEAD = 0.6

export type AntiGravDebugRenderer = {
  group: THREE.Group
  setEnabled(on: boolean): void
  isEnabled(): boolean
  toggle(): boolean
  dispose(): void
}

export function createAntiGravDebugRenderer(track: Track): AntiGravDebugRenderer {
  const group = new THREE.Group()
  group.name = 'anti-grav-debug'
  group.visible = false
  // Rendered at the end so the lines aren't hidden behind opaque geometry
  // — anti-grav diagnostics are explicitly an X-ray view.
  group.renderOrder = 998

  // Spline polylines + arrows.
  for (const s of track.aiSplines) {
    if (!s.antiGrav || !s.bankings || s.points.length < 2) continue

    // Coloured polyline — sample colour from banking magnitude so flat
    // sections read cool (blue) and walls / loops read hot (red).
    const lineGeom = new THREE.BufferGeometry()
    const pos = new Float32Array((s.points.length + 1) * 3)
    const col = new Float32Array((s.points.length + 1) * 3)
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]!
      pos[i * 3] = p.x
      pos[i * 3 + 1] = p.y + 0.3
      pos[i * 3 + 2] = p.z
      const c = bankingToColor(s.bankings[i] ?? 0)
      col[i * 3] = c.r
      col[i * 3 + 1] = c.g
      col[i * 3 + 2] = c.b
    }
    // Close the loop.
    pos[s.points.length * 3] = s.points[0]!.x
    pos[s.points.length * 3 + 1] = s.points[0]!.y + 0.3
    pos[s.points.length * 3 + 2] = s.points[0]!.z
    const c0 = bankingToColor(s.bankings[0] ?? 0)
    col[s.points.length * 3] = c0.r
    col[s.points.length * 3 + 1] = c0.g
    col[s.points.length * 3 + 2] = c0.b
    lineGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    lineGeom.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    })
    const line = new THREE.Line(lineGeom, lineMat)
    line.frustumCulled = false
    group.add(line)

    // "Up" arrows at regular arc-length intervals. Each arrow is a
    // 3-segment polyline: shaft + two chevron strokes. Packing them all
    // into one LineSegments mesh avoids per-arrow allocation cost.
    const arrowSegs: number[] = []
    const arrowCols: number[] = []
    let accum = 0
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i]!
      const b = s.points[(i + 1) % s.points.length]!
      const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      accum += segLen
      if (accum < ARROW_SPACING_M) continue
      accum = 0

      const t = i / s.points.length
      const tangent = tangent3dAtT(s.points, t)
      const banking = s.bankings[i] ?? 0
      const up = curveUpAtT(tangent, banking)
      const root = { x: a.x, y: a.y + 0.3, z: a.z }
      const tip = {
        x: root.x + up.x * ARROW_LEN,
        y: root.y + up.y * ARROW_LEN,
        z: root.z + up.z * ARROW_LEN,
      }
      const col = bankingToColor(banking)
      pushSeg(arrowSegs, arrowCols, root, tip, col)
      // Chevron: two short segments from tip down-and-back-along-tangent.
      const cBackX = -tangent.x * ARROW_HEAD - up.x * ARROW_HEAD
      const cBackY = -tangent.y * ARROW_HEAD - up.y * ARROW_HEAD
      const cBackZ = -tangent.z * ARROW_HEAD - up.z * ARROW_HEAD
      const cFwdX = tangent.x * ARROW_HEAD - up.x * ARROW_HEAD
      const cFwdY = tangent.y * ARROW_HEAD - up.y * ARROW_HEAD
      const cFwdZ = tangent.z * ARROW_HEAD - up.z * ARROW_HEAD
      pushSeg(
        arrowSegs,
        arrowCols,
        tip,
        { x: tip.x + cBackX, y: tip.y + cBackY, z: tip.z + cBackZ },
        col,
      )
      pushSeg(
        arrowSegs,
        arrowCols,
        tip,
        { x: tip.x + cFwdX, y: tip.y + cFwdY, z: tip.z + cFwdZ },
        col,
      )
    }
    if (arrowSegs.length > 0) {
      const arrowGeom = new THREE.BufferGeometry()
      arrowGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arrowSegs), 3))
      arrowGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(arrowCols), 3))
      const arrowMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        linewidth: 2,
      })
      const arrows = new THREE.LineSegments(arrowGeom, arrowMat)
      arrows.frustumCulled = false
      group.add(arrows)
    }

    // Falloff envelope — translucent tube-ish dashed outline a falloff
    // radius out from the curve, on the side opposite the up vector
    // (which is where the bike most commonly enters the curve's
    // influence). Cheap visual cue for "this is the catch radius."
    // Skip for now — adds visual clutter; can revisit.
  }

  // Volume zones — wireframe boxes (existing race-time visual is already
  // a faint wireframe; this debug overlay adds bright X-ray edges).
  for (const z of track.antiGravZones) {
    const w = z.halfWidth * 2
    const h = z.halfHeight * 2
    const d = z.halfDepth * 2
    const boxGeom = new THREE.BoxGeometry(w, h, d)
    const wireGeom = new THREE.WireframeGeometry(boxGeom)
    const wireMat = new THREE.LineBasicMaterial({
      color: 0xc8a0ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    })
    const wire = new THREE.LineSegments(wireGeom, wireMat)
    wire.position.set(z.position.x, z.position.y, z.position.z)
    wire.quaternion.set(z.rotation.x, z.rotation.y, z.rotation.z, z.rotation.w)
    wire.frustumCulled = false
    group.add(wire)
    // Up arrow at zone center (in zone local +Y).
    const zUp = quatRotate(z.rotation, { x: 0, y: 1, z: 0 })
    const root = { x: z.position.x, y: z.position.y, z: z.position.z }
    const tip = {
      x: root.x + zUp.x * 3,
      y: root.y + zUp.y * 3,
      z: root.z + zUp.z * 3,
    }
    const arrSegs: number[] = []
    const arrCols: number[] = []
    pushSeg(arrSegs, arrCols, root, tip, { r: 0.8, g: 0.4, b: 1 })
    const arrowGeom = new THREE.BufferGeometry()
    arrowGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arrSegs), 3))
    arrowGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(arrCols), 3))
    const arrowMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    })
    const arrow = new THREE.LineSegments(arrowGeom, arrowMat)
    arrow.frustumCulled = false
    group.add(arrow)
  }

  let enabled = false

  function dispose(): void {
    group.traverse((c) => {
      const geom = (c as THREE.Mesh).geometry
      if (geom) geom.dispose()
      const mat = (c as THREE.Mesh).material
      if (mat) {
        if (Array.isArray(mat)) for (const m of mat) m.dispose()
        else mat.dispose()
      }
    })
    group.removeFromParent()
  }

  return {
    group,
    setEnabled(on) {
      enabled = on
      group.visible = on
    },
    isEnabled() {
      return enabled
    },
    toggle() {
      enabled = !enabled
      group.visible = enabled
      return enabled
    },
    dispose,
  }
}

/**
 * Banking magnitude → colour ramp. Flat (0) → blue, ±π/4 → cyan,
 * ±π/2 (wall) → green, ±3π/4 → yellow, ±π (ceiling) → red. The hot
 * end of the ramp is most extreme so the eye picks out walls / loops
 * at a glance. Uses |banking| so positive and negative same-magnitude
 * banking colour identically — the *direction* of banking is shown by
 * the arrow's tilt, not its colour.
 */
function bankingToColor(banking: number): { r: number; g: number; b: number } {
  const mag = Math.min(Math.abs(banking) / Math.PI, 1)
  if (mag < 0.25) {
    // blue → cyan
    const f = mag / 0.25
    return { r: 0, g: f, b: 1 }
  }
  if (mag < 0.5) {
    // cyan → green
    const f = (mag - 0.25) / 0.25
    return { r: 0, g: 1, b: 1 - f }
  }
  if (mag < 0.75) {
    // green → yellow
    const f = (mag - 0.5) / 0.25
    return { r: f, g: 1, b: 0 }
  }
  // yellow → red
  const f = (mag - 0.75) / 0.25
  return { r: 1, g: 1 - f, b: 0 }
}

function pushSeg(
  posOut: number[],
  colOut: number[],
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { r: number; g: number; b: number },
): void {
  posOut.push(a.x, a.y, a.z, b.x, b.y, b.z)
  colOut.push(c.r, c.g, c.b, c.r, c.g, c.b)
}
