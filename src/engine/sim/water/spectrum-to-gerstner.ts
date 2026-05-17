/**
 * Convert top-K Phillips spectrum modes into "fake Gerstner waves" that
 * the existing analytic-Gerstner GPU shader can iterate without
 * modification. This is the bridge that lets Phase A1b ship behind an
 * opt-in flag: the CPU buoyancy path uses the spectrum sum directly,
 * while the GPU vertex shader (which is build-time unrolled over an
 * array of `(dirX, dirZ, k, ω, amp, phase)` tuples) sees what looks
 * like a 32-wave Gerstner setup. Both paths produce the IDENTICAL
 * heightfield at every (x, z, t) — proved by the parity test below.
 *
 * The math, derived once and pinned down here so the rest of the code
 * doesn't have to think about it:
 *
 *   Spectrum mode contribution (from `sampleSpectrumHeightFromModes`):
 *     aRe · cos(kx·x + kz·z + ω·t) − aIm · sin(kx·x + kz·z + ω·t)
 *   = |a| · cos(kx·x + kz·z + ω·t + ψ)            where ψ = atan2(aIm, aRe), |a| = √(aRe²+aIm²)
 *
 *   Gerstner wave contribution (existing shader):
 *     amp · sin(kx_g·x + kz_g·z − ω·t + phase_g)
 *
 * Setting these equal for all (x, z, t) forces the (x, z) coefficient
 * signs to flip (Gerstner's ω·t is negative, spectrum's is positive),
 * so we negate the direction:
 *
 *     kx_g = −kx,    kz_g = −kz,    dirX = kx_g/|k|,  dirZ = kz_g/|k|
 *     amp = |a|
 *     phase_g = π/2 − atan2(aIm, aRe)
 *
 * The π/2 comes from `cos(α) = sin(π/2 − α)` after the direction
 * negation aligns the arguments.
 *
 * Why this works for the visuals: the spectrum is statistically
 * isotropic with wind-aligned bias, so negating every mode's direction
 * just relabels "left-traveling" as "right-traveling." Wind direction
 * gets inverted, which the spectrum builder compensates for by
 * accepting (windDirX, windDirZ) — flip it on the way in if you want
 * the bias to point a specific world direction.
 */

import type { SpectrumMode } from './spectrum-modes'

const HALF_PI = Math.PI / 2

/**
 * One converted mode — exact shape the GPU shader's `waveConsts`
 * builder expects. Index-aligned with the source `SpectrumMode[]` so
 * tests can compare 1:1.
 */
export type GerstnerShapedMode = {
  /** Wavenumber magnitude (rad/m). Always positive. */
  k: number
  /** Angular frequency (rad/s). Same as the source spectrum mode. */
  omega: number
  /** Unit-length wave direction. NOTE the sign flip vs. the source
   *  mode's (kx, kz) — see module docstring for why. */
  dirX: number
  dirZ: number
  /** Per-wave amplitude in meters. `|a| = √(aRe² + aIm²)`. */
  amp: number
  /** Static phase offset, radians. */
  phase: number
}

/**
 * Convert a top-K spectrum mode list into Gerstner-shaped constants.
 * Pure math, deterministic — same input → same output. Used at
 * shader-build time in `water.ts` when the wave field is in spectrum
 * mode, so the shader's unrolled wave iteration stays bit-identical
 * to the Gerstner path. Modes with zero amplitude pass through as-is
 * (k = 0 entries get `dirX = 1, dirZ = 0` to dodge `0/0`); their
 * Gerstner contribution is zero anyway via `amp = 0`.
 */
export function spectrumModesToGerstnerShape(
  modes: readonly SpectrumMode[],
): GerstnerShapedMode[] {
  return modes.map((m) => {
    const kxg = -m.kx
    const kzg = -m.kz
    const k = Math.hypot(kxg, kzg)
    const len = k > 0 ? k : 1
    const amp = Math.hypot(m.aRe, m.aIm)
    return {
      k,
      omega: m.omega,
      dirX: kxg / len,
      dirZ: kzg / len,
      amp,
      phase: HALF_PI - Math.atan2(m.aIm, m.aRe),
    }
  })
}
