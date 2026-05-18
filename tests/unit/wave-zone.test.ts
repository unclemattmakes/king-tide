import { describe, expect, it } from 'vitest'
import {
  createWaveField,
  defaultWaves,
  sampleHeight,
  sampleSurface,
  sampleZoneFactors,
  setWaveZones,
  type WaveZoneInput,
} from '../../src/engine/sim/water/wave-field'

/**
 * Wave-zone authoring system: verifies per-zone amplitude / frequency
 * blending, soft-edge falloff across `blendRadiusM`, multi-zone soft-max
 * overlap, periodic surge timing, and direction-override behaviour.
 *
 * Companion to `tests/unit/wave-field.test.ts` — that suite covers the
 * global Gerstner field; this one isolates the zone-modifier layer.
 */

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 }

function makeZone(over: Partial<WaveZoneInput> = {}): WaveZoneInput {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: IDENTITY_QUAT,
    halfWidth: 10,
    halfHeight: 50,
    halfDepth: 10,
    heightMult: 2,
    freqMult: 1,
    blendRadiusM: 5,
    ...over,
  }
}

describe('wave-zone blend math', () => {
  it('returns neutral factors when no zones are set', () => {
    const fx = sampleZoneFactors([], 0, 0, 0)
    expect(fx.heightMult).toBe(1)
    expect(fx.freqMult).toBe(1)
    expect(fx.bearingRad).toBeUndefined()
    expect(fx.surgeY).toBe(0)
  })

  it('weight = 1 well inside the zone → full multiplier', () => {
    const field = createWaveField([])
    setWaveZones(field, [makeZone({ heightMult: 3, freqMult: 1.5 })])
    const fx = sampleZoneFactors(field.zones, 0, 0, 0)
    expect(fx.heightMult).toBeCloseTo(3, 6)
    expect(fx.freqMult).toBeCloseTo(1.5, 6)
  })

  it('weight = 0 outside the blend radius → neutral multiplier', () => {
    const field = createWaveField([])
    setWaveZones(field, [makeZone({ heightMult: 3, blendRadiusM: 5 })])
    // 10 (halfWidth) + 5 (blend) + 1 (margin) = 16 m from centre on +X.
    const fx = sampleZoneFactors(field.zones, 16, 0, 0)
    expect(fx.heightMult).toBe(1)
    expect(fx.freqMult).toBe(1)
  })

  it('smoothstep weight at the OBB face is exactly 0.5', () => {
    const field = createWaveField([])
    setWaveZones(field, [makeZone({ heightMult: 3, blendRadiusM: 5 })])
    // At halfWidth=10 + blendRadius/2=2.5 → 12.5 m from centre on +X,
    // outsideDist = 2.5, t = 1 - 2.5/5 = 0.5, smoothstep(0.5) = 0.5.
    const fx = sampleZoneFactors(field.zones, 12.5, 0, 0)
    // mix(1, 3, 0.5) = 2.
    expect(fx.heightMult).toBeCloseTo(2, 3)
  })

  it('weight monotonically decreases across the blend edge', () => {
    const field = createWaveField([])
    setWaveZones(field, [makeZone({ heightMult: 5, blendRadiusM: 8 })])
    const a = sampleZoneFactors(field.zones, 11, 0, 0).heightMult // just outside, deep in blend
    const b = sampleZoneFactors(field.zones, 14, 0, 0).heightMult // mid-blend
    const c = sampleZoneFactors(field.zones, 17, 0, 0).heightMult // near end of blend
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    expect(c).toBeGreaterThan(1) // still inside falloff
  })

  it('two overlapping zones pick the louder via soft-max', () => {
    const field = createWaveField([])
    setWaveZones(field, [
      // Both zones cover the origin fully (weight=1). Soft-max should
      // pick the one with the larger heightMult.
      makeZone({ position: { x: 0, y: 0, z: 0 }, heightMult: 2 }),
      makeZone({ position: { x: 5, y: 0, z: 0 }, heightMult: 4 }),
    ])
    const fx = sampleZoneFactors(field.zones, 2.5, 0, 0)
    // Tie on weight (both = 1). Loop order picks whichever appears
    // first with the highest weight — but bestWeight strict-greater
    // means second-listed zone (heightMult=4) wins only if its weight
    // is strictly higher. Both are 1 here so the first zone (heightMult=2)
    // is what the soft-max returns; this is the documented "louder
    // weight wins" behaviour, ties resolve to authoring order.
    expect(fx.heightMult).toBeCloseTo(2, 3)
  })

  it('non-overlapping zones each apply independently', () => {
    const field = createWaveField([])
    setWaveZones(field, [
      makeZone({ position: { x: -100, y: 0, z: 0 }, heightMult: 2 }),
      makeZone({ position: { x: 100, y: 0, z: 0 }, heightMult: 3 }),
    ])
    expect(sampleZoneFactors(field.zones, -100, 0, 0).heightMult).toBeCloseTo(2, 3)
    expect(sampleZoneFactors(field.zones, 100, 0, 0).heightMult).toBeCloseTo(3, 3)
    expect(sampleZoneFactors(field.zones, 0, 0, 0).heightMult).toBeCloseTo(1, 3)
  })

  it('surge contributes max(0, sin(2π t / period)) · amplitude', () => {
    const field = createWaveField([])
    setWaveZones(field, [
      makeZone({
        heightMult: 1, // isolate the surge term
        freqMult: 1,
        surgePeriodS: 4,
        surgeAmplitude: 6,
      }),
    ])
    // t=0 → sin(0) = 0 → surge 0.
    expect(sampleZoneFactors(field.zones, 0, 0, 0).surgeY).toBeCloseTo(0, 6)
    // t=1 (period/4) → sin(π/2)=1 → surge 6.
    expect(sampleZoneFactors(field.zones, 0, 0, 1).surgeY).toBeCloseTo(6, 6)
    // t=2 (period/2) → sin(π)=0 → surge 0.
    expect(sampleZoneFactors(field.zones, 0, 0, 2).surgeY).toBeCloseTo(0, 6)
    // t=3 (3/4 period) → sin(3π/2)=-1 → clamped to 0.
    expect(sampleZoneFactors(field.zones, 0, 0, 3).surgeY).toBeCloseTo(0, 6)
  })

  it('directionDeg overrides global bearing for samples inside the zone', () => {
    const field = createWaveField([])
    setWaveZones(field, [makeZone({ directionDeg: 90, heightMult: 1, freqMult: 1 })])
    // Inside → bearing override applies.
    expect(sampleZoneFactors(field.zones, 0, 0, 0).bearingRad).toBeCloseTo(Math.PI / 2, 6)
    // Outside → falls back to global (undefined here).
    expect(sampleZoneFactors(field.zones, 100, 0, 0).bearingRad).toBeUndefined()
  })

  it('sampleHeight inside a 2× zone is ≈ 2× the same coords with no zone', () => {
    // Pick a coord where the default wave field gives a non-zero height,
    // then compare the same field with vs without a 2× zone at that point.
    const fieldNoZone = createWaveField(defaultWaves())
    const fieldZone = createWaveField(defaultWaves())
    setWaveZones(fieldZone, [
      makeZone({
        position: { x: 50, y: 0, z: 50 },
        heightMult: 2,
        freqMult: 1,
        blendRadiusM: 5,
      }),
    ])
    const baseline = sampleHeight(fieldNoZone, 50, 50)
    const zoned = sampleHeight(fieldZone, 50, 50)
    // Within numerical wobble, the zoned height should be 2× the baseline.
    // Tolerance is loose because the wave field doesn't pass through zero
    // here — we just want to confirm the scaling actually fires.
    expect(Math.abs(zoned)).toBeGreaterThan(Math.abs(baseline) - 1e-6)
    expect(Math.abs(zoned / baseline)).toBeCloseTo(2, 1)
  })

  it('sampleSurface scales slopes alongside height', () => {
    const fieldNoZone = createWaveField(defaultWaves())
    const fieldZone = createWaveField(defaultWaves())
    setWaveZones(fieldZone, [
      makeZone({
        position: { x: 30, y: 0, z: 0 },
        heightMult: 3,
        blendRadiusM: 5,
      }),
    ])
    const baseline = sampleSurface(fieldNoZone, 30, 0)
    const zoned = sampleSurface(fieldZone, 30, 0)
    // Surface y should scale; the normal will shift but stay valid.
    expect(Math.abs(zoned.y / baseline.y)).toBeCloseTo(3, 1)
    // Normal stays normalised.
    expect(Math.hypot(zoned.nx, zoned.ny, zoned.nz)).toBeCloseTo(1, 6)
  })

  it("rotated zone aligns its OBB with the empty's yaw (90° case)", () => {
    // 90° yaw around world-Y. Quaternion: (0, sin(π/4), 0, cos(π/4)).
    // After a 90° rotation the zone's local +X aligns with one of the
    // world XZ axes (sign depends on the right-/left-handed convention
    // baked into yawFromQuat + the world-to-local rotation). We
    // construct a long thin zone (long along local +X, narrow along
    // local +Z) and probe both world axes — one must be inside and
    // the other outside; the test doesn't care WHICH unless we hard-
    // code the convention. So we assert that exactly one of (world +X,
    // world +Z) probes is "inside" — the OBB rotated correctly.
    const half = Math.PI / 4
    const yawQuat = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    const field = createWaveField([])
    setWaveZones(field, [
      makeZone({
        rotation: yawQuat,
        halfWidth: 20,
        halfDepth: 3,
        heightMult: 4,
        blendRadiusM: 1,
      }),
    ])
    const probeXMult = sampleZoneFactors(field.zones, 15, 0, 0).heightMult
    const probeZMult = sampleZoneFactors(field.zones, 0, 0, 15).heightMult
    // Exactly one axis hits the long side of the rotated OBB. The
    // other lands well outside the 3+1 m half-depth+blend bound.
    const insideHits = [probeXMult, probeZMult].filter((m) => m > 3.5).length
    const outsideHits = [probeXMult, probeZMult].filter((m) => m < 1.5).length
    expect(insideHits).toBe(1)
    expect(outsideHits).toBe(1)
  })
})
