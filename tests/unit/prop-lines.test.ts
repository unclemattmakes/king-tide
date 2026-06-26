import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { sampleCatmullRom } from '@/game/tracks/catmull-rom'
import {
  expandPropLine,
  expandPropLines,
  fnv1a32,
  resolvePropLineSource,
  seatPropLineInstances,
  sliceMainSplineForBind,
} from '@/game/tracks/prop-lines'
import type { Prop, PropLine } from '@/game/tracks/types'

/** A synthetic closed racing line for the spline-bind tests — the same shape
 *  the runtime derives (sampleCatmullRom over the AI-spline anchors). */
const MAIN_ANCHORS: Vec3[] = [
  { x: -40, y: 0.5, z: -40 },
  { x: 40, y: 0.5, z: -40 },
  { x: 50, y: 1.5, z: 20 },
  { x: 0, y: 0.5, z: 50 },
  { x: -50, y: 2.5, z: 20 },
]
const MAIN_POINTS = sampleCatmullRom(MAIN_ANCHORS, { divisionsPerSegment: 12, closed: true })

function line(over: Partial<PropLine> = {}): PropLine {
  return {
    id: 'row',
    assetId: 'palm',
    anchors: [
      { x: 0, y: 2, z: 0 },
      { x: 30, y: 2, z: 0 },
    ],
    spacingMode: 'count',
    count: 5,
    ...over,
  }
}

describe('fnv1a32', () => {
  it('is a stable 32-bit hash', () => {
    // Locked golden so the Python port can target the exact same value.
    expect(fnv1a32('row') >>> 0).toBe(fnv1a32('row') >>> 0)
    expect(fnv1a32('row')).not.toBe(fnv1a32('row2'))
    expect(fnv1a32('')).toBe(0x811c9dc5)
  })
})

describe('expandPropLine', () => {
  it('emits exactly `count` tagged asset props', () => {
    const props = expandPropLine(line({ count: 7 }))
    expect(props).toHaveLength(7)
    for (const p of props) {
      expect(p.type).toBe('asset')
      expect(p.assetId).toBe('palm')
      expect(p.fromPropLine).toBe(true)
    }
  })

  it('arcLength mode rounds count to the curve length', () => {
    // The 2-anchor open line is ~27.5 m of sampled polyline; spacing 5 → ~6.
    const props = expandPropLine({
      id: 'row',
      assetId: 'palm',
      anchors: [
        { x: 0, y: 2, z: 0 },
        { x: 30, y: 2, z: 0 },
      ],
      spacingMode: 'arcLength',
      spacingM: 5,
    })
    expect(props.length).toBeGreaterThanOrEqual(4)
    expect(props.length).toBeLessThanOrEqual(8)
  })

  it('places along the curve and yaws to the tangent', () => {
    const props = expandPropLine(line({ count: 4 }))
    for (const p of props) {
      expect(p.position.z).toBeCloseTo(0, 6) // straight line along +X at z=0
      expect(p.position.y).toBeCloseTo(2, 6) // anchor Y
      // Tangent is +X → yaw = atan2(1,0) = π/2 → quat (0, sin π/4, 0, cos π/4).
      expect(p.rotation.y).toBeCloseTo(Math.sin(Math.PI / 4), 5)
    }
  })

  it('applies normal + lateral offset', () => {
    const props = expandPropLine(line({ count: 3, normalOffsetM: 1.5, offsetM: 4 }))
    for (const p of props) {
      expect(p.position.y).toBeCloseTo(3.5, 6) // 2 + normalOffset
      // left of +X travel is +Z (leftX=-tanZ=0, leftZ=tanX=1) → z = +offset
      expect(p.position.z).toBeCloseTo(4, 6)
    }
  })

  it('copies surface / waveRider / waterline onto every instance', () => {
    const props = expandPropLine(
      line({ count: 2, surface: 'sand', waveRider: { dof: 'yaw' }, waterline: false }),
    )
    for (const p of props) {
      expect(p.surface).toBe('sand')
      expect(p.waveRider).toEqual({ dof: 'yaw' })
      expect(p.waterline).toBe(false)
    }
  })

  it('is deterministic — same line, identical output', () => {
    const a = expandPropLine(
      line({ count: 6, jitter: { posM: 1, yawDeg: 20, scaleMin: 0.8, scaleMax: 1.3 } }),
    )
    const b = expandPropLine(
      line({ count: 6, jitter: { posM: 1, yawDeg: 20, scaleMin: 0.8, scaleMax: 1.3 } }),
    )
    expect(a).toEqual(b)
  })

  it('re-rolls jitter when the id changes', () => {
    const j = { posM: 2, yawDeg: 30 }
    const a = expandPropLine(line({ id: 'rowA', count: 5, jitter: j }))
    const b = expandPropLine(line({ id: 'rowB', count: 5, jitter: j }))
    // Same curve + params, different seed → at least one instance differs.
    const differ = a.some((p, i) => Math.abs(p.position.x - (b[i]?.position.x ?? 0)) > 1e-9)
    expect(differ).toBe(true)
  })

  it('closed loops place N without a seam duplicate', () => {
    const closed = expandPropLine(
      line({
        anchors: [
          { x: 0, y: 0, z: 0 },
          { x: 20, y: 0, z: 0 },
          { x: 20, y: 0, z: 20 },
          { x: 0, y: 0, z: 20 },
        ],
        closed: true,
        count: 8,
      }),
    )
    expect(closed).toHaveLength(8)
    // First and last instances are NOT coincident (no duplicate at the seam).
    const first = closed[0]!
    const last = closed[closed.length - 1]!
    expect(
      Math.hypot(first.position.x - last.position.x, first.position.z - last.position.z),
    ).toBeGreaterThan(1)
  })

  it('returns [] for a degenerate line (<2 anchors)', () => {
    expect(expandPropLine(line({ anchors: [{ x: 0, y: 0, z: 0 }] }))).toEqual([])
  })
})

describe('expandPropLines', () => {
  it('flattens multiple lines in order', () => {
    const out = expandPropLines([line({ id: 'a', count: 3 }), line({ id: 'b', count: 2 })])
    expect(out).toHaveLength(5)
  })
})

// ── Spline-bind (FOLLOW-UP 2) ────────────────────────────────────────────────
describe('sliceMainSplineForBind', () => {
  it('full range (or absent t0/t1) returns the whole closed loop', () => {
    const full = sliceMainSplineForBind({}, MAIN_POINTS)
    expect(full).not.toBeNull()
    expect(full!.closed).toBe(true)
    expect(full!.points).toHaveLength(MAIN_POINTS.length)
    const explicit = sliceMainSplineForBind({ t0: 0, t1: 1 }, MAIN_POINTS)
    expect(explicit).toEqual(full)
  })

  it('partial range is an open arc sliced by floor(t·M)', () => {
    const M = MAIN_POINTS.length
    const src = sliceMainSplineForBind({ t0: 0.25, t1: 0.5 }, MAIN_POINTS)
    expect(src).not.toBeNull()
    expect(src!.closed).toBe(false)
    const i0 = Math.floor(0.25 * M)
    const i1 = Math.floor(0.5 * M)
    expect(src!.points).toHaveLength(i1 - i0 + 1)
    expect(src!.points[0]).toEqual({ ...MAIN_POINTS[i0]! })
  })

  it('t0 > t1 wraps forward across the seam', () => {
    const M = MAIN_POINTS.length
    const src = sliceMainSplineForBind({ t0: 0.9, t1: 0.1 }, MAIN_POINTS)!
    const i0 = Math.floor(0.9 * M)
    const i1 = Math.floor(0.1 * M)
    expect(src.points).toHaveLength(M - i0 + i1 + 1)
    expect(src.points[0]).toEqual({ ...MAIN_POINTS[i0]! })
  })

  it('returns null without a usable main spline', () => {
    expect(sliceMainSplineForBind({ t0: 0, t1: 1 }, undefined)).toBeNull()
    expect(sliceMainSplineForBind({ t0: 0, t1: 1 }, [{ x: 0, y: 0, z: 0 }])).toBeNull()
  })
})

describe('expandPropLine with bind', () => {
  const bound = (over: Partial<PropLine> = {}): PropLine => ({
    id: 'turn_buoys',
    assetId: 'buoy',
    anchors: [],
    bind: { t0: 0.2, t1: 0.45 },
    spacingMode: 'count',
    count: 6,
    ...over,
  })

  it('places along the bound stretch of the main spline', () => {
    const props = expandPropLine(bound(), { mainSplinePoints: MAIN_POINTS })
    expect(props).toHaveLength(6)
    // Every instance sits near the sliced arc (within a sane bound of it).
    const arc = sliceMainSplineForBind({ t0: 0.2, t1: 0.45 }, MAIN_POINTS)!.points
    for (const p of props) {
      const near = arc.some((a) => Math.hypot(a.x - p.position.x, a.z - p.position.z) < 6)
      expect(near).toBe(true)
    }
  })

  it('a full-loop bind places N around the loop with no seam duplicate', () => {
    const props = expandPropLine(bound({ bind: {}, count: 8 }), { mainSplinePoints: MAIN_POINTS })
    expect(props).toHaveLength(8)
    const first = props[0]!
    const last = props[props.length - 1]!
    expect(
      Math.hypot(first.position.x - last.position.x, first.position.z - last.position.z),
    ).toBeGreaterThan(1)
  })

  it('a bound line with no main spline expands to []', () => {
    expect(expandPropLine(bound())).toEqual([])
    expect(expandPropLine(bound(), { mainSplinePoints: [] })).toEqual([])
  })

  it('bind wins over anchors when both are present', () => {
    const withAnchors = bound({
      anchors: [
        { x: 999, y: 0, z: 999 },
        { x: 1099, y: 0, z: 999 },
      ],
    })
    const props = expandPropLine(withAnchors, { mainSplinePoints: MAIN_POINTS })
    // Came from the spline, not the far-away anchors.
    for (const p of props) expect(p.position.x).toBeLessThan(900)
  })

  it('resolvePropLineSource picks anchors when bind is absent', () => {
    const src = resolvePropLineSource(line({ count: 4 }), MAIN_POINTS)
    expect(src).not.toBeNull()
    // Anchor source ignores the main spline (it's a straight 2-anchor line).
    expect(src!.points[0]).toEqual({ x: 0, y: 2, z: 0 })
  })
})

// ── Terrain seating (FOLLOW-UP 1) ────────────────────────────────────────────
describe('seatToTerrain', () => {
  it('does not change the deterministic expansion (seat is a post-pass)', () => {
    const a = expandPropLine(line({ count: 5, normalOffsetM: 1 }))
    const b = expandPropLine(line({ count: 5, normalOffsetM: 1, seatToTerrain: true }))
    expect(b).toEqual(a)
  })

  it('seatPropLineInstances rewrites only marked instances to terrain + offset', () => {
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'palm',
        position: { x: 10, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        fromPropLine: true,
        seatToTerrainOffsetM: 1.5,
      },
      {
        type: 'asset',
        assetId: 'palm',
        position: { x: 20, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        fromPropLine: true,
        // unmarked → untouched
      },
    ]
    // Terrain = a ramp y = x/10; off-map (x>=100) returns null.
    seatPropLineInstances(props, (x) => (x < 100 ? x / 10 : null))
    expect(props[0]!.position.y).toBeCloseTo(10 / 10 + 1.5, 9) // terrain(10)=1 + 1.5
    expect(props[1]!.position.y).toBe(2) // unmarked, unchanged
  })

  it('leaves a marked instance at its curve Y when terrain is absent (open water)', () => {
    const props: Prop[] = [
      {
        type: 'asset',
        assetId: 'buoy',
        position: { x: 5, y: 3, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 1, y: 1, z: 1 },
        fromPropLine: true,
        seatToTerrainOffsetM: 0,
      },
    ]
    seatPropLineInstances(props, () => null)
    expect(props[0]!.position.y).toBe(3)
  })
})

// ── Cross-language drift golden ──────────────────────────────────────────────
// This locks the JS expansion to a checked-in golden; the Python port
// (tools/blender/propline_expand.py) is locked to the SAME golden by
// tools/blender/test_propline_expand.py — so Python == JS by transitivity.
// Diverse cases: count/arcLength, straight/curved/closed, jitter/offset/scale,
// spline-bind (partial + full loop), and a terrain-seat no-op guard. A bound
// case carries its `mainSplinePoints` so the slice is exercised cross-language;
// seating is a runtime post-pass, so a `seatToTerrain` case must expand
// IDENTICALLY to the same line without the flag.
type DriftCase = { line: PropLine; mainSplinePoints?: Vec3[] }
const DRIFT_CASES: DriftCase[] = [
  {
    line: {
      id: 'palm_row',
      assetId: 'palm',
      anchors: [
        { x: 0, y: 2, z: 0 },
        { x: 40, y: 2, z: 0 },
      ],
      spacingMode: 'count',
      count: 6,
      offsetM: 3,
      jitter: { posM: 1.5, yawDeg: 20, scaleMin: 0.8, scaleMax: 1.3 },
      surface: 'sand',
    },
  },
  {
    line: {
      id: 'dock_pilings',
      assetId: 'piling',
      anchors: [
        { x: -10, y: 0, z: -10 },
        { x: 10, y: 0, z: -8 },
        { x: 18, y: 0, z: 6 },
        { x: 4, y: 0, z: 16 },
      ],
      spacingMode: 'arcLength',
      spacingM: 4,
      normalOffsetM: -0.5,
      yawDeg: 90,
      waveRider: { dof: 'locked' },
    },
  },
  {
    line: {
      id: 'buoy_ring',
      assetId: 'buoy',
      anchors: [
        { x: 0, y: 0, z: 0 },
        { x: 24, y: 0, z: 2 },
        { x: 26, y: 0, z: 26 },
        { x: -2, y: 0, z: 22 },
      ],
      closed: true,
      spacingMode: 'count',
      count: 10,
      scale: 1.4,
      jitter: { yawDeg: 360 },
    },
  },
  {
    // Spline-bind, partial arc — buoys along a stretch of the racing line.
    line: {
      id: 'turn3_buoys',
      assetId: 'buoy',
      anchors: [],
      bind: { t0: 0.2, t1: 0.45 },
      spacingMode: 'count',
      count: 6,
      offsetM: 2,
      jitter: { posM: 0.5, yawDeg: 15 },
    },
    mainSplinePoints: MAIN_POINTS,
  },
  {
    // Spline-bind, full loop — lamp posts around the whole racing line.
    line: {
      id: 'loop_lamps',
      assetId: 'lamp',
      anchors: [],
      bind: {},
      spacingMode: 'count',
      count: 9,
      normalOffsetM: 0.5,
      scale: 1.2,
    },
    mainSplinePoints: MAIN_POINTS,
  },
  {
    // Terrain-seat — must expand identically to the same line without the flag.
    line: {
      id: 'seated_row',
      assetId: 'palm',
      anchors: [
        { x: 0, y: 4, z: 0 },
        { x: 30, y: 1, z: 10 },
      ],
      spacingMode: 'count',
      count: 5,
      normalOffsetM: 1.25,
      seatToTerrain: true,
    },
  },
]

const GOLDEN_PATH = path.resolve(__dirname, '../../tools/blender/propline_drift_golden.json')

describe('cross-language drift golden', () => {
  it('JS expansion matches the checked-in golden (regen: HB_REGEN=1)', () => {
    const expected = DRIFT_CASES.map((c) =>
      expandPropLine(
        c.line,
        c.mainSplinePoints ? { mainSplinePoints: c.mainSplinePoints } : undefined,
      ),
    )
    if (process.env.HB_REGEN === '1') {
      fs.writeFileSync(
        GOLDEN_PATH,
        `${JSON.stringify({ cases: DRIFT_CASES, expected }, null, 2)}\n`,
      )
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
      cases: DriftCase[]
      expected: unknown
    }
    // The fixture's INPUT cases must match what we expand here.
    expect(golden.cases).toEqual(DRIFT_CASES)
    // …and the JS output must still equal the golden (catches a JS-side change
    // that would silently diverge from the Python port).
    expect(expected).toEqual(golden.expected)
  })
})
