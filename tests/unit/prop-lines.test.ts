import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandPropLine, expandPropLines, fnv1a32 } from '@/game/tracks/prop-lines'
import type { PropLine } from '@/game/tracks/types'

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

// ── Cross-language drift golden ──────────────────────────────────────────────
// This locks the JS expansion to a checked-in golden; the Python port
// (tools/blender/propline_expand.py) is locked to the SAME golden by
// tools/blender/test_propline_expand.py — so Python == JS by transitivity.
// Diverse cases: count/arcLength, straight/curved/closed, jitter/offset/scale.
const DRIFT_CASES: PropLine[] = [
  {
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
  {
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
  {
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
]

const GOLDEN_PATH = path.resolve(__dirname, '../../tools/blender/propline_drift_golden.json')

describe('cross-language drift golden', () => {
  it('JS expansion matches the checked-in golden (regen: HB_REGEN=1)', () => {
    const expected = DRIFT_CASES.map((c) => expandPropLine(c))
    if (process.env.HB_REGEN === '1') {
      fs.writeFileSync(
        GOLDEN_PATH,
        `${JSON.stringify({ cases: DRIFT_CASES, expected }, null, 2)}\n`,
      )
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
      cases: PropLine[]
      expected: unknown
    }
    // The fixture's INPUT cases must match what we expand here.
    expect(golden.cases).toEqual(DRIFT_CASES)
    // …and the JS output must still equal the golden (catches a JS-side change
    // that would silently diverge from the Python port).
    expect(expected).toEqual(golden.expected)
  })
})
