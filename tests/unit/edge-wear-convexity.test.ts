import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { stampConvexityColor0 } from '@/engine/render/edge-wear-convexity'

/** Min/max/mean of the COLOR_0 alpha channel across a stamped geometry. */
function alphaRange(geom: THREE.BufferGeometry): { min: number; max: number; mean: number } {
  const c = geom.getAttribute('color') as THREE.BufferAttribute
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (let i = 0; i < c.count; i++) {
    const a = c.getW(i)
    min = Math.min(min, a)
    max = Math.max(max, a)
    sum += a
  }
  return { min, max, mean: sum / c.count }
}

describe('stampConvexityColor0', () => {
  it('stamps a VEC4 COLOR_0 with AO=1 on every vertex', () => {
    const geom = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3)
    stampConvexityColor0(geom)
    const c = geom.getAttribute('color') as THREE.BufferAttribute
    expect(c).toBeTruthy()
    expect(c.itemSize).toBe(4)
    // G channel is the AO multiplier — must be 1 (no darkening) everywhere, else
    // the vinyl material floors the prop to 0.55×.
    for (let i = 0; i < c.count; i++) expect(c.getY(i)).toBe(1)
  })

  it('lights up box edges/corners but leaves face interiors clean', () => {
    // A subdivided box is the worst case: welding must reconnect the split
    // hard-edge corners so they read convex (A < 1) while the coplanar face
    // interiors stay flat (A ≈ 1). Without welding every vert reads A = 1.
    const geom = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3)
    stampConvexityColor0(geom)
    const { min, max } = alphaRange(geom)
    expect(min).toBeLessThan(0.85) // edges/corners are worn
    expect(max).toBeGreaterThan(0.98) // face interiors stay clean
  })

  it('wears a smooth sphere far more gently than a hard-edged box', () => {
    // A smooth sphere has its edges near-tangent to the (smooth) normal → low,
    // near-uniform convexity: gentle wear, no sharp drybrushed corners like the
    // box. The contrast is the whole point of the welded measure.
    const sphere = new THREE.SphereGeometry(1, 32, 24)
    stampConvexityColor0(sphere)
    const box = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3)
    stampConvexityColor0(box)
    const s = alphaRange(sphere)
    expect(s.min).toBeGreaterThan(0.7) // never the box's near-0 corner bleach
    expect(s.mean).toBeGreaterThan(alphaRange(box).mean + 0.25) // much less worn overall
  })

  it('is a no-op when a color attribute already exists', () => {
    const geom = new THREE.BoxGeometry(1, 1, 1)
    const existing = new THREE.BufferAttribute(
      new Float32Array(geom.getAttribute('position').count * 4).fill(0.5),
      4,
    )
    geom.setAttribute('color', existing)
    stampConvexityColor0(geom)
    expect(geom.getAttribute('color')).toBe(existing)
  })
})
