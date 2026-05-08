import type { Vec3 } from '@/engine/sim/physics/vec'

/**
 * Closed-loop Catmull-Rom sampling. Used by the JSON track loader to
 * resolve a sparse `anchors` array into the dense `points` polyline that
 * the AI controller actually follows.
 *
 * Why this lives in the sim layer (Three-free) and not in `engine/render`:
 * the loader has to produce a Track from the JSON without pulling in
 * Three.js — the sim is supposed to be renderless. Three.js does ship
 * `CatmullRomCurve3` but it lives in the render-side dependency tree.
 *
 * Math: uniform Catmull-Rom (alpha=0). For each segment between p1 and
 * p2 we sample using neighbour points p0 and p3 to bias the tangent. On
 * a closed loop that means wrapping around to the back/front of the
 * anchor list. With small numbers of anchors and roughly uniform spacing
 * this gives smooth visually-sensible curves without the centripetal
 * variant's complexity.
 */
export type CatmullRomOptions = {
  /** Number of polyline samples emitted per anchor segment. Default 12. */
  divisionsPerSegment?: number
  /** If true, the curve closes back to the first anchor (last segment
   *  goes from anchors[n-1] to anchors[0]). Default true. */
  closed?: boolean
  /** Tension. 0.5 (default) is the classic uniform Catmull-Rom; values
   *  closer to 1 flatten the curve toward chord lines. */
  tension?: number
}

export function sampleCatmullRom(anchors: Vec3[], opts: CatmullRomOptions = {}): Vec3[] {
  const div = opts.divisionsPerSegment ?? 12
  const closed = opts.closed ?? true
  const tension = opts.tension ?? 0.5

  const n = anchors.length
  if (n === 0) return []
  if (n === 1) return [{ ...anchors[0]! }]
  if (n === 2) {
    // Just lerp.
    const out: Vec3[] = []
    const segs = closed ? 2 : 1
    for (let s = 0; s < segs; s++) {
      const a = anchors[s]!
      const b = anchors[(s + 1) % 2]!
      for (let i = 0; i < div; i++) {
        const t = i / div
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        })
      }
    }
    return out
  }

  const out: Vec3[] = []
  const segCount = closed ? n : n - 1
  for (let i = 0; i < segCount; i++) {
    const p0 = anchors[wrap(i - 1, n, closed)]!
    const p1 = anchors[i]!
    const p2 = anchors[wrap(i + 1, n, closed)]!
    const p3 = anchors[wrap(i + 2, n, closed)]!
    for (let s = 0; s < div; s++) {
      const t = s / div
      out.push(catmullRomPoint(p0, p1, p2, p3, t, tension))
    }
  }
  return out
}

function wrap(i: number, n: number, closed: boolean): number {
  if (closed) return ((i % n) + n) % n
  return Math.max(0, Math.min(n - 1, i))
}

function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, tension: number): Vec3 {
  // Standard catmull-rom blending function with tension. tension=0.5
  // recovers the canonical uniform Catmull-Rom basis matrix.
  const t2 = t * t
  const t3 = t2 * t
  const k = tension
  return {
    x: blend(p0.x, p1.x, p2.x, p3.x, t, t2, t3, k),
    y: blend(p0.y, p1.y, p2.y, p3.y, t, t2, t3, k),
    z: blend(p0.z, p1.z, p2.z, p3.z, t, t2, t3, k),
  }
}

function blend(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
  t2: number,
  t3: number,
  k: number,
): number {
  // Hermite form: h00*p1 + h10*m1 + h01*p2 + h11*m2 with
  // m1 = k*(p2 - p0), m2 = k*(p3 - p1).
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const m1 = k * (v2 - v0)
  const m2 = k * (v3 - v1)
  return h00 * v1 + h10 * m1 + h01 * v2 + h11 * m2
}

/**
 * Find the parameter t ∈ [0, 1) of the point on the sampled curve that's
 * closest in xz to the given world point. Closed loops only — t = 0 and
 * t = 1 correspond to the same point.
 */
export function nearestT(point: Vec3, sampled: Vec3[]): number {
  if (sampled.length === 0) return 0
  let bestI = 0
  let bestD = Infinity
  for (let i = 0; i < sampled.length; i++) {
    const p = sampled[i]!
    const dx = p.x - point.x
    const dz = p.z - point.z
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI / sampled.length
}

/**
 * Resolve a parameter t to a position on the sampled curve via linear
 * interpolation between the two surrounding samples. t wraps modulo 1
 * for closed loops.
 */
export function pointAtT(sampled: Vec3[], t: number): Vec3 {
  if (sampled.length === 0) return { x: 0, y: 0, z: 0 }
  if (sampled.length === 1) return { ...sampled[0]! }
  const wrapped = ((t % 1) + 1) % 1
  const f = wrapped * sampled.length
  const i0 = Math.floor(f) % sampled.length
  const i1 = (i0 + 1) % sampled.length
  const frac = f - Math.floor(f)
  const a = sampled[i0]!
  const b = sampled[i1]!
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
  }
}

/**
 * Tangent direction at parameter t — discrete derivative from the
 * sampled polyline. Returns a unit vector in xz; y is zero (we treat
 * gates as upright). Wraps for closed loops.
 */
export function tangentAtT(sampled: Vec3[], t: number): Vec3 {
  if (sampled.length < 2) return { x: 0, y: 0, z: 1 }
  const wrapped = ((t % 1) + 1) % 1
  const f = wrapped * sampled.length
  const i0 = Math.floor(f) % sampled.length
  const i1 = (i0 + 1) % sampled.length
  const a = sampled[i0]!
  const b = sampled[i1]!
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz) || 1
  return { x: dx / len, y: 0, z: dz / len }
}
