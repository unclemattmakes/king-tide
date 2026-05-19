/**
 * Runtime emissive lava-river material — drives the
 * ``landmark_lava_river_strip`` archetype (Kilauea Crown's lava-waterfall
 * hero set-piece today, plus any future track that drops a library-linked
 * lava strip).
 *
 * The strip's geometry ships from ``seed_landmarks_library.py`` with a
 * ``COLOR_0`` override per ``docs/vertex-attribute-spec.md``:
 *
 *   R = emissive multiplier (1 = white-hot core, 0.2 = cool bank edge)
 *   G = AO (always 1 here — surface, not under-geometry)
 *   B = flow-phase / V-coord along length (0..1)
 *   A = reserved (1)
 *
 * The seeded GLB ships with a flat baked material; this module replaces
 * it at load with a ``MeshStandardNodeMaterial`` whose colour + emissive
 * nodes pull the hot-core mask out of ``COLOR_0.r`` and mix between the
 * trailer-shot hot-core and the deep-red bank-edge palette. A subtle
 * sin-of-time scroll on ``COLOR_0.b`` adds a flow shimmer without
 * costing a noise texture.
 *
 * WebGPU constraints — per ``memory/feedback_webgpu_particles.md`` the
 * renderer rejects ``ShaderMaterial`` in places, so we author this as a
 * TSL node graph on a node-material (same path the terrain + water
 * shaders use). Compiles to WGSL on WebGPU and GLSL on the WebGL2
 * fallback through Three's unified node pipeline.
 *
 * Player-settings hook — ``playerSettings.emissiveLandmarks`` gates the
 * intensity uniform (Full / Reduced / Off). Off collapses the emissive
 * contribution to zero so the band reads as flat albedo — the
 * compatibility/low-end path. The setter in ``player-settings.ts``
 * calls ``applyEmissiveLandmarksSetting`` to keep the live uniform in
 * sync without forcing a track reload.
 */

import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  abs,
  attribute,
  clamp,
  float,
  max,
  mix,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  EMISSIVE_LANDMARKS_SCALAR,
  type EmissiveLandmarksIntensity,
} from '@/engine/player-settings'

/** Hot-core colour at ``COLOR_0.r = 1``. The brief asks for an
 *  orange-yellow molten-glow that bloom can pick up without going
 *  pure white. */
export const LAVA_HOT_CORE_RGB: readonly [number, number, number] = [1.0, 0.878, 0.627]

/** Cool bank-edge colour at ``COLOR_0.r ≈ 0.2``. Deep red so the
 *  cooling crust reads as solidifying rock rather than continuing
 *  flame. */
export const LAVA_BAND_EDGE_RGB: readonly [number, number, number] = [0.659, 0.18, 0.063]

/** Bank-edge attenuation on the cooler ramp. The seeded mask falls
 *  off to 0.2 at the bank; remap so the band-edge colour anchors at
 *  ``r ≤ BANK_EDGE_R`` and the hot-core anchors at ``r = 1``.
 *  Anything between is a smooth lerp. */
export const LAVA_BANK_EDGE_R = 0.2

/** Local-Y half-width of the seed's strip geometry. The Blender seed
 *  in ``seed_landmarks_library.py`` builds a 60 m × 4 m strip in the
 *  local XY plane with vertex rows at ``y = ±width/2 = ±2``. The
 *  Blender → glTF axis swap moves that width axis onto local Z, so the
 *  runtime strip's centreline lives at ``positionLocal.z = 0`` with
 *  edges at ``|positionLocal.z| = 2``. The shader uses this to derive
 *  a fallback hot-core mask when the geometry ships only 2 rows of
 *  vertices (which the current seed does — vertex interpolation
 *  between two 0.2 edges yields 0.2 across the surface, masking the
 *  contract's centreline=1 mask). The fallback collapses to a no-op
 *  on any future seed that adds a centreline row with R=1, because
 *  ``max(vc.r, fallback)`` returns the vertex value once it exceeds
 *  the computed one. */
export const LAVA_STRIP_LOCAL_HALF_WIDTH = 2

/** Frequency (Hz) of the flow scroll wave. Slow — the lava-waterfall
 *  is descending, the per-fragment band shimmer just hints at flow. */
const FLOW_FREQ_HZ = 0.35

/** Peak ±contribution of the flow scroll on top of the hot-core mask
 *  before the colour mix. Kept small so the player still reads the
 *  centreline mask. */
const FLOW_MOD_AMPLITUDE = 0.12

/** Shared TSL uniforms. Single instance per process so multiple lava
 *  meshes share a draw-call's worth of state. */
const TIME_UNIFORM = uniform(0)
const INTENSITY_UNIFORM = uniform(EMISSIVE_LANDMARKS_SCALAR.full)

// Live numeric mirrors so other modules (debug, tests) can read the
// current values without poking into the uniform handle's type.
let liveTimeSeconds = 0
let liveIntensity = EMISSIVE_LANDMARKS_SCALAR.full

/**
 * Pure helper — clamp & lerp the hot-core ↔ band-edge ramp from a
 * `COLOR_0.r` mask value. Exposed for unit-tests; the runtime TSL
 * graph mirrors the same math.
 *
 * - ``r ≤ LAVA_BANK_EDGE_R`` → returns the band-edge RGB.
 * - ``r ≥ 1.0``              → returns the hot-core RGB.
 * - in between               → linear interp on each channel.
 */
export function mixHotEdge(r: number): [number, number, number] {
  const safe = Number.isFinite(r) ? r : 0
  const t = Math.max(0, Math.min(1, (safe - LAVA_BANK_EDGE_R) / (1 - LAVA_BANK_EDGE_R)))
  const e = LAVA_BAND_EDGE_RGB
  const h = LAVA_HOT_CORE_RGB
  return [
    e[0] + (h[0] - e[0]) * t,
    e[1] + (h[1] - e[1]) * t,
    e[2] + (h[2] - e[2]) * t,
  ]
}

/** Pure helper — map a settings choice to its emissive intensity
 *  multiplier. Mirrors ``EMISSIVE_LANDMARKS_SCALAR``; kept as a thin
 *  function so call sites can read intent rather than indexing a
 *  record. */
export function intensityForSetting(setting: EmissiveLandmarksIntensity): number {
  return EMISSIVE_LANDMARKS_SCALAR[setting]
}

/**
 * Build the lava-river material as a fresh ``MeshStandardNodeMaterial``.
 * Cheap to call; the only allocated state is the material itself plus
 * the TSL node graph (the time + intensity uniforms are module-scoped
 * and shared across calls).
 *
 * The graph composes:
 *
 *   1. ``COLOR_0.r``  →  hot-channel mask (already 0..1 along width)
 *      taken with ``max(vc.r, fromLocalZ)``. The fallback derived
 *      from ``positionLocal.z`` covers the current seed shipping only
 *      2 edge rows (no centreline vertex) — without it, fragment
 *      interpolation between two 0.2 R values produces a uniform 0.2
 *      across the entire strip and the hot core disappears. The
 *      fallback collapses to a no-op once a future seed authors a
 *      centreline row with ``COLOR_0.r = 1``.
 *   2. Subtle flow modulation:
 *        flowMod = sin(time × 2π × FLOW_FREQ_HZ + COLOR_0.b × 2π)
 *      multiplied by FLOW_MOD_AMPLITUDE, added to the mask. Centre
 *      stays hottest on average; bands shimmer up/down the strip.
 *   3. ``colorNode``  =  mix(bandEdge, hotCore, clamp(mask, 0, 1))
 *   4. ``emissiveNode`` = colorNode × intensityUniform.
 *
 * Roughness is high (0.85) — lava reads as a non-reflective surface.
 * Metalness is 0 — there's no specular kick off molten rock.
 */
export function buildLavaRiverMaterial(): MeshStandardNodeMaterial {
  // High roughness + zero metalness — molten rock reads as matte, no
  // specular kick that would fight the emissive read.
  const mat = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.85 })
  mat.name = 'mat_lava_river'

  // COLOR_0 lands on Three's `attribute('color')` as a vec4 — same
  // path the terrain shader uses for AO + path-worn. Default-zeroed
  // when the geometry doesn't ship the attribute (shouldn't happen
  // for lava strips, but defensive).
  const vc = attribute('color') as Node<'vec4'>
  // R = hot-channel mask along the river width (centreline=1, edges≈0.2).
  // B = flow phase along the strip's length (0..1).
  //
  // The seed's strip ships only 2 vertex rows at the banks (no
  // centreline), so vertex interpolation between two 0.2 R values
  // yields 0.2 everywhere — the COLOR_0 contract's centreline=1 hot
  // peak is lost. Defend against that by also deriving a hot-core mask
  // from the local-space distance to the centreline: 1 at z=0, 0 at
  // |z|=LAVA_STRIP_LOCAL_HALF_WIDTH. Take the max of the two so a
  // future seed that adds a centreline row (with vc.r=1 there) wins
  // back automatically without any shader churn.
  const vertexMask = clamp(vc.r, float(0), float(1))
  const widthFalloff = clamp(
    abs(positionLocal.z).div(float(LAVA_STRIP_LOCAL_HALF_WIDTH)),
    float(0),
    float(1),
  )
  const computedMask = float(1).sub(widthFalloff.mul(widthFalloff).mul(float(0.8)))
  const hotMaskRaw = clamp(max(vertexMask, computedMask), float(0), float(1))
  const flowPhase = vc.b

  // Sin-of-time scroll. The factor `2π × FLOW_FREQ_HZ` is folded into
  // the time multiply at graph-build time, leaving one mul + one add
  // inside the sin for the per-fragment cost.
  const flow = sin(
    TIME_UNIFORM.mul(float(FLOW_FREQ_HZ * Math.PI * 2)).add(
      flowPhase.mul(float(Math.PI * 2)),
    ),
  ).mul(float(FLOW_MOD_AMPLITUDE))
  const mask = clamp(hotMaskRaw.add(flow), float(0), float(1))

  // Remap [LAVA_BANK_EDGE_R, 1] → [0, 1] before the colour mix so the
  // band edge colour anchors where the seed actually stamped 0.2 (any
  // r below that — beyond the bank — also reads as full cool).
  const ramped = clamp(
    mask.sub(float(LAVA_BANK_EDGE_R)).div(float(1 - LAVA_BANK_EDGE_R)),
    float(0),
    float(1),
  )

  const bandCol = vec3(LAVA_BAND_EDGE_RGB[0], LAVA_BAND_EDGE_RGB[1], LAVA_BAND_EDGE_RGB[2])
  const hotCol = vec3(LAVA_HOT_CORE_RGB[0], LAVA_HOT_CORE_RGB[1], LAVA_HOT_CORE_RGB[2])
  const blended = mix(bandCol, hotCol, ramped)

  mat.colorNode = blended
  // Emissive is the same ramp scaled by intensity — multiplying after
  // the mix means the band-edge red glows softly while the hot core
  // lights up brightly. Saturate at 2× linear so bloom hookups (when
  // they land) get a strong signal without blowing past the tonemap's
  // useful range.
  mat.emissiveNode = blended.mul(INTENSITY_UNIFORM).mul(ramped.add(float(0.4)))
  return mat
}

/**
 * Walk a loaded glTF scene root and swap every mesh tagged
 * ``userData.landmark_id === "lava_river_strip"`` over to the runtime
 * lava material. Idempotent — re-running on the same root just
 * re-replaces materials that are already lava (the shared intensity
 * uniform refreshes either way).
 *
 * Always replaces materials regardless of setting — the `off` setting
 * collapses the emissive contribution to zero via the shared uniform,
 * which keeps the strip rendering as cooled-lava albedo (hot/edge mix
 * without glow) rather than the GLB's flat baked colour. Live setting
 * changes via ``applyEmissiveLandmarksSetting`` therefore take effect
 * immediately without re-loading the track.
 *
 * Returns the count of meshes affected, for caller logging.
 */
export function applyLavaRiverMaterialToScene(
  root: THREE.Object3D,
  setting: EmissiveLandmarksIntensity,
): number {
  applyEmissiveLandmarksSetting(setting)
  let count = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (obj.userData?.landmark_id !== 'lava_river_strip') return
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) {
      for (const m of mat) safeDispose(m)
    } else if (mat) {
      safeDispose(mat)
    }
    obj.material = buildLavaRiverMaterial() as unknown as THREE.Material
    count += 1
  })
  return count
}

function safeDispose(m: THREE.Material): void {
  try {
    m.dispose()
  } catch {
    /* tolerate already-disposed glTF defaults */
  }
}

/**
 * Advance the lava material's shared animation clock. Call once per
 * frame from the render loop with deterministic simulation time so
 * the flow shimmer matches across replays. Render-only — never writes
 * sim state.
 */
export function updateLavaTime(seconds: number): void {
  if (!Number.isFinite(seconds)) return
  liveTimeSeconds = seconds
  TIME_UNIFORM.value = seconds
}

/**
 * Push a new player-facing emissive intensity into the live material
 * uniform. Used by ``setEmissiveLandmarks`` so a setting change takes
 * effect immediately without a reload. ``off`` zeroes the emissive
 * contribution; the colourNode keeps reading the hot/edge ramp so
 * the strip still reads as cooled lava rather than a black band.
 */
export function applyEmissiveLandmarksSetting(setting: EmissiveLandmarksIntensity): void {
  const v = EMISSIVE_LANDMARKS_SCALAR[setting]
  liveIntensity = v
  INTENSITY_UNIFORM.value = v
}

/** Read-only debug view of the shared uniforms. Surfaced for tests
 *  and the perf HUD. */
export function debugLavaState(): { timeSeconds: number; intensity: number } {
  return { timeSeconds: liveTimeSeconds, intensity: liveIntensity }
}
