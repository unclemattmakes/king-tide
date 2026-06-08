/**
 * Instanced AI/peer bike field.
 *
 * The AI field all resolves to the same racer GLB (the render registry only
 * carries the player's variant + the racer default — see render-systems.ts), so
 * the only per-bike variation is two material tints: `mat_bike_*_livery` (body)
 * and `mat_bike_*_glow` (exhaust). That makes the field a textbook instancing
 * target: one `InstancedMesh` per visual sub-mesh, each sharing a SINGLE vinyl
 * material across the whole field, with the livery / exhaust colour supplied as a
 * per-instance `aTint` attribute the material reads (painterly-vinyl-material.ts
 * `tintAttribute`). Result: the whole field draws in one call per sub-mesh
 * instead of one object tree per bike, and the pre-warm compiles one material set
 * instead of one per clone.
 *
 * The player bike + the Time-Trial ghost stay on the per-clone path
 * (render-systems.ts) — the hero bike the player stares at is left untouched, and
 * the ghost needs its bespoke hologram material.
 */
import * as THREE from 'three'
import type { LoadedBike } from '@/game/assets/bike-loader'
import { ExportedKind } from '../asset-kinds'
import { stampConvexityColor0 } from './edge-wear-convexity'
import { buildVinylMaterial } from './painterly-vinyl-material'

/** Per-instance livery/exhaust colour attribute the vinyl material samples. */
const TINT_ATTR = 'aTint'

type FieldSubmesh = {
  inst: THREE.InstancedMesh
  /** Prototype transform of this sub-mesh relative to bike_root. */
  rel: THREE.Matrix4
  /** This sub-mesh's per-instance tint buffer, or null for untinted sub-meshes
   *  (which only need per-instance transforms). */
  tint: THREE.InstancedBufferAttribute | null
  /** Which colour drives this sub-mesh's tint. */
  tintKind: 'livery' | 'exhaust' | null
}

export type InstancedBikeField = {
  group: THREE.Group
  readonly capacity: number
  /** Stamp instance `i`'s livery + exhaust colour (hex). Colours don't change per
   *  frame, so call once when a bike claims an index. */
  setColors(i: number, liveryHex: number, exhaustHex: number): void
  /** Set instance `i`'s world transform for this frame. */
  setMatrix(i: number, m: THREE.Matrix4): void
  /** Park instance `i` (zero-scale → not visible) when its bike despawns. */
  park(i: number): void
  /** How many instances to draw (high-water mark of claimed indices). */
  setDrawCount(n: number): void
  /** Push the frame's transform writes to the GPU. */
  flush(): void
  /** Dev/test read-back: per active instance, its livery colour (linear RGB) +
   *  world position. Lets a harness assert the field renders distinct, placed
   *  bikes without depending on camera framing. */
  debug(): Array<{ livery: [number, number, number]; x: number; y: number; z: number }>
  dispose(): void
}

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

/**
 * Build an instanced render group for one bike GLB at a given field capacity.
 * `visualScale` matches the per-clone path's root scale; `brush`/`edgeWear` match
 * its vinyl options so the instanced field reads identically to a cloned bike.
 */
export function createInstancedBikeField(
  loaded: LoadedBike,
  capacity: number,
  opts: { brush: number; edgeWear: number; visualScale: number },
): InstancedBikeField {
  const group = new THREE.Group()
  group.name = 'bikes:instanced'
  const submeshes: FieldSubmesh[] = []

  // One shared vinyl material per source material, so all `_livery` sub-meshes
  // share a material (and all `_glow` ones theirs) — that's the compile win.
  const matCache = new Map<THREE.Material, THREE.Material>()

  loaded.root.updateWorldMatrix(true, true)
  const rootInv = new THREE.Matrix4().copy(loaded.root.matrixWorld).invert()

  loaded.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const kind = (mesh.userData as { kind?: unknown })?.kind
    if (kind === ExportedKind.COLLIDER || kind === ExportedKind.SOCKET) return
    const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.Material
      | undefined
    if (!srcMat) return

    const matName = srcMat.name ?? ''
    const tintKind: FieldSubmesh['tintKind'] = matName.includes('_livery')
      ? 'livery'
      : matName.includes('_glow')
        ? 'exhaust'
        : null

    // Clone the geometry so the per-instance attribute + convexity stamp don't
    // touch the prototype geometry (shared by reference with the player's clone).
    const geom = (mesh.geometry as THREE.BufferGeometry).clone()
    stampConvexityColor0(geom) // edge-wear data; no-op if the GLB already carries COLOR_0

    let tint: THREE.InstancedBufferAttribute | null = null
    if (tintKind) {
      // Default white so an unclaimed instance reads its source colour, not black.
      const data = new Float32Array(capacity * 3).fill(1)
      tint = new THREE.InstancedBufferAttribute(data, 3)
      tint.setUsage(THREE.DynamicDrawUsage)
      geom.setAttribute(TINT_ATTR, tint)
    }

    let vinyl = matCache.get(srcMat)
    if (!vinyl) {
      vinyl = buildVinylMaterial(srcMat, {
        brush: opts.brush,
        edgeWear: opts.edgeWear,
        brushObjectSpace: true,
        ...(tintKind ? { tintAttribute: TINT_ATTR } : {}),
        ...(tintKind === 'exhaust' ? { emissiveFromTint: true } : {}),
      })
      matCache.set(srcMat, vinyl)
    }

    const inst = new THREE.InstancedMesh(geom, vinyl, capacity)
    inst.castShadow = true
    inst.receiveShadow = true
    // Bikes are spread across the track and always near the action; the prototype
    // sub-mesh's origin-local bounding sphere would wrongly cull the whole field.
    inst.frustumCulled = false
    inst.count = 0
    // Park every instance until claimed so stale matrices never flash a bike.
    for (let i = 0; i < capacity; i++) inst.setMatrixAt(i, ZERO_MATRIX)
    inst.instanceMatrix.needsUpdate = true
    inst.userData.kind = 'bike'

    submeshes.push({
      inst,
      rel: new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld),
      tint,
      tintKind,
    })
    group.add(inst)
  })

  const scaleM = new THREE.Matrix4().makeScale(opts.visualScale, opts.visualScale, opts.visualScale)
  const instM = new THREE.Matrix4()
  const subM = new THREE.Matrix4()
  const liveryColor = new THREE.Color()
  const exhaustColor = new THREE.Color()
  let drawCount = 0

  return {
    group,
    capacity,
    setColors(i, liveryHex, exhaustHex) {
      liveryColor.setHex(liveryHex)
      exhaustColor.setHex(exhaustHex)
      for (const sm of submeshes) {
        if (!sm.tint) continue
        const c = sm.tintKind === 'exhaust' ? exhaustColor : liveryColor
        sm.tint.setXYZ(i, c.r, c.g, c.b)
        sm.tint.needsUpdate = true
      }
    },
    setMatrix(i, m) {
      // bikeWorld already carries position + (trick-spun) rotation; fold in the
      // visual scale and each sub-mesh's prototype offset.
      instM.multiplyMatrices(m, scaleM)
      for (const sm of submeshes) {
        subM.multiplyMatrices(instM, sm.rel)
        sm.inst.setMatrixAt(i, subM)
      }
    },
    park(i) {
      for (const sm of submeshes) sm.inst.setMatrixAt(i, ZERO_MATRIX)
    },
    setDrawCount(n) {
      drawCount = Math.min(n, capacity)
      for (const sm of submeshes) sm.inst.count = drawCount
    },
    flush() {
      for (const sm of submeshes) sm.inst.instanceMatrix.needsUpdate = true
    },
    debug() {
      const livery = submeshes.find((s) => s.tintKind === 'livery') ?? submeshes[0]
      const base = submeshes[0]
      const m = new THREE.Matrix4()
      const pos = new THREE.Vector3()
      const out: Array<{ livery: [number, number, number]; x: number; y: number; z: number }> = []
      for (let i = 0; i < drawCount; i++) {
        const r = livery?.tint?.getX(i) ?? -1
        const g = livery?.tint?.getY(i) ?? -1
        const b = livery?.tint?.getZ(i) ?? -1
        base?.inst.getMatrixAt(i, m)
        pos.setFromMatrixPosition(m)
        out.push({ livery: [r, g, b], x: pos.x, y: pos.y, z: pos.z })
      }
      return out
    },
    dispose() {
      for (const sm of submeshes) {
        sm.inst.geometry.dispose()
        group.remove(sm.inst)
        sm.inst.dispose()
      }
    },
  }
}
