import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  cloneGateProp,
  PROP_GATE_AUTHOR_HALF_WIDTH,
  PROP_GATE_AUTHOR_HEIGHT,
} from '@/engine/render/gate-prop'

/** Mock the runtime template a glTF load would hand us. The real
 *  `prop_gate_mesh` lives in `tracks-src/props-library.blend` and ships
 *  via `public/assets/props/gate.glb`; we don't need to network-load it
 *  here — we just need an Object3D containing meshes-with-materials so
 *  the cloning + scaling + material-isolation logic is exercised. */
function buildFakeGateTemplate(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'gate_prop'

  // Two "posts" + one "crossbar" — same shape the library mesh ships.
  const postGeom = new THREE.CylinderGeometry(0.35, 0.35, PROP_GATE_AUTHOR_HEIGHT, 8)
  const barGeom = new THREE.CylinderGeometry(0.25, 0.25, PROP_GATE_AUTHOR_HALF_WIDTH * 2, 8)
  const sharedMaterial = new THREE.MeshStandardMaterial({ color: 0xd6d3ce })

  const left = new THREE.Mesh(postGeom, sharedMaterial)
  left.position.set(-PROP_GATE_AUTHOR_HALF_WIDTH, PROP_GATE_AUTHOR_HEIGHT / 2, 0)
  root.add(left)

  const right = new THREE.Mesh(postGeom, sharedMaterial)
  right.position.set(PROP_GATE_AUTHOR_HALF_WIDTH, PROP_GATE_AUTHOR_HEIGHT / 2, 0)
  root.add(right)

  const bar = new THREE.Mesh(barGeom, sharedMaterial)
  bar.rotation.z = Math.PI / 2
  bar.position.set(0, PROP_GATE_AUTHOR_HEIGHT, 0)
  root.add(bar)

  return root
}

describe('cloneGateProp', () => {
  it('scales the cloned mesh to match the checkpoint dimensions', () => {
    const template = buildFakeGateTemplate()
    const clone = cloneGateProp(template, 21, 9)

    // 21 / 14 = 1.5 on X, 9 / 6 = 1.5 on Y, Z untouched.
    expect(clone.root.scale.x).toBeCloseTo(1.5, 6)
    expect(clone.root.scale.y).toBeCloseTo(1.5, 6)
    expect(clone.root.scale.z).toBeCloseTo(1.0, 6)
  })

  it('renders at unit scale when the checkpoint matches the author dimensions', () => {
    const template = buildFakeGateTemplate()
    const clone = cloneGateProp(template, PROP_GATE_AUTHOR_HALF_WIDTH, PROP_GATE_AUTHOR_HEIGHT)
    expect(clone.root.scale.x).toBeCloseTo(1.0, 6)
    expect(clone.root.scale.y).toBeCloseTo(1.0, 6)
    expect(clone.root.scale.z).toBeCloseTo(1.0, 6)
  })

  it('clones materials so recoloring one gate does not tint siblings', () => {
    const template = buildFakeGateTemplate()
    const a = cloneGateProp(template, 14, 6)
    const b = cloneGateProp(template, 14, 6)

    expect(a.recolorables.length).toBe(3) // posts + crossbar
    expect(b.recolorables.length).toBe(3)

    // Materials in the two clones must be different instances — the
    // whole point of cloning them is so per-checkpoint state recolor
    // doesn't leak across gates.
    for (let i = 0; i < a.recolorables.length; i++) {
      const matA = a.recolorables[i]!.material as THREE.Material
      const matB = b.recolorables[i]!.material as THREE.Material
      expect(matA).not.toBe(matB)
    }

    // Recolor gate A; gate B must not move.
    for (const mesh of a.recolorables) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.color.setHex(0xff9933)
    }
    for (const mesh of b.recolorables) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      expect(mat.color.getHex()).toBe(0xd6d3ce)
    }
  })

  it('exposes a dispose() that releases the cloned materials', () => {
    const template = buildFakeGateTemplate()
    const clone = cloneGateProp(template, 14, 6)
    const materials = clone.recolorables.map((m) => m.material as THREE.Material)

    let disposed = 0
    for (const mat of materials) {
      const originalDispose = mat.dispose.bind(mat)
      mat.dispose = () => {
        disposed++
        originalDispose()
      }
    }

    clone.dispose()
    expect(disposed).toBe(materials.length)
  })
})
