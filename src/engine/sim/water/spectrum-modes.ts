/**
 * Mode-selection helpers for the Phillips wave spectrum.
 *
 * The full Phillips grid is N×N complex amplitudes (16k modes at
 * N=128). Almost all of those modes carry vanishingly little energy —
 * the 1/k⁴ tail concentrates everything in the few longest-wavelength
 * cells around DC. We keep the top K most-energetic modes and discard
 * the rest, so each CPU buoyancy probe is an O(K) sum instead of
 * O(N²). K=128 captures ~95% of the height variance for typical wind
 * speeds; that's the default.
 *
 * The selection is deterministic for a given spectrum: ranked by
 * |h0|² (energy), ties broken by (kx, kz) lexicographically. Same K
 * inputs → same K outputs, replay-safe.
 */

import type { SpectrumGrid } from './phillips'

const TWO_PI = Math.PI * 2

/**
 * A single retained spectrum mode. Stores the precomputed values
 * needed by the analytic sampler so each probe is a tight loop of
 * `K · (cos + sin)` without re-deriving k or ω.
 */
export type SpectrumMode = {
  /** World-space angular wavenumber, rad/m. */
  kx: number
  kz: number
  /** Deep-water angular frequency, rad/s. `ω = √(g·|k|)`. */
  omega: number
  /** Initial complex amplitude. Sampled from Phillips × Gaussian
   *  at build time; constant for the lifetime of the spectrum.
   *  See `sampleSpectrumHeightFromModes`. */
  aRe: number
  aIm: number
}

export type ModeSelectionOpts = {
  /** Number of modes to keep. K=128 is the default; raise for more
   *  faithful CPU/GPU agreement at the cost of buoyancy sample time. */
  topK?: number
}

/**
 * Pick the top-K most energetic modes from a Phillips spectrum grid.
 * Returns them as a precomputed `SpectrumMode[]` ready for the
 * analytic sampler.
 *
 * Modes are dropped in the conjugate-symmetric pair. Each retained
 * mode contributes `2·Re[h0·e^{i(k·x + ωt)}]` to the heightfield —
 * the factor of 2 comes from including the symmetric −k partner that
 * a real heightfield requires. We bake that 2 into `aRe` / `aIm` here
 * so the sampler hot loop has one fewer multiply.
 */
export function selectTopKModes(
  spectrum: SpectrumGrid,
  opts: ModeSelectionOpts = {},
): SpectrumMode[] {
  const topK = opts.topK ?? 128
  const N = spectrum.N
  const kStep = TWO_PI / spectrum.tileSize

  // Build a (energy, index) pair list so we can sort by energy and
  // pick the top K. Skip zero-amplitude modes up front — saves a lot
  // of churn on the directional-cosine-zero entries the Phillips
  // factor zeroes out (waves running exactly perpendicular to wind).
  type Entry = { energy: number; idx: number }
  const entries: Entry[] = []
  for (let zi = 0; zi < N; zi++) {
    for (let xi = 0; xi < N; xi++) {
      const idx = zi * N + xi
      const r = spectrum.h0[idx * 2]!
      const i = spectrum.h0[idx * 2 + 1]!
      const energy = r * r + i * i
      if (energy > 0) entries.push({ energy, idx })
    }
  }
  // Stable sort by energy descending, lexicographic on index for ties
  // — keeps the selection bit-identical run-to-run for a fixed seed.
  entries.sort((a, b) => {
    if (a.energy !== b.energy) return b.energy - a.energy
    return a.idx - b.idx
  })
  const keep = entries.slice(0, topK)

  const modes: SpectrumMode[] = []
  for (const { idx } of keep) {
    const xi = idx % N
    const zi = Math.floor(idx / N)
    const kx = (xi - N / 2) * kStep
    const kz = (zi - N / 2) * kStep
    const h0r = spectrum.h0[idx * 2]!
    const h0i = spectrum.h0[idx * 2 + 1]!
    modes.push({
      kx,
      kz,
      omega: spectrum.omega[idx]!,
      // Bake the conjugate-pair factor of 2 into the amplitude so the
      // sampler hot loop reads `aRe·cos − aIm·sin` (vs. needing to
      // multiply by 2 each iteration).
      aRe: 2 * h0r,
      aIm: 2 * h0i,
    })
  }
  return modes
}

/**
 * Evaluate the time-evolved heightfield at (x, z, t) from a top-K
 * mode list. This is the buoyancy path — O(K) per call, called per
 * probe per fixed step. Matches `sampleSpectrumHeight` over the full
 * grid up to whatever energy the truncation dropped (typically <5%
 * for K=128 / N=128).
 */
export function sampleSpectrumHeightFromModes(
  modes: readonly SpectrumMode[],
  x: number,
  z: number,
  t: number,
): number {
  let y = 0
  for (const m of modes) {
    const phase = m.kx * x + m.kz * z + m.omega * t
    y += m.aRe * Math.cos(phase) - m.aIm * Math.sin(phase)
  }
  return y
}

/**
 * Full sample: height plus xz-slope plus ∂y/∂t. Mirrors the existing
 * `sampleSurface` return shape (used by `hoverSystem` for buoyancy
 * damping). Same O(K) cost as the height-only sampler — six trig
 * calls per mode instead of two, but they're the same `phase`.
 */
export function sampleSpectrumSurfaceFromModes(
  modes: readonly SpectrumMode[],
  x: number,
  z: number,
  t: number,
): { y: number; dydx: number; dydz: number; vy: number } {
  let y = 0
  let dydx = 0
  let dydz = 0
  let vy = 0
  for (const m of modes) {
    const phase = m.kx * x + m.kz * z + m.omega * t
    const c = Math.cos(phase)
    const s = Math.sin(phase)
    // d/dx [aRe·cos(φ) − aIm·sin(φ)] = −kx·(aRe·sin(φ) + aIm·cos(φ))
    y += m.aRe * c - m.aIm * s
    const slopeFactor = -(m.aRe * s + m.aIm * c)
    dydx += slopeFactor * m.kx
    dydz += slopeFactor * m.kz
    // d/dt similar: −ω·(aRe·sin + aIm·cos)
    vy += slopeFactor * m.omega
  }
  return { y, dydx, dydz, vy }
}
