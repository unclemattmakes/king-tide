/**
 * Shore field — a pure-data bake derived from the terrain heightmap, used to
 * drive shore-aligned ("shoreline transition") waves on BOTH the CPU buoyancy
 * sampler and the GPU water shader.
 *
 * No Three.js here: this module lives in the sim layer so `wave-field.ts` can
 * sample it for buoyancy without violating the sim-can't-import-Three rule.
 * The render layer (`terrain-heightmap.ts`) calls {@link buildShoreField} from
 * the same rasterisation pass that produces the heightmap's `raw` grid, wraps
 * the result in a GPU texture, and also hands the same arrays to the wave field
 * via `setShoreField`. One bake → one source of truth → CPU, GPU, and every
 * multiplayer peer evaluate the identical field (only `waveField.time` is
 * snapshotted, so the static field must reproduce bit-for-bit — the bake is
 * deterministic: fixed iteration order, no Map/Set traversal).
 *
 * Contents, per cell (row-major `v*resolution + u`):
 *   - `dist`  — horizontal distance (metres) to the nearest shoreline (the
 *               land/water boundary), via a deterministic 2-pass chamfer
 *               distance transform. Lightly blurred so its gradient is smooth.
 *   - `nrmX/nrmZ` — unit OFFSHORE normal = normalize(∇dist). Points from land
 *               toward deeper water (direction of increasing distance).
 *   - `depth` — water depth (`waterLevel − terrainY`), metres. Positive in
 *               water, ≤ 0 on land; open-ocean / uncovered cells hold a large
 *               positive value so the shore term naturally vanishes there.
 *
 * The shore-wave math that consumes this field (amplitude envelope, phase,
 * the SHORE_* constants) lives in `wave-field.ts` and is mirrored into the
 * TSL shader in `render/water.ts`.
 */

/** Mirror of `DEEP_SENTINEL` in `render/terrain-heightmap.ts` — cells with no
 *  rasterised terrain hold this max-Y value. Kept in sync structurally: a
 *  terrain Y this low always reads as bottomless deep water. */
const DEEP_SENTINEL = -10000

/** Distances are clamped to this many metres before storage so the value
 *  stays inside the half-float range when uploaded as a GPU texture. Anything
 *  this far from shore is open ocean where the shore term is zero anyway. */
const MAX_DIST = 4096

export type ShoreField = {
  resolution: number
  /** World-space XZ AABB minimum (same coverage as the source heightmap). */
  minX: number
  minZ: number
  /** World-space XZ AABB span. */
  sizeX: number
  sizeZ: number
  /** Horizontal distance to nearest shoreline, metres. */
  dist: Float32Array
  /** Unit offshore normal X (= ∂dist/∂x normalised). */
  nrmX: Float32Array
  /** Unit offshore normal Z (= ∂dist/∂z normalised). */
  nrmZ: Float32Array
  /** Water depth (waterLevel − terrainY), metres. */
  depth: Float32Array
}

/** Sample result. `null` from {@link sampleShore} means "no shore influence
 *  here" (out of bounds, on dry land, or beyond the surf band). */
export type ShoreSample = {
  dist: number
  nrmX: number
  nrmZ: number
  depth: number
}

/**
 * Build a shore field from a heightmap's raw max-Y grid. Returns `null` when
 * the grid contains no land (nothing above `waterLevel`), so callers can treat
 * the field as absent and fall back to legacy open-water behaviour.
 *
 * Deterministic by construction: the chamfer transform and the box blur run in
 * fixed scan order with plain arithmetic, so two bakes of the same input are
 * byte-identical (required for replay / netcode — see module header).
 */
export function buildShoreField(opts: {
  raw: Float32Array
  resolution: number
  minX: number
  minZ: number
  sizeX: number
  sizeZ: number
  /** Mean sea level Y the water plane sits at (typically 0). */
  waterLevel: number
}): ShoreField | null {
  const { raw, resolution, minX, minZ, sizeX, sizeZ, waterLevel } = opts
  const n = resolution * resolution
  if (raw.length !== n || sizeX <= 0 || sizeZ <= 0) return null

  const cellX = sizeX / resolution
  const cellZ = sizeZ / resolution
  const diag = Math.hypot(cellX, cellZ)

  // Depth + land mask. A cell is "land" when its terrain rises to/above the
  // water plane. Sentinel cells (no terrain) read as very deep water and are
  // never land. `depth` mirrors the GPU's `waterY − terrainY`.
  const depth = new Float32Array(n)
  const dist = new Float32Array(n)
  let landCount = 0
  for (let i = 0; i < n; i++) {
    const terrainY = raw[i] ?? DEEP_SENTINEL
    const d = waterLevel - terrainY
    depth[i] = d
    if (d <= 0) {
      dist[i] = 0 // land seeds the distance transform
      landCount++
    } else {
      dist[i] = MAX_DIST // water — to be filled by the transform
    }
  }
  // No coastline at all → no shore waves. Caller falls back to legacy.
  if (landCount === 0 || landCount === n) return null

  // ---- 2-pass chamfer distance transform (anisotropic, metric in metres) --
  // Forward scan accumulates from already-visited up/left neighbours, backward
  // scan from down/right. Orthogonal steps cost the real cell pitch; diagonal
  // steps cost the cell diagonal — so the result approximates true Euclidean
  // distance even when cells aren't square (padded AABBs rarely are).
  const idx = (u: number, v: number) => v * resolution + u
  const relax = (i: number, fromDist: number, cost: number) => {
    const cand = fromDist + cost
    if (cand < dist[i]!) dist[i] = cand
  }
  for (let v = 0; v < resolution; v++) {
    for (let u = 0; u < resolution; u++) {
      const i = idx(u, v)
      if (dist[i] === 0) continue
      if (u > 0) relax(i, dist[idx(u - 1, v)]!, cellX)
      if (v > 0) relax(i, dist[idx(u, v - 1)]!, cellZ)
      if (u > 0 && v > 0) relax(i, dist[idx(u - 1, v - 1)]!, diag)
      if (u < resolution - 1 && v > 0) relax(i, dist[idx(u + 1, v - 1)]!, diag)
    }
  }
  for (let v = resolution - 1; v >= 0; v--) {
    for (let u = resolution - 1; u >= 0; u--) {
      const i = idx(u, v)
      if (dist[i] === 0) continue
      if (u < resolution - 1) relax(i, dist[idx(u + 1, v)]!, cellX)
      if (v < resolution - 1) relax(i, dist[idx(u, v + 1)]!, cellZ)
      if (u < resolution - 1 && v < resolution - 1) relax(i, dist[idx(u + 1, v + 1)]!, diag)
      if (u > 0 && v < resolution - 1) relax(i, dist[idx(u - 1, v + 1)]!, diag)
    }
  }

  // ---- Light separable box blur so ∇dist is smooth across the medial axis --
  // A raw distance field has gradient discontinuities along ridges equidistant
  // from two shores; finite-differencing it produces noisy normals. One 3-tap
  // blur each axis tames this without meaningfully shifting the bands.
  boxBlur3(dist, resolution)

  // ---- Offshore normal = normalize(∇dist) via central differences ---------
  const nrmX = new Float32Array(n)
  const nrmZ = new Float32Array(n)
  for (let v = 0; v < resolution; v++) {
    for (let u = 0; u < resolution; u++) {
      const i = idx(u, v)
      const uL = u > 0 ? u - 1 : u
      const uR = u < resolution - 1 ? u + 1 : u
      const vD = v > 0 ? v - 1 : v
      const vU = v < resolution - 1 ? v + 1 : v
      const gx = (dist[idx(uR, v)]! - dist[idx(uL, v)]!) / ((uR - uL || 1) * cellX)
      const gz = (dist[idx(u, vU)]! - dist[idx(u, vD)]!) / ((vU - vD || 1) * cellZ)
      const len = Math.hypot(gx, gz)
      if (len > 1e-5) {
        nrmX[i] = gx / len
        nrmZ[i] = gz / len
      }
      // else leave (0,0): flat distance (deep water plateaus or the medial
      // axis). Amplitude is ~0 in those places, so direction doesn't matter.
    }
  }

  return { resolution, minX, minZ, sizeX, sizeZ, dist, nrmX, nrmZ, depth }
}

/** In-place separable 3-tap box blur (weights 1/4, 1/2, 1/4), clamped edges. */
function boxBlur3(grid: Float32Array, res: number): void {
  const tmp = new Float32Array(grid.length)
  // Horizontal.
  for (let v = 0; v < res; v++) {
    const row = v * res
    for (let u = 0; u < res; u++) {
      const c = grid[row + u]!
      const l = u > 0 ? grid[row + u - 1]! : c
      const r = u < res - 1 ? grid[row + u + 1]! : c
      tmp[row + u] = l * 0.25 + c * 0.5 + r * 0.25
    }
  }
  // Vertical.
  for (let v = 0; v < res; v++) {
    const row = v * res
    for (let u = 0; u < res; u++) {
      const c = tmp[row + u]!
      const d = v > 0 ? tmp[row - res + u]! : c
      const up = v < res - 1 ? tmp[row + res + u]! : c
      grid[row + u] = d * 0.25 + c * 0.5 + up * 0.25
    }
  }
}

/**
 * Bilinearly sample the shore field at world (x, z). Filtering matches the
 * GPU's `LinearFilter` texture read (texel-centre −0.5 offset, clamped
 * neighbours) so CPU buoyancy and the rendered surface agree.
 *
 * Returns `null` when the sample is out of bounds — callers treat that as deep
 * open water with no shore contribution. The normal is renormalised after the
 * lerp (bilinear filtering shrinks unit vectors near the medial axis).
 */
export function sampleShore(field: ShoreField, x: number, z: number): ShoreSample | null {
  const u = ((x - field.minX) / field.sizeX) * field.resolution - 0.5
  const v = ((z - field.minZ) / field.sizeZ) * field.resolution - 0.5
  if (u < 0 || v < 0 || u >= field.resolution || v >= field.resolution) return null
  const u0 = Math.floor(u)
  const v0 = Math.floor(v)
  const u1 = Math.min(u0 + 1, field.resolution - 1)
  const v1 = Math.min(v0 + 1, field.resolution - 1)
  const fu = u - u0
  const fv = v - v0
  const res = field.resolution
  const i00 = v0 * res + u0
  const i10 = v0 * res + u1
  const i01 = v1 * res + u0
  const i11 = v1 * res + u1
  const lerp2 = (a: Float32Array) => {
    const top = a[i00]! + (a[i10]! - a[i00]!) * fu
    const bot = a[i01]! + (a[i11]! - a[i01]!) * fu
    return top + (bot - top) * fv
  }
  const depth = lerp2(field.depth)
  const dist = lerp2(field.dist)
  let nrmX = lerp2(field.nrmX)
  let nrmZ = lerp2(field.nrmZ)
  const len = Math.hypot(nrmX, nrmZ)
  if (len > 1e-5) {
    nrmX /= len
    nrmZ /= len
  } else {
    nrmX = 0
    nrmZ = 0
  }
  return { dist, nrmX, nrmZ, depth }
}
