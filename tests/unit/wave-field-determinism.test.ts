import { describe, expect, it } from 'vitest'
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
