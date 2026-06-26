/**
 * Terrain water-level service — live handles for the King-tide.
 *
 * Mirrors `brush-tuning-service`: the terrain shader anchors its wet band,
 * waterline trio (algae/barnacle/salt marks) and underwater tint to a single
 * `waterLevel` value (terrain-shader.ts `yRelWater`). Holding that in a shader
 * UNIFORM instead of a baked constant lets the painted shoreline ride a moving
 * tide with no recompile — just a per-frame uniform write.
 *
 * Each terrain material registers its uniform here at GLB track load (after a
 * `clearTerrainWaterLevel()`); the runtime calls `setTerrainWaterLevel(h)` each
 * frame with the current sea level. Tracks with no tide never call the setter,
 * so the uniform sits at its build-time `water.height` — identical to the old
 * baked `float(waterLevel)`.
 */

/** Minimal shape of a TSL scalar uniform node — only `.value` is touched. */
type ScalarUniform = { value: number }

const handles = new Set<ScalarUniform>()

/** Drop all registered handles — call at the start of a GLB track load before
 *  the terrain materials re-register (pairs with `clearBrushTargets`). */
export function clearTerrainWaterLevel(): void {
  handles.clear()
}

export function registerTerrainWaterLevel(u: ScalarUniform): void {
  handles.add(u)
}

/** Push the current world sea level to every registered terrain material. */
export function setTerrainWaterLevel(h: number): void {
  for (const u of handles) u.value = h
}
