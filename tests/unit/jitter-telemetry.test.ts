import { describe, expect, it } from 'vitest'
import { createJitterTelemetry, STEPS_HISTOGRAM_MAX } from '@/engine/jitter-telemetry'

const FIXED_DT_MS = (1 / 60) * 1000

describe('createJitterTelemetry', () => {
  it('reports a clean signature for a steady 1-step-per-frame, constant-velocity stream', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    let x = 0
    for (let f = 0; f < 120; f++) {
      x += 1 // one fixed-step worth of motion
      jt.recordTick(x, 0, 0)
      jt.recordFrame(FIXED_DT_MS, 1, 0, x, 0, 0)
    }
    const s = jt.summary()
    expect(s.frames).toBe(120)
    expect(s.ticks).toBe(120)
    expect(s.zeroStepFrac).toBe(0)
    expect(s.multiStepFrac).toBe(0)
    expect(s.meanStepsPerFrame).toBeCloseTo(1, 5)
    // Constant velocity → zero second difference on both streams.
    expect(s.renderJerkMean).toBeCloseTo(0, 6)
    expect(s.simJerkMean).toBeCloseTo(0, 6)
    expect(s.vertReversalsPerSec).toBe(0)
    expect(s.renderHz).toBeCloseTo(60, 0)
    expect(s.simHz).toBeCloseTo(60, 0)
    expect(s.stepsHistogram[1]).toBe(120)
    expect(s.verdict).toContain('No significant jitter')
  })

  it('flags ragged render/sim cadence (the 0-step / 2-step beat) as a render-sampling stutter', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    let x = 0
    // Alternate 0 and 2 sim steps per frame — the canonical fixed-step
    // beat against a same-rate-but-out-of-phase render loop. The sim
    // itself moves at a perfectly constant velocity.
    for (let f = 0; f < 120; f++) {
      const steps = f % 2 === 0 ? 0 : 2
      for (let k = 0; k < steps; k++) {
        x += 1
        jt.recordTick(x, 0, 0)
      }
      jt.recordFrame(FIXED_DT_MS, steps, 0, x, 0, 0)
    }
    const s = jt.summary()
    expect(s.zeroStepFrac).toBeCloseTo(0.5, 5)
    expect(s.multiStepFrac).toBeCloseTo(0.5, 5)
    expect(s.meanStepsPerFrame).toBeCloseTo(1, 5)
    // Rendered motion stair-steps (held, then double-jump) → non-zero
    // render jerk, while the underlying sim motion stays smooth. That gap
    // is the signature of a render-side interpolation miss.
    expect(s.renderJerkMean).toBeGreaterThan(0)
    expect(s.simJerkMean).toBeCloseTo(0, 6)
    expect(s.stepsHistogram[0]).toBe(60)
    expect(s.stepsHistogram[2]).toBe(60)
    expect(s.verdict.toLowerCase()).toContain('stutter')
    expect(s.verdict.toLowerCase()).toContain('interpolation')
  })

  it('reports cadence as absorbed (not a stutter) when the rendered path tracks the sim', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    let simX = 0
    // Ragged cadence (alternating 0/2 steps) but a SMOOTH rendered path that
    // advances every frame — what render interpolation produces — over an
    // equally smooth (constant-velocity) sim. The post-fix state.
    for (let f = 0; f < 120; f++) {
      const steps = f % 2 === 0 ? 0 : 2
      for (let k = 0; k < steps; k++) {
        simX += 1
        jt.recordTick(simX, 0, 0)
      }
      jt.recordFrame(FIXED_DT_MS, steps, 0, f, 0, 0) // rendered X advances every frame
    }
    const s = jt.summary()
    expect(s.zeroStepFrac).toBeCloseTo(0.5, 5)
    expect(s.multiStepFrac).toBeCloseTo(0.5, 5)
    // Both paths are linear → both jerks ≈ 0 → not a sampling artifact.
    expect(s.renderJerkMean).toBeCloseTo(0, 6)
    expect(s.simJerkMean).toBeCloseTo(0, 6)
    expect(s.verdict.toLowerCase()).not.toContain('stutter')
    expect(s.verdict.toLowerCase()).toContain('smooth')
  })

  it('flags sustained vertical oscillation as sim-side hover-spring ringing', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    let x = 0
    for (let f = 0; f < 120; f++) {
      x += 1
      // Body bounces vertically every tick — a ringing hover spring.
      const y = f % 2 === 0 ? 0.05 : -0.05
      jt.recordTick(x, y, 0)
      jt.recordFrame(FIXED_DT_MS, 1, 0, x, y, 0)
    }
    const s = jt.summary()
    expect(s.vertReversalsPerSec).toBeGreaterThan(8)
    expect(s.verdict.toLowerCase()).toContain('hover')
  })

  it('ignores sub-deadband vertical float noise when counting reversals', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    for (let f = 0; f < 120; f++) {
      // 1e-5 m wobble is below the 1e-4 m deadband — should not register.
      const y = f % 2 === 0 ? 1e-5 : -1e-5
      jt.recordTick(f, y, 0)
      jt.recordFrame(FIXED_DT_MS, 1, 0, f, y, 0)
    }
    expect(jt.summary().vertReversalsPerSec).toBe(0)
  })

  it('buckets large step counts into the overflow slot', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    jt.recordFrame(FIXED_DT_MS, 99, 0, 0, 0, 0)
    expect(jt.summary().stepsHistogram[STEPS_HISTOGRAM_MAX]).toBe(1)
  })

  it('withholds a verdict until enough frames are collected, then resets cleanly', () => {
    const jt = createJitterTelemetry(FIXED_DT_MS)
    jt.recordFrame(FIXED_DT_MS, 1, 0.5, 0, 0, 0)
    expect(jt.summary().verdict).toContain('Collecting')

    for (let f = 0; f < 120; f++) jt.recordFrame(FIXED_DT_MS, 1, 0.5, f, 0, 0)
    expect(jt.summary().frames).toBe(121)
    expect(jt.summary().meanAlpha).toBeCloseTo(0.5, 5)

    jt.reset()
    const s = jt.summary()
    expect(s.frames).toBe(0)
    expect(s.ticks).toBe(0)
    expect(s.stepsHistogram.every((v) => v === 0)).toBe(true)
    expect(s.verdict).toContain('Collecting')
  })
})
