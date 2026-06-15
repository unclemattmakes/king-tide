/**
 * Foliage sway shader hook — Item 6 from docs/blender-wishlist.md.
 *
 * Single shared `onBeforeCompile` injection that adds a vertex
 * displacement to any opted-in material. Reads the canonical `COLOR_0`
 * vertex attribute set up by Blender's procedural builders:
 *
 *   R = wind sway strength  (0 = rigid, 1 = full)
 *   G = AO multiplier       (consumed downstream; not used here yet)
 *   B = phase offset        (so a cluster doesn't sway in lockstep)
 *
 * The full spec lives in [docs/vertex-attribute-spec.md](../../../docs/vertex-attribute-spec.md).
 *
 * Three.js note: the game's PRIMARY renderer is `WebGPURenderer`
 * (three/webgpu), which uses TSL node materials — `onBeforeCompile`
 * does nothing there. So this module ships TWO code paths that mirror
 * the same math:
 *
 *   - WebGL2 fallback → `applyFoliageSway(material)` patches the
 *     material in place via `onBeforeCompile` (the original path).
 *   - WebGPU / node materials → `applyFoliageSwayToMesh(mesh)` CONVERTS
 *     each foliage material to a `MeshStandardNodeMaterial` and sets its
 *     `positionNode` to a TSL sway node (loaded GLB materials are plain
 *     `MeshStandardMaterial`, which can't carry a `positionNode`, so the
 *     mesh's material slot has to be replaced).
 *
 * Both paths read the same shared wind/time state, exposed to the WebGL2
 * path as plain `{ value }` uniform objects and to the TSL path as
 * `uniform()` nodes; `updateWind` / `updateSwayTime` mutate both.
 */

import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  attribute,
  float,
  fract,
  instanceIndex,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

const TWO_PI = 6.2831853

/** Shared wind state. The render loop updates this once per frame; every
 *  swayed material samples from it via a uniform reference. */
const WIND_DIR = new THREE.Vector3(1, 0, 0)
let windStrength = 0.0
let windFrequency = 1.4

/** Single per-frame time uniform shared across all swayed materials.
 *  Updated once per frame from the render loop via `updateSwayTime`. */
const SWAY_TIME = { value: 0 }
const SWAY_WIND = {
  value: new THREE.Vector3(WIND_DIR.x * windStrength, 0, WIND_DIR.z * windStrength),
}
const SWAY_FREQ = { value: windFrequency }

/** TSL uniform nodes — the node-material twins of the plain-object
 *  uniforms above. Created once at module scope so every swayed node
 *  material shares the same GPU uniform; `updateWind` / `updateSwayTime`
 *  mutate their `.value` in lockstep with the WebGL2 uniforms. */
const SWAY_TIME_NODE = uniform(0)
const SWAY_WIND_NODE = uniform(
  new THREE.Vector3(WIND_DIR.x * windStrength, 0, WIND_DIR.z * windStrength),
)
const SWAY_FREQ_NODE = uniform(windFrequency)

const PATCHED = Symbol.for('hoverbike.foliageSwayPatched')
/** Marks a node material we've already attached a sway `positionNode` to,
 *  so `applyFoliageSwayToMesh` is idempotent and doesn't double-swap. */
const NODE_SWAYED = Symbol.for('hoverbike.foliageSwayNodeSwayed')
/** Marks a mesh already recorded in the debug registry (one entry per mesh). */
const SWAY_RECORDED = Symbol.for('hoverbike.foliageSwayRecorded')

/** Per-mesh sway record for dev tooling / verification — what phase each
 *  swayed mesh got and where it is, so a probe can confirm distinct palms
 *  desync on the live scene. Read via {@link debugSwayMeshes}. */
export type SwayMeshRecord = {
  name: string
  /** Per-mesh baseline phase, radians. */
  phase: number
  x: number
  y: number
  z: number
  instanced: boolean
  /** Instance count (1 for a plain mesh). */
  count: number
}
const SWAY_MESH_RECORDS: SwayMeshRecord[] = []

/** Active renderer backend. Defaults to `'webgpu'` — the project's
 *  primary renderer — so foliage sways even if a boot path forgets to
 *  call `setFoliageSwayBackend`. The live race boot wires the real backend
 *  (from `createRenderer`) via `src/boot/race-boot.ts`, right after the
 *  renderer is created and BEFORE the first track loads — so the WebGL2
 *  fallback genuinely takes the `onBeforeCompile` path rather than relying
 *  on this default. The default remains the safety net for standalone
 *  scenes / tests that don't run the full race boot. */
let activeBackend: 'webgpu' | 'webgl2' = 'webgpu'

/** Tell the sway system which renderer backend is live. WebGPU uses the
 *  TSL node-material path; WebGL2 uses the `onBeforeCompile` path (kept as
 *  the real WebGL2 fallback so that backend doesn't swap each foliage mesh's
 *  material). Wired at boot from `race-boot.ts`. */
export function setFoliageSwayBackend(backend: 'webgpu' | 'webgl2'): void {
  activeBackend = backend
}

type Patchable = THREE.Material & {
  onBeforeCompile?: (shader: THREE.WebGLProgramParametersWithUniforms) => void
  userData: { [key: string]: unknown; [k: symbol]: unknown }
}

export type SwayOptions = {
  /** Override the global wind for this material (e.g. interior banners
   *  that get less wind than open coast). 1.0 = full global wind. */
  windScale?: number
  /** Baseline sway-phase offset in **radians**, added on top of the
   *  per-vertex `COLOR_0.b` phase. `applyFoliageSwayToMesh` derives this
   *  per mesh from the mesh's world position so distinct palm meshes that
   *  share one geometry datablock (and a `COLOR_0.b` of 0) don't sway in
   *  lockstep. Defaults to 0 when omitted. */
  phaseOffset?: number
}

/**
 * Deterministic per-mesh sway-phase from a world-XZ position, returned in
 * **radians** `[0, 2π)`. Mirrors the GLSL `fract(sin(dot(p,k)) * f)` pseudo-
 * hash the WebGL2 instancing path uses for `instanceMatrix[3].xz`, so the
 * two backends pick comparable phases. The constants are the usual
 * `(12.9898, 78.233) / 43758.5453` pair plus a small bias so two palms on
 * the exact same XZ row don't collide on a 0 phase.
 *
 * Used to desync palms that are *separate meshes sharing one geometry*
 * (e.g. sandbar's 12 frond meshes), where `COLOR_0.b` is 0 and there's no
 * per-instance matrix to hash. Exported for unit testing.
 */
export function swayPhaseFromPosition(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233 + 0.31415) * 43758.5453
  return (s - Math.floor(s)) * TWO_PI
}

const _meshWorldPos = new THREE.Vector3()

/**
 * Patch a material so its vertex shader applies the foliage sway
 * displacement. Idempotent — safe to call repeatedly.
 *
 * The patch reads `attribute vec3 color` (three.js's name for the
 * glTF `COLOR_0` attribute) and:
 *   - takes `color.r` as sway strength
 *   - takes `color.b` as a *baseline* per-vertex phase offset (mapped
 *     0..1 → 0..2π)
 *   - adds `opts.phaseOffset` (radians), the caller-supplied per-mesh
 *     phase. `applyFoliageSwayToMesh` derives it from the mesh's world
 *     position so separate palm meshes that share one geometry datablock
 *     (and a 0 `color.b`) don't sway in lockstep.
 *   - when the mesh is an `InstancedMesh` (an `EXT_mesh_gpu_instancing`
 *     block lifted by the GLB loader), adds a deterministic per-instance
 *     phase term hashed from `instanceMatrix[3].xz`. This desyncs the
 *     sway across scattered palms without needing per-instance vertex
 *     attributes — which the gltf instancing extension can't carry,
 *     it only ships TRS. The Geometry-Nodes "Store Named Attribute"
 *     sway-phase stamp is per-vertex on the source mesh and so gets
 *     baked into the single frozen mesh datablock the addon's scatter
 *     realize pass shares across all instances; the only way to vary
 *     phase per InstancedMesh row is to derive it from the per-instance
 *     matrix at draw time.
 *   - displaces the vertex along the wind uniform direction
 *
 * The mesh's `geometry` must include the `color` attribute. The runtime
 * GLB loader already populates this for any mesh that ships `COLOR_0`.
 */
export function applyFoliageSway(material: THREE.Material, opts: SwayOptions = {}): void {
  const m = material as Patchable
  if (m.userData[PATCHED]) {
    return
  }
  m.userData[PATCHED] = true

  const windScale = { value: typeof opts.windScale === 'number' ? opts.windScale : 1.0 }
  // Per-mesh baseline phase (radians). On WebGL2 the material is patched in
  // place and shared across meshes, so the value baked here is whichever
  // mesh patched it first — true per-mesh desync for separate-mesh palms is
  // the WebGPU path's job (one node material per mesh). This keeps the GLSL
  // math structurally identical to the TSL path and is correct for the
  // common single-mesh-per-material case.
  const phaseOffset = { value: typeof opts.phaseOffset === 'number' ? opts.phaseOffset : 0 }

  const prevOnBeforeCompile = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile.call(m, shader)

    // Expose the shared uniforms.
    shader.uniforms.uSwayTime = SWAY_TIME
    shader.uniforms.uSwayWind = SWAY_WIND
    shader.uniforms.uSwayFreq = SWAY_FREQ
    shader.uniforms.uSwayWindScale = windScale
    shader.uniforms.uSwayPhaseOffset = phaseOffset

    // Vertex shader: declare uniforms + attribute, then displace pre-projection.
    // We inject before `#include <begin_vertex>` so subsequent transforms
    // (skinning, morph, instancing) act on the displaced position.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uSwayTime;
uniform vec3  uSwayWind;
uniform float uSwayFreq;
uniform float uSwayWindScale;
uniform float uSwayPhaseOffset;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // color.r is sway strength (0..1), color.b is the baseline per-vertex
  // phase offset (0..1). Defaults to no sway when the geometry has no
  // COLOR_0 attribute -- three.js fills color with vec3(1.0) in that
  // case, so guard with a small material-level userData flag if you
  // need stricter checks.
  #ifdef USE_COLOR
    float swayStrength = color.r;
    float swayPhase    = color.b * 6.2831853; // 2π
    // Per-mesh baseline (radians) so separate palm meshes sharing one
    // geometry datablock (color.b == 0) don't lock-step.
    swayPhase += uSwayPhaseOffset;
    // EXT_mesh_gpu_instancing carries only TRS per instance, not arbitrary
    // vertex attributes -- so the scatter pipeline can't ship a per-
    // instance COLOR_0.B value. Derive an uncorrelated phase from the
    // instance origin instead: instanceMatrix[3].xz is the world-XZ
    // translation column, identical across all verts of one instance
    // but different across instances. fract(sin(dot(p, k)) * f) is the
    // standard cheap pseudo-hash; the constants here are the usual
    // (12.9898, 78.233) / 43758.5453 pair plus a tiny bias so two palms
    // landing on the exact same XZ row don't collide.
    #ifdef USE_INSTANCING
      vec2 instOrigin = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
      float instPhase = fract(sin(dot(instOrigin, vec2(12.9898, 78.233)) + 0.31415) * 43758.5453);
      swayPhase += instPhase * 6.2831853;
    #endif
    float swayWave     = sin(uSwayTime * uSwayFreq + swayPhase);
    transformed.xz += uSwayWind.xz * uSwayWindScale * swayStrength * swayWave;
  #endif
}`,
      )
  }

  // `USE_COLOR` is the three.js define that gates the `color` attribute's
  // shader path. Set it via `vertexColors = true` so three.js plumbs the
  // attribute through even though we're using it for parameters, not tint.
  if ('vertexColors' in m) {
    ;(m as unknown as { vertexColors: boolean }).vertexColors = true
  }
  m.needsUpdate = true
}

/** Source visual props copied verbatim from a loaded GLB material onto its
 *  node-material replacement so the swayed foliage keeps its authored look. */
const COPIED_STANDARD_PROPS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'roughness',
  'metalness',
  'transparent',
  'opacity',
  'alphaTest',
  'side',
  'depthWrite',
  'depthTest',
  'emissiveIntensity',
] as const

/**
 * Build the TSL sway displacement node mirroring the GLSL math in
 * `applyFoliageSway`'s `onBeforeCompile` injection:
 *
 *   swayStrength = color.r
 *   swayPhase    = color.b * 2π + phaseOffset (+ per-instance term)
 *   swayWave     = sin(uSwayTime * uSwayFreq + swayPhase)
 *   pos.xz      += uSwayWind.xz * windScale * swayStrength * swayWave
 *
 * `phaseOffset` (radians) is the per-mesh baseline the caller hashes from
 * the mesh's world position — it desyncs separate palm meshes that share
 * one geometry datablock (and a `color.b` of 0).
 *
 * When `instanced` is true (an `InstancedMesh` lifted from a GLB's
 * `EXT_mesh_gpu_instancing` block, e.g. a scatter-zone palm field), a
 * per-instance term is added so the instances within one InstancedMesh
 * don't lock-step either. This resolves the original TODO. We key it off
 * the `instanceIndex` builtin rather than the instance-matrix translation
 * column the WebGL2 path hashes: `instanceIndex` is the canonical,
 * backend-agnostic per-instance accessor (storage / uniform-buffer /
 * interleaved instancing all resolve it), needs no coupling to three's
 * internal `instanceMatrix` buffer layout (the blocker the old TODO cited),
 * and is collision-free (every instance has a distinct index, unlike the
 * world-XZ hash which can collide for palms on the same row). The phase is
 * uncorrelated per instance either way — visually equivalent to the
 * position hash.
 *
 * Returns a `positionLocal`-relative node ready to assign to
 * `material.positionNode`.
 */
function buildSwayPositionNode(
  windScale: number,
  phaseOffset: number,
  instanced: boolean,
): Node<'vec3'> {
  // three.js exposes the glTF COLOR_0 attribute as `color`. Cast mirrors
  // the pattern in terrain-shader.ts (`attribute('color') as Node<...>`).
  const color = attribute('color', 'vec3') as unknown as Node<'vec3'>
  const swayStrength = color.r
  let swayPhase = color.b.mul(float(TWO_PI)).add(float(phaseOffset))
  if (instanced) {
    // Cheap per-instance pseudo-hash of the instance index → [0, 1).
    // Same fract(sin(x)*f) family as the WebGL2 path's instance hash.
    const idx = float(instanceIndex)
    const instHash = fract(sin(idx.mul(float(12.9898)).add(float(0.31415))).mul(float(43758.5453)))
    swayPhase = swayPhase.add(instHash.mul(float(TWO_PI)))
  }
  const swayWave = sin(SWAY_TIME_NODE.mul(SWAY_FREQ_NODE).add(swayPhase))
  const amount = swayStrength.mul(float(windScale)).mul(swayWave)
  const offset = vec3(SWAY_WIND_NODE.x.mul(amount), float(0), SWAY_WIND_NODE.z.mul(amount))
  return positionLocal.add(offset) as unknown as Node<'vec3'>
}

type NodeMaterialMarked = MeshStandardNodeMaterial & {
  userData: { [key: string]: unknown; [k: symbol]: unknown }
}

/** Convert a single plain `MeshStandardMaterial` (as loaded from a GLB)
 *  into a `MeshStandardNodeMaterial` carrying the TSL sway `positionNode`,
 *  preserving the source's visual properties. Returns the existing node
 *  material untouched (but ensures it's marked) when already a node
 *  material so the swap is idempotent. */
function toSwayNodeMaterial(
  src: THREE.Material,
  windScale: number,
  phaseOffset: number,
  instanced: boolean,
): MeshStandardNodeMaterial {
  // Already a node material we've swayed → leave as-is (idempotent).
  if ((src as NodeMaterialMarked).userData?.[NODE_SWAYED]) {
    return src as MeshStandardNodeMaterial
  }

  const next = new MeshStandardNodeMaterial()
  next.name = src.name
  const std = src as Partial<THREE.MeshStandardMaterial> & THREE.Material
  for (const key of COPIED_STANDARD_PROPS) {
    const v = (std as unknown as Record<string, unknown>)[key]
    if (v !== undefined && v !== null) {
      ;(next as unknown as Record<string, unknown>)[key] = v
    }
  }
  if (std.color) next.color.copy(std.color)
  if (std.emissive) next.emissive.copy(std.emissive)
  // The sway math reads the `color` vertex attribute; enable vertexColors so
  // three plumbs COLOR_0 through, matching the WebGL2 path's USE_COLOR gate.
  next.vertexColors = true
  next.positionNode = buildSwayPositionNode(windScale, phaseOffset, instanced)
  ;(next as NodeMaterialMarked).userData[NODE_SWAYED] = true
  next.needsUpdate = true
  return next
}

/**
 * Apply foliage sway to a mesh, choosing the path appropriate for the live
 * renderer backend:
 *
 *   - WebGPU (node-material path) → CONVERT each foliage material slot to a
 *     `MeshStandardNodeMaterial` with a TSL sway `positionNode`, then assign
 *     the converted material(s) back to the mesh. Loaded GLB materials are
 *     plain `MeshStandardMaterial`, which can't carry a `positionNode`, so
 *     the slot must be replaced.
 *   - WebGL2 → patch each material in place via the original
 *     `applyFoliageSway` `onBeforeCompile` hook.
 *
 * Idempotent: a second call is a no-op (the in-place path is guarded by its
 * own `PATCHED` marker; the node path by `NODE_SWAYED`).
 *
 * Phase desync: each mesh gets a baseline phase hashed from its world
 * position (so separate palm meshes sharing one geometry don't lock-step),
 * and `InstancedMesh` foliage additionally gets a per-instance phase term
 * (so instances within one scatter field desync too).
 *
 * Handles both single-material and array-material (multi-slot) meshes.
 */
export function applyFoliageSwayToMesh(mesh: THREE.Mesh, opts: SwayOptions = {}): void {
  const mat = mesh.material
  if (!mat) return
  const windScale = typeof opts.windScale === 'number' ? opts.windScale : 1.0
  // Mesh world position drives both the per-mesh phase and the debug record.
  // `getWorldPosition` updates the world matrix up the parent chain first,
  // so this is correct even during GLB load before the scene is mounted.
  mesh.getWorldPosition(_meshWorldPos)
  // Per-mesh baseline phase (radians). Honour an explicit override, else
  // hash the mesh's world position so separate palm meshes that share one
  // geometry datablock (and a 0 `COLOR_0.b`) each get their own phase.
  const phaseOffset =
    typeof opts.phaseOffset === 'number'
      ? opts.phaseOffset
      : swayPhaseFromPosition(_meshWorldPos.x, _meshWorldPos.z)
  // InstancedMesh (a GLB `EXT_mesh_gpu_instancing` scatter field) → also add
  // a per-instance phase term in the node so the instances desync.
  const instanced = (mesh as { isInstancedMesh?: boolean }).isInstancedMesh === true

  // Record once per mesh for dev tooling (see `debugSwayMeshes`).
  const meshRec = mesh as THREE.Mesh & { userData: { [k: symbol]: unknown } }
  if (!meshRec.userData[SWAY_RECORDED]) {
    meshRec.userData[SWAY_RECORDED] = true
    const matName = Array.isArray(mat) ? (mat.find((m) => m?.name)?.name ?? '') : (mat.name ?? '')
    SWAY_MESH_RECORDS.push({
      name: matName,
      phase: phaseOffset,
      x: _meshWorldPos.x,
      y: _meshWorldPos.y,
      z: _meshWorldPos.z,
      instanced,
      count: instanced ? (mesh as THREE.InstancedMesh).count : 1,
    })
  }

  if (activeBackend === 'webgl2') {
    const webglOpts: SwayOptions = { ...opts, phaseOffset }
    if (Array.isArray(mat)) {
      for (const m of mat) if (m) applyFoliageSway(m, webglOpts)
    } else {
      applyFoliageSway(mat, webglOpts)
    }
    return
  }

  // WebGPU / node-material path — convert and swap.
  const convert = (m: THREE.Material): THREE.Material => {
    // Already a node material (e.g. a custom material someone pre-built):
    // patch it in place rather than wrapping it in a fresh standard node.
    if ((m as { isNodeMaterial?: boolean }).isNodeMaterial) {
      const nm = m as NodeMaterialMarked & {
        positionNode?: Node<'vec3'> | null
        needsUpdate: boolean
      }
      if (nm.userData?.[NODE_SWAYED]) return m
      nm.positionNode = buildSwayPositionNode(windScale, phaseOffset, instanced)
      nm.userData[NODE_SWAYED] = true
      nm.needsUpdate = true
      return m
    }
    return toSwayNodeMaterial(m, windScale, phaseOffset, instanced)
  }

  if (Array.isArray(mat)) {
    mesh.material = mat.map((m) => (m ? convert(m) : m)) as THREE.Material[]
  } else {
    mesh.material = convert(mat)
  }
}

/**
 * Update the shared wind state. Call once per frame from the render
 * loop. `direction` is a unit vector in the xz plane; `strength` is the
 * peak xz displacement applied to a fully-swaying vertex.
 */
export function updateWind(
  direction: THREE.Vector3 | { x: number; z: number },
  strength: number,
  frequency = windFrequency,
): void {
  WIND_DIR.set(direction.x, 0, direction.z).normalize()
  windStrength = strength
  windFrequency = frequency
  SWAY_WIND.value.set(WIND_DIR.x * windStrength, 0, WIND_DIR.z * windStrength)
  SWAY_FREQ.value = windFrequency
  // Mirror into the TSL uniform nodes so the WebGPU path stays in sync.
  SWAY_WIND_NODE.value.set(WIND_DIR.x * windStrength, 0, WIND_DIR.z * windStrength)
  SWAY_FREQ_NODE.value = windFrequency
}

/** Advance the shared sway clock. Pass elapsed simulation time in
 *  seconds. The render layer owns this — call once per frame before
 *  rendering swayed materials. */
export function updateSwayTime(seconds: number): void {
  SWAY_TIME.value = seconds
  SWAY_TIME_NODE.value = seconds
}

/** Read access for debugging / dev tools. */
export function debugSwayState(): { time: number; windX: number; windZ: number; freq: number } {
  return {
    time: SWAY_TIME.value,
    windX: SWAY_WIND.value.x,
    windZ: SWAY_WIND.value.z,
    freq: SWAY_FREQ.value,
  }
}

/** Dev/test access: every mesh swayed this session, with the per-mesh phase
 *  and world position it was assigned. A verification probe can confirm that
 *  distinct palms got distinct phases (no lockstep) on the live scene. The
 *  list is module-scoped, so it resets on page reload. */
export function debugSwayMeshes(): readonly SwayMeshRecord[] {
  return SWAY_MESH_RECORDS
}
