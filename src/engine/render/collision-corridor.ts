/**
 * Collision-corridor clipping — drop static collision for geometry the player
 * can never legally reach.
 *
 * Most of a track's terrain trimesh is out of bounds: the out-of-bounds system
 * (src/game/systems/out-of-bounds.ts) leashes the bike to the racing line and
 * kills it past 2.5x the corridor half-width (the "hard leash"). On a 1 km
 * island like Mayday Bay the playable channel is a thin ribbon through the
 * middle, yet `attachTrackColliders` builds a Rapier trimesh for the WHOLE
 * island — paying collider build time + memory (and the double-winding) for
 * seabed and far hills the bike dies before touching.
 *
 * This module decides, per triangle, whether any part of it lies within a
 * generous corridor around the racing line; `attachTrackColliders` collides
 * only the kept triangles (and skips a mesh entirely when none survive — a
 * far-out-of-bounds landmark). Pure geometry, no three/Rapier imports, so the
 * safety property is unit-testable headlessly (tests/unit/collision-corridor).
 *
 * Safety (why this can't drop the floor from under the bike):
 *  - The cutoff = hard-leash + margin, ALWAYS strictly greater than the lethal
 *    wall, so every point the bike can legally occupy is well inside it.
 *  - The keep test is conservative by `maxEdge`: a triangle is dropped only when
 *    its NEAREST vertex is farther than `cutoff + (that triangle's longest
 *    edge)` from the line. The closest point of a triangle to the line is at
 *    most one edge-length nearer than its nearest vertex, so this NEVER drops a
 *    triangle that has any point within `cutoff` — even a huge coarse triangle
 *    that spans the corridor with all three vertices outside it. The whole
 *    cutoff-wide band therefore keeps full collision.
 *  - Distance is point-to-SEGMENT against the densely-sampled line, so it's
 *    robust regardless of sample spacing.
 * The caller adds a final belt-and-braces fallback: if a mesh whose XZ bounds
 * overlap the corridor somehow keeps zero triangles (a coordinate-frame
 * surprise), it collides the mesh whole.
 */

/** Extra horizontal margin (m) added beyond the hard-leash wall before terrain
 *  is dropped. Covers leash slop + a comfortable buffer past the lethal line. */
export const CORRIDOR_COLLISION_MARGIN_M = 60

/** Floor on the corridor cutoff (m) so a tight-corridor track (or one on the
 *  default leash) still keeps a wide, safe band of collidable terrain. */
export const MIN_CORRIDOR_COLLISION_CUTOFF_M = 150

export type CollisionCorridor = {
  /** Flat [x0,z0, x1,z1, ...] world-space samples of the (closed) racing line. */
  readonly lineXZ: Float32Array
  /** Triangles whose nearest point is farther than this (m, horizontal) from
   *  the line are dropped. = hard-leash + margin, floored — always > the wall. */
  readonly cutoffM: number
}

/**
 * Build a corridor from the racing line + the out-of-bounds hard-leash radius.
 * Returns null when there's no usable line (fewer than 2 points) — the caller
 * then collides everything (legacy behaviour).
 */
export function makeCollisionCorridor(
  points: readonly { x: number; z: number }[],
  hardLeashM: number,
): CollisionCorridor | null {
  if (points.length < 2) return null
  const lineXZ = new Float32Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    lineXZ[i * 2] = p.x
    lineXZ[i * 2 + 1] = p.z
  }
  const cutoffM = Math.max(
    hardLeashM + CORRIDOR_COLLISION_MARGIN_M,
    MIN_CORRIDOR_COLLISION_CUTOFF_M,
  )
  return { lineXZ, cutoffM }
}

/** Squared XZ distance from (px,pz) to segment (ax,az)-(bx,bz). */
function distSqPointSeg(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = ax + t * dx
  const cz = az + t * dz
  const ex = px - cx
  const ez = pz - cz
  return ex * ex + ez * ez
}

/** Min squared XZ distance from (px,pz) to the closed polyline `lineXZ`. */
function distSqToLineXZ(lineXZ: Float32Array, px: number, pz: number): number {
  const n = lineXZ.length / 2
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const d = distSqPointSeg(
      px,
      pz,
      lineXZ[i * 2]!,
      lineXZ[i * 2 + 1]!,
      lineXZ[j * 2]!,
      lineXZ[j * 2 + 1]!,
    )
    if (d < best) best = d
  }
  return best
}

export type CorridorClipResult = {
  /** Kept base-triangle indices (length is a multiple of 3) — a subset of the
   *  input, to be fed (then double-winded) to the trimesh. */
  readonly kept: Uint32Array
  /** Total base triangles considered (`baseIndices.length / 3`). */
  readonly total: number
  /** True when the mesh's XZ bounds overlap the corridor band. The caller uses
   *  this for its fail-safe: overlap + zero kept ⇒ collide the mesh whole. */
  readonly overlapsCorridor: boolean
}

/**
 * Filter `baseIndices` (a flat triangle list into `worldVerts`) to the
 * triangles that lie within `corridor.cutoffM` of the racing line. See the
 * module doc for the safety argument behind the `+maxEdge` keep test.
 */
export function clipTrianglesToCorridor(
  worldVerts: Float32Array,
  baseIndices: ArrayLike<number>,
  corridor: CollisionCorridor,
): CorridorClipResult {
  const { lineXZ, cutoffM } = corridor
  const triCount = Math.floor(baseIndices.length / 3)
  const vCount = Math.floor(worldVerts.length / 3)

  // Line bbox (XZ) for the cheap "definitely far" vertex reject.
  let lMinX = Number.POSITIVE_INFINITY
  let lMaxX = Number.NEGATIVE_INFINITY
  let lMinZ = Number.POSITIVE_INFINITY
  let lMaxZ = Number.NEGATIVE_INFINITY
  for (let i = 0; i < lineXZ.length; i += 2) {
    const x = lineXZ[i]!
    const z = lineXZ[i + 1]!
    if (x < lMinX) lMinX = x
    if (x > lMaxX) lMaxX = x
    if (z < lMinZ) lMinZ = z
    if (z > lMaxZ) lMaxZ = z
  }

  // Mesh-wide longest edge bounds how far a triangle's body can reach past its
  // nearest vertex, so a vertex beyond (line bbox + cutoff + meshMaxEdge) is
  // safely far for EVERY triangle here — we can skip its segment loop entirely.
  // Also accumulate the mesh XZ bbox for the overlap fail-safe.
  let meshMaxEdge = 0
  let mMinX = Number.POSITIVE_INFINITY
  let mMaxX = Number.NEGATIVE_INFINITY
  let mMinZ = Number.POSITIVE_INFINITY
  let mMaxZ = Number.NEGATIVE_INFINITY
  for (let v = 0; v < vCount; v++) {
    const x = worldVerts[v * 3]!
    const z = worldVerts[v * 3 + 2]!
    if (x < mMinX) mMinX = x
    if (x > mMaxX) mMaxX = x
    if (z < mMinZ) mMinZ = z
    if (z > mMaxZ) mMaxZ = z
  }
  for (let t = 0; t < triCount; t++) {
    const e = triMaxEdge(worldVerts, baseIndices, t)
    if (e > meshMaxEdge) meshMaxEdge = e
  }

  const farReject = cutoffM + meshMaxEdge
  // Per-vertex distance to the line (lazily: Infinity outside the reject bbox).
  const dist = new Float64Array(vCount)
  for (let v = 0; v < vCount; v++) {
    const x = worldVerts[v * 3]!
    const z = worldVerts[v * 3 + 2]!
    if (
      x < lMinX - farReject ||
      x > lMaxX + farReject ||
      z < lMinZ - farReject ||
      z > lMaxZ + farReject
    ) {
      dist[v] = Number.POSITIVE_INFINITY
    } else {
      dist[v] = Math.sqrt(distSqToLineXZ(lineXZ, x, z))
    }
  }

  const overlapsCorridor =
    mMinX <= lMaxX + cutoffM &&
    mMaxX >= lMinX - cutoffM &&
    mMinZ <= lMaxZ + cutoffM &&
    mMaxZ >= lMinZ - cutoffM

  const kept: number[] = []
  for (let t = 0; t < triCount; t++) {
    const a = baseIndices[t * 3] as number
    const b = baseIndices[t * 3 + 1] as number
    const c = baseIndices[t * 3 + 2] as number
    let minD = dist[a]!
    if (dist[b]! < minD) minD = dist[b]!
    if (dist[c]! < minD) minD = dist[c]!
    // Conservative keep: a triangle's closest point is at most one edge-length
    // nearer than its nearest vertex, so this never drops a triangle with any
    // point within `cutoffM` of the line (see module doc).
    if (minD <= cutoffM + triMaxEdge(worldVerts, baseIndices, t)) {
      kept.push(a, b, c)
    }
  }

  return { kept: Uint32Array.from(kept), total: triCount, overlapsCorridor }
}

/** Longest 3D edge length of base triangle `t`. 3D (not XZ) so the keep slack
 *  is conservative — a steep triangle's body can't be nearer than this allows. */
function triMaxEdge(worldVerts: Float32Array, baseIndices: ArrayLike<number>, t: number): number {
  const a = (baseIndices[t * 3] as number) * 3
  const b = (baseIndices[t * 3 + 1] as number) * 3
  const c = (baseIndices[t * 3 + 2] as number) * 3
  const ab = edgeLen(worldVerts, a, b)
  const bc = edgeLen(worldVerts, b, c)
  const ca = edgeLen(worldVerts, c, a)
  return Math.max(ab, bc, ca)
}

function edgeLen(worldVerts: Float32Array, i: number, j: number): number {
  const dx = worldVerts[i]! - worldVerts[j]!
  const dy = worldVerts[i + 1]! - worldVerts[j + 1]!
  const dz = worldVerts[i + 2]! - worldVerts[j + 2]!
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
