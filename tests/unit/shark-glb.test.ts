/**
 * `createGlbShark` — the rigged-GLB great white reused as the out-of-bounds
 * breach predator. Verifies it satisfies the `Shark` interface the breach
 * sequence drives (group, mouth marker at the head, mixer-driven `update`,
 * safe `dispose`). The on-GPU look is proven separately (the same `cc0/shark`
 * asset is captured swimming in the aquarium); these pin the wiring.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createGlbShark } from '../../src/engine/render/shark'
import type { LoadedProp } from '../../src/game/assets/prop-loader'

function stubRiggedShark(): LoadedProp {
  const root = new THREE.Group()
  root.name = 'prop_shark_root'
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  body.name = 'body'
  root.add(body)
  // Trivial Swim clip: drives "body" from y=0 to y=1 over 1s.
  const track = new THREE.VectorKeyframeTrack('body.position', [0, 1], [0, 0, 0, 0, 1, 0])
  const clip = new THREE.AnimationClip('Swim', 1, [track])
  return {
    root,
    colliders: [],
    extras: { prop_id: 'shark', category: 'fauna' },
    animations: [clip],
  }
}

describe('createGlbShark', () => {
  it('builds a Shark whose group holds the cloned model', () => {
    const s = createGlbShark(stubRiggedShark())
    expect(s.group).toBeInstanceOf(THREE.Object3D)
    expect(s.group.getObjectByName('body')).toBeDefined()
  })

  it('exposes a mouth marker at the head end (scaled native +Z)', () => {
    const s = createGlbShark(stubRiggedShark())
    const v = s.mouthWorldPosition(new THREE.Vector3())
    // GLB_MOUTH.z (6.2) × GLB_SCALE (9/14.8 ≈ 0.61) ≈ 3.77, group at origin.
    expect(v.z).toBeCloseTo(3.77, 1)
    expect(Math.abs(v.x)).toBeLessThan(0.01)
  })

  it('setJawOpen is a safe no-op (no jaw bone in the rig)', () => {
    const s = createGlbShark(stubRiggedShark())
    expect(() => {
      s.setJawOpen(1)
      s.setJawOpen(0)
    }).not.toThrow()
  })

  it('update advances the Swim mixer (body deforms)', () => {
    const s = createGlbShark(stubRiggedShark())
    const body = s.group.getObjectByName('body')!
    expect(body.position.y).toBeCloseTo(0, 5)
    s.update(0.5) // halfway through the 1s clip → y ≈ 0.5
    expect(body.position.y).toBeGreaterThan(0.3)
  })

  it('dispose detaches the group (shared buffers left intact)', () => {
    const scene = new THREE.Scene()
    const s = createGlbShark(stubRiggedShark())
    scene.add(s.group)
    expect(scene.children).toContain(s.group)
    s.dispose()
    expect(scene.children).not.toContain(s.group)
  })
})
