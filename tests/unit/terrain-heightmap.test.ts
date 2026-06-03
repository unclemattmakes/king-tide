import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  buildTerrainHeightmap,
  CEILING_OVERHANG_CAP,
} from '../../src/engine/render/terrain-heightmap'

const DEEP_SENTINEL = -10000

/** A flat quad lying in the XZ plane, centred at (cx,cz), spanning ±half,
 *  raised to world Y = y. Both its triangles have min-vertex-Y === y. */
function flatQuad(cx: number, cz: number, half: number, y: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(half * 2, half * 2)
  g.rotateX(-Math.PI / 2) // XY plane → XZ plane (lie flat, face +Y)
  const m = new THREE.Mesh(g)
  m.position.set(cx, y, cz)
  m.updateMatrixWorld(true)
  return m
}

type Heightmap = NonNullable<ReturnType<typeof buildTerrainHeightmap>>

/** Build expecting a non-null heightmap (most cases here have terrain). */
function build(roots: THREE.Object3D[], opts: { waterLevel: number }): Heightmap {
  const hm = buildTerrainHeightmap(roots, opts)
  if (hm === null) throw new Error('expected a non-null heightmap')
  return hm
}

function sample(hm: Heightmap, x: number, z: number) {
  const u = Math.floor(((x - hm.worldMin.x) / (hm.worldMax.x - hm.worldMin.x)) * hm.resolution)
  const v = Math.floor(((z - hm.worldMin.y) / (hm.worldMax.y - hm.worldMin.y)) * hm.resolution)
  const raw = hm.raw
  if (!raw) throw new Error('expected raw grid')
  return raw[v * hm.resolution + u]
}

describe('buildTerrainHeightmap — overhang/ceiling cull (waves stay live under arches)', () => {
  it('returns null when the only geometry is an overhang above the cap', () => {
    // A bare arch span at +25 m over open water → no shoal data at all.
    const span = flatQuad(0, 0, 20, 25)
    expect(buildTerrainHeightmap([span], { waterLevel: 0 })).toBeNull()
  })

  it('keeps the waterline legs but skips the span over the opening', () => {
    // Model an arch: two legs that cross the waterline + a span overhead.
    const group = new THREE.Group()
    group.add(
      flatQuad(-15, 0, 5, 0), // left leg base at the waterline → kept
      flatQuad(15, 0, 5, 0), //  right leg base at the waterline → kept
      flatQuad(0, 0, 18, 25), // span over the opening at +25 m → culled
    )
    group.updateMatrixWorld(true)
    const hm = build([group], { waterLevel: 0 })
    expect(hm).not.toBeNull()
    // Legs shoal (read ~water level), so they'll foam at their bases.
    expect(sample(hm, -15, 0)).toBeCloseTo(0, 1)
    expect(sample(hm, 15, 0)).toBeCloseTo(0, 1)
    // The cell under the OPENING stays open ocean → the wave swings free.
    expect(sample(hm, 0, 0)).toBe(DEEP_SENTINEL)
  })

  it('keeps a pillar/leg whose lowest vertex sits just below the cap', () => {
    const leg = flatQuad(0, 0, 10, CEILING_OVERHANG_CAP - 1)
    const hm = build([leg], { waterLevel: 0 })
    expect(sample(hm, 0, 0)).toBeCloseTo(CEILING_OVERHANG_CAP - 1, 1)
  })

  it('applies the cap relative to waterLevel', () => {
    // waterLevel 10 → cap at 16; a plate at 14 is below it → kept.
    const plate = flatQuad(0, 0, 10, 14)
    const hm = build([plate], { waterLevel: 10 })
    expect(sample(hm, 0, 0)).toBeCloseTo(14, 1)
  })
})
