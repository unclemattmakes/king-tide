import * as THREE from 'three'
import { isAnimatedAssetProp, type LoadedProp } from '@/game/assets/prop-loader'
import type { Prop, PropType } from '@/game/tracks/types'
import { ExportedKind } from '../asset-kinds'
import { buildPropGeometry } from './props-geometry'

/**
 * Build a Three.js group containing the visual meshes for every
 * editor-authored prop. Two render paths:
 *
 *  - **Asset props** (`type === 'asset'` with an `assetId`) share a single
 *    pre-loaded GLB across every placement. Repeated placements of the same
 *    asset are drawn with a `THREE.InstancedMesh` per visual sub-mesh — one
 *    draw call for the whole field of, say, 19 sea-boulders, instead of 19
 *    cloned object trees. Geometry + material (and therefore the `COLOR_0`
 *    toy-shading vertex colours) are shared by reference; only the per-
 *    instance matrix differs.
 *  - **Procedural props** (box/sphere/etc) are built per-placement via
 *    `buildPropGeometry` — there are only ever a handful and each can carry a
 *    bespoke colour/size, so instancing buys nothing.
 *
 * Physics colliders are attached separately by `createPropColliders`.
 *
 * Wave-rider asset props (GLBs tagged with `wave_rider_archetype` in their
 * root extras) are skipped here — those placements spawn a WaveRider entity
 * instead, and `wave-rider-render` owns the visual so it can drive the
 * per-entity transform each frame from the kinematic body. A static-prop
 * placement that happens to share the same asset id wouldn't make sense
 * anyway: an editor placement is always one-to-one with the loaded prop's
 * behaviour.
 *
 * NB: this is the runtime/race render path (`main.ts`, attract, calibration).
 * The in-app track editor renders + picks props through its own path and does
 * not call this function, so instancing here can't affect editor selection.
 */
const DEFAULT_COLORS: Record<Exclude<PropType, 'asset'>, number> = {
  box: 0xc0a070,
  sphere: 0xddaa66,
  cylinder: 0x9999bb,
  pipe: 0x99ccdd,
  halfpipe: 0xaadddd,
}

/** Pre-loaded prop GLBs keyed by `assetId`. Provided by main.ts after
 *  the boot pre-load step finishes. Empty when no asset-props are in
 *  the track (procedural-only). */
export type PropAssetRegistry = Map<string, LoadedProp>

/** One visual sub-mesh of a prop prototype, captured for instancing: its
 *  geometry, material, and transform relative to the prop root (so the
 *  authored placement pose can be applied as a single parent matrix). */
type PrototypeSubmesh = {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  /** Transform of this sub-mesh relative to the prop root, EXCLUDING the
   *  root's own local transform (which the placement pose replaces). */
  relMatrix: THREE.Matrix4
}

/** Collect the visual sub-meshes of a loaded prop, each with its transform
 *  relative to the prop root. Collider gizmos are skipped. */
function collectPrototypeSubmeshes(loaded: LoadedProp): PrototypeSubmesh[] {
  const root = loaded.root
  root.updateWorldMatrix(true, true)
  const rootWorldInv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const out: PrototypeSubmesh[] = []
  root.traverse((obj) => {
    if (obj.userData?.kind === ExportedKind.COLLIDER) return
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    // rel = inverse(rootWorld) · meshWorld → the chain from root down to this
    // mesh, with root's own (and all ancestors') transform cancelled out.
    const relMatrix = new THREE.Matrix4().multiplyMatrices(rootWorldInv, mesh.matrixWorld)
    out.push({ geometry: mesh.geometry, material: mesh.material, relMatrix })
  })
  return out
}

export function createPropsMesh(props: Prop[], assets?: PropAssetRegistry): THREE.Group {
  const group = new THREE.Group()
  group.name = 'track:props'

  // Bucket asset placements by assetId so repeats instance together. Keep the
  // original order stable; procedural props render in place as we go.
  const assetBuckets = new Map<string, Prop[]>()
  for (const p of props) {
    if (p.type === 'asset') {
      if (!p.assetId) continue
      const loaded = assets?.get(p.assetId)
      if (!loaded) continue // silently skip; caller logs missing assets at boot
      // Wave-rider props are hosted by `wave-rider-render` (see header).
      if (loaded.waveRider !== undefined) continue
      // Animated props are hosted by `animated-props` (skeleton-cloned +
      // mixer-driven). Skipped here so an instanced bind-pose copy doesn't
      // double-render under the swimming one.
      if (isAnimatedAssetProp(p, loaded)) continue
      let bucket = assetBuckets.get(p.assetId)
      if (!bucket) {
        bucket = []
        assetBuckets.set(p.assetId, bucket)
      }
      bucket.push(p)
      continue
    }
    // Procedural prop — one mesh per placement.
    const color = p.color ? new THREE.Color(p.color).getHex() : DEFAULT_COLORS[p.type]
    const mat = new THREE.MeshLambertMaterial({
      // Ring (pipe / halfpipe) needs DoubleSide because the inner wall's
      // triangles face inward; viewing the open-top half-pipe from above
      // should show the inside surface lit.
      color,
      side: p.type === 'pipe' || p.type === 'halfpipe' ? THREE.DoubleSide : THREE.FrontSide,
    })
    const geom = buildPropGeometry(p.type, p.size)
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(p.position.x, p.position.y, p.position.z)
    mesh.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.kind = 'prop'
    group.add(mesh)
  }

  // Emit one InstancedMesh per prototype sub-mesh, per assetId.
  const placementMatrix = new THREE.Matrix4()
  const instanceMatrix = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  for (const [assetId, bucket] of assetBuckets) {
    const loaded = assets?.get(assetId)
    if (!loaded) continue
    const submeshes = collectPrototypeSubmeshes(loaded)
    if (submeshes.length === 0) continue

    // Precompute each placement's parent matrix once (shared across submeshes).
    const placementMatrices = bucket.map((p) => {
      pos.set(p.position.x, p.position.y, p.position.z)
      quat.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
      scl.set(Math.max(0.01, p.size.x), Math.max(0.01, p.size.y), Math.max(0.01, p.size.z))
      return new THREE.Matrix4().compose(pos, quat, scl)
    })

    for (const sm of submeshes) {
      const inst = new THREE.InstancedMesh(sm.geometry, sm.material, bucket.length)
      inst.name = `track:props:${assetId}`
      inst.castShadow = true
      inst.receiveShadow = true
      inst.userData.kind = 'prop'
      inst.userData.assetId = assetId
      for (let i = 0; i < placementMatrices.length; i++) {
        const pm = placementMatrices[i]
        if (!pm) continue
        placementMatrix.copy(pm)
        instanceMatrix.multiplyMatrices(placementMatrix, sm.relMatrix)
        inst.setMatrixAt(i, instanceMatrix)
      }
      inst.instanceMatrix.needsUpdate = true
      // Cull against the real spread of instances, not the prototype geometry's
      // origin-local sphere (which would wrongly cull the whole field when the
      // camera doesn't frame the origin).
      inst.computeBoundingSphere()
      group.add(inst)
    }
  }

  return group
}
