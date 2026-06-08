import * as THREE from 'three'
import type { Vec3 } from '@/engine/sim/physics/vec'
import type { PropType } from '@/game/tracks/types'

/**
 * Geometry builders for editor-authored props. Shared between the in-app
 * editor's helpers and the runtime render path so both look identical.
 *
 * Local-axis conventions:
 *  - box       — centered on origin, axis-aligned. size = (halfX, halfY, halfZ).
 *  - sphere    — centered. size.x = radius.
 *  - cylinder  — axis = +Y, centered. size.x = radius, size.y = halfHeight.
 *  - pipe      — hollow tube along +Z (drive-through). size = (outerR, halfLen, wall).
 *  - halfpipe  — pipe with the upper half (Y > 0) removed. Open face is +Y.
 */
export function buildPropGeometry(type: PropType, size: Vec3): THREE.BufferGeometry {
  if (type === 'box') {
    // 3 segments/face so the painterly-vinyl edge-wear stamp (welded per-vertex
    // convexity, see edge-wear-convexity.ts) localises to the edges/corners with
    // clean face interiors — an un-subdivided box is all-corners, which would
    // drybrush the whole surface instead of just the edges.
    return new THREE.BoxGeometry(
      Math.max(0.1, size.x * 2),
      Math.max(0.1, size.y * 2),
      Math.max(0.1, size.z * 2),
      3,
      3,
      3,
    )
  }
  if (type === 'sphere') {
    return new THREE.SphereGeometry(Math.max(0.1, size.x), 18, 14)
  }
  if (type === 'cylinder') {
    return new THREE.CylinderGeometry(
      Math.max(0.1, size.x),
      Math.max(0.1, size.x),
      Math.max(0.1, size.y * 2),
      24,
    )
  }
  const outer = Math.max(0.2, size.x)
  const halfLen = Math.max(0.1, size.y)
  const wall = Math.max(0.05, Math.min(size.z, outer - 0.05))
  const inner = outer - wall
  return buildRingGeometry({
    outer,
    inner,
    halfLen,
    radialSegs: type === 'halfpipe' ? 24 : 32,
    lengthSegs: 1,
    open: type === 'halfpipe',
  })
}

/**
 * Hollow-cylinder shell along +Z. `open=true` removes the upper half so
 * the inside is exposed at +Y (open-top half-pipe).
 *
 * The geometry has both outer and inner faces, plus annular end caps, so
 * the bike sees a wall from any approach.
 */
export function buildRingGeometry(opts: {
  outer: number
  inner: number
  halfLen: number
  radialSegs: number
  lengthSegs: number
  open: boolean
}): THREE.BufferGeometry {
  const { outer, inner, halfLen, radialSegs, lengthSegs, open } = opts
  // For halfpipe, surviving arc is the BOTTOM half so the open face is +Y.
  const thetaStart = open ? Math.PI : 0
  const thetaEnd = open ? Math.PI * 2 : Math.PI * 2
  const thetaRange = thetaEnd - thetaStart

  const verts: number[] = []
  const idx: number[] = []
  const ringCount = lengthSegs + 1

  for (let l = 0; l < ringCount; l++) {
    const z = -halfLen + (l / lengthSegs) * (halfLen * 2)
    for (let r = 0; r <= radialSegs; r++) {
      const t = thetaStart + (r / radialSegs) * thetaRange
      verts.push(Math.cos(t) * outer, Math.sin(t) * outer, z)
    }
  }
  const innerStart = ringCount * (radialSegs + 1)
  for (let l = 0; l < ringCount; l++) {
    const z = -halfLen + (l / lengthSegs) * (halfLen * 2)
    for (let r = 0; r <= radialSegs; r++) {
      const t = thetaStart + (r / radialSegs) * thetaRange
      verts.push(Math.cos(t) * inner, Math.sin(t) * inner, z)
    }
  }
  for (let l = 0; l < lengthSegs; l++) {
    for (let r = 0; r < radialSegs; r++) {
      const a = l * (radialSegs + 1) + r
      const b = a + 1
      const c = a + (radialSegs + 1)
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  for (let l = 0; l < lengthSegs; l++) {
    for (let r = 0; r < radialSegs; r++) {
      const a = innerStart + l * (radialSegs + 1) + r
      const b = a + 1
      const c = a + (radialSegs + 1)
      const d = c + 1
      idx.push(a, b, c, b, d, c)
    }
  }
  for (let l = 0; l < ringCount; l++) {
    const isStartCap = l === 0
    const oBase = l * (radialSegs + 1)
    const iBase = innerStart + l * (radialSegs + 1)
    for (let r = 0; r < radialSegs; r++) {
      const oA = oBase + r
      const oB = oBase + r + 1
      const iA = iBase + r
      const iB = iBase + r + 1
      if (isStartCap) {
        idx.push(oA, oB, iA, iA, oB, iB)
      } else {
        idx.push(oA, iA, oB, oB, iA, iB)
      }
    }
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geom.setIndex(idx)
  geom.computeVertexNormals()
  return geom
}
