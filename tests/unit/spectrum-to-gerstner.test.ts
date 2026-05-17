import { describe, expect, it } from 'vitest'
import {
  buildPhillipsSpectrum,
  type PhillipsParams,
} from '@/engine/sim/water/phillips'
import {
  sampleSpectrumHeightFromModes,
  selectTopKModes,
} from '@/engine/sim/water/spectrum-modes'
import { spectrumModesToGerstnerShape } from '@/engine/sim/water/spectrum-to-gerstner'

/**
 * Walk the same heightfield two ways at the same (x, z, t):
 *
 *   1. Sum the spectrum modes via `aRe·cos(φ) − aIm·sin(φ)` (the CPU
 *      buoyancy path).
 *   2. Sum the Gerstner-shaped modes via `amp·sin(k·dir·xz − ω·t + phase)`
 *      (the GPU shader path).
 *
 * The conversion in `spectrum-to-gerstner.ts` says these must agree
 * exactly. If they ever drift, A1b's "CPU + GPU stay locked" guarantee
 * is broken.
 */
function gerstnerSum(
  modes: ReturnType<typeof spectrumModesToGerstnerShape>,
  x: number,
  z: number,
  t: number,
): number {
  let y = 0
  for (const m of modes) {
    const phase = m.k * m.dirX * x + m.k * m.dirZ * z - m.omega * t + m.phase
    y += m.amp * Math.sin(phase)
  }
  return y
}

const PRESET: PhillipsParams = {
  N: 32,
  tileSize: 80,
  windSpeed: 9,
  windDirX: 1,
  windDirZ: 0,
  amplitude: 1,
  smallWavelengthCutoff: 0.5,
  seed: 0xa11f,
}

describe('spectrumModesToGerstnerShape', () => {
  it('produces the same heightfield as the spectrum sampler at every probe', () => {
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 32 })
    const gModes = spectrumModesToGerstnerShape(modes)

    // Walk a 9×9×5 cube of probe points across space + time.
    for (let t = 0; t < 5; t += 1.1) {
      for (let x = -40; x <= 40; x += 10) {
        for (let z = -40; z <= 40; z += 10) {
          const spectrum = sampleSpectrumHeightFromModes(modes, x, z, t)
          const gerstner = gerstnerSum(gModes, x, z, t)
          expect(gerstner).toBeCloseTo(spectrum, 6)
        }
      }
    }
  })

  it('is determinstic for a given mode list', () => {
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 16 })
    const a = spectrumModesToGerstnerShape(modes)
    const b = spectrumModesToGerstnerShape(modes)
    expect(a).toEqual(b)
  })

  it('preserves amplitude magnitude', () => {
    // |a_gerstner| = √(aRe² + aIm²) by definition.
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 8 })
    const g = spectrumModesToGerstnerShape(modes)
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!
      expect(g[i]!.amp).toBeCloseTo(Math.hypot(m.aRe, m.aIm), 6)
    }
  })

  it('flips the wave direction relative to the source (kx, kz)', () => {
    // The sign-convention argument from the module docstring: spectrum's
    // ω·t is positive, Gerstner's is negative. Aligning the (x, z) part
    // requires negating (kx, kz). Verify that.
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 4 })
    const g = spectrumModesToGerstnerShape(modes)
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!
      const kMag = Math.hypot(m.kx, m.kz)
      if (kMag === 0) continue
      expect(g[i]!.dirX).toBeCloseTo(-m.kx / kMag, 6)
      expect(g[i]!.dirZ).toBeCloseTo(-m.kz / kMag, 6)
    }
  })
})
