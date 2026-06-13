import type * as THREE from 'three'

/**
 * Shadow-caster size gate (the 2026-06-11 frame-ablation finding — see
 * docs/perf-baseline.md).
 *
 * Every static mesh used to cast into the sun's 1024² follow box, and the
 * depth-pass cost scales with caster COUNT, not map size: on mexico-city the
 * dressed city's ~477 casters were the whole ~6.5 ms CPU gap vs sandbar
 * (scenery-hidden ≈ shadows-off in the ablation), while 1024²→512² measured
 * exactly free. So small dressing stops casting; landmark-scale silhouettes
 * (terrain, buildings, bridges) keep their grounding shadows; movers (bikes,
 * riders) are spawned outside the gated roots and are never gated.
 *
 * This mirrors the water mirror's `REFLECT_MIN_RADIUS_M` opt-in gate
 * (track-loader), inverted: reflections opt the big things IN, shadows opt
 * the small things OUT.
 *
 * Exemptions baked into `shadowCasterExempt`:
 *  - foliage (`mat_foliage*`): palm shadows on the beach are a cheap,
 *    look-load-bearing read (a few dozen meshes repo-wide), and their thin
 *    silhouettes sit near the gate boundary — keep them stable.
 *
 * `?shadowcast=<metres>` overrides the threshold per boot — the perf kit's
 * A/B axis and a future quality-ladder rung. `?shadowcast=0` disables the
 * gate (legacy cast-everything).
 */

/** Default minimum world bounding radius (m) for a static mesh to cast. */
export const DEFAULT_SHADOW_CAST_MIN_RADIUS_M = 6

/** Per-boot threshold: `?shadowcast=<metres>`, 0 = gate off. */
export function resolveShadowCastMinRadius(): number {
  if (typeof window === 'undefined') return DEFAULT_SHADOW_CAST_MIN_RADIUS_M
  const raw = new URLSearchParams(window.location.search).get('shadowcast')
  if (raw === null) return DEFAULT_SHADOW_CAST_MIN_RADIUS_M
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHADOW_CAST_MIN_RADIUS_M
}

/** Material-based exemptions — see module doc. */
export function shadowCasterExempt(mesh: THREE.Mesh): boolean {
  const mat = mesh.material
  const name = Array.isArray(mat) ? mat[0]?.name : (mat as THREE.Material | null)?.name
  return typeof name === 'string' && name.startsWith('mat_foliage')
}

/**
 * Apply the gate to one mesh given its world-space bounding radius. Returns
 * true when the mesh was gated (stopped casting). No-op when the gate is
 * disabled (minRadius 0), the mesh wasn't casting anyway, or it's exempt.
 */
export function gateShadowCaster(
  mesh: THREE.Mesh,
  worldRadiusM: number,
  minRadiusM: number,
): boolean {
  if (minRadiusM <= 0 || !mesh.castShadow) return false
  if (worldRadiusM >= minRadiusM) return false
  if (shadowCasterExempt(mesh)) return false
  mesh.castShadow = false
  return true
}
