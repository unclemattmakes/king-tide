/**
 * PropLine expansion — "instance an asset GLB along a curve", expanded to
 * ordinary {@link Prop}s at track load so the render / collider / wave-rider
 * paths never change.
 *
 * DETERMINISM CONTRACT (the whole point of this module): the in-app editor
 * preview, the runtime, and the Blender authoring preview must all produce
 * byte-identical instances from the same `PropLine`. That holds because the
 * expansion is built only from operations that are reproducible in JS AND in
 * the Python port (`tools/blender/hoverbike_addon/propline_placements.py`):
 *
 *   1. Curve: `sampleCatmullRom` with the FROZEN constants below.
 *   2. Spacing: a shared arc-length walk (no Three, no Date/random).
 *   3. Jitter: a per-instance seed = `fnv1a32(id) XOR (i * KNUTH)` feeding
 *      `mulberry32` (our sim RNG), with a FIXED draw order. Integer-only seed
 *      math keeps the seed bit-identical across V8 and CPython; the only
 *      transcendentals (sin/cos/atan2) agree to far below 1 µm at metre scale.
 *
 * Three-free (runs inside the Three-free `buildTrackFromJson`).
 */

import type { Vec3 } from '@/engine/sim/physics/vec'
import { createRng } from '@/engine/sim/rng'
import { sampleCatmullRom } from './catmull-rom'
import type { Prop, PropLine } from './types'

const DEG2RAD = Math.PI / 180

// ── FROZEN expansion constants — the Python port MUST match these exactly. ──
/** Catmull-Rom samples per anchor segment. */
export const PROPLINE_DIVISIONS_PER_SEGMENT = 12
/** Catmull-Rom tension (0.5 = canonical uniform basis). */
export const PROPLINE_TENSION = 0.5
/** Knuth's golden-ratio multiplicative hash constant (uint32). */
const KNUTH = 0x9e3779b1
/** FNV-1a 32-bit offset basis + prime. */
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32-bit hash of a string's UTF-8 bytes. The only string hash on the
 * determinism path (run once over the PropLine id). Trivially identical in
 * Python: `h=0x811c9dc5; for b in id.encode('utf-8'): h=((h^b)*0x01000193)&0xffffffff`.
 */
export function fnv1a32(s: string): number {
  let h = FNV_OFFSET >>> 0
  const bytes = new TextEncoder().encode(s)
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h >>> 0
}

type Frame = { pos: Vec3; tanX: number; tanZ: number }

/** Cumulative XZ arc length over the dense polyline (closed includes the
 *  wrap segment). */
function arcLengths(P: Vec3[], closed: boolean): { cum: number[]; segCount: number } {
  const segCount = closed ? P.length : P.length - 1
  const cum = new Array<number>(segCount + 1)
  cum[0] = 0
  for (let i = 0; i < segCount; i++) {
    const a = P[i] as Vec3
    const b = P[(i + 1) % P.length] as Vec3
    cum[i + 1] = (cum[i] as number) + Math.hypot(b.x - a.x, b.z - a.z)
  }
  return { cum, segCount }
}

/** Sample the polyline at an absolute arc distance: lerp position + unit XZ
 *  tangent of the containing segment. */
function sampleAtDist(P: Vec3[], cum: number[], segCount: number, dist: number): Frame {
  const total = cum[segCount] as number
  let d = dist
  if (d < 0) d = 0
  if (d > total) d = total
  let seg = 0
  while (seg < segCount - 1 && (cum[seg + 1] as number) < d) seg++
  const segStart = cum[seg] as number
  const segLen = (cum[seg + 1] as number) - segStart
  const frac = segLen > 0 ? (d - segStart) / segLen : 0
  const a = P[seg] as Vec3
  const b = P[(seg + 1) % P.length] as Vec3
  let tanX = b.x - a.x
  let tanZ = b.z - a.z
  const len = Math.hypot(tanX, tanZ)
  if (len > 1e-9) {
    tanX /= len
    tanZ /= len
  } else {
    tanX = 0
    tanZ = 1
  }
  return {
    pos: { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac, z: a.z + (b.z - a.z) * frac },
    tanX,
    tanZ,
  }
}

/** Number of instances a line resolves to (before any are placed). */
export function propLineCount(line: PropLine, totalArcLen: number): number {
  if ((line.spacingMode ?? 'arcLength') === 'count') {
    return Math.max(1, Math.round(line.count ?? 1))
  }
  return Math.max(1, Math.round(totalArcLen / Math.max(1e-3, line.spacingM ?? 1)))
}

/**
 * Expand one PropLine into its deterministic list of asset {@link Prop}s
 * (tagged `fromPropLine`). Returns [] for a degenerate curve (&lt;2 anchors or
 * zero length).
 */
export function expandPropLine(line: PropLine): Prop[] {
  if (!Array.isArray(line.anchors) || line.anchors.length < 2) return []
  const closed = line.closed ?? false
  const P = sampleCatmullRom(line.anchors, {
    divisionsPerSegment: PROPLINE_DIVISIONS_PER_SEGMENT,
    closed,
    tension: PROPLINE_TENSION,
  })
  if (P.length < 2) return []
  const { cum, segCount } = arcLengths(P, closed)
  const total = cum[segCount] as number
  if (!(total > 0)) return []

  const N = propLineCount(line, total)
  const seed0 = fnv1a32(line.id)
  const offsetM = line.offsetM ?? 0
  const normalOffsetM = line.normalOffsetM ?? 0
  const alignToTangent = line.alignToTangent ?? true
  const yawConst = (line.yawDeg ?? 0) * DEG2RAD
  const baseScale = line.scale ?? 1
  const jPosM = line.jitter?.posM ?? 0
  const jYawRad = (line.jitter?.yawDeg ?? 0) * DEG2RAD
  const jScaleMin = line.jitter?.scaleMin ?? 1
  const jScaleMax = line.jitter?.scaleMax ?? 1

  const props: Prop[] = []
  for (let i = 0; i < N; i++) {
    // Even spacing: closed loops divide by N (no duplicate at the seam); open
    // lines span endpoints inclusive (N-1 gaps).
    const f = closed ? i / N : N === 1 ? 0.5 : i / (N - 1)
    const fr = sampleAtDist(P, cum, segCount, f * total)

    // Jitter — FIXED draw order (angle, radius, yaw, scale). Mirror in Python.
    const rng = createRng((seed0 ^ (Math.imul(i, KNUTH) >>> 0)) >>> 0)
    const jAngle = rng.next() * 2 * Math.PI
    const jRadius = rng.next() * jPosM
    const jYaw = (rng.next() * 2 - 1) * jYawRad
    const jScale = jScaleMin + rng.next() * (jScaleMax - jScaleMin)

    // Lateral offset along the LEFT perpendicular of travel (XZ): rotating the
    // tangent +90° gives (-tanZ, tanX). Positive offsetM = left of travel.
    const leftX = -fr.tanZ
    const leftZ = fr.tanX
    const x = fr.pos.x + leftX * offsetM + Math.cos(jAngle) * jRadius
    const z = fr.pos.z + leftZ * offsetM + Math.sin(jAngle) * jRadius
    const y = fr.pos.y + normalOffsetM

    const tanYaw = alignToTangent ? Math.atan2(fr.tanX, fr.tanZ) : 0
    const yaw = tanYaw + yawConst + jYaw
    const half = yaw / 2
    const s = baseScale * jScale

    const prop: Prop = {
      type: 'asset',
      assetId: line.assetId,
      position: { x, y, z },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      size: { x: s, y: s, z: s },
      fromPropLine: true,
    }
    if (line.surface) prop.surface = line.surface
    if (line.waveRider) prop.waveRider = { dof: line.waveRider.dof ?? 'locked' }
    if (line.waterline !== undefined) prop.waterline = line.waterline
    props.push(prop)
  }
  return props
}

/** Expand every line in order into a flat list of tagged props. */
export function expandPropLines(lines: readonly PropLine[]): Prop[] {
  const out: Prop[] = []
  for (const line of lines) {
    for (const p of expandPropLine(line)) out.push(p)
  }
  return out
}
