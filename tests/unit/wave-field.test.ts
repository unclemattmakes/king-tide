import { describe, expect, it } from 'vitest'
import { buildShoreField, type ShoreField } from '../../src/engine/sim/water/shore-field'
import { acquireWakeTrail, feedWakeTrail } from '../../src/engine/sim/water/wake-trail'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  effectiveSteepness,
  SHOAL_FADE_DEPTH,
  SHOAL_GAIN_MAX,
  SHORE_ASYM,
  SHORE_BAND_DEPTH,
  SHORE_DEPTH_CAP,
  STEEPNESS_SUM_LIMIT,
  sampleHeight,
  sampleSurface,
  setShoreField,
  shoalAttenuation,
  steepnessSum,
  type WaveFieldState,
} from '../../src/engine/sim/water/wave-field'

/** Feed bike id 1's wake trail along a path at the 60 Hz fixed step — the
 *  same machinery `wakeUpdateSystem` drives. `pos(tSec)` maps elapsed ride
 *  time to the bike's XZ position; the field clock advances in lockstep. */
function ride(
  f: WaveFieldState,
  pos: (tSec: number) => { x: number; z: number },
  seconds: number,
  opts?: { weight?: number; speed?: number },
): void {
  const dt = 1 / 60
  const steps = Math.round(seconds * 60)
  for (let i = 1; i <= steps; i++) {
    advanceWaveField(f, dt)
    const t = i * dt
    const p = pos(t)
    const prev = pos(Math.max(t - dt, 0))
    const speed = opts?.speed ?? Math.hypot(p.x - prev.x, p.z - prev.z) / dt
    const tr = acquireWakeTrail(f.trails, 1, p.x, p.z, f.time)
    feedWakeTrail(tr, p.x, p.z, opts?.weight ?? 1, speed, f.time)
  }
}

/** Straight ride along +X at `speed`, ending with the head at the origin. */
function rideStraight(f: WaveFieldState, speed: number, seconds = 5, weight = 1): void {
  const startX = -speed * seconds
  ride(f, (t) => ({ x: startX + speed * t, z: 0 }), seconds, { weight, speed })
}

describe('wave field', () => {
  it('returns 0 height with no waves', () => {
    const f = createWaveField([])
    expect(sampleHeight(f, 0, 0)).toBe(0)
    expect(sampleHeight(f, 100, -50)).toBe(0)
  })

  it('produces a periodic single sine', () => {
    const f = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 1, wavelength: 10, speed: 1, phase: 0 },
    ])
    // At t=0, x=0: phase = 0, y = 0.
    expect(sampleHeight(f, 0, 0)).toBeCloseTo(0, 6)
    // x = wavelength/4 = 2.5: phase = π/2, y = 1.
    expect(sampleHeight(f, 2.5, 0)).toBeCloseTo(1, 6)
    // x = wavelength/2 = 5: phase = π, y = 0.
    expect(sampleHeight(f, 5, 0)).toBeCloseTo(0, 6)
  })

  it('advances time and oscillates a fixed point', () => {
    const f = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 1, wavelength: 4, speed: 1, phase: 0 },
    ])
    // omega = (2π/4) * 1 = π/2 rad/s. Quarter period = 1s.
    const a = sampleHeight(f, 0, 0)
    advanceWaveField(f, 1) // 1 second = quarter period
    const b = sampleHeight(f, 0, 0)
    expect(Math.abs(b - a)).toBeGreaterThan(0.5)
  })

  it('default preset produces nontrivial samples within reasonable bounds', () => {
    const f = createWaveField(defaultWaves())
    let min = Infinity
    let max = -Infinity
    // Sample a grid over a full set-beat period (~30s) so the test sees both
    // calm windows and big-swell peaks.
    for (let ti = 0; ti < 60; ti++) {
      advanceWaveField(f, 0.5)
      for (let x = -20; x <= 20; x += 5) {
        for (let z = -20; z <= 20; z += 5) {
          const y = sampleHeight(f, x, z)
          min = Math.min(min, y)
          max = Math.max(max, y)
        }
      }
    }
    expect(max).toBeGreaterThan(0.3)
    expect(min).toBeLessThan(-0.3)
    // Sum of amplitudes is the upper bound; clamp generously to allow
    // constructive interference of all swell + chop components.
    expect(max).toBeLessThan(3.0)
    expect(min).toBeGreaterThan(-3.0)
  })

  it('sampleSurface returns unit normal', () => {
    const f = createWaveField(defaultWaves())
    const s = sampleSurface(f, 3, 7)
    const len = Math.hypot(s.nx, s.ny, s.nz)
    expect(len).toBeCloseTo(1, 5)
    // Normal y should be positive (water surface points up overall).
    expect(s.ny).toBeGreaterThan(0)
  })

  it('wake forms a V with raised edges and a sunken middle', () => {
    // Empty wave field so we measure ONLY the wake contribution. A straight
    // 12 m/s ride ending with the head at the origin reproduces the classic
    // heading-ray V — now evaluated along the recorded trail.
    const f = createWaveField([])
    rideStraight(f, 12)
    // The V's right edge sits at z = behind * WAKE_HALF_ANGLE_TAN
    // + WAKE_BASE_WIDTH, with the bike at origin having ridden +X.
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55 // = 4.55
    const bx = -behind

    // On the V edge: positive peak (the visible ridge).
    const yEdge = sampleHeight(f, bx, wakeWidth)
    expect(yEdge).toBeGreaterThan(0.25)

    // On the bike's central axis (perp=0): trough — water is below
    // ambient. This is what makes the wake feel like a real channel
    // carved through the surface.
    const yAxis = sampleHeight(f, bx, 0)
    expect(yAxis).toBeLessThan(-0.25)

    // WAY off to the side (perp >> wakeWidth + halfwidth): zero.
    const ySide = sampleHeight(f, bx, 30)
    expect(Math.abs(ySide)).toBeLessThan(0.01)

    // IN FRONT of the bike (behind = 0): no wake — the head caps the trail
    // and the longitudinal ramp is zero there.
    const yFront = sampleHeight(f, 10, 0)
    expect(yFront).toBe(0)
  })

  it('wake fades to zero at low speed', () => {
    // Points laid below WAKE_SPEED_LOW carry zero strength — the speed gate
    // is baked into each breadcrumb at drop time.
    const f = createWaveField([])
    rideStraight(f, 0.5, 5)
    expect(sampleHeight(f, -1, 0)).toBe(0)
    expect(sampleHeight(f, -2, 0.95)).toBe(0)
  })

  it('wake scales with weight', () => {
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55
    const fFull = createWaveField([])
    rideStraight(fFull, 12, 5, 1)
    const edgeFull = sampleHeight(fFull, -behind, wakeWidth)
    const axisFull = sampleHeight(fFull, -behind, 0)
    const fHalf = createWaveField([])
    rideStraight(fHalf, 12, 5, 0.5)
    const edgeHalf = sampleHeight(fHalf, -behind, wakeWidth)
    const axisHalf = sampleHeight(fHalf, -behind, 0)
    // Identical rides except the deposit weight → strictly linear scaling
    // on both the ridge peak and the trough.
    expect(edgeFull).not.toBeCloseTo(0, 2)
    expect(edgeHalf).toBeCloseTo(edgeFull * 0.5, 4)
    expect(axisHalf).toBeCloseTo(axisFull * 0.5, 4)
  })

  it('wake produces non-trivial slope between trough and ridge', () => {
    const f = createWaveField([])
    rideStraight(f, 12)
    // The V's slope is steepest somewhere between the central trough
    // and the edge ridge. Sample the surface normal across the trough
    // wall — at least one sample should tilt by ≥ 0.1 in nz.
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55
    let maxAbs = 0
    for (let z = 0.1; z < wakeWidth; z += 0.05) {
      const s = sampleSurface(f, -behind, z)
      maxAbs = Math.max(maxAbs, Math.abs(s.nz))
    }
    expect(maxAbs).toBeGreaterThan(0.1)
  })

  it('wake has transverse oscillation along its length (M9.35 scallops)', () => {
    // Sample the V's edge-ridge height at many points along the wake's
    // length. With pure exponential decay the height profile would be
    // near-monotone; the longitudinal sin modulation creates multiple
    // direction changes. Sampled over [3..24]m (well inside the recorded
    // 30 m trail span) at 0.25m steps; the K=0.7 wavenumber gives ~2.3
    // full periods over that range, expecting ≥4 direction changes.
    const f = createWaveField([])
    rideStraight(f, 12)
    const samples: number[] = []
    for (let b = 3; b <= 24; b += 0.25) {
      const wakeWidth = b * 0.4 + 0.55
      samples.push(sampleHeight(f, -b, wakeWidth))
    }
    let directionChanges = 0
    let lastDir = 0
    for (let i = 1; i < samples.length; i++) {
      const dir = Math.sign(samples[i]! - samples[i - 1]!)
      if (dir !== 0 && dir !== lastDir && lastDir !== 0) {
        directionChanges++
      }
      if (dir !== 0) lastDir = dir
    }
    expect(directionChanges).toBeGreaterThanOrEqual(4)
  })

  it('wake follows a curved path, not the heading ray', () => {
    // Quarter-ish circle of radius 10 at 12 m/s, ending at angle 0 with the
    // head at (10, 0) heading +Z. On the RIDDEN ARC 15 m back the trough is
    // carved; 15 m straight behind the CURRENT heading (where the old
    // heading-ray V lived) the surface is untouched — the sagitta at that
    // arc length (~9.3 m) is outside the V's width + bell (~7.3 m).
    const f = createWaveField([])
    const r = 10
    const speed = 12
    const seconds = (Math.PI * 0.6 * r) / speed // ~60% of a half-circle
    const endAngle = 0
    ride(
      f,
      (t) => {
        const a = endAngle + (speed / r) * (seconds - t) // winds back in time
        return { x: r * Math.cos(a), z: -r * Math.sin(a) }
      },
      seconds,
      { speed },
    )
    // On-path probe: 15 m of arc back along the circle.
    const aBack = endAngle + 15 / r
    const onPath = sampleHeight(f, r * Math.cos(aBack), -r * Math.sin(aBack))
    expect(onPath).toBeLessThan(-0.08) // the carved trough
    // Heading-ray probe: the head sits at (10, 0) moving toward +Z (the
    // circle is wound so travel at the end is +Z), so the old V would have
    // painted (10, -15). The trail leaves it untouched.
    const headingRay = sampleHeight(f, r, -15)
    expect(Math.abs(headingRay)).toBeLessThan(0.02)
  })

  it('an airborne hop leaves a gap and keeps the pre-jump wake', () => {
    const f = createWaveField([])
    const speed = 12
    // 4 s straight ride...
    ride(f, (t) => ({ x: -48 - 18 + speed * t, z: 0 }), 4, { speed })
    // ...then 1 s airborne (no feeding — wakeUpdateSystem skips weight ≤
    // 0.05), landing 18 m further along, fed exactly once at touchdown.
    advanceWaveField(f, 1)
    const tr = acquireWakeTrail(f.trails, 1, 0, 0, f.time)
    feedWakeTrail(tr, 0, 0, 1, speed, f.time)

    // Mid-gap (9 m into the 18 m flight): no wake — the over-long segment
    // is skipped, so the flight path is clean water.
    expect(Math.abs(sampleHeight(f, -9, 0))).toBeLessThan(0.01)
    // Pre-jump wake (6 m before takeoff): still there, receded + aged but
    // not wiped — a hop must not erase the wake you already laid.
    expect(Math.abs(sampleHeight(f, -24, 2.2))).toBeGreaterThan(0.03)
  })

  it('wake trail feeding is deterministic', () => {
    const build = () => {
      const f = createWaveField([])
      ride(f, (t) => ({ x: -30 + 10 * t, z: Math.sin(t * 2) * 4 }), 3, { speed: 11 })
      return f
    }
    const a = build()
    const b = build()
    for (let x = -30; x <= 2; x += 1.7) {
      for (let z = -6; z <= 6; z += 1.3) {
        expect(sampleHeight(a, x, z)).toBe(sampleHeight(b, x, z))
      }
    }
  })

  it('sampleHeight can exclude wakes (ambient-only weight read)', () => {
    const f = createWaveField([])
    rideStraight(f, 12)
    const withWake = sampleHeight(f, -10, 4.55)
    const ambient = sampleHeight(f, -10, 4.55, false)
    expect(Math.abs(withWake)).toBeGreaterThan(0.1)
    expect(ambient).toBe(0)
  })
})

// A west→east beach ramp: terrain rises with +X, crossing the water plane at
// x = 0. Land is +X, open water is −X. depth = −0.05·x in the water.
function rampShore(): ShoreField {
  const RES = 64
  const MINX = -100
  const SIZE = 200
  const cell = SIZE / RES
  const raw = new Float32Array(RES * RES)
  for (let v = 0; v < RES; v++) {
    for (let u = 0; u < RES; u++) {
      const x = MINX + (u + 0.5) * cell
      raw[v * RES + u] = 0.05 * x
    }
  }
  const f = buildShoreField({
    raw,
    resolution: RES,
    minX: MINX,
    minZ: MINX,
    sizeX: SIZE,
    sizeZ: SIZE,
    waterLevel: 0,
  })
  if (!f) throw new Error('expected a shore field')
  return f
}

describe('terrain shoaling (CPU mirror of the GPU shallow-water fade)', () => {
  it('is 1 with no shore field; legacy regime (strength 0) squares toward 0 in the shallows', () => {
    // No shore field installed → open water → full amplitude everywhere.
    const open = createWaveField(defaultWaves())
    expect(shoalAttenuation(open, 0, 0)).toBe(1)

    // Shoaling v2 ships default-ON; this test pins the LEGACY endpoint
    // (strength 0 — the exact pre-P3.1 kill-switch, the A/B baseline).
    const f = createWaveField(defaultWaves())
    f.shoalSurfStrength = 0
    setShoreField(f, rampShore()) // depth = −0.05·x in the water (x < 0)
    // Deep water past SHOAL_FADE_DEPTH (x = −80 → depth 4 m ≥ 3) → 1.
    expect(shoalAttenuation(f, -80, 0)).toBe(1)
    // depth = SHOAL_FADE_DEPTH exactly (x = −60 → depth 3 m) → 1.
    expect(shoalAttenuation(f, -SHOAL_FADE_DEPTH / 0.05, 0)).toBeCloseTo(1, 5)
    // Shallow (x = −30 → depth 1.5 m) → (1.5/3)² = 0.25.
    expect(shoalAttenuation(f, -30, 0)).toBeCloseTo(0.25, 5)
    // Land (x = +40, depth < 0) → 0.
    expect(shoalAttenuation(f, 40, 0)).toBe(0)

    // Surf regime (default strength 1): amplifies toward the break, never
    // past the gain clamp, still 0 on land. (Full curve coverage lives in
    // wave-shoaling.test.ts.)
    const surf = createWaveField(defaultWaves())
    setShoreField(surf, rampShore())
    expect(shoalAttenuation(surf, -80, 0)).toBeGreaterThan(1)
    expect(shoalAttenuation(surf, -80, 0)).toBeLessThanOrEqual(SHOAL_GAIN_MAX)
    expect(shoalAttenuation(surf, 40, 0)).toBe(0)
  })

  it('bounds the ambient swell in the shallows (depth-limited in surf, flattened in legacy)', () => {
    const f = createWaveField(defaultWaves())
    setShoreField(f, rampShore())
    const legacy = createWaveField(defaultWaves())
    legacy.shoalSurfStrength = 0
    setShoreField(legacy, rampShore())
    let deepPeak = 0
    let shallowPeak = 0
    let shallowPeakLegacy = 0
    for (let i = 0; i < 80; i++) {
      advanceWaveField(f, 0.1)
      advanceWaveField(legacy, 0.1)
      deepPeak = Math.max(deepPeak, Math.abs(sampleHeight(f, -90, 0))) // depth 4.5 m
      shallowPeak = Math.max(shallowPeak, Math.abs(sampleHeight(f, -8, 0))) // depth 0.4 m
      shallowPeakLegacy = Math.max(shallowPeakLegacy, Math.abs(sampleHeight(legacy, -8, 0)))
    }
    // Deep water keeps a real swell.
    expect(deepPeak).toBeGreaterThan(0.3)
    // Legacy: the shallows are flattened well below the deep swell.
    expect(shallowPeakLegacy).toBeLessThan(deepPeak * 0.2)
    // Surf v2: the shallows stay ALIVE (that's the feature) but
    // depth-limited — bounded by the breaking ratio + the shore-breaker
    // budget at this 0.4 m depth, well under an unshoaled swell.
    expect(shallowPeak).toBeGreaterThan(shallowPeakLegacy)
    expect(shallowPeak).toBeLessThan(deepPeak * 0.6)
  })

  it('keeps the buoyancy surface above the seabed in the shallows (the floor bug)', () => {
    // The "driving on the ocean floor" failure: without shoaling, a
    // full-amplitude ambient trough drops the buoyancy target below the seabed
    // in shallow water. Near shore (depth ≲ SHOAL_FADE_DEPTH/2) the squared
    // fade keeps shoal·amplitude well under the water column, so the surface
    // stays above terrain across a full time scan. (At moderate depth with
    // absurd amplitude both CPU and GPU can still tip over — that's parity, not
    // desync — so we assert the guarantee where it actually holds: the surf
    // band the rider rides through onto the beach.)
    const f = createWaveField(defaultWaves())
    setShoreField(f, rampShore())
    let breaches = 0
    let breachesUnshoaled = 0
    const unshoaled = createWaveField(defaultWaves()) // no shore field → shoal ≡ 1
    for (let i = 0; i < 160; i++) {
      advanceWaveField(f, 0.05)
      advanceWaveField(unshoaled, 0.05)
      for (let x = -28; x <= -1; x += 1) {
        const depth = -0.05 * x // = waterLevel − terrainY; seabed at y = −depth
        if (sampleHeight(f, x, 0) < -depth - 1e-3) breaches++
        if (sampleHeight(unshoaled, x, 0) < -depth - 1e-3) breachesUnshoaled++
      }
    }
    expect(breaches).toBe(0)
    // Sanity: the same swell WITHOUT shoaling really does sink below the seabed
    // in the shallows — so the test is exercising the fix, not a no-op.
    expect(breachesUnshoaled).toBeGreaterThan(0)
  })

  it('sampleHeight and sampleSurface agree on the shoaled height', () => {
    const f = createWaveField(defaultWaves())
    setShoreField(f, rampShore())
    for (let i = 0; i < 20; i++) {
      advanceWaveField(f, 0.13)
      for (const x of [-90, -30, -12, -4]) {
        expect(sampleSurface(f, x, 0).y).toBeCloseTo(sampleHeight(f, x, 0), 9)
      }
    }
  })
})

describe('shore-aligned waves', () => {
  it('adds rideable height in the surf band, and nothing when strength = 0', () => {
    const f = createWaveField([]) // isolate the shore term (no ambient swell)
    setShoreField(f, rampShore())
    // x = −40 → depth ≈ 2 m, squarely in the band. Scan a beat so we don't
    // land on a phase zero-crossing.
    let peak = 0
    for (let i = 0; i < 40; i++) {
      advanceWaveField(f, 0.1)
      peak = Math.max(peak, Math.abs(sampleHeight(f, -40, 0)))
    }
    expect(peak).toBeGreaterThan(0.1)
    // Strength 0 collapses the contribution to exactly zero (empty field).
    f.shoreWaveStrength = 0
    for (let i = 0; i < 40; i++) {
      advanceWaveField(f, 0.1)
      expect(sampleHeight(f, -40, 0)).toBe(0)
    }
  })

  it('contributes nothing on dry land or in deep water', () => {
    const f = createWaveField([])
    setShoreField(f, rampShore())
    advanceWaveField(f, 1.3)
    // Land (x = +40, depth < 0).
    expect(sampleHeight(f, 40, 0)).toBe(0)
    // Deep water (x = −95 → depth ≈ 4.75 ≥ SHORE_BAND_DEPTH).
    expect(SHORE_BAND_DEPTH).toBeLessThan(4.75)
    expect(sampleHeight(f, -95, 0)).toBe(0)
  })

  it('never breaches the seabed (|height| ≤ SHORE_DEPTH_CAP·(1+SHORE_ASYM)·depth)', () => {
    // The depth cap bounds the breaker's FUNDAMENTAL amplitude A; the
    // forward-lean second harmonic (shoaling v2) adds up to SHORE_ASYM·A
    // on top, so the waveform bound is (1 + a₂)·A — still half the water
    // column at the shipped 0.5 cap.
    const f = createWaveField([])
    const shore = rampShore()
    setShoreField(f, shore)
    for (let i = 0; i < 30; i++) {
      advanceWaveField(f, 0.17)
      for (let x = -85; x <= -5; x += 5) {
        const s = sampleSurface(f, x, 0) // unused beyond keeping parity warm
        void s
        const y = sampleHeight(f, x, 0)
        // depth at this x from the same field the term reads.
        const depth = -0.05 * x
        expect(Math.abs(y)).toBeLessThanOrEqual(SHORE_DEPTH_CAP * (1 + SHORE_ASYM) * depth + 1e-3)
      }
    }
  })

  it('sampleHeight and sampleSurface agree on height with a shore field', () => {
    const f = createWaveField(defaultWaves())
    setShoreField(f, rampShore())
    for (let i = 0; i < 10; i++) {
      advanceWaveField(f, 0.37)
      for (let x = -80; x <= -10; x += 10) {
        for (let z = -30; z <= 30; z += 15) {
          expect(sampleHeight(f, x, z)).toBeCloseTo(sampleSurface(f, x, z).y, 9)
        }
      }
    }
  })

  it('shore ∂y/∂t (vy) matches a finite difference of height', () => {
    const f = createWaveField([]) // isolate shore so vy is purely the shore term
    setShoreField(f, rampShore())
    advanceWaveField(f, 2.0)
    const x = -35
    const z = 0
    const vy = sampleSurface(f, x, z).vy
    const eps = 1e-3
    advanceWaveField(f, eps)
    const hp = sampleHeight(f, x, z)
    advanceWaveField(f, -2 * eps)
    const hm = sampleHeight(f, x, z)
    const numeric = (hp - hm) / (2 * eps)
    expect(vy).toBeCloseTo(numeric, 3)
  })

  it('leaves the field untouched when no shore field is installed', () => {
    const a = createWaveField(defaultWaves())
    const b = createWaveField(defaultWaves())
    setShoreField(b, null)
    advanceWaveField(a, 1.1)
    advanceWaveField(b, 1.1)
    for (let x = -50; x <= 50; x += 25) {
      expect(sampleHeight(a, x, 7)).toBe(sampleHeight(b, x, 7))
    }
  })
})

describe('gerstner sim↔render sync', () => {
  it('steepness 0 leaves sampleHeight vertical-only (regression)', () => {
    const a = createWaveField(defaultWaves()) // steepness defaults to 0
    const b = createWaveField(defaultWaves())
    b.steepness = 0
    for (let i = 0; i < 5; i++) {
      advanceWaveField(a, 0.31)
      advanceWaveField(b, 0.31)
      for (let x = -20; x <= 20; x += 10) {
        for (let z = -20; z <= 20; z += 10) {
          expect(sampleHeight(a, x, z)).toBeCloseTo(sampleHeight(b, x, z), 12)
        }
      }
    }
  })

  it('effectiveSteepness clamps as amplitude grows (no fold) and eases the pinch', () => {
    const f = createWaveField(defaultWaves())
    f.steepness = 0.7
    // Default amplitudes: budget under the limit → no clamp.
    expect(effectiveSteepness(f)).toBeCloseTo(0.7, 12)
    // Crank amplitude until the budget exceeds the limit → effective Q eases.
    for (const w of f.waves) w.amplitude *= 6
    const qEff = effectiveSteepness(f)
    expect(qEff).toBeLessThan(0.7)
    expect(qEff * steepnessSum(f)).toBeLessThanOrEqual(STEEPNESS_SUM_LIMIT + 1e-9)
  })

  it('sampleHeight and sampleSurface agree on height WITH steepness on', () => {
    const f = createWaveField(defaultWaves())
    f.steepness = 0.7
    for (let i = 0; i < 8; i++) {
      advanceWaveField(f, 0.29)
      for (let x = -25; x <= 25; x += 12.5) {
        for (let z = -25; z <= 25; z += 12.5) {
          expect(sampleHeight(f, x, z)).toBeCloseTo(sampleSurface(f, x, z).y, 9)
        }
      }
    }
  })

  it('steepness actually shifts the sampled surface (inverse-map applied)', () => {
    const a = createWaveField(defaultWaves())
    const b = createWaveField(defaultWaves())
    b.steepness = 0.8
    advanceWaveField(a, 1.0)
    advanceWaveField(b, 1.0)
    let maxDelta = 0
    for (let x = -30; x <= 30; x += 3) {
      for (let z = -30; z <= 30; z += 3) {
        maxDelta = Math.max(maxDelta, Math.abs(sampleHeight(a, x, z) - sampleHeight(b, x, z)))
      }
    }
    expect(maxDelta).toBeGreaterThan(0.05)
  })
})
