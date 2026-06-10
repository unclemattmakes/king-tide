/**
 * Procedural oil-paint stroke sheets — the foam's painterly mask textures.
 *
 * Rasterizes a seamless (toroidal) tile of tapered, bristle-split brush
 * strokes, all running along the texture's +U axis. The water shader samples
 * these as the foam break-up pattern (in place of the legacy round-disc
 * bubble sheet) with U mapped to the crest direction — globally for the mass
 * sheet, locally (cross-slope) for the face streaks — so foam dissolves into
 * strokes pulled along the wave fronts: the same painted read as the bikes'
 * engine-trail ribbons (`engine-trail.ts`), which this deliberately echoes.
 *
 * Each stroke is a union of a few parallel "bristle" capsules sharing one
 * gently-bowed spine: blunt where the brush pressed down, splitting into
 * ragged tips where it lifted off, with hash-jittered edges so nothing reads
 * mathematically clean. Silhouette is what matters — the shader thresholds
 * foam near-binary, so internal value softness would be thrown away anyway.
 *
 * Fully procedural + deterministic (seeded; no Math.random, no DOM, no
 * Three) — unlike the retired R2-served `foam_streaks.png` sheet, it can
 * never silently 404 into a no-op on an unhydrated clone, and headless test
 * runs get the identical bytes. Build cost is a few ms once per session.
 */

/** One size-class of strokes scattered onto the sheet. All geometric values
 *  are fractions of the tile edge so specs are resolution-independent. */
export type OilStrokeClass = {
  /** How many strokes of this class to scatter. */
  count: number
  /** Stroke length range (fraction of tile edge). */
  lenMin: number
  lenMax: number
  /** Stroke half-width range (fraction of tile edge). Bristle offsets spread
   *  the visual width to roughly 2× this. */
  widthMin: number
  widthMax: number
  /** Max deviation of the stroke axis from +U, in degrees (± jitter). */
  angleJitterDeg: number
}

export type OilStrokeSheetSpec = {
  /** Output resolution (square, power of two for mips). */
  size: number
  /** RNG seed — same spec + seed → identical bytes, every platform. */
  seed: number
  classes: OilStrokeClass[]
  /** Bristles per stroke (the parallel sub-capsules). Default 3..6. */
  bristleMin?: number
  bristleMax?: number
  /** Where along the stroke the tail taper begins (0..1 of its length).
   *  Lower = longer pointed tails. Default 0.5. */
  taperStart?: number
  /** Edge-jitter amplitude (0 = clean capsule edges, ~0.5 = heavily ragged
   *  dry-brush edges). Default 0.35. */
  raggedness?: number
}

/** Deterministic 32-bit PRNG (mulberry32) — tiny, seedable, good enough. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth 1-D value noise in [0,1] (hash-lerp) — the edge-raggedness source.
 *  Pure function of x, so stamping order can't change a stroke's silhouette. */
function valueNoise1D(x: number): number {
  const xi = Math.floor(x)
  const xf = x - xi
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
    return s - Math.floor(s)
  }
  const sm = xf * xf * (3 - 2 * xf)
  return h(xi) * (1 - sm) + h(xi + 1) * sm
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Union-stamp one AA disc into the float grid, wrapping toroidally. `gain`
 *  caps the stamp's peak value — whole strokes painted at slightly different
 *  strengths stage their reveal as the foam mask strengthens. */
function stampDisc(
  grid: Float32Array,
  size: number,
  px: number,
  py: number,
  r: number,
  gain: number,
): void {
  const AA = 1.1 // edge ramp in texels — soft enough for mips, crisp at 1:1
  const reach = Math.ceil(r + AA)
  const cx = Math.floor(px)
  const cy = Math.floor(py)
  for (let dy = -reach; dy <= reach; dy++) {
    const ty = cy + dy
    const wy = ((ty % size) + size) % size
    const rowBase = wy * size
    const fy = ty + 0.5 - py
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = cx + dx
      const fx = tx + 0.5 - px
      const dist = Math.sqrt(fx * fx + fy * fy)
      const v = Math.min(1, Math.max(0, (r - dist) / AA + 1)) * gain
      if (v <= 0) continue
      const idx = rowBase + (((tx % size) + size) % size)
      if (v > grid[idx]!) grid[idx] = v
    }
  }
}

/**
 * Rasterize the sheet. Returns a single-channel float grid in [0,1]
 * (row-major, `size`²) — callers pack it into whatever texture format they
 * need. Strokes are stamped as overlapping discs marched along each bristle's
 * spine (how 2-D paint brushes actually work), unioned via max() so crossing
 * strokes merge instead of darkening.
 */
export function rasterizeOilStrokeSheet(spec: OilStrokeSheetSpec): Float32Array {
  const { size, classes } = spec
  const bristleMin = spec.bristleMin ?? 3
  const bristleMax = spec.bristleMax ?? 6
  const taperStart = spec.taperStart ?? 0.5
  const raggedness = spec.raggedness ?? 0.35
  const rng = mulberry32(spec.seed)
  const grid = new Float32Array(size * size)

  for (const cls of classes) {
    const angleJitter = (cls.angleJitterDeg * Math.PI) / 180
    // Stratified centres — a jittered √count grid instead of pure random
    // scatter, so the tile has no big bare patches or pile-ups (a bare patch
    // tiles into a conspicuous foam-free hole at world scale).
    const cells = Math.max(1, Math.round(Math.sqrt(cls.count)))
    const cellPx = size / cells
    for (let i = 0; i < cls.count; i++) {
      const gx = i % cells
      const gy = Math.floor(i / cells) % cells
      const cx = (gx + rng()) * cellPx
      const cy = (gy + rng()) * cellPx
      const theta = (rng() * 2 - 1) * angleJitter
      const L = (cls.lenMin + rng() * (cls.lenMax - cls.lenMin)) * size
      const W = (cls.widthMin + rng() * (cls.widthMax - cls.widthMin)) * size
      // Gentle bow so strokes read hand-pulled, not ruled. Peaks mid-stroke.
      const bow = (rng() * 2 - 1) * 0.07 * L
      // Half the strokes pull the other way (blunt head ↔ tapered tail
      // mirrored) so the sheet doesn't comb uniformly left-to-right.
      const flip = rng() < 0.5 ? -1 : 1
      // Whole-stroke paint strength — dimmer strokes only surface where the
      // foam mask is stronger, staging a painterly build-up instead of every
      // stroke popping at the same threshold.
      const gain = 0.7 + 0.3 * rng()
      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      const bristles = bristleMin + Math.floor(rng() * (bristleMax - bristleMin + 1))

      for (let k = 0; k < bristles; k++) {
        // Bristle 0 is the loaded core of the stroke: centred, near-full
        // length, fat. The rest scatter inside the width envelope with
        // shorter, thinner runs — their differing lengths are what splits
        // the tail into separate lifted-off tips.
        const isCore = k === 0
        const vOff = isCore ? 0 : (rng() * 2 - 1) * 0.85 * W
        const lenF = isCore ? 0.88 + rng() * 0.12 : 0.5 + rng() * 0.45
        const rBase = W * (isCore ? 0.62 : 0.26 + rng() * 0.24)
        const noisePhase = rng() * 100
        const Lb = L * lenF

        let u = 0
        while (u <= Lb) {
          const t = u / L
          // Blunt pressed-down head (strokes start at ~60% width, not a
          // point), pointed lifted-off tail.
          const head = 0.6 + 0.4 * smoothstep(0, 0.1 * L, u)
          const taper = 1 - smoothstep(taperStart, 1, u / Lb)
          let r = rBase * head * (0.08 + 0.92 * taper)
          // Ragged dry-brush edge — low-frequency width wobble per bristle.
          r *= 1 + raggedness * (valueNoise1D(u * 0.12 + noisePhase) - 0.5)
          // March in steps proportional to the CURRENT radius so shrinking
          // tips stay a connected point, not a dotted trail.
          const step = Math.max(0.6, r * 0.5)
          if (r >= 0.55) {
            const v = bow * Math.sin(Math.PI * t) + vOff
            const lx = (u - L * 0.5) * flip
            const px = cx + lx * cosT - v * sinT
            const py = cy + lx * sinT + v * cosT
            stampDisc(grid, size, px, py, r, gain)
          }
          u += step
        }
      }
    }
  }
  return grid
}

/** Pack a float grid into RGBA8 bytes (grayscale replicated, opaque alpha) —
 *  the layout `THREE.DataTexture` + the water shader's `.r` reads expect. */
export function packSheetRGBA8(grid: Float32Array): Uint8Array {
  const out = new Uint8Array(grid.length * 4)
  for (let i = 0; i < grid.length; i++) {
    const byte = Math.round(Math.min(1, Math.max(0, grid[i]!)) * 255)
    const o = i * 4
    out[o] = byte
    out[o + 1] = byte
    out[o + 2] = byte
    out[o + 3] = 255
  }
  return out
}

/**
 * The foam-mass sheet — replaces the round-disc bubble texture as the foam
 * break-up pattern. Chunky overlapping dabs in two size classes; enough gap
 * between strokes that foam fringes dissolve into distinct combed strokes,
 * dense enough that strong foam still unions into solid caps (the
 * strength-aware floor in water.ts keeps cores solid regardless).
 */
export const FOAM_STROKE_MASS_SPEC: OilStrokeSheetSpec = {
  size: 512,
  seed: 1107,
  classes: [
    // Bold primary dabs.
    { count: 24, lenMin: 0.2, lenMax: 0.36, widthMin: 0.021, widthMax: 0.034, angleJitterDeg: 13 },
    // Smaller secondary flicks filling between.
    { count: 34, lenMin: 0.09, lenMax: 0.18, widthMin: 0.013, widthMax: 0.021, angleJitterDeg: 17 },
  ],
}

/**
 * The face-streak sheet — long thin combing strokes the shader drags down
 * steep wave faces (replaces the retired R2-served `foam_streaks.png`).
 * Sparse and strongly tapered; clean water between strokes.
 */
export const FOAM_STROKE_STREAK_SPEC: OilStrokeSheetSpec = {
  size: 1024,
  seed: 2203,
  classes: [
    { count: 26, lenMin: 0.28, lenMax: 0.6, widthMin: 0.007, widthMax: 0.013, angleJitterDeg: 5 },
    { count: 22, lenMin: 0.12, lenMax: 0.3, widthMin: 0.004, widthMax: 0.009, angleJitterDeg: 8 },
  ],
  bristleMin: 2,
  bristleMax: 4,
  taperStart: 0.35,
  raggedness: 0.45,
}
