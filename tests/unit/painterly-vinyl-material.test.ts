/**
 * Painterly-vinyl size-shared materials — the material-count collapse that
 * feeds the shader pre-warm (three's WebGPU pipeline cache keys per material
 * INSTANCE, so every vinyl twin is a main-thread node-build + codegen).
 *
 * Covers:
 *  - ``applyVinylMaterialToScene`` builds ONE vinyl material per SOURCE
 *    material regardless of mesh size (the old per-size-bucket forking is
 *    gone), while distinct sources still convert separately.
 *  - Every converted mesh carries the per-object userData stamps the shared
 *    material reads at render time (brush freq/weights, waterline band scale,
 *    object scale), with values matching the old baked-path formulas exactly.
 *  - A mesh that arrives already WEARING a size-shared vinyl (a clone sharing
 *    the material by reference) gets stamped too — an unstamped wearer would
 *    read undefined → NaN uniforms.
 *  - The skip rules survive the rewrite (terrain names, skip kinds, foliage).
 *  - The live Brush tuner still re-dials stroke size end-to-end: a
 *    ``setVinylBrush`` re-stamps every mesh from its recorded size.
 *  - ``createPropsMesh`` shares one vinyl material across assets of different
 *    sizes and stamps each InstancedMesh with its own asset size.
 */

import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'
import { BRUSH_TEX_TILE, brushScaleWeights } from '../../src/engine/render/brush-strokes'
import {
  clearBrushTargets,
  setVinylBrush,
  VINYL_BRUSH_DEFAULTS,
} from '../../src/engine/render/brush-tuning-service'
import {
  applyVinylMaterialToScene,
  buildVinylMaterial,
  isSizePerObjectVinyl,
  stampVinylObjectSize,
} from '../../src/engine/render/painterly-vinyl-material'
import { createPropsMesh, type PropAssetRegistry } from '../../src/engine/render/props-mesh'
import type { LoadedProp } from '../../src/game/assets/prop-loader'
import type { Prop } from '../../src/game/tracks/types'

/** A mesh whose geometry bbox × scale gives `size` metres on its longest axis. */
function meshOfSize(size: number, material: THREE.Material, name = ''): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.5, size * 0.25), material)
  mesh.name = name
  return mesh
}

type Stamps = {
  vinylPropSize: number
  vinylObjectScale: number
  vinylBandScale: number
  vinylBrushFreq: number
  vinylBrushWeights: { x: number; y: number; z: number }
}

function stampsOf(obj: THREE.Object3D): Stamps {
  return obj.userData as unknown as Stamps
}

/** The baked path's frequency formula (textured sheet): TILE / (scale·cappedSize). */
function expectedFreq(size: number, brushScale = VINYL_BRUSH_DEFAULTS.brushScale, cap = 6): number {
  return (1 / Math.max(brushScale * Math.min(size, cap), 0.02)) * BRUSH_TEX_TILE
}

beforeEach(() => clearBrushTargets())

describe('applyVinylMaterialToScene — size-shared materials', () => {
  it('builds ONE vinyl material per source material across mesh sizes', () => {
    const src = new THREE.MeshStandardMaterial({ color: 0x8899aa })
    const root = new THREE.Group()
    const small = meshOfSize(1, src)
    const mid = meshOfSize(8, src)
    const big = meshOfSize(30, src)
    root.add(small, mid, big)

    const count = applyVinylMaterialToScene(root)

    expect(count).toBe(1)
    expect(small.material).toBe(mid.material)
    expect(mid.material).toBe(big.material)
    const vinyl = small.material as THREE.Material
    expect(vinyl.name.startsWith('mat_vinyl')).toBe(true)
    expect(isSizePerObjectVinyl(vinyl)).toBe(true)
  })

  it('still converts distinct source materials separately', () => {
    const root = new THREE.Group()
    const a = meshOfSize(2, new THREE.MeshStandardMaterial())
    const b = meshOfSize(2, new THREE.MeshStandardMaterial())
    root.add(a, b)
    expect(applyVinylMaterialToScene(root)).toBe(2)
    expect(a.material).not.toBe(b.material)
  })

  it('stamps each mesh with its own exact size inputs (baked-path formulas)', () => {
    const src = new THREE.MeshStandardMaterial()
    const root = new THREE.Group()
    const small = meshOfSize(1, src)
    const big = meshOfSize(30, src)
    root.add(small, big)
    applyVinylMaterialToScene(root)

    const s = stampsOf(small)
    expect(s.vinylPropSize).toBeCloseTo(1, 5)
    expect(s.vinylBandScale).toBeCloseTo(1 / 6, 5)
    expect(s.vinylBrushFreq).toBeCloseTo(expectedFreq(1), 5)
    const [wc, wm, wf] = brushScaleWeights(1)
    expect(s.vinylBrushWeights.x).toBeCloseTo(wc, 5)
    expect(s.vinylBrushWeights.y).toBeCloseTo(wm, 5)
    expect(s.vinylBrushWeights.z).toBeCloseTo(wf, 5)

    const b = stampsOf(big)
    expect(b.vinylPropSize).toBeCloseTo(30, 5)
    // Band scale clamps at 1 on big props; brush size caps at 6 m.
    expect(b.vinylBandScale).toBe(1)
    expect(b.vinylBrushFreq).toBeCloseTo(expectedFreq(30), 5)
    const [bc, bm, bf] = brushScaleWeights(6)
    expect(b.vinylBrushWeights.x).toBeCloseTo(bc, 5)
    expect(b.vinylBrushWeights.y).toBeCloseTo(bm, 5)
    expect(b.vinylBrushWeights.z).toBeCloseTo(bf, 5)
  })

  it('folds the mesh world scale into the stamped size', () => {
    const src = new THREE.MeshStandardMaterial()
    const root = new THREE.Group()
    const mesh = meshOfSize(2, src)
    mesh.scale.setScalar(5) // 2 m geometry × 5 → 10 m characteristic size
    root.add(mesh)
    applyVinylMaterialToScene(root)
    expect(stampsOf(mesh).vinylPropSize).toBeCloseTo(10, 5)
    expect(stampsOf(mesh).vinylObjectScale).toBeCloseTo(5, 5)
  })

  it('stamps a mesh that already wears a size-shared vinyl (clone path)', () => {
    const src = new THREE.MeshStandardMaterial()
    const root = new THREE.Group()
    const original = meshOfSize(4, src)
    root.add(original)
    applyVinylMaterialToScene(root)

    // A new mesh sharing the converted material by reference, with NO stamps —
    // e.g. a clone whose userData was reset. The pass must stamp it even
    // though there is nothing left to convert.
    const wearer = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), original.material)
    const cloneRoot = new THREE.Group()
    cloneRoot.add(wearer)
    const count = applyVinylMaterialToScene(cloneRoot)

    expect(count).toBe(0)
    expect(stampsOf(wearer).vinylPropSize).toBeCloseTo(12, 5)
    expect(stampsOf(wearer).vinylBrushFreq).toBeCloseTo(expectedFreq(12), 5)
  })

  it('keeps the skip rules: terrain names, skip kinds, owned passes', () => {
    const root = new THREE.Group()
    const terrain = meshOfSize(50, new THREE.MeshStandardMaterial(), 'terrain_mesh')
    const horizon = meshOfSize(50, new THREE.MeshStandardMaterial())
    horizon.userData.kind = 'horizon'
    const foliage = meshOfSize(3, new THREE.MeshStandardMaterial())
    ;(foliage.material as THREE.Material).name = 'mat_foliage_palm'
    root.add(terrain, horizon, foliage)

    const count = applyVinylMaterialToScene(root)
    expect(count).toBe(0)
    expect((terrain.material as THREE.Material).name).not.toMatch(/^mat_vinyl/)
    expect((horizon.material as THREE.Material).name).not.toMatch(/^mat_vinyl/)
    expect((foliage.material as THREE.Material).name).toBe('mat_foliage_palm')
    expect(stampsOf(terrain).vinylPropSize).toBeUndefined()
  })

  it('re-stamps every mesh when the Brush tuner re-dials stroke size', () => {
    const src = new THREE.MeshStandardMaterial()
    const root = new THREE.Group()
    const small = meshOfSize(1, src)
    const big = meshOfSize(30, src)
    root.add(small, big)
    applyVinylMaterialToScene(root)

    setVinylBrush({ brushScale: 0.24 })

    // Frequency halves (scale doubled), each mesh from its OWN recorded size.
    expect(stampsOf(small).vinylBrushFreq).toBeCloseTo(expectedFreq(1, 0.24), 5)
    expect(stampsOf(big).vinylBrushFreq).toBeCloseTo(expectedFreq(30, 0.24), 5)

    // Cap re-dial shifts the big mesh's capped size (and its weights).
    setVinylBrush({ brushScale: 0.12, brushPropSizeCap: 12 })
    expect(stampsOf(big).vinylBrushFreq).toBeCloseTo(expectedFreq(30, 0.12, 12), 5)
    const [wc] = brushScaleWeights(12)
    expect(stampsOf(big).vinylBrushWeights.x).toBeCloseTo(wc, 5)
  })

  it('marks only size-shared twins (the baked path is unchanged)', () => {
    const baked = buildVinylMaterial(new THREE.MeshStandardMaterial(), { propSize: 3 })
    expect(isSizePerObjectVinyl(baked)).toBe(false)
    const shared = buildVinylMaterial(new THREE.MeshStandardMaterial(), { sizePerObject: true })
    expect(isSizePerObjectVinyl(shared)).toBe(true)
  })

  it('stamp values survive a JSON round-trip (Object3D.clone copies userData)', () => {
    const mesh = meshOfSize(4, new THREE.MeshStandardMaterial())
    stampVinylObjectSize(mesh, 4, 1, {
      brushScale: VINYL_BRUSH_DEFAULTS.brushScale,
      brushPropSizeCap: VINYL_BRUSH_DEFAULTS.brushPropSizeCap,
    })
    const roundTripped = JSON.parse(JSON.stringify(mesh.userData)) as Stamps
    expect(roundTripped.vinylBrushFreq).toBeCloseTo(expectedFreq(4), 5)
    expect(roundTripped.vinylBrushWeights.x).toBeCloseTo(brushScaleWeights(4)[0], 5)
  })
})

describe('createPropsMesh — shared vinyl across asset sizes', () => {
  function fakeAsset(propId: string, size: number, material: THREE.Material): LoadedProp {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(size, size, size), material))
    return {
      root,
      colliders: [],
      animations: [],
      extras: { prop_id: propId, category: 'test' },
    }
  }
  function placement(assetId: string, x: number): Prop {
    return {
      type: 'asset',
      assetId,
      position: { x, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 1, y: 1, z: 1 },
    } as Prop
  }

  it('two assets of different sizes share ONE vinyl material, each stamped', () => {
    const sharedSrc = new THREE.MeshStandardMaterial({ color: 0x445566 })
    const assets: PropAssetRegistry = new Map([
      ['crate_small', fakeAsset('crate_small', 1, sharedSrc)],
      ['crate_big', fakeAsset('crate_big', 9, sharedSrc)],
    ])
    const group = createPropsMesh([placement('crate_small', 0), placement('crate_big', 20)], assets)

    const instanced = group.children.filter(
      (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh,
    )
    expect(instanced.length).toBe(2)
    const [a, b] = instanced as [THREE.InstancedMesh, THREE.InstancedMesh]
    expect(a.material).toBe(b.material)
    expect(isSizePerObjectVinyl(a.material as THREE.Material)).toBe(true)
    const sizes = instanced.map((m) => stampsOf(m).vinylPropSize).sort((x, y) => x - y)
    expect(sizes[0]).toBeCloseTo(1, 4)
    expect(sizes[1]).toBeCloseTo(9, 4)
  })
})
