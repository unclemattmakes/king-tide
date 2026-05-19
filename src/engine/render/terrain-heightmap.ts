import * as THREE from 'three'

/**
 * A 2D top-down heightmap of static terrain, sampled by the water shader to
 * attenuate wave displacement in shallow / dry areas (so wave crests stop
 * clipping up through the seabed near shorelines) and to drive depth-based
 * surf foam. Built once at track load.
 *
 * Format: single-channel half-float texture. Each texel stores the maximum Y
 * found by rasterizing every terrain triangle into the cell at world coords
 * (cellX, cellZ). Cells with no terrain coverage hold `DEEP_SENTINEL` so the
 * shader treats them as bottomless (full-strength waves).
 *
 * Coverage: `worldMin` / `worldMax` give the world-space XZ AABB the texture
 * spans. The shader clips to these bounds and falls back to "deep" outside —
 * water past the terrain's reach (open ocean horizon) reads as full-depth.
 */
export type TerrainHeightmap = {
  texture: THREE.DataTexture
  worldMin: THREE.Vector2
  worldMax: THREE.Vector2
  resolution: number
  /** CPU-side copy of the rasterised max-Y grid. Same layout as the
   *  Float32 accumulator before the half-float pack — `raw[v*res + u]`
   *  holds the highest terrain Y inside cell (u, v), or
   *  `DEEP_SENTINEL` for cells with no terrain coverage. Used for
   *  CPU diagnostics like the water-coverage check at boot. */
  raw?: Float32Array
}

const DEEP_SENTINEL = -10000

/**
 * Build a heightmap by rasterizing all terrain triangles in the given roots.
 * Each root's `matrixWorld` is read directly (callers should ensure parents
 * have been added to the scene + updated, or pass already-world-baked
 * geometry). Decorative meshes (`userData.kind === 'decoration'`) and
 * `InstancedMesh` instances are skipped — matching the rule used by
 * `attachTrackColliders` so the heightmap reflects the same terrain the
 * physics raycast hits.
 *
 * Returns null if no triangles were found (e.g. an editor scene with no
 * environment yet) — callers should treat this as "no heightmap, no
 * shoaling" and the water shader falls back to its previous behaviour.
 */
/**
 * Heightmap resolution. The water shader allocates its sampling texture
 * at this fixed size so the builder's output drops straight into the
 * pre-bound GPU texture without forcing a re-allocation. If you ever
 * change this, update `TERRAIN_HEIGHTMAP_RES` in `water.ts` to match.
 */
export const TERRAIN_HEIGHTMAP_RESOLUTION = 512

export function buildTerrainHeightmap(
  roots: readonly THREE.Object3D[],
  opts?: { padding?: number },
): TerrainHeightmap | null {
  const resolution = TERRAIN_HEIGHTMAP_RESOLUTION
  const padding = opts?.padding ?? 8

  const va = new THREE.Vector3()
  const vb = new THREE.Vector3()
  const vc = new THREE.Vector3()

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  type Tri = {
    ax: number
    az: number
    ay: number
    bx: number
    bz: number
    by: number
    cx: number
    cz: number
    cy: number
  }
  const tris: Tri[] = []

  for (const root of roots) {
    root.updateMatrixWorld(true)
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      if (obj.userData?.kind === 'decoration') return
      if (obj instanceof THREE.InstancedMesh) return
      const geom = obj.geometry as THREE.BufferGeometry
      const posAttr = geom.attributes.position
      if (!posAttr) return
      const mw = obj.matrixWorld
      const index = geom.index
      const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
      for (let i = 0; i < triCount; i++) {
        const ai = index ? (index.array[i * 3] as number) : i * 3
        const bi = index ? (index.array[i * 3 + 1] as number) : i * 3 + 1
        const ci = index ? (index.array[i * 3 + 2] as number) : i * 3 + 2
        va.fromBufferAttribute(posAttr, ai).applyMatrix4(mw)
        vb.fromBufferAttribute(posAttr, bi).applyMatrix4(mw)
        vc.fromBufferAttribute(posAttr, ci).applyMatrix4(mw)
        tris.push({
          ax: va.x,
          az: va.z,
          ay: va.y,
          bx: vb.x,
          bz: vb.z,
          by: vb.y,
          cx: vc.x,
          cz: vc.z,
          cy: vc.y,
        })
        const tMinX = Math.min(va.x, vb.x, vc.x)
        const tMaxX = Math.max(va.x, vb.x, vc.x)
        const tMinZ = Math.min(va.z, vb.z, vc.z)
        const tMaxZ = Math.max(va.z, vb.z, vc.z)
        if (tMinX < minX) minX = tMinX
        if (tMaxX > maxX) maxX = tMaxX
        if (tMinZ < minZ) minZ = tMinZ
        if (tMaxZ > maxZ) maxZ = tMaxZ
      }
    })
  }

  if (tris.length === 0 || !Number.isFinite(minX)) return null

  minX -= padding
  minZ -= padding
  maxX += padding
  maxZ += padding
  const sizeX = maxX - minX
  const sizeZ = maxZ - minZ
  const cellX = sizeX / resolution
  const cellZ = sizeZ / resolution

  // Float32 accumulator — converted to half-float at the end for a
  // filterable WebGPU texture (`r16float` is in the default feature set;
  // `r32float` requires `float32-filterable`).
  const grid = new Float32Array(resolution * resolution)
  grid.fill(DEEP_SENTINEL)

  for (const t of tris) {
    const tMinX = Math.min(t.ax, t.bx, t.cx)
    const tMaxX = Math.max(t.ax, t.bx, t.cx)
    const tMinZ = Math.min(t.az, t.bz, t.cz)
    const tMaxZ = Math.max(t.az, t.bz, t.cz)

    // Cell range covering the tri's XZ AABB (inclusive).
    let u0 = Math.floor((tMinX - minX) / cellX)
    let u1 = Math.floor((tMaxX - minX) / cellX)
    let v0 = Math.floor((tMinZ - minZ) / cellZ)
    let v1 = Math.floor((tMaxZ - minZ) / cellZ)
    if (u0 < 0) u0 = 0
    if (v0 < 0) v0 = 0
    if (u1 > resolution - 1) u1 = resolution - 1
    if (v1 > resolution - 1) v1 = resolution - 1
    if (u0 > u1 || v0 > v1) continue

    // Barycentric setup in XZ.
    const dx1 = t.ax - t.cx
    const dz1 = t.az - t.cz
    const dx2 = t.bx - t.cx
    const dz2 = t.bz - t.cz
    const denom = dz2 * dx1 - dx2 * dz1
    // Tris collapsed in XZ (a vertical wall) can't be projected — skip.
    if (Math.abs(denom) < 1e-7) continue
    const invDenom = 1 / denom

    for (let v = v0; v <= v1; v++) {
      const cz = minZ + (v + 0.5) * cellZ
      const rowOffset = v * resolution
      for (let u = u0; u <= u1; u++) {
        const cx = minX + (u + 0.5) * cellX
        const px = cx - t.cx
        const pz = cz - t.cz
        const w1 = (dz2 * px - dx2 * pz) * invDenom
        const w2 = (dx1 * pz - dz1 * px) * invDenom
        const w3 = 1 - w1 - w2
        // Tiny epsilon so edge-shared triangles don't leave hairline gaps
        // between cells at triangle boundaries.
        if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue
        const y = t.ay * w1 + t.by * w2 + t.cy * w3
        const idx = rowOffset + u
        const prev = grid[idx] ?? DEEP_SENTINEL
        if (y > prev) grid[idx] = y
      }
    }
  }

  // Convert to half-float for a default-filterable WebGPU texture. Heights
  // in the half-float range (±65504) easily cover any plausible terrain Y.
  const halfData = new Uint16Array(resolution * resolution)
  for (let i = 0; i < grid.length; i++) {
    halfData[i] = THREE.DataUtils.toHalfFloat(grid[i] ?? DEEP_SENTINEL)
  }
  const texture = new THREE.DataTexture(
    halfData,
    resolution,
    resolution,
    THREE.RedFormat,
    THREE.HalfFloatType,
  )
  texture.name = 'water:terrainHeightmap'
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true

  return {
    texture,
    worldMin: new THREE.Vector2(minX, minZ),
    worldMax: new THREE.Vector2(maxX, maxZ),
    resolution,
    raw: grid,
  }
}

/**
 * Sample the heightmap at a world XZ coordinate. Returns the highest
 * terrain Y at that XZ, or `null` when the point is outside the
 * heightmap's covered region (open ocean), or when the cell holds the
 * deep-sentinel (no triangle rasterised here).
 *
 * Linear-filtered via the four surrounding cells, matching the GPU
 * shader's `LinearFilter` sampling so the CPU diagnostic reads the
 * same height the runtime water shader does for shoaling.
 */
export function sampleTerrainHeightAtXZ(
  hm: TerrainHeightmap,
  x: number,
  z: number,
): number | null {
  if (!hm.raw) return null
  const sizeX = hm.worldMax.x - hm.worldMin.x
  const sizeZ = hm.worldMax.y - hm.worldMin.y
  if (sizeX <= 0 || sizeZ <= 0) return null
  const u = ((x - hm.worldMin.x) / sizeX) * hm.resolution - 0.5
  const v = ((z - hm.worldMin.y) / sizeZ) * hm.resolution - 0.5
  if (u < 0 || v < 0 || u >= hm.resolution || v >= hm.resolution) return null
  const u0 = Math.floor(u)
  const v0 = Math.floor(v)
  const u1 = Math.min(u0 + 1, hm.resolution - 1)
  const v1 = Math.min(v0 + 1, hm.resolution - 1)
  const fu = u - u0
  const fv = v - v0
  const idx = (uu: number, vv: number) => vv * hm.resolution + uu
  const h00 = hm.raw[idx(u0, v0)]!
  const h10 = hm.raw[idx(u1, v0)]!
  const h01 = hm.raw[idx(u0, v1)]!
  const h11 = hm.raw[idx(u1, v1)]!
  // Treat any neighbouring deep-sentinel as "no terrain" — don't blend
  // into the −10000 floor or the result is dragged catastrophically low.
  if (
    h00 === DEEP_SENTINEL ||
    h10 === DEEP_SENTINEL ||
    h01 === DEEP_SENTINEL ||
    h11 === DEEP_SENTINEL
  ) {
    return null
  }
  const top = h00 + (h10 - h00) * fu
  const bot = h01 + (h11 - h01) * fu
  return top + (bot - top) * fv
}
