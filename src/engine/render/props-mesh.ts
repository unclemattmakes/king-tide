import * as THREE from 'three'
import { isAnimatedAssetProp, type LoadedProp } from '@/game/assets/prop-loader'
import type { Prop, PropType } from '@/game/tracks/types'
import { ExportedKind } from '../asset-kinds'
import { VINYL_BRUSH_DEFAULTS } from './brush-tuning-service'
import { stampConvexityColor0 } from './edge-wear-convexity'
import { buildVinylMaterial, stampVinylObjectSize } from './painterly-vinyl-material'
import { buildPropGeometry } from './props-geometry'
import { gateShadowCaster, resolveShadowCastMinRadius } from './shadow-caster-gate'

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

/** ONE painterly-vinyl material per (source material, waterline-on?), shared
 *  across every asset/placement/sub-mesh that references it (conversion runs once
 *  per source, not per placement or size). The size-derived inputs (brush stroke
 *  scale + waterline band scale) are per-OBJECT userData reads — each
 *  InstancedMesh is stamped with its asset's size below — so two differently-sized
 *  assets sharing a source material still read at the right scale while sharing
 *  the instance. Material COUNT is the shader pre-warm lever (one main-thread
 *  node-build + codegen per material). Reset per `createPropsMesh` call (per track
 *  load) so the track's sea level baked into the waterline material can't go stale
 *  across tracks; the waterline-on flag splits the rare asset that opts out. */
let vinylMaterialCache = new Map<THREE.Material, Map<boolean, THREE.Material>>()

/** Default waterline-trio strength for props. The trio is world-height gated, so
 *  only props crossing the sea line actually show bands; opt out per prop via
 *  `Prop.waterline = false` (per-asset for instanced placements). */
const PROP_WATERLINE = 1.0

/** The stamp config matching buildVinylMaterial's defaults — props don't
 *  override any brush dial. */
const PROP_STAMP_CFG = {
  brushScale: VINYL_BRUSH_DEFAULTS.brushScale,
  brushPropSizeCap: VINYL_BRUSH_DEFAULTS.brushPropSizeCap,
}

/** Wrap a prop sub-mesh's material(s) in the (size-shared) painterly-vinyl
 *  runtime material. The caller MUST stamp each mesh wearing the result via
 *  `stampVinylObjectSize`. See painterly-vinyl-material.ts /
 *  docs/painterly-vinyl-pipeline.md. */
function vinylizeMaterial(
  mat: THREE.Material | THREE.Material[],
  waterLevel: number,
  waterlineOn: boolean,
): THREE.Material | THREE.Material[] {
  const one = (m: THREE.Material): THREE.Material => {
    let byFlag = vinylMaterialCache.get(m)
    if (!byFlag) {
      byFlag = new Map()
      vinylMaterialCache.set(m, byFlag)
    }
    let v = byFlag.get(waterlineOn)
    if (!v) {
      v = buildVinylMaterial(m, {
        sizePerObject: true,
        waterLevel,
        waterline: waterlineOn ? PROP_WATERLINE : 0,
      })
      byFlag.set(waterlineOn, v)
    }
    return v
  }
  return Array.isArray(mat) ? mat.map(one) : one(mat)
}

export function createPropsMesh(
  props: Prop[],
  assets?: PropAssetRegistry,
  opts?: { waterLevel?: number },
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'track:props'

  // The track's sea level for the prop waterline trio (default on). Fresh vinyl
  // cache per call so this track's baked sea level can't leak into the next.
  const waterLevel = opts?.waterLevel ?? 0
  vinylMaterialCache = new Map()

  // Shadow-caster size gate threshold (`?shadowcast=<m>`, 0 = gate off) —
  // resolved once per build; see shadow-caster-gate.ts.
  const shadowMinR = resolveShadowCastMinRadius()

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
    // Procedural prop — one mesh per placement. Route it through the same
    // painterly-vinyl material as asset props (look + hard-surface edge wear)
    // instead of a flat MeshLambert. buildPropGeometry stamps no COLOR_0, so
    // bake welded-convexity edge-wear data first — this also makes the vinyl
    // AO/edge channel reads safe no-ops vs a fully-absent attribute (which TSL
    // would read as 0 on every channel: AO darken + full edge bleach).
    const color = p.color ? new THREE.Color(p.color).getHex() : DEFAULT_COLORS[p.type]
    const isRing = p.type === 'pipe' || p.type === 'halfpipe'
    const geom = buildPropGeometry(p.type, p.size)
    stampConvexityColor0(geom)
    const baseMat = new THREE.MeshStandardMaterial({
      color,
      // Ring (pipe / halfpipe) needs DoubleSide because the inner wall's
      // triangles face inward; viewing the open-top half-pipe from above
      // should show the inside surface lit.
      side: isRing ? THREE.DoubleSide : THREE.FrontSide,
    })
    const propSize = Math.max(p.size.x, p.size.y, p.size.z, 0.05) * 2
    const mesh = new THREE.Mesh(
      geom,
      buildVinylMaterial(baseMat, {
        propSize,
        waterLevel,
        waterline: p.waterline === false ? 0 : PROP_WATERLINE,
      }),
    )
    mesh.position.set(p.position.x, p.position.y, p.position.z)
    mesh.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
    mesh.castShadow = true
    mesh.receiveShadow = true
    // Size gate: small dressing stops casting into the sun's depth pass
    // (caster count is the cost — see shadow-caster-gate.ts). p.size is the
    // half-extent set, so propSize/2 ≈ the world bounding radius.
    gateShadowCaster(mesh, propSize / 2, shadowMinR)
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

    // The prop's intrinsic size (prototype bbox max dimension) drives the
    // scale-relative brush + waterline band in the vinyl material — once per asset.
    loaded.root.updateMatrixWorld(true)
    const assetSize = new THREE.Vector3()
    new THREE.Box3().setFromObject(loaded.root).getSize(assetSize)
    const propSize = Math.max(assetSize.x, assetSize.y, assetSize.z, 0.05)

    // Precompute each placement's parent matrix once (shared across submeshes).
    const placementMatrices = bucket.map((p) => {
      pos.set(p.position.x, p.position.y, p.position.z)
      quat.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
      scl.set(Math.max(0.01, p.size.x), Math.max(0.01, p.size.y), Math.max(0.01, p.size.z))
      return new THREE.Matrix4().compose(pos, quat, scl)
    })
    // Largest placement scale in the bucket — the shadow gate judges the
    // whole instanced field by its biggest member.
    const maxPlacementScale = bucket.reduce(
      (mx, p) => Math.max(mx, p.size.x, p.size.y, p.size.z),
      0.01,
    )
    // Waterline opt-out is per-asset (instanced placements share one material):
    // drop the trio only when EVERY placement of this asset opts out.
    const bucketWaterlineOn = !bucket.every((p) => p.waterline === false)

    for (const sm of submeshes) {
      // Safety net: every shipped prop GLB carries COLOR_0 (baked convexity), so
      // this is a no-op for them — but a prop that somehow lacks it would read 0
      // on every channel under TSL (AO darken + full edge bleach). Stamp welded
      // convexity so a missing channel becomes correct edge-wear data instead.
      stampConvexityColor0(sm.geometry)
      const inst = new THREE.InstancedMesh(
        sm.geometry,
        vinylizeMaterial(sm.material, waterLevel, bucketWaterlineOn),
        bucket.length,
      )
      inst.name = `track:props:${assetId}`
      inst.castShadow = true
      inst.receiveShadow = true
      // Size gate per ASSET: the whole instanced field casts (one depth draw)
      // only when the prototype at its largest placement scale clears the
      // threshold — see shadow-caster-gate.ts. propSize is the prototype's
      // bbox max dimension, so /2 ≈ radius.
      gateShadowCaster(inst, (propSize / 2) * maxPlacementScale, shadowMinR)
      inst.userData.kind = 'prop'
      inst.userData.assetId = assetId
      // Per-object size inputs for the shared vinyl material — one stamp per
      // InstancedMesh, i.e. per asset: every placement of the asset reads the
      // prototype's size, exactly like the old per-asset size bucket did.
      // (objectScale 1: the prop brush samples world space.)
      stampVinylObjectSize(inst, propSize, 1, PROP_STAMP_CFG)
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
