import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyFoliageSway,
  applyFoliageSwayToMesh,
  debugSwayState,
  setFoliageSwayBackend,
  swayPhaseFromPosition,
  updateSwayTime,
  updateWind,
} from '../../src/engine/render/foliage-sway'

const TWO_PI = 6.2831853

const NODE_SWAYED = Symbol.for('hoverbike.foliageSwayNodeSwayed')

function makeMesh(material: THREE.Material | THREE.Material[]): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1)
  return new THREE.Mesh(geo, material)
}

// The module defaults to the WebGPU backend; tests that want the WebGL2
// path opt in explicitly and reset afterwards so order can't leak.
afterEach(() => {
  setFoliageSwayBackend('webgpu')
})

describe('shared wind / time state', () => {
  it('updateWind / updateSwayTime are reflected in debugSwayState', () => {
    updateSwayTime(3.5)
    updateWind({ x: 1, z: 0 }, 2, 0.9)
    const s = debugSwayState()
    expect(s.time).toBe(3.5)
    expect(s.windX).toBeCloseTo(2, 5)
    expect(s.windZ).toBeCloseTo(0, 5)
    expect(s.freq).toBeCloseTo(0.9, 5)
  })

  it('updateWind normalizes the direction before scaling by strength', () => {
    // (3,4) normalizes to (0.6, 0.8); strength 5 → (3, 4).
    updateWind({ x: 3, z: 4 }, 5, 1.2)
    const s = debugSwayState()
    expect(s.windX).toBeCloseTo(3, 4)
    expect(s.windZ).toBeCloseTo(4, 4)
  })
})

describe('applyFoliageSwayToMesh — WebGPU node path', () => {
  it('swaps a plain MeshStandardMaterial to a node material with positionNode', () => {
    setFoliageSwayBackend('webgpu')
    const src = new THREE.MeshStandardMaterial({ name: 'mat_foliage_palm' })
    src.color.setRGB(0.2, 0.6, 0.3)
    src.roughness = 0.7
    const mesh = makeMesh(src)

    applyFoliageSwayToMesh(mesh)

    const next = mesh.material as MeshStandardNodeMaterial
    expect(next).not.toBe(src)
    expect((next as { isNodeMaterial?: boolean }).isNodeMaterial).toBe(true)
    expect(next.positionNode).not.toBeNull()
    expect(next.positionNode).toBeDefined()
    // Preserves visual props.
    expect(next.name).toBe('mat_foliage_palm')
    expect(next.roughness).toBeCloseTo(0.7, 5)
    expect(next.color.r).toBeCloseTo(0.2, 5)
    expect(next.color.g).toBeCloseTo(0.6, 5)
    expect(next.vertexColors).toBe(true)
    expect((next.userData as Record<symbol, unknown>)[NODE_SWAYED]).toBe(true)
  })

  it('is idempotent — calling twice does not double-swap', () => {
    setFoliageSwayBackend('webgpu')
    const mesh = makeMesh(new THREE.MeshStandardMaterial({ name: 'mat_foliage_x' }))
    applyFoliageSwayToMesh(mesh)
    const first = mesh.material
    applyFoliageSwayToMesh(mesh)
    expect(mesh.material).toBe(first)
  })

  it('handles array-material meshes per slot', () => {
    setFoliageSwayBackend('webgpu')
    const a = new THREE.MeshStandardMaterial({ name: 'mat_foliage_a' })
    const b = new THREE.MeshStandardMaterial({ name: 'mat_foliage_b' })
    const mesh = makeMesh([a, b])

    applyFoliageSwayToMesh(mesh)

    const mats = mesh.material as MeshStandardNodeMaterial[]
    expect(Array.isArray(mats)).toBe(true)
    expect(mats).toHaveLength(2)
    for (const m of mats) {
      expect((m as { isNodeMaterial?: boolean }).isNodeMaterial).toBe(true)
      expect(m.positionNode).toBeDefined()
      expect(m.positionNode).not.toBeNull()
    }
  })

  it('patches an already-node material in place (no replacement)', () => {
    setFoliageSwayBackend('webgpu')
    const node = new MeshStandardNodeMaterial()
    node.name = 'mat_foliage_node'
    const mesh = makeMesh(node)

    applyFoliageSwayToMesh(mesh)

    // Same instance — node materials get a positionNode attached in place.
    expect(mesh.material).toBe(node)
    expect(node.positionNode).not.toBeNull()
    expect(node.positionNode).toBeDefined()
  })
})

describe('applyFoliageSwayToMesh — WebGL2 path', () => {
  it('patches the material in place via onBeforeCompile (no swap)', () => {
    setFoliageSwayBackend('webgl2')
    const src = new THREE.MeshStandardMaterial({ name: 'mat_foliage_palm' })
    const mesh = makeMesh(src)

    applyFoliageSwayToMesh(mesh)

    // No material replacement under WebGL2.
    expect(mesh.material).toBe(src)
    expect(src.vertexColors).toBe(true)
    // onBeforeCompile hook is installed.
    expect(typeof src.onBeforeCompile).toBe('function')
  })

  it('handles array-material meshes under WebGL2 without swapping slots', () => {
    setFoliageSwayBackend('webgl2')
    const a = new THREE.MeshStandardMaterial({ name: 'mat_foliage_a' })
    const b = new THREE.MeshStandardMaterial({ name: 'mat_foliage_b' })
    const mesh = makeMesh([a, b])

    applyFoliageSwayToMesh(mesh)

    const mats = mesh.material as THREE.Material[]
    expect(mats[0]).toBe(a)
    expect(mats[1]).toBe(b)
  })
})

describe('swayPhaseFromPosition — per-mesh phase hash', () => {
  it('is deterministic and within [0, 2π)', () => {
    const a = swayPhaseFromPosition(12.5, -3.2)
    const b = swayPhaseFromPosition(12.5, -3.2)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(TWO_PI)
  })

  it('gives distinct phases for distinct positions (desyncs lockstep palms)', () => {
    const phases = [
      swayPhaseFromPosition(0, 0),
      swayPhaseFromPosition(5, 0),
      swayPhaseFromPosition(0, 5),
      swayPhaseFromPosition(-12.3, 7.1),
    ]
    const unique = new Set(phases.map((p) => p.toFixed(4)))
    expect(unique.size).toBe(phases.length)
  })
})

describe('applyFoliageSwayToMesh — InstancedMesh node path', () => {
  it('converts an InstancedMesh foliage material with a positionNode', () => {
    setFoliageSwayBackend('webgpu')
    const geo = new THREE.PlaneGeometry(1, 1)
    const src = new THREE.MeshStandardMaterial({ name: 'mat_foliage_palm' })
    const inst = new THREE.InstancedMesh(geo, src, 8)
    expect(inst.isInstancedMesh).toBe(true)

    applyFoliageSwayToMesh(inst)

    const next = inst.material as unknown as MeshStandardNodeMaterial
    expect(next).not.toBe(src)
    expect((next as { isNodeMaterial?: boolean }).isNodeMaterial).toBe(true)
    // The instanced path adds a per-instance phase term; the node still
    // resolves to a valid positionNode.
    expect(next.positionNode).not.toBeNull()
    expect(next.positionNode).toBeDefined()
    expect((next.userData as Record<symbol, unknown>)[NODE_SWAYED]).toBe(true)
  })
})

describe('applyFoliageSway — legacy in-place export still works', () => {
  it('is idempotent and sets vertexColors', () => {
    const m = new THREE.MeshStandardMaterial({ name: 'mat_foliage_legacy' })
    applyFoliageSway(m)
    const hook = m.onBeforeCompile
    applyFoliageSway(m)
    // Second call is a no-op — same hook reference (PATCHED guard).
    expect(m.onBeforeCompile).toBe(hook)
    expect(m.vertexColors).toBe(true)
  })
})
