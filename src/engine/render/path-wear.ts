/**
 * Path-worn racing-line mask — pure math.
 *
 * The actual bake happens in Blender
 * (`tools/blender/hoverbike_addon/bake.py`), which stamps the result
 * into the source terrain's `baked_path` FLOAT attribute. The seeded
 * Geometry-Nodes graph routes that attribute into `COLOR_0.B`, and the
 * runtime terrain shader (`terrain-shader.ts`) reads `vc.b` to mix the
 * diffuse toward `pathTint`. See
 * [docs/vertex-attribute-spec.md](../../../docs/vertex-attribute-spec.md)
 * for the locked channel contract.
 *
 * This module exists so the falloff math can be exercised by vitest
 * without booting Blender. The Python `path_wear_at_distance` in
 * `bake.py` mirrors this function exactly; any divergence will be
 * caught by the cross-checked numbers in
 * `tests/unit/path-wear.test.ts`.
 */

export const DEFAULT_PATH_WEAR_INNER_M = 0
export const DEFAULT_PATH_WEAR_OUTER_M = 8
export const DEFAULT_PATH_WEAR_INTENSITY = 1

/**
 * Map `distance` (metres from the AI spline polyline) to a wear value
 * in `[0, 1]`.
 *
 * - `distance <= inner` → `1.0 * intensity` (full wear on the line).
 * - `distance >= outer` → `0.0` (no wear beyond the falloff).
 * - In between, follows a smoothstep from outer→inner (wear *rises*
 *   as you approach the line).
 *
 * `intensity` is a `[0, 1]` multiplier on the final value (clamped to
 * a sane upper bound so a runaway slider can't write values past 1).
 */
export function pathWearAtDistance(
  distance: number,
  inner: number = DEFAULT_PATH_WEAR_INNER_M,
  outer: number = DEFAULT_PATH_WEAR_OUTER_M,
  intensity: number = DEFAULT_PATH_WEAR_INTENSITY,
): number {
  let wear: number
  if (outer <= inner) {
    // Degenerate band — collapse to a hard mask at `inner`.
    wear = distance <= inner ? 1 : 0
  } else if (distance <= inner) {
    wear = 1
  } else if (distance >= outer) {
    wear = 0
  } else {
    // Smoothstep from outer (wear=0) → inner (wear=1).
    const t = (outer - distance) / (outer - inner)
    wear = t * t * (3 - 2 * t)
  }
  const clampedI = Math.max(0, Math.min(1, intensity))
  return Math.max(0, Math.min(1, wear * clampedI))
}
