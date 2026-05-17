import { describe, expect, it } from 'vitest'
import {
  buildPhillipsSpectrum,
  sampleSpectrumHeight,
} from '@/engine/sim/water/phillips'
import {
  advanceWaveField,
  createSpectrumWaveField,
  createWaveField,
  defaultSpectrumParams,
  defaultWaves,
  sampleHeight,
  sampleSurface,
} from '@/engine/sim/water/wave-field'

/**
 * Replay + multiplayer correctness checks for the spectrum wave field.
 *
 * Determinism is load-bearing for two systems:
 *
 *   - Replay recorder/player. The recorder snapshots inputs + initial
 *     state; the player must regenerate every frame's surface
 *     deterministically from those. A drifting spectrum desyncs the
 *     replayed bike from the recorded one and visibly breaks the
 *     replay.
 *
 *   - Multiplayer lockstep. Two peers seeded identically must produce
 *     identical heights at every probe so their hover physics agree.
 *     A drifting spectrum desyncs bike positions across peers.
 *
 * The Gerstner path has been determinism-clean since launch. The
 * spectrum path inherits that property by construction (mulberry32
 * PRNG + stable mode-selection sort), but every architecture-level
 * change carries the risk of a subtle ordering bug — these tests pin
 * the invariant down.
 */

const TEST_POINTS = [
  [0, 0],
  [5.3, -7.1],
  [-22, 18],
  [50, 50],
  [-50, -50],
  [13.7, -42.4],
] as const

function snapshotSamples(
  field: ReturnType<typeof createSpectrumWaveField>,
): Array<{ y: number; nx: number; ny: number; nz: number; vy: number }> {
  return TEST_POINTS.map(([x, z]) => sampleSurface(field, x, z))
}

describe('spectrum wave field — determinism', () => {
  it('two fields built from the same params produce identical samples at t=0', () => {
    const a = createSpectrumWaveField(defaultSpectrumParams())
    const b = createSpectrumWaveField(defaultSpectrumParams())
    expect(snapshotSamples(a)).toEqual(snapshotSamples(b))
  })

  it('two fields evolved through the same ticks stay identical', () => {
    const a = createSpectrumWaveField(defaultSpectrumParams())
    const b = createSpectrumWaveField(defaultSpectrumParams())
    // Walk 200 ticks at 1/60 s, the typical sim step length. The spectrum
    // is a deterministic function of (params, time), so the two fields
    // should never drift — but if any non-deterministic ordering crept
    // in (e.g. floating-point reduction order changes), it'd surface
    // after several hundred steps.
    for (let i = 0; i < 200; i++) {
      advanceWaveField(a, 1 / 60)
      advanceWaveField(b, 1 / 60)
    }
    expect(snapshotSamples(a)).toEqual(snapshotSamples(b))
  })

  it('seed difference cleanly forks the state', () => {
    const a = createSpectrumWaveField({ ...defaultSpectrumParams(), seed: 1 })
    const b = createSpectrumWaveField({ ...defaultSpectrumParams(), seed: 2 })
    // Same time, same probes — different seeds must give different heights.
    // (Negation test: catches a bug where the seed is silently ignored.)
    const sa = snapshotSamples(a)
    const sb = snapshotSamples(b)
    let anyDiffers = false
    for (let i = 0; i < sa.length; i++) {
      if (sa[i]!.y !== sb[i]!.y) anyDiffers = true
    }
    expect(anyDiffers).toBe(true)
  })

  it('matches across a rebuild-restore cycle (replay scenario)', () => {
    // Simulates the replay player: capture initial state, advance,
    // then rebuild from the captured `spectrumParams` + drive to the
    // same time. Should produce bit-identical state.
    const original = createSpectrumWaveField(defaultSpectrumParams())
    const targetTime = 4.7
    advanceWaveField(original, targetTime)
    const expected = snapshotSamples(original)

    // Replay player rebuilds from the stored params (the only thing
    // serialized in the replay file) + advances time.
    const replayed = createSpectrumWaveField(original.spectrumParams)
    advanceWaveField(replayed, targetTime)
    const actual = snapshotSamples(replayed)
    expect(actual).toEqual(expected)
  })

  it('Gerstner path stays deterministic too (regression check on the kind union)', () => {
    // Make sure the discriminated-union refactor in A1b didn't break
    // the legacy Gerstner determinism. Two fields built from the same
    // defaultWaves() should still produce identical samples after the
    // same number of ticks.
    const a = createWaveField(defaultWaves())
    const b = createWaveField(defaultWaves())
    for (let i = 0; i < 100; i++) {
      advanceWaveField(a, 1 / 60)
      advanceWaveField(b, 1 / 60)
    }
    for (const [x, z] of TEST_POINTS) {
      expect(sampleHeight(a, x, z)).toBe(sampleHeight(b, x, z))
    }
  })

  it('top-K analytic sum converges to the full grid when topK = N² (A2 buoyancy-vs-render probe)', () => {
    // Phase A2 cutover: the GPU vertex shader samples a full-grid
    // Phillips IFFT (one inverse DFT per output texel — see
    // `gpu-bake.ts`'s `createGpuOceanDisplacement`), while the CPU
    // buoyancy sampler keeps reading the top-K analytic sum out of
    // `field.spectrum`. Both sides build their h0 array from the SAME
    // PhillipsParams via the same `buildPhillipsSpectrum` call, so
    // the only thing separating them is the truncation residual from
    // keeping only the K most energetic modes on the CPU.
    //
    // This probe locks down two things:
    //
    //   1. When the CPU keeps ALL non-zero modes (topK ≥ N²), the
    //      analytic sum must equal the full-grid analytic sum to FP
    //      noise. That nails down the sign convention + factor-of-2
    //      conjugate-pair handling that the GPU kernel relies on.
    //
    //   2. At the default truncation (topK = 32), the captured
    //      fraction of height variance is bounded below by a sane
    //      floor. Any future regression that drops a load-bearing
    //      mode (e.g. zeroing the wrong amplitude, or sorting in the
    //      wrong order) will tank this fraction visibly.
    //
    // We use a small-amplitude variant of `defaultSpectrumParams` for
    // the magnitude check so the probe values are physically
    // reasonable (default params have an aggressive Phillips A; the
    // visual A/B tune-up lives further down the plan in A5).
    const params = { ...defaultSpectrumParams(), amplitude: 0.01 }
    const fullGrid = buildPhillipsSpectrum(params)
    const fullKField = createSpectrumWaveField(params, {
      topK: params.N * params.N,
    })
    const topKField = createSpectrumWaveField(params)

    let fullMatchMaxDelta = 0
    let totalSquared = 0
    let topKResidualSquared = 0
    let samples = 0
    for (const t of [0, 1.5, 3.7, 8.2]) {
      fullKField.time = t
      topKField.time = t
      for (const [x, z] of TEST_POINTS) {
        const full = sampleSpectrumHeight(fullGrid, x, z, t)
        // (1) Convergence at topK = N². Two paths over the same
        //     numbers should round to FP noise.
        const fullKMode = sampleHeight(fullKField, x, z) - fullKField.baseY
        fullMatchMaxDelta = Math.max(fullMatchMaxDelta, Math.abs(fullKMode - full))
        // (2) Variance capture by the default top-K.
        const top = sampleHeight(topKField, x, z) - topKField.baseY
        const residual = top - full
        totalSquared += full * full
        topKResidualSquared += residual * residual
        samples += 1
      }
    }
    // FP-noise floor on the convergence test. At default params the
    // raw amplitudes are sub-meter; 1e-4 m is well into round-off
    // territory for Float64 sums of order ~1.
    expect(fullMatchMaxDelta).toBeLessThan(1e-4)
    // The default top-K (= 32 of 1024 modes) should still capture a
    // healthy fraction of the variance for a Phillips spectrum
    // (1/k⁴ tail concentrates energy at low k). 30% floor is loose
    // enough to survive future tweaks to the default param tune
    // while tight enough to flag a regression that drops core modes.
    const captured = 1 - topKResidualSquared / totalSquared
    expect(captured).toBeGreaterThan(0.3)
    expect(samples).toBeGreaterThan(0)
  })

  it('sample is a pure function of (params, time, x, z) — no hidden state', () => {
    // Build a field, advance it to time A, then explicitly reset to
    // time B. Compare to a fresh field set straight to time B. If the
    // sampler is truly stateless (just reads `field.time`), the two
    // must agree bit-exactly. If anything per-tick accumulates (e.g.
    // a hidden phase counter), the advanced-then-reset field would
    // carry that residue and diverge.
    const advanced = createSpectrumWaveField(defaultSpectrumParams())
    for (let i = 0; i < 300; i++) advanceWaveField(advanced, 0.0173)
    advanced.time = 2.0

    const fresh = createSpectrumWaveField(defaultSpectrumParams())
    fresh.time = 2.0

    expect(snapshotSamples(advanced)).toEqual(snapshotSamples(fresh))
  })
})
