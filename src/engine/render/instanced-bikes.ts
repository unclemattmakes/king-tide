/**
 * Instanced AI/peer bike field — one field per bike GLB.
 *
 * Within a field every bike shares the same GLB (render-systems.ts builds one
 * field per distinct variant model in play), so the only per-bike variation is
 * two material tints: `mat_bike_*_livery` (body) and `mat_bike_*_glow`
 * (exhaust). That makes each field a textbook instancing target: one
 * `InstancedMesh` per visual sub-mesh, each sharing a SINGLE vinyl material
 * across the field, with the livery / exhaust colour supplied as a per-instance
 * `aTint` attribute the material reads (painterly-vinyl-material.ts
 * `tintAttribute`). Result: a field draws in one call per sub-mesh instead of
 * one object tree per bike, and the pre-warm compiles one material set per
 * variant instead of one per clone.
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
import type { BikeRimSignal } from './signal-state'

/** Per-instance livery/exhaust colour attribute the vinyl material samples. */
const TINT_ATTR = 'aTint'
/** Per-instance additive-rim signal attributes the vinyl material samples (the
 *  style-as-legibility rim — see signal-state.ts). Colour is linear RGB; strength
 *  0 = no rim (the default for every instance until a signal is pushed), so the
 *  field reads byte-identical to today until `setRimSignal` lifts a strength. */
const RIM_COLOR_ATTR = 'aRimColor'
const RIM_STRENGTH_ATTR = 'aRimStrength'

/** Cross-FIELD vinyl material cache (see `fieldMaterialKey`). The caller owns
 *  one map and passes it to every field it builds, so equivalent materials in
 *  different variant GLBs collapse to a single compiled vinyl instance —
 *  material COUNT is the shader pre-warm lever. */
export type SharedVinylCache = Map<string, THREE.Material>

/** Structural share-key for a field material, or null when it must stay
 *  per-source (textured — a unique look we can't prove equivalent).
 *
 *  - Tinted roles (livery / exhaust): the per-instance `aTint` REPLACES the
 *    base colour in the vinyl graph (and drives emissive for the exhaust), so
 *    the source colour is irrelevant — one material per role serves EVERY
 *    variant's field.
 *  - Untinted (chassis): vinyl flattens PBR (metalness 0, house roughness),
 *    so only the baked colour + emissive survive conversion. Quantised to
 *    1/64 — sub-perceptual for the near-black chassis family this exists for.
 */
function fieldMaterialKey(src: THREE.Material, tintKind: FieldSubmesh['tintKind']): string | null {
  const std = src as Partial<THREE.MeshStandardMaterial>
  const textured = Boolean(
    std.map ||
      std.normalMap ||
      std.emissiveMap ||
      std.roughnessMap ||
      std.metalnessMap ||
      std.aoMap,
  )
  if (textured) return null
  const emi = std.emissiveIntensity ?? 1
  if (tintKind) return `tint:${tintKind}:${emi}`
  const q = (c: THREE.Color | undefined): string =>
    c ? `${Math.round(c.r * 64)},${Math.round(c.g * 64)},${Math.round(c.b * 64)}` : '-'
  return `plain:${q(std.color)}:${q(std.emissive)}:${emi}`
}

type FieldSubmesh = {
  inst: THREE.InstancedMesh
  /** Prototype transform of this sub-mesh relative to bike_root. */
  rel: THREE.Matrix4
  /** This sub-mesh's per-instance tint buffer, or null for untinted sub-meshes
   *  (which only need per-instance transforms). */
  tint: THREE.InstancedBufferAttribute | null
  /** Which colour drives this sub-mesh's tint. */
  tintKind: 'livery' | 'exhaust' | null
  /** Per-instance additive-rim signal buffers (colour + strength). Present on
   *  EVERY sub-mesh (the rim must paint the whole bike silhouette, not just the
   *  tinted body), so a charge/rival signal rims the full bike. Strength starts 0
   *  on every instance ⇒ rim off until a signal is pushed. */
  rimColor: THREE.InstancedBufferAttribute
  rimStrength: THREE.InstancedBufferAttribute
}

export type InstancedBikeField = {
  group: THREE.Group
  readonly capacity: number
  /** Stamp instance `i`'s livery + exhaust colour (hex). Colours don't change per
   *  frame, so call once when a bike claims an index. */
  setColors(i: number, liveryHex: number, exhaustHex: number): void
  /** Set instance `i`'s world transform for this frame. */
  setMatrix(i: number, m: THREE.Matrix4): void
  /** Paint instance `i`'s additive-rim gameplay signal for this frame (the
   *  style-as-legibility rim — drift/charge ladder, rival draft, …). Pass a
   *  signal with `strength === 0` (e.g. the module's `NO_SIGNAL`) to clear it back
   *  to today's look. Drives the per-instance `aRimColor`/`aRimStrength`
   *  attributes the shared vinyl material reads; cheap to call every frame (only
   *  flags the buffer dirty when a value actually changes). Wiring: the bike
   *  render system, which owns the entity→instance index map, calls this with
   *  `getBikeSignal(eid)` (see signal-state.ts). */
  setRimSignal(i: number, signal: Readonly<BikeRimSignal>): void
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
  opts: {
    brush: number
    edgeWear: number
    visualScale: number
    /** Share equivalent vinyl materials ACROSS fields (pass the same map to
     *  every per-variant field — see `SharedVinylCache`). Omit → materials
     *  are only deduped within this field. */
    sharedVinyl?: SharedVinylCache
  },
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

    // Per-instance additive-rim signal buffers on EVERY sub-mesh (the rim paints
    // the whole bike silhouette). Strength defaults 0 ⇒ no rim, so the field is
    // byte-identical to today until `setRimSignal` lifts a strength. Colour
    // defaults black (irrelevant at strength 0).
    const rimColorData = new Float32Array(capacity * 3) // 0,0,0
    const rimColor = new THREE.InstancedBufferAttribute(rimColorData, 3)
    rimColor.setUsage(THREE.DynamicDrawUsage)
    geom.setAttribute(RIM_COLOR_ATTR, rimColor)
    const rimStrengthData = new Float32Array(capacity) // all 0 = rim off
    const rimStrength = new THREE.InstancedBufferAttribute(rimStrengthData, 1)
    rimStrength.setUsage(THREE.DynamicDrawUsage)
    geom.setAttribute(RIM_STRENGTH_ATTR, rimStrength)

    const shareKey = opts.sharedVinyl ? fieldMaterialKey(srcMat, tintKind) : null
    let vinyl = shareKey ? opts.sharedVinyl?.get(shareKey) : matCache.get(srcMat)
    if (!vinyl) {
      vinyl = buildVinylMaterial(srcMat, {
        brush: opts.brush,
        edgeWear: opts.edgeWear,
        brushObjectSpace: true,
        ...(tintKind ? { tintAttribute: TINT_ATTR } : {}),
        ...(tintKind === 'exhaust' ? { emissiveFromTint: true } : {}),
        // Per-instance signal rim on every sub-mesh — one shared material, a
        // distinct gameplay rim per bike. Always wired (the attributes always
        // exist); default strength 0 keeps it off until a signal is pushed.
        rimColorAttribute: RIM_COLOR_ATTR,
        rimStrengthAttribute: RIM_STRENGTH_ATTR,
      })
      if (shareKey) opts.sharedVinyl?.set(shareKey, vinyl)
      else matCache.set(srcMat, vinyl)
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
      rimColor,
      rimStrength,
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
    setRimSignal(i, signal) {
      // Write the per-instance rim colour + strength on every sub-mesh so the rim
      // wraps the whole bike. Only flag the buffer dirty when a value actually
      // moved, so an unsignalled / steady-state field uploads nothing each frame
      // (strength stays 0 ⇒ rim off ⇒ today's look). `signal.strength === 0`
      // (e.g. NO_SIGNAL) is the clear-to-default path.
      const r = signal.color.r
      const g = signal.color.g
      const b = signal.color.b
      const s = signal.strength
      for (const sm of submeshes) {
        const prevS = sm.rimStrength.getX(i)
        if (prevS !== s) {
          sm.rimStrength.setX(i, s)
          sm.rimStrength.needsUpdate = true
        }
        // Colour only matters while the rim is visible; skip the write (and the
        // upload) when both this and last frame are off.
        if (s > 0 || prevS > 0) {
          if (sm.rimColor.getX(i) !== r || sm.rimColor.getY(i) !== g || sm.rimColor.getZ(i) !== b) {
            sm.rimColor.setXYZ(i, r, g, b)
            sm.rimColor.needsUpdate = true
          }
        }
      }
    },
    park(i) {
      for (const sm of submeshes) {
        sm.inst.setMatrixAt(i, ZERO_MATRIX)
        // Clear any lingering signal so a reused slot doesn't inherit the previous
        // bike's rim before the next setRimSignal.
        if (sm.rimStrength.getX(i) !== 0) {
          sm.rimStrength.setX(i, 0)
          sm.rimStrength.needsUpdate = true
        }
      }
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
