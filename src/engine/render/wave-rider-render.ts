/**
 * Wave-rider render system — INSTANCED.
 *
 * Wave-riders (buoys, logs) are placed in fields: a track's marker wall can run
 * ~100 buoys, and every one resolves to the same prop GLB (one geometry, one
 * material). The old path cloned the GLB per entity, so a 100-buoy wall cost ~100
 * draw calls (×shadow/reflection passes). This renders each ASSET's whole field
 * through one `InstancedMesh` per sub-mesh instead: one draw for the wall.
 *
 * Two visual sources, in order:
 *
 *   1. **Asset GLB, instanced** — entities bound to a `LoadedProp` (the
 *      production path) share an instanced field per asset. Per frame each
 *      entity's bob is written into its instance matrix; per entity a small,
 *      deterministic scale + brightness jitter is baked in so the field reads as
 *      a scattered set of real buoys, not a grid of identical clones.
 *
 *   2. **Primitive fallback, per-clone** — the `?waveriders=1` validation scene
 *      spawns raw WaveRiders with no prop GLB; those few keep the simple
 *      cylinder-and-cap clone (no field to instance).
 */

import { query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { LoadedProp } from '@/game/assets/prop-loader'
import { TransformStore } from '@/game/components'
import {
  type WaveRiderArchetypeId,
  WaveRiderStore,
  WaveRiderTag,
} from '@/game/components/wave-rider'
import { ExportedKind } from '../asset-kinds'

export type WaveRiderRenderSystem = {
  /** Walk WaveRider entities, lazily mint instances, sync transforms. */
  render(): void
  /** Tear down all created meshes + materials. */
  dispose(): void
}

/** Resolves a wave-rider entity id to the prop GLB it was instanced from, when
 *  applicable. Returns undefined for entities spawned outside the asset-prop
 *  pipeline (the `?waveriders=1` test scene). */
export type WaveRiderAssetResolver = (eid: number) => LoadedProp | undefined

export type WaveRiderRenderOpts = {
  assetResolver?: WaveRiderAssetResolver
}

/** Per-asset instanced-field capacity. A track's buoy wall runs ~100; 256 leaves
 *  headroom without a wasteful instance buffer. */
const FIELD_CAPACITY = 256

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

type FieldSubmesh = {
  inst: THREE.InstancedMesh
  /** Prototype sub-mesh transform relative to prop_root (root transform cancelled). */
  rel: THREE.Matrix4
}

type Field = {
  group: THREE.Group
  submeshes: FieldSubmesh[]
  /** prop_root's authored scale — the per-clone path kept it, so re-apply it. */
  rootScale: THREE.Vector3
  eidToIndex: Map<number, number>
  free: number[]
  next: number
}

/** Deterministic 0..1 hash for per-instance jitter (no Math.random → stable
 *  across reloads). */
function hash01(n: number, salt: number): number {
  const s = Math.sin((n + 1) * (12.9898 + salt * 4.1414)) * 43758.5453
  return s - Math.floor(s)
}

export function createWaveRiderRenderSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  opts: WaveRiderRenderOpts = {},
): WaveRiderRenderSystem {
  // Asset-backed entities → one instanced field per LoadedProp.
  const fields = new Map<LoadedProp, Field>()
  // Primitive-fallback entities (test scene) → per-entity clone.
  const primitives = new Map<number, THREE.Object3D>()
  const ownedGeometries = new Set<THREE.BufferGeometry>()
  const ownedMaterials = new Set<THREE.Material>()

  // Per-frame scratch.
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scaleV = new THREE.Vector3()
  const placement = new THREE.Matrix4()
  const instM = new THREE.Matrix4()
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const jitterColor = new THREE.Color()

  function buildField(loaded: LoadedProp): Field {
    const group = new THREE.Group()
    group.name = 'wave-riders:instanced'
    loaded.root.updateWorldMatrix(true, true)
    const rootInv = new THREE.Matrix4().copy(loaded.root.matrixWorld).invert()
    const rootScale = new THREE.Vector3()
    loaded.root.matrixWorld.decompose(tmpPos, tmpQuat, rootScale)

    const submeshes: FieldSubmesh[] = []
    loaded.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const kind = (mesh.userData as { kind?: unknown })?.kind
      if (kind === ExportedKind.COLLIDER || kind === ExportedKind.SOCKET) return
      const inst = new THREE.InstancedMesh(
        mesh.geometry as THREE.BufferGeometry,
        mesh.material as THREE.Material,
        FIELD_CAPACITY,
      )
      inst.name = `wave-rider:${loaded.extras.prop_id}`
      inst.castShadow = true
      inst.receiveShadow = true
      // Buoy/log fields are spread along a wall; the prototype's origin-local
      // bounding sphere would wrongly cull the whole field.
      inst.frustumCulled = false
      inst.count = 0
      // Per-instance brightness jitter (multiplies albedo). Defaults white so an
      // unclaimed slot reads its source colour.
      inst.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(FIELD_CAPACITY * 3).fill(1),
        3,
      )
      for (let i = 0; i < FIELD_CAPACITY; i++) inst.setMatrixAt(i, ZERO_MATRIX)
      inst.instanceMatrix.needsUpdate = true
      inst.userData.kind = 'prop'
      submeshes.push({
        inst,
        rel: new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld),
      })
      group.add(inst)
    })
    scene.add(group)
    const field: Field = { group, submeshes, rootScale, eidToIndex: new Map(), free: [], next: 0 }
    fields.set(loaded, field)
    return field
  }

  /** Claim an instance slot for `eid`, baking in its per-instance jitter colour. */
  function claim(field: Field, eid: number): number {
    const idx = field.free.pop() ?? field.next++
    field.eidToIndex.set(eid, idx)
    const bright = 0.82 + hash01(idx, 1) * 0.32 // 0.82..1.14
    jitterColor.setRGB(bright, bright, bright)
    for (const sm of field.submeshes) {
      sm.inst.instanceColor?.setXYZ(idx, jitterColor.r, jitterColor.g, jitterColor.b)
      if (sm.inst.instanceColor) sm.inst.instanceColor.needsUpdate = true
    }
    return idx
  }

  function buildPrimitive(archetype: WaveRiderArchetypeId | undefined): THREE.Object3D {
    const group = new THREE.Group()
    if (archetype === 'buoy') {
      const bodyGeom = new THREE.CylinderGeometry(0.38, 0.42, 0.9, 18, 1, false)
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd83d2a, roughness: 0.55 })
      const capGeom = new THREE.SphereGeometry(0.18, 16, 12)
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xfff0a0,
        emissive: 0xffaa00,
        emissiveIntensity: 1.4,
        roughness: 0.4,
      })
      const body = new THREE.Mesh(bodyGeom, bodyMat)
      const cap = new THREE.Mesh(capGeom, capMat)
      cap.position.y = 0.6
      body.castShadow = true
      cap.castShadow = true
      group.add(body, cap)
      ownedGeometries.add(bodyGeom).add(capGeom)
      ownedMaterials.add(bodyMat).add(capMat)
    } else {
      const logGeom = new THREE.CylinderGeometry(0.3, 0.3, 2.4, 14, 1, false)
      const logMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.88 })
      const log = new THREE.Mesh(logGeom, logMat)
      log.rotation.z = Math.PI / 2
      log.castShadow = true
      group.add(log)
      ownedGeometries.add(logGeom)
      ownedMaterials.add(logMat)
    }
    return group
  }

  function render(): void {
    const entities = query(sim, [WaveRiderTag])
    for (const eid of entities) {
      const wr = WaveRiderStore.get(eid)
      if (!wr) continue
      const t = TransformStore.get(eid)
      if (!t) continue
      const loaded = opts.assetResolver?.(eid)

      if (loaded) {
        const field = fields.get(loaded) ?? buildField(loaded)
        let idx = field.eidToIndex.get(eid)
        if (idx === undefined) idx = claim(field, eid)
        // The per-clone path kept prop_root's authored scale; re-apply it (rel
        // cancelled the root transform) plus a small per-instance size jitter so
        // the field doesn't read as identical clones.
        const sj = 0.88 + hash01(idx, 2) * 0.24 // 0.88..1.12
        scaleV.set(field.rootScale.x * sj, field.rootScale.y * sj, field.rootScale.z * sj)
        pos.set(t.x, t.y, t.z)
        quat.set(t.qx, t.qy, t.qz, t.qw)
        placement.compose(pos, quat, scaleV)
        for (const sm of field.submeshes) {
          instM.multiplyMatrices(placement, sm.rel)
          sm.inst.setMatrixAt(idx, instM)
        }
      } else {
        let mesh = primitives.get(eid)
        if (!mesh) {
          mesh = buildPrimitive(wr.archetype)
          scene.add(mesh)
          primitives.set(eid, mesh)
        }
        mesh.position.set(t.x, t.y, t.z)
        mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw)
      }
    }

    // Flush each field: draw the high-water mark of claimed slots.
    for (const field of fields.values()) {
      for (const sm of field.submeshes) {
        sm.inst.count = field.next
        sm.inst.instanceMatrix.needsUpdate = true
      }
    }
  }

  function dispose(): void {
    for (const field of fields.values()) {
      for (const sm of field.submeshes) sm.inst.dispose()
      scene.remove(field.group)
    }
    fields.clear()
    for (const mesh of primitives.values()) scene.remove(mesh)
    primitives.clear()
    for (const g of ownedGeometries) g.dispose()
    for (const m of ownedMaterials) m.dispose()
    ownedGeometries.clear()
    ownedMaterials.clear()
  }

  return { render, dispose }
}
