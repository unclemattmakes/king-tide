import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPECTRUM_COMPONENTS,
  generateSpectrumWaves,
  MAX_SPECTRUM_COMPONENTS,
  MIN_SPECTRUM_COMPONENTS,
  parseSpectrumParam,
  SPECTRUM_PRESET_NAMES,
  SPECTRUM_PRESETS,
  SPECTRUM_STEEPNESS_BUDGET,
  type SpectrumSpec,
  shippedBankVariance,
} from '../../src/engine/sim/water/spectrum'
import {
  DEFAULT_CHOP_TUNING_SCALE,
  DEFAULT_SWELL_TUNING_SCALE,
  defaultWaves,
  SWELL_WAVELENGTH_MIN,
} from '../../src/engine/sim/water/wave-field'

/**
 * Per-track spectrum generator (P2.2, water-next-research §7.1). The
 * contracts that keep a generated bank a drop-in for the hand-tuned one:
 *
 *  1. DETERMINISM — same spec → bit-identical bank, every call (replays,
 *     multiplayer, and the baked-at-construction shader all depend on it).
 *  2. ENERGY INVARIANT — every bank, once the boot-time per-band tuning
 *     scales stomp it (applyStoredWaterTuning: swells ×3.2, chop ×0.9),
 *     carries the SHIPPED effective sea's variance, so `seaStateBeaufort`
 *     keeps owning loudness.
 *  3. PHYSICALITY — deep-water dispersion ties speed to wavelength
 *     (players read group timing); directions stay inside a trackable fan.
 *  4. STRUCTURE — sorted longest-first, a non-degenerate swell/chop split
 *     (the outer/skirt layers draw only the swells), steepness budget
 *     under the no-fold clamp's reach.
 */

const G = 9.81

/** What boot does to a bank: amplitude × the band's default tuning scale. */
const effectiveAmp = (w: { amplitude: number; wavelength: number }) =>
  w.amplitude *
  (w.wavelength >= SWELL_WAVELENGTH_MIN ? DEFAULT_SWELL_TUNING_SCALE : DEFAULT_CHOP_TUNING_SCALE)

function specs(): SpectrumSpec[] {
  const out: SpectrumSpec[] = []
  for (const preset of SPECTRUM_PRESET_NAMES) {
    for (const seed of [1, 2, 7, 1234]) out.push({ preset, seed })
  }
  out.push({ preset: 'mixed-sea', seed: 3, components: 8 })
  out.push({ preset: 'open-swell', seed: 5, components: 16, swellBias: 0.8 })
  out.push({ preset: 'lagoon-chop', seed: 9, components: 10, spreadDeg: 20 })
  out.push({ preset: 'storm-cross', seed: 4, peakWavelengthM: 80 })
  return out
}

describe('generateSpectrumWaves', () => {
  it('is deterministic — same spec, bit-identical bank', () => {
    for (const spec of specs()) {
      const a = generateSpectrumWaves(spec)
      const b = generateSpectrumWaves(spec)
      expect(b).toEqual(a)
    }
  })

  it('different seeds re-roll the bank', () => {
    const a = generateSpectrumWaves({ preset: 'mixed-sea', seed: 1 })
    const b = generateSpectrumWaves({ preset: 'mixed-sea', seed: 2 })
    expect(b.waves.map((w) => w.wavelength)).not.toEqual(a.waves.map((w) => w.wavelength))
  })

  it('normalizes every bank to the shipped EFFECTIVE variance (Beaufort stays the loudness dial)', () => {
    const target = shippedBankVariance()
    // Sanity on the target itself: defaultWaves × boot scales.
    let check = 0
    for (const w of defaultWaves()) check += effectiveAmp(w) ** 2
    expect(target).toBeCloseTo(check / 2, 12)
    for (const spec of specs()) {
      const { waves } = generateSpectrumWaves(spec)
      let v = 0
      for (const w of waves) v += effectiveAmp(w) ** 2
      expect(v / 2).toBeCloseTo(target, 9)
    }
  })

  it('pins phase speed to the deep-water dispersion relation', () => {
    for (const spec of specs()) {
      for (const w of generateSpectrumWaves(spec).waves) {
        const k = (2 * Math.PI) / w.wavelength
        expect(w.speed).toBeCloseTo(Math.sqrt(G * k) / k, 9)
      }
    }
  })

  it('sorts longest-first with a non-degenerate swell/chop split', () => {
    for (const spec of specs()) {
      const { waves, swellCount } = generateSpectrumWaves(spec)
      for (let i = 1; i < waves.length; i++) {
        expect(waves[i]!.wavelength).toBeLessThanOrEqual(waves[i - 1]!.wavelength)
      }
      expect(swellCount).toBeGreaterThanOrEqual(1)
      expect(swellCount).toBeLessThan(waves.length)
      // swellCount IS the wavelength classification, pre-computed.
      expect(swellCount).toBe(waves.filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN).length)
    }
  })

  it('keeps wavelengths inside the preset span and directions inside a trackable fan', () => {
    for (const spec of specs()) {
      const preset = SPECTRUM_PRESETS[spec.preset]
      const { waves } = generateSpectrumWaves(spec)
      // Widest legal fan: chop spread override or preset, plus the storm
      // preset's deliberate cross-swell rotation.
      const maxFanDeg =
        Math.max(spec.spreadDeg ?? preset.chopSpreadDeg, preset.swellSpreadDeg) +
        (preset.crossSwellDeg ?? 0) +
        1e-6
      for (const w of waves) {
        expect(w.wavelength).toBeGreaterThanOrEqual(preset.lambdaMin - 1e-9)
        expect(w.wavelength).toBeLessThanOrEqual(preset.lambdaMax + 1e-9)
        expect(Math.hypot(w.dirX, w.dirZ)).toBeCloseTo(1, 9)
        const deg = (Math.atan2(w.dirZ, w.dirX) * 180) / Math.PI
        expect(Math.abs(deg)).toBeLessThanOrEqual(maxFanDeg)
      }
    }
  })

  it('respects component count, clamped to the GPU-safe range', () => {
    expect(generateSpectrumWaves({ preset: 'mixed-sea', seed: 1 }).waves).toHaveLength(
      DEFAULT_SPECTRUM_COMPONENTS,
    )
    expect(
      generateSpectrumWaves({ preset: 'mixed-sea', seed: 1, components: 9 }).waves,
    ).toHaveLength(9)
    expect(
      generateSpectrumWaves({ preset: 'mixed-sea', seed: 1, components: 99 }).waves,
    ).toHaveLength(MAX_SPECTRUM_COMPONENTS)
    expect(
      generateSpectrumWaves({ preset: 'mixed-sea', seed: 1, components: 1 }).waves,
    ).toHaveLength(MIN_SPECTRUM_COMPONENTS)
  })

  it('keeps the EFFECTIVE steepness budget under the no-fold clamp', () => {
    for (const spec of specs()) {
      const { waves } = generateSpectrumWaves(spec)
      // Σ qBase·A_eff·k on the post-boot-scale sea — what the live
      // steepnessSum sees once applyStoredWaterTuning has run.
      let qSum = 0
      for (const w of waves) {
        qSum += (w.qBase ?? 0) * effectiveAmp(w) * ((2 * Math.PI) / w.wavelength)
      }
      expect(qSum).toBeLessThanOrEqual(SPECTRUM_STEEPNESS_BUDGET + 1e-9)
    }
  })

  it('swellBias expresses in EFFECTIVE space (the boot stomp cannot distort the preset)', () => {
    // lagoon-chop designs a chop-heavy sea (bias 0.3). After the boot
    // scales (swells ×3.2 in amplitude = ×10.2 in energy) the chop must
    // STILL carry the majority of the effective energy — that's the
    // pre-divide doing its job.
    const { waves, swellCount } = generateSpectrumWaves({ preset: 'lagoon-chop', seed: 1 })
    let swell = 0
    let total = 0
    waves.forEach((w, i) => {
      const e = effectiveAmp(w) ** 2
      total += e
      if (i < swellCount) swell += e
    })
    expect(swell / total).toBeLessThan(0.5)
  })

  it('storm-cross pushes its second swell train off-axis', () => {
    const { waves, swellCount } = generateSpectrumWaves({ preset: 'storm-cross', seed: 1 })
    expect(swellCount).toBeGreaterThanOrEqual(2)
    const second = waves[1]!
    const deg = Math.abs((Math.atan2(second.dirZ, second.dirX) * 180) / Math.PI)
    expect(deg).toBeGreaterThan(SPECTRUM_PRESETS['storm-cross'].crossSwellDeg! * 0.8)
  })

  it('swellBias tilts EFFECTIVE energy between the swell and chop bands', () => {
    const energyOf = (bias: number) => {
      const { waves, swellCount } = generateSpectrumWaves({
        preset: 'mixed-sea',
        seed: 11,
        swellBias: bias,
      })
      let swell = 0
      let total = 0
      waves.forEach((w, i) => {
        const e = effectiveAmp(w) ** 2
        total += e
        if (i < swellCount) swell += e
      })
      return swell / total
    }
    expect(energyOf(0.8)).toBeGreaterThan(energyOf(0.5))
    expect(energyOf(0.2)).toBeLessThan(energyOf(0.5))
  })

  it('the default hand bank still classifies as 2 swells + 4 chop at the shared threshold', () => {
    const bank = defaultWaves()
    const swells = bank.filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN)
    expect(swells).toHaveLength(2)
    expect(bank.indexOf(swells[0]!)).toBe(0)
    expect(bank.indexOf(swells[1]!)).toBe(1)
  })
})

describe('parseSpectrumParam', () => {
  it('parses preset / seed / components forms', () => {
    expect(parseSpectrumParam('open-swell')).toEqual({ preset: 'open-swell' })
    expect(parseSpectrumParam('open-swell:3')).toEqual({ preset: 'open-swell', seed: 3 })
    expect(parseSpectrumParam('mixed-sea:3:14')).toEqual({
      preset: 'mixed-sea',
      seed: 3,
      components: 14,
    })
  })

  it("recognises the 'off' kill switch", () => {
    expect(parseSpectrumParam('off')).toBe('off')
    expect(parseSpectrumParam('none')).toBe('off')
    expect(parseSpectrumParam('0')).toBe('off')
  })

  it('returns null for absent or unknown values (boot falls through to track JSON)', () => {
    expect(parseSpectrumParam(null)).toBeNull()
    expect(parseSpectrumParam('')).toBeNull()
    expect(parseSpectrumParam('tsunami-madness')).toBeNull()
    expect(parseSpectrumParam('tsunami-madness:3')).toBeNull()
  })

  it('ignores non-numeric seed/components rather than NaN-poisoning the bank', () => {
    expect(parseSpectrumParam('mixed-sea:abc')).toEqual({ preset: 'mixed-sea' })
    expect(parseSpectrumParam('mixed-sea:2:abc')).toEqual({ preset: 'mixed-sea', seed: 2 })
  })
})
