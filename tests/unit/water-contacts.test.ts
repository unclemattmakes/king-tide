import { describe, expect, it } from 'vitest'
import {
  type ContactScanNode,
  collectWaterContacts,
  MAX_WATER_CONTACTS,
  mergeNearbyContacts,
  selectNearestContacts,
  type WaterContact,
} from '../../src/engine/render/water-contacts'

// Column-major identity + translation helpers (the scan multiplies bbox
// corners through `matrixWorld.elements` exactly like THREE.Matrix4 lays
// them out).
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function translation(x: number, y: number, z: number): number[] {
  const m = [...IDENT]
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

type Box = { min: [number, number, number]; max: [number, number, number] }

function meshNode(opts: {
  bbox: Box
  name?: string
  kind?: string
  matrix?: number[]
  visible?: boolean
}): ContactScanNode {
  return {
    name: opts.name ?? 'mesh',
    visible: opts.visible,
    userData: opts.kind !== undefined ? { kind: opts.kind } : {},
    isMesh: true,
    geometry: {
      boundingBox: {
        min: { x: opts.bbox.min[0], y: opts.bbox.min[1], z: opts.bbox.min[2] },
        max: { x: opts.bbox.max[0], y: opts.bbox.max[1], z: opts.bbox.max[2] },
      },
      computeBoundingBox() {},
    },
    matrixWorld: { elements: opts.matrix ?? IDENT },
  }
}

function group(kind: string | undefined, children: ContactScanNode[]): ContactScanNode {
  const g: ContactScanNode = {
    name: 'group',
    userData: kind !== undefined ? { kind } : {},
    children,
  }
  for (const c of children) c.parent = g
  return g
}

// A 2×8×2 pillar spanning y ∈ [-2, 6] — comfortably straddles waterY = 0.
const PILLAR: Box = { min: [-1, -2, -1], max: [1, 6, 1] }

describe('collectWaterContacts', () => {
  it('accepts a straddling pillar and centres the disc on its footprint', () => {
    const root = group('track', [meshNode({ bbox: PILLAR, matrix: translation(10, 0, -4) })])
    const out = collectWaterContacts([root], { waterY: 0 })
    expect(out.length).toBe(1)
    expect(out[0]!.x).toBeCloseTo(10)
    expect(out[0]!.z).toBeCloseTo(-4)
    expect(out[0]!.radius).toBeCloseTo(1) // 2 m footprint → 1 m radius
  })

  it('rejects fully-dry and fully-sunken meshes', () => {
    const dry = meshNode({ bbox: PILLAR, matrix: translation(0, 10, 0) }) // bottom at +8
    const sunk = meshNode({ bbox: PILLAR, matrix: translation(0, -10, 0) }) // top at -4
    const out = collectWaterContacts([group('track', [dry, sunk])], { waterY: 0 })
    expect(out.length).toBe(0)
  })

  it('rejects wide meshes (terrain chunks, merged buildings) via the footprint cap', () => {
    const slab: Box = { min: [-10, -2, -10], max: [10, 6, 10] } // 20 m footprint
    const out = collectWaterContacts([group('track', [meshNode({ bbox: slab })])], { waterY: 0 })
    expect(out.length).toBe(0)
  })

  it('excludes water/horizon/decal kinds, terrain-named meshes and hidden proxies', () => {
    const nodes = [
      meshNode({ bbox: PILLAR, kind: 'water' }),
      meshNode({ bbox: PILLAR, kind: 'horizon' }),
      meshNode({ bbox: PILLAR, kind: 'decal' }),
      meshNode({ bbox: PILLAR, kind: 'collider_mesh' }),
      meshNode({ bbox: PILLAR, name: 'terrain_mesh', kind: 'track' }),
      meshNode({ bbox: PILLAR, kind: 'track', visible: false }),
    ]
    const out = collectWaterContacts([group(undefined, nodes)], { waterY: 0 })
    expect(out.length).toBe(0)
  })

  it('resolves kind through the parent chain (multi-primitive GLB splits)', () => {
    // Mesh carries no kind of its own; the authored kind sits on the parent
    // group — the GLTFLoader multi-material split shape.
    const okay = group('decoration', [meshNode({ bbox: PILLAR })])
    const out = collectWaterContacts([okay], { waterY: 0 })
    expect(out.length).toBe(1)

    const sea = group('water', [meshNode({ bbox: PILLAR, matrix: translation(50, 0, 0) })])
    expect(collectWaterContacts([sea], { waterY: 0 }).length).toBe(0)
  })

  it('expands instanced meshes into one disc per straddling instance', () => {
    // Three instances: two straddle, one parked high and dry.
    const instances = [...translation(0, 0, 0), ...translation(20, 0, 0), ...translation(40, 30, 0)]
    const node: ContactScanNode = {
      ...meshNode({ bbox: PILLAR }),
      isInstancedMesh: true,
      count: 3,
      instanceMatrix: { array: instances },
    }
    const out = collectWaterContacts([group('prop', [node])], { waterY: 0 })
    expect(out.length).toBe(2)
    const xs = out.map((c) => c.x).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0)
    expect(xs[1]).toBeCloseTo(20)
  })

  it('merges overlapping discs (pillar + its base) into one collar', () => {
    const pillar = meshNode({ bbox: PILLAR, matrix: translation(0, 0, 0) })
    const base: Box = { min: [-1.6, -2, -1.6], max: [1.6, 0.5, 1.6] }
    const baseMesh = meshNode({ bbox: base, matrix: translation(0.2, 0, 0) })
    const out = collectWaterContacts([group('track', [pillar, baseMesh])], { waterY: 0 })
    expect(out.length).toBe(1)
  })

  it('clamps radii into the collar-friendly range', () => {
    const tiny: Box = { min: [-0.1, -2, -0.1], max: [0.1, 6, 0.1] }
    const wide: Box = { min: [-6.5, -2, -6.5], max: [6.5, 6, 6.5] } // 13 m — under cap
    const out = collectWaterContacts(
      [
        group('track', [
          meshNode({ bbox: tiny }),
          meshNode({ bbox: wide, matrix: translation(100, 0, 0) }),
        ]),
      ],
      { waterY: 0 },
    )
    expect(out.length).toBe(2)
    const radii = out.map((c) => c.radius).sort((a, b) => a - b)
    expect(radii[0]).toBeGreaterThanOrEqual(0.3)
    expect(radii[1]).toBeLessThanOrEqual(7)
  })

  it('honours a custom reach for storm seas', () => {
    // Bottom face 2 m above the waterline: out of reach at the default
    // 1.5 m band, in reach when the swell can climb 3 m.
    const high = meshNode({ bbox: PILLAR, matrix: translation(0, 4, 0) })
    expect(collectWaterContacts([group('track', [high])], { waterY: 0 }).length).toBe(0)
    expect(collectWaterContacts([group('track', [high])], { waterY: 0, reach: 3 }).length).toBe(1)
  })
})

describe('mergeNearbyContacts', () => {
  it('keeps separated discs and absorbs contained ones', () => {
    const a: WaterContact = { x: 0, z: 0, radius: 2, strength: 1 }
    const b: WaterContact = { x: 0.5, z: 0, radius: 0.6, strength: 1 } // inside a
    const c: WaterContact = { x: 30, z: 0, radius: 1, strength: 1 }
    const out = mergeNearbyContacts([a, b, c])
    expect(out.length).toBe(2)
  })
})

describe('selectNearestContacts', () => {
  it('returns the N nearest to the origin', () => {
    const contacts: WaterContact[] = []
    for (let i = 0; i < MAX_WATER_CONTACTS + 10; i++) {
      contacts.push({ x: i * 10, z: 0, radius: 1, strength: 1 })
    }
    const picked = selectNearestContacts(contacts, 0, 0, 4)
    expect(picked.length).toBe(4)
    expect(picked.map((c) => c.x)).toEqual([0, 10, 20, 30])
    // Short lists pass through untrimmed.
    expect(selectNearestContacts(contacts.slice(0, 3), 0, 0, 4).length).toBe(3)
  })
})
