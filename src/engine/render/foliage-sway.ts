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
 * Three.js note: this implementation works through WebGL2's
 * `onBeforeCompile` path. WebGPU's TSL is a follow-up — when the
 * project's WebGPU path needs sway, port the same math into a TSL
 * node-tree fragment and call it from `applyFoliageSway` based on the
 * material's `userData.isWebGPU` hint.
 */

import * as THREE from 'three'

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

const PATCHED = Symbol.for('hoverbike.foliageSwayPatched')

type Patchable = THREE.Material & {
  onBeforeCompile?: (shader: THREE.WebGLProgramParametersWithUniforms) => void
  userData: { [key: string]: unknown; [k: symbol]: unknown }
}

export type SwayOptions = {
  /** Override the global wind for this material (e.g. interior banners
   *  that get less wind than open coast). 1.0 = full global wind. */
  windScale?: number
}

/**
 * Patch a material so its vertex shader applies the foliage sway
 * displacement. Idempotent — safe to call repeatedly.
 *
 * The patch reads `attribute vec3 color` (three.js's name for the
 * glTF `COLOR_0` attribute) and:
 *   - takes `color.r` as sway strength
 *   - takes `color.b` as a phase offset (mapped 0..1 → 0..2π)
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

  const prevOnBeforeCompile = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile.call(m, shader)

    // Expose the shared uniforms.
    shader.uniforms.uSwayTime = SWAY_TIME
    shader.uniforms.uSwayWind = SWAY_WIND
    shader.uniforms.uSwayFreq = SWAY_FREQ
    shader.uniforms.uSwayWindScale = windScale

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
uniform float uSwayWindScale;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // color.r is sway strength (0..1), color.b is phase offset (0..1).
  // Defaults to no sway when the geometry has no COLOR_0 attribute —
  // three.js fills color with vec3(1.0) in that case, so guard with
  // a small material-level userData flag if you need stricter checks.
  #ifdef USE_COLOR
    float swayStrength = color.r;
    float swayPhase    = color.b * 6.2831853; // 2π
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
}

/** Advance the shared sway clock. Pass elapsed simulation time in
 *  seconds. The render layer owns this — call once per frame before
 *  rendering swayed materials. */
export function updateSwayTime(seconds: number): void {
  SWAY_TIME.value = seconds
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
