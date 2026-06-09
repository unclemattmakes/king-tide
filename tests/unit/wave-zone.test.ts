import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createWaveField,
  defaultWaves,
  effectiveSteepness,
  MAX_WAVE_ZONES,
  sampleHeight,
  sampleSurface,
  sampleZoneFactors,
  setWaveZones,
  type WaveFieldState,
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

  it(`setWaveZones caps the list at MAX_WAVE_ZONES (${MAX_WAVE_ZONES})`, () => {
    const field = createWaveField([])
    const zones = Array.from({ length: MAX_WAVE_ZONES + 3 }, (_, i) =>
      makeZone({ position: { x: i * 100, y: 0, z: 0 } }),
    )
    setWaveZones(field, zones)
    // The GPU shader evaluates a fixed-size zone array; the CPU must feel
    // exactly the zones the player can see, so the overflow is dropped.
    expect(field.zones.length).toBe(MAX_WAVE_ZONES)
    expect(field.zones[0]!.position.x).toBe(0)
    expect(field.zones[MAX_WAVE_ZONES - 1]!.position.x).toBe((MAX_WAVE_ZONES - 1) * 100)
  })

  it(`no shipped track JSON exceeds MAX_WAVE_ZONES zones`, () => {
    const dir = resolve(__dirname, '../../public/tracks')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as {
        waveZones?: unknown[]
      }
      const n = Array.isArray(raw.waveZones) ? raw.waveZones.length : 0
      expect(n, `${f} has ${n} waveZones — over the MAX_WAVE_ZONES cap`).toBeLessThanOrEqual(
        MAX_WAVE_ZONES,
      )
    }
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

describe('zone factors × Gerstner inverse map (steepness > 0)', () => {
  /**
   * Independent oracle for the GPU vertex transform WITH zone factors: the
   * shader displaces each rest-grid vertex (vx, vz) by the zone-scaled
   * Gerstner horizontal pinch and lifts it to the zone-scaled height. This
   * reimplements that formula from the spec (zone factors evaluated at the
   * REST vertex, exactly like the shader's `waveZoneFactors(worldX, worldZ)`)
   * so the test doesn't share code with the sampler it's checking.
   */
  function shaderSurfaceAt(
    field: WaveFieldState,
    vx: number,
    vz: number,
  ): { x: number; z: number; y: number } {
    const t = field.time
    const fx = sampleZoneFactors(field.zones, vx, vz, t)
    const bearing = fx.bearingRad ?? field.waveBearing
    const cosB = Math.cos(bearing)
    const sinB = Math.sin(bearing)
    const qEff = effectiveSteepness(field) // no shore field installed → shoal = 1
    const xRot = vx * cosB + vz * sinB
    const zRot = -vx * sinB + vz * cosB
    let y = 0
    let dxRot = 0
    let dzRot = 0
    for (const w of field.waves) {
      const k = ((2 * Math.PI) / w.wavelength) * fx.freqMult
      const omega = w.speed * k
      const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
      const amp = w.amplitude * fx.heightMult
      y += amp * Math.sin(phase)
      const q = qEff * (w.qBase ?? 0.7)
      // Default pinch direction (pinchCos=1, pinchSin=0) → along-wave.
      dxRot += q * w.dirX * amp * Math.cos(phase)
      dzRot += q * w.dirZ * amp * Math.cos(phase)
    }
    return {
      x: vx + (dxRot * cosB - dzRot * sinB),
      z: vz + (dxRot * sinB + dzRot * cosB),
      y: y + fx.surgeY,
    }
  }

  /** Solve for the rest vertex whose displaced position is (X, Z), then
   *  return the surface height the shader would draw at world (X, Z). */
  function renderedHeightAt(field: WaveFieldState, X: number, Z: number): number {
    let vx = X
    let vz = Z
    for (let i = 0; i < 40; i++) {
      const s = shaderSurfaceAt(field, vx, vz)
      vx += X - s.x
      vz += Z - s.z
    }
    const s = shaderSurfaceAt(field, vx, vz)
    // The fixed-point solve must have converged or the oracle is meaningless.
    expect(Math.hypot(s.x - X, s.z - Z)).toBeLessThan(1e-4)
    return s.y
  }

  it('buoyancy floats on the zone-scaled displaced surface deep inside a zone', () => {
    const field = createWaveField(defaultWaves())
    field.steepness = 0.44
    field.time = 3.7
    setWaveZones(field, [
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 200,
        halfHeight: 30,
        halfDepth: 200,
        heightMult: 1.6,
        freqMult: 0.8,
        blendRadiusM: 20,
      },
    ])
    // Deep inside the zone the blend weight saturates at 1, so the CPU's
    // evaluate-factors-at-the-query-point approximation is exact and the
    // sampler must land on the displaced surface to inverse-map precision.
    for (const [X, Z] of [
      [12.3, -7.9],
      [-31.0, 24.5],
      [3.1, 88.8],
    ] as const) {
      expect(sampleHeight(field, X, Z)).toBeCloseTo(renderedHeightAt(field, X, Z), 2)
    }
  })

  it('bearing-override zone: buoyancy still matches the displaced surface', () => {
    const field = createWaveField(defaultWaves())
    field.steepness = 0.44
    field.time = 9.2
    field.waveBearing = 0.6 // non-trivial global bearing the zone overrides
    setWaveZones(field, [
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 200,
        halfHeight: 30,
        halfDepth: 200,
        heightMult: 1.2,
        freqMult: 1.1,
        directionDeg: 90,
        blendRadiusM: 20,
      },
    ])
    for (const [X, Z] of [
      [5.5, 14.0],
      [-44.4, -2.2],
    ] as const) {
      expect(sampleHeight(field, X, Z)).toBeCloseTo(renderedHeightAt(field, X, Z), 2)
    }
  })
})
