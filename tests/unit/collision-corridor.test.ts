import { describe, expect, it } from 'vitest'
import {
  CORRIDOR_COLLISION_MARGIN_M,
  clipTrianglesToCorridor,
  MIN_CORRIDOR_COLLISION_CUTOFF_M,
  makeCollisionCorridor,
} from '@/engine/render/collision-corridor'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'

// ── Synthetic geometry helpers ──────────────────────────────────────────────

/** Flat terrain grid centred on the origin: a plane of `cell`-metre quads
 *  spanning [-halfX..halfX] × [-halfZ..halfZ] at y=0, two triangles per quad. */
function flatGrid(halfX: number, halfZ: number, cell: number) {
  const nx = Math.floor((2 * halfX) / cell) + 1
  const nz = Math.floor((2 * halfZ) / cell) + 1
  const worldVerts = new Float32Array(nx * nz * 3)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 3
      worldVerts[o] = -halfX + i * cell
      worldVerts[o + 1] = 0
      worldVerts[o + 2] = -halfZ + j * cell
    }
  }
  const tris: number[] = []
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = j * nx + i + 1
      const c = (j + 1) * nx + i
      const d = (j + 1) * nx + i + 1
      tris.push(a, c, b, b, c, d)
    }
  }
  return { worldVerts, indices: Uint32Array.from(tris) }
}

/** A straight racing line along the +Z axis at x=0, sampled every `step` m. */
function zLine(halfZ: number, step: number): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = []
  for (let z = -halfZ; z <= halfZ; z += step) pts.push({ x: 0, z })
  return pts
}

function sideXZ(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  return (px - bx) * (az - bz) - (ax - bx) * (pz - bz)
}

function pointInTriXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): boolean {
  const d1 = sideXZ(px, pz, ax, az, bx, bz)
  const d2 = sideXZ(px, pz, bx, bz, cx, cz)
  const d3 = sideXZ(px, pz, cx, cz, ax, az)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** True when (x,z) falls inside any KEPT triangle, viewed top-down. */
function coveredByKept(worldVerts: Float32Array, kept: Uint32Array, x: number, z: number): boolean {
  for (let t = 0; t < kept.length; t += 3) {
    const a = kept[t]! * 3
    const b = kept[t + 1]! * 3
    const c = kept[t + 2]! * 3
    if (
      pointInTriXZ(
        x,
        z,
        worldVerts[a]!,
        worldVerts[a + 2]!,
        worldVerts[b]!,
        worldVerts[b + 2]!,
        worldVerts[c]!,
        worldVerts[c + 2]!,
      )
    ) {
      return true
    }
  }
  return false
}

// ── makeCollisionCorridor ───────────────────────────────────────────────────

describe('makeCollisionCorridor', () => {
  it('returns null without a usable line', () => {
    expect(makeCollisionCorridor([], 30)).toBeNull()
    expect(makeCollisionCorridor([{ x: 0, z: 0 }], 30)).toBeNull()
  })

  it('cutoff is hard-leash + margin, floored to the minimum', () => {
    const wide = makeCollisionCorridor(
      [
        { x: 0, z: 0 },
        { x: 0, z: 10 },
      ],
      200,
    )
    expect(wide?.cutoffM).toBe(200 + CORRIDOR_COLLISION_MARGIN_M)
    // A tight corridor still keeps the generous floor.
    const tight = makeCollisionCorridor(
      [
        { x: 0, z: 0 },
        { x: 0, z: 10 },
      ],
      10,
    )
    expect(tight?.cutoffM).toBe(MIN_CORRIDOR_COLLISION_CUTOFF_M)
  })

  it('packs the line into flat XZ pairs', () => {
    const c = makeCollisionCorridor(
      [
        { x: 1, z: 2 },
        { x: 3, z: 4 },
        { x: 5, z: 6 },
      ],
      30,
    )
    expect(Array.from(c!.lineXZ)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

// ── clipTrianglesToCorridor ─────────────────────────────────────────────────

describe('clipTrianglesToCorridor', () => {
  it('keeps near triangles and drops far ones', () => {
    const grid = flatGrid(400, 200, 8)
    const corridor = makeCollisionCorridor(zLine(200, 8), 20)!
    const res = clipTrianglesToCorridor(grid.worldVerts, grid.indices, corridor)
    expect(res.total).toBe(grid.indices.length / 3)
    expect(res.kept.length).toBeGreaterThan(0)
    expect(res.kept.length).toBeLessThan(grid.indices.length) // genuinely clipped
    expect(res.overlapsCorridor).toBe(true)
  })

  it('SAFETY: every point within the hard leash keeps collision', () => {
    // cutoff = 150 (floor); the bike dies at the hard leash (20 m) — far inside.
    const grid = flatGrid(400, 200, 8)
    const hard = 20
    const corridor = makeCollisionCorridor(zLine(200, 8), hard)!
    const res = clipTrianglesToCorridor(grid.worldVerts, grid.indices, corridor)
    for (let z = -180; z <= 180; z += 11) {
      for (let x = -hard; x <= hard; x += 2.5) {
        expect(coveredByKept(grid.worldVerts, res.kept, x, z)).toBe(true)
      }
    }
    // ...and far out of bounds genuinely loses its collision (the whole point).
    expect(coveredByKept(grid.worldVerts, res.kept, 360, 0)).toBe(false)
  })

  it('keeps a huge triangle that spans the corridor with all vertices outside it', () => {
    // The +maxEdge keep rule: a triangle crossing the line but with every
    // vertex beyond the cutoff must NOT be dropped (it has points on the line).
    const verts = Float32Array.from([200, 0, -10, 200, 0, 10, -200, 0, 0])
    const indices = Uint32Array.from([0, 1, 2])
    const corridor = makeCollisionCorridor(zLine(50, 10), 20)! // cutoff 150
    const res = clipTrianglesToCorridor(verts, indices, corridor)
    expect(res.kept.length).toBe(3)
  })

  it('drops a small mesh entirely out of bounds and reports no overlap', () => {
    const verts = Float32Array.from([300, 0, 0, 310, 0, 0, 305, 0, 10])
    const indices = Uint32Array.from([0, 1, 2])
    const corridor = makeCollisionCorridor(zLine(50, 10), 20)! // band |x| <= 150
    const res = clipTrianglesToCorridor(verts, indices, corridor)
    expect(res.kept.length).toBe(0)
    expect(res.overlapsCorridor).toBe(false)
  })

  it('handles point-to-segment distance between sparse line samples', () => {
    // Two samples 100 m apart; a vertex beside the segment midpoint is near the
    // line even though it's far from either sample point.
    const verts = Float32Array.from([5, 0, 50, 7, 0, 50, 6, 0, 52])
    const indices = Uint32Array.from([0, 1, 2])
    const corridor = makeCollisionCorridor(
      [
        { x: 0, z: 0 },
        { x: 0, z: 100 },
      ],
      10,
    )!
    const res = clipTrianglesToCorridor(verts, indices, corridor)
    expect(res.kept.length).toBe(3)
  })
})

// ── End-to-end Rapier proof ─────────────────────────────────────────────────

describe('corridor-clipped collision (Rapier)', () => {
  it('collides under the corridor and nowhere past it', async () => {
    const phys = await createPhysicsWorld({ gravity: 0 })
    const grid = flatGrid(400, 200, 8)
    const hard = 20
    const corridor = makeCollisionCorridor(zLine(200, 8), hard)!
    const kept = clipTrianglesToCorridor(grid.worldVerts, grid.indices, corridor).kept

    // Double-wind exactly as attachTrackColliders does, then build the trimesh.
    const n = kept.length
    const idx = new Uint32Array(n * 2)
    for (let i = 0; i < n; i += 3) {
      const a = kept[i]!
      const b = kept[i + 1]!
      const c = kept[i + 2]!
      idx[i] = a
      idx[i + 1] = b
      idx[i + 2] = c
      idx[n + i] = a
      idx[n + i + 1] = c
      idx[n + i + 2] = b
    }
    const rb = phys.world.createRigidBody(phys.rapier.RigidBodyDesc.fixed())
    phys.world.createCollider(phys.rapier.ColliderDesc.trimesh(grid.worldVerts, idx), rb)
    phys.step() // update the query pipeline so castRay sees the collider

    const castDown = (x: number, z: number) =>
      phys.world.castRay(new phys.rapier.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 200, true)

    // Inside the playable band: a downward ray always finds ground.
    for (const z of [-150, -50, 0, 50, 150]) {
      for (const x of [-hard, 0, hard]) {
        expect(castDown(x, z), `expected ground at (${x}, ${z})`).not.toBeNull()
      }
    }
    // Far out of bounds (past the cutoff): collision is correctly gone.
    expect(castDown(360, 0)).toBeNull()

    phys.world.free()
  })
})
