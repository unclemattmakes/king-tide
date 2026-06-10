import {
  DEFAULT_CHOP_TUNING_SCALE,
  DEFAULT_SWELL_TUNING_SCALE,
  defaultWaves,
  SWELL_WAVELENGTH_MIN,
  type Wave,
} from './wave-field'

/**
 * Per-track wave-spectrum presets (water-next-research.md §7.1, P2.2).
 *
 * Replaces the one global hand-tuned 6-wave bank with a deterministic,
 * seeded generator: JONSWAP-shaped energy integrated per octave bin,
 * log-uniform (non-harmonic) wavelengths inside each bin so commensurate
 * frequency ratios are measure-zero and the visible repeat period
 * stretches to minutes, directions fanned around the bearing axis
 * (every preset stays inside a tight fan — the pre-v2 190° spread read
 * as "confused seas" and was untrackable under the bike), and phase
 * speeds pinned to the deep-water dispersion relation `ω² = g·k`
 * (players subconsciously read group/shoaling timing, so detuning
 * speed reads wrong; randomize k instead).
 *
 * The generator runs ONCE at boot, before the water mesh is built —
 * the shader bakes wavelength/direction/phase per wave at construction
 * and live-mirrors only the amplitudes, so a per-track bank must be in
 * `field.waves` before `createWaterMesh` (main.ts orders this).
 * Everything downstream — CPU buoyancy, the GPU vertex loops, zones,
 * shoaling, the set envelope, Beaufort/lap-weather amplitude writers —
 * consumes `Wave[]` generically and needs no changes.
 *
 * Energy contract: every generated bank is normalized so the LIVE sea —
 * after `applyStoredWaterTuning` stomps the boot-time per-band tuning
 * scales onto it (swells ×3.2, chop ×0.9; see DEFAULT_*_TUNING_SCALE in
 * wave-field.ts) — carries the same total variance (Σ A²/2) as the
 * shipped default sea under the same scales. The generator designs in
 * that EFFECTIVE space and pre-divides its output per band, so the
 * preset's character survives the stomp untouched. The spectrum shapes
 * the sea's CHARACTER (where the energy sits in wavelength/direction);
 * the per-track `sky.seaStateBeaufort` scalar stays the single owner of
 * how MUCH energy there is. A calm-lagoon preset at Beaufort 6 is a
 * choppy storm; an open-swell preset at Beaufort 2 is glassy rollers.
 *
 * Sim layer: pure math, no Three.js (ADR 0002).
 */

/** Gravity used by the dispersion relation (matches the hand bank's
 *  `c ≈ √(g·λ/2π)` tuning). */
const G = 9.81

/** Hard cap on generated components. The GPU vertex stage unrolls the
 *  wave loop ~11× per center-plane vertex (height, disp, swell twin,
 *  crest signals, 4-tap foam accumulator), so component count is the
 *  single biggest water vertex-cost lever. 16 is the measured-safe
 *  ceiling on the dev RTX 5050 (see wave-count-perf.spec.ts); anything
 *  beyond it must re-run that measurement. */
export const MAX_SPECTRUM_COMPONENTS = 16
export const MIN_SPECTRUM_COMPONENTS = 4
/** Default component count when a track authors a spectrum without an
 *  explicit `components`. Picked from the wave-count perf grid (8 / 12 /
 *  16 on the 768² center plane) as the sweet spot of nuance vs vertex
 *  cost — see docs/water-next-research.md §8 P2.2. */
export const DEFAULT_SPECTRUM_COMPONENTS = 12

/** Ceiling on the generated bank's steepness budget Σ qBase·A·k,
 *  measured on the EFFECTIVE (post-boot-tuning) amplitudes — the sea the
 *  pinch actually displaces. Two reasons it sits where the shipped
 *  default sea does (≈ 0.43) rather than at wave-field.ts's
 *  STEEPNESS_SUM_LIMIT (0.85, the crest-fold threshold): (a) generated
 *  banks pinch no harder than the sea every track was graded against,
 *  and (b) the CPU buoyancy inverse map is a fixed-point iteration whose
 *  contraction factor IS Q·Σ — at the shipped Q it converges to
 *  sub-millimetre in the standard 4 steps, and even the Q=1.2 stress
 *  diagnostic stays mm-scale (a 0.6 budget measurably degraded it to
 *  ~5 cm at Q=1.2: 0.72⁴ ≈ 0.27 of the displacement left as residual).
 *  Generated banks are qBase-rescaled down to this budget when their
 *  random draw lands hot. */
export const SPECTRUM_STEEPNESS_BUDGET = 0.45

export type SpectrumPresetName = 'mixed-sea' | 'open-swell' | 'lagoon-chop' | 'storm-cross'

/** Authoring surface — mirrors `water.spectrum` in track JSON. */
export type SpectrumSpec = {
  preset: SpectrumPresetName
  /** PRNG seed — same seed = bit-identical bank, every boot, every
   *  client. Different seeds re-roll wavelengths/directions/phases
   *  within the same preset character. Default 1. */
  seed?: number
  /** Total component count, clamped to
   *  [MIN_SPECTRUM_COMPONENTS, MAX_SPECTRUM_COMPONENTS]. Default
   *  DEFAULT_SPECTRUM_COMPONENTS. */
  components?: number
  /** Override the preset's chop-fan half-width (degrees). Swell stays
   *  on the preset's tighter fan. */
  spreadDeg?: number
  /** Energy tilt between the swell band (λ ≥ SWELL_WAVELENGTH_MIN) and
   *  chop, 0..1. 0.5 = the preset's natural JONSWAP split; higher
   *  shifts energy into the long swells, lower into chop. */
  swellBias?: number
  /** Override the preset's spectral-peak wavelength (m). */
  peakWavelengthM?: number
}

type PresetDef = {
  /** Octave-span bounds (m). `lambdaMax` must exceed
   *  SWELL_WAVELENGTH_MIN — bin 0's lower edge is clamped to the swell
   *  threshold so every bank carries at least one true swell (the
   *  outer/skirt water layers draw ONLY the swell subset; an all-chop
   *  bank would leave them flat and seam against the center plane). */
  lambdaMin: number
  lambdaMax: number
  /** JONSWAP peak wavelength (m) — where the energy concentrates. */
  peakWavelengthM: number
  /** JONSWAP peak-enhancement γ. 3.3 = textbook sea; higher = pointier
   *  spectrum = cleaner, more regular swell lines; lower = broad,
   *  disordered wind sea. */
  gamma: number
  /** Direction fan half-widths (degrees) around the bearing axis. */
  swellSpreadDeg: number
  chopSpreadDeg: number
  /** Default energy tilt (see SpectrumSpec.swellBias). */
  swellBias: number
  /** When set and the bank has ≥ 2 swells, the second swell is rotated
   *  this far off-axis — a deliberate bichromatic CROSS sea (storm
   *  preset). Degrees. */
  crossSwellDeg?: number
}

/**
 * The four shipped sea characters. Per-track water identity is content
 * (water-next-research §6 rule 4) — these are starting points an author
 * refines with `seed`/`swellBias`/`spreadDeg`, not a closed list; add a
 * preset here and it's immediately legal in track JSON.
 */
export const SPECTRUM_PRESETS: Record<SpectrumPresetName, PresetDef> = {
  /** Neutral JONSWAP — the generated cousin of the hand-tuned default
   *  bank. Balanced swell + chop, modest fan. */
  'mixed-sea': {
    lambdaMin: 4,
    lambdaMax: 90,
    peakWavelengthM: 50,
    gamma: 3.3,
    swellSpreadDeg: 10,
    chopSpreadDeg: 25,
    swellBias: 0.5,
  },
  /** Long-period groundswell — clean, widely-spaced rollers with light
   *  surface chop. The "Southern Ocean lines" finale character. */
  'open-swell': {
    lambdaMin: 6,
    lambdaMax: 120,
    peakWavelengthM: 70,
    gamma: 6,
    swellSpreadDeg: 6,
    chopSpreadDeg: 18,
    swellBias: 0.65,
  },
  /** Sheltered wind sea — short-period chop, one modest background
   *  swell to carry the outer-layer silhouette. */
  'lagoon-chop': {
    lambdaMin: 3,
    lambdaMax: 45,
    peakWavelengthM: 14,
    gamma: 2.2,
    swellSpreadDeg: 12,
    chopSpreadDeg: 30,
    swellBias: 0.3,
  },
  /** Energetic disordered storm sea + a second swell train pushed
   *  deliberately off-axis (cross sea). Widest fan that still stays
   *  trackable. */
  'storm-cross': {
    lambdaMin: 5,
    lambdaMax: 110,
    peakWavelengthM: 60,
    gamma: 2.8,
    swellSpreadDeg: 10,
    chopSpreadDeg: 30,
    swellBias: 0.5,
    crossSwellDeg: 24,
  },
}

export const SPECTRUM_PRESET_NAMES = Object.keys(SPECTRUM_PRESETS) as SpectrumPresetName[]

export function isSpectrumPresetName(v: unknown): v is SpectrumPresetName {
  return typeof v === 'string' && v in SPECTRUM_PRESETS
}

/** mulberry32 — tiny deterministic PRNG. Same seed → same sequence on
 *  every JS engine (pure uint32 arithmetic), which is what makes a
 *  spectrum bank replay- and multiplayer-safe per-track data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Unnormalized JONSWAP energy density S(ω). The Phillips α is dropped —
 *  the bank is variance-normalized after generation, so only the SHAPE
 *  survives. */
function jonswapShape(omega: number, omegaPeak: number, gamma: number): number {
  const sigma = omega <= omegaPeak ? 0.07 : 0.09
  const r = Math.exp(-((omega - omegaPeak) ** 2) / (2 * sigma * sigma * omegaPeak * omegaPeak))
  return omega ** -5 * Math.exp(-1.25 * (omegaPeak / omega) ** 4) * gamma ** r
}

/** Per-wave Gerstner steepness coefficient by wavelength — the same
 *  hand-tuned curve `defaultWaves()` encodes at its sample points
 *  (swells roll at 0.35, mid chop ridges at 0.85, fine chop pinches
 *  hard at 1.0), interpolated in log-λ between them. */
function qBaseForWavelength(lambda: number): number {
  if (lambda >= 50) return 0.35
  if (lambda <= 6) return 1.0
  if (lambda >= 16) {
    // 16 m → 0.85, 50 m → 0.35
    const t = (Math.log(lambda) - Math.log(16)) / (Math.log(50) - Math.log(16))
    return 0.85 + (0.35 - 0.85) * t
  }
  // 6 m → 1.0, 16 m → 0.85
  const t = (Math.log(lambda) - Math.log(6)) / (Math.log(16) - Math.log(6))
  return 1.0 + (0.85 - 1.0) * t
}

/** The boot-applied per-band scale for a wavelength (see
 *  DEFAULT_*_TUNING_SCALE in wave-field.ts: `applyStoredWaterTuning`
 *  stomps `amplitude = base · scale` on every boot, swell vs chop by the
 *  shared wavelength threshold). */
function bandTuningScale(lambda: number): number {
  return lambda >= SWELL_WAVELENGTH_MIN ? DEFAULT_SWELL_TUNING_SCALE : DEFAULT_CHOP_TUNING_SCALE
}

/** Total variance (Σ A²/2) of the SHIPPED EFFECTIVE sea — the hand-tuned
 *  default bank with the boot-time per-band tuning scales applied
 *  (swells ×3.2, chop ×0.9; what every track was actually graded
 *  against). Every generated bank is normalized to carry this energy
 *  post-scale, so `seaStateBeaufort` keeps meaning the same thing on
 *  spectrum tracks as on default ones. */
export function shippedBankVariance(): number {
  let v = 0
  for (const w of defaultWaves()) {
    const a = w.amplitude * bandTuningScale(w.wavelength)
    v += a * a
  }
  return v / 2
}

export type GeneratedSpectrum = {
  waves: Wave[]
  /** How many leading entries are swell-band (λ ≥ SWELL_WAVELENGTH_MIN).
   *  Waves are sorted longest-first, so indices [0, swellCount) are the
   *  swells — the render layer derives its swell subset (outer/skirt
   *  geometry, P1 readability field, menu sliders) from wavelength, and
   *  this count is the same classification pre-computed. */
  swellCount: number
}

/**
 * Generate a deterministic per-track wave bank from a spectrum spec.
 *
 * Algorithm (each step closed-form + seeded — no iteration, no state):
 *  1. Octave bins descend from λmax; bin 0's lower edge is clamped up to
 *     SWELL_WAVELENGTH_MIN so at least one component is a true swell.
 *  2. Components round-robin across bins longest-first (every bin gets
 *     one before any gets two), λ log-uniform inside its bin.
 *  3. ω² = g·k (deep-water dispersion) → speed = ω/k.
 *  4. Amplitude² ∝ JONSWAP S(ω)·Δω_bin / n_bin, tilted by swellBias,
 *     rescaled to `shippedBankVariance()` in effective space, then
 *     pre-divided by the boot tuning scale per band.
 *  5. Directions fan around the bearing axis — tight for swell, wider
 *     for chop, quadratically center-weighted; storm preset rotates its
 *     second swell off-axis (cross sea).
 *  6. qBase by wavelength (the default bank's pinch curve), rescaled
 *     down if the bank's Σ qBase·A·k overshoots the steepness budget.
 *  7. Sort longest-first; swellCount = #(λ ≥ SWELL_WAVELENGTH_MIN).
 */
export function generateSpectrumWaves(spec: SpectrumSpec): GeneratedSpectrum {
  const preset = SPECTRUM_PRESETS[spec.preset]
  if (!preset) throw new Error(`[spectrum] unknown preset '${String(spec.preset)}'`)
  const rand = mulberry32(Math.floor(spec.seed ?? 1))
  const count = Math.round(
    Math.min(
      MAX_SPECTRUM_COMPONENTS,
      Math.max(MIN_SPECTRUM_COMPONENTS, spec.components ?? DEFAULT_SPECTRUM_COMPONENTS),
    ),
  )
  const peakLambda = spec.peakWavelengthM ?? preset.peakWavelengthM
  const omegaPeak = Math.sqrt((G * 2 * Math.PI) / peakLambda)
  const chopSpread = ((spec.spreadDeg ?? preset.chopSpreadDeg) * Math.PI) / 180
  const swellSpread = (preset.swellSpreadDeg * Math.PI) / 180
  const swellBias = Math.min(1, Math.max(0, spec.swellBias ?? preset.swellBias))

  // 1. Octave bins, longest-first. Bin 0 = [max(λmax/2, swell threshold),
  // λmax]; each later bin halves until λmin. The clamp guarantees a swell
  // even for chop-heavy presets whose λmax barely clears the threshold.
  const bins: Array<{ lo: number; hi: number }> = []
  let hi = preset.lambdaMax
  let lo = Math.max(preset.lambdaMax / 2, Math.min(SWELL_WAVELENGTH_MIN, preset.lambdaMax * 0.99))
  for (;;) {
    bins.push({ lo, hi })
    if (lo <= preset.lambdaMin) break
    hi = lo
    lo = Math.max(hi / 2, preset.lambdaMin)
  }

  // 2. Round-robin allocation, longest bin first — every bin is covered
  // before any bin doubles up, so small counts still span the range.
  const perBin = new Array<number>(bins.length).fill(0)
  for (let i = 0; i < count; i++) perBin[i % bins.length]!++

  type Draft = {
    lambda: number
    omega: number
    a2: number
    theta: number
    phase: number
  }
  const drafts: Draft[] = []
  for (let b = 0; b < bins.length; b++) {
    const bin = bins[b]!
    const n = perBin[b]!
    if (n === 0) continue
    // Angular-frequency width of the bin (dispersion maps λ → ω).
    const omegaHi = Math.sqrt((G * 2 * Math.PI) / bin.lo)
    const omegaLo = Math.sqrt((G * 2 * Math.PI) / bin.hi)
    const dOmega = Math.max(omegaHi - omegaLo, 1e-6)
    for (let j = 0; j < n; j++) {
      // Log-uniform λ inside the bin — non-harmonic by construction.
      const u = rand()
      const lambda = Math.exp(Math.log(bin.lo) + u * (Math.log(bin.hi) - Math.log(bin.lo)))
      const k = (2 * Math.PI) / lambda
      const omega = Math.sqrt(G * k)
      // 4. Energy share: S(ω)·Δω split across the bin's components.
      let a2 = (2 * jonswapShape(omega, omegaPeak, preset.gamma) * dOmega) / n
      // swellBias tilt — energy-space (a², not a), 0.5 = neutral.
      const isSwell = lambda >= SWELL_WAVELENGTH_MIN
      a2 *= isSwell ? 2 * swellBias : 2 * (1 - swellBias)
      // 5. Direction: quadratically center-weighted draw inside the fan.
      const spread = isSwell ? swellSpread : chopSpread
      const v = 2 * rand() - 1
      const theta = spread * v * Math.abs(v)
      const phase = rand() * 2 * Math.PI
      drafts.push({ lambda, omega, a2, theta, phase })
    }
  }

  // Sort longest-first BEFORE the cross-swell rotation so "the second
  // swell" is well-defined and stable across draws.
  drafts.sort((p, q) => q.lambda - p.lambda)
  if (preset.crossSwellDeg !== undefined) {
    const swells = drafts.filter((d) => d.lambda >= SWELL_WAVELENGTH_MIN)
    if (swells.length >= 2) {
      // Push the whole second train off-axis (sign from the seed so
      // tracks can mirror it by re-rolling).
      const sign = rand() < 0.5 ? -1 : 1
      swells[1]!.theta += (sign * preset.crossSwellDeg * Math.PI) / 180
    }
  }

  // Normalize in EFFECTIVE space: the drafts' JONSWAP energies describe
  // the sea the player should see/ride AFTER boot applies the per-band
  // tuning scales. Match the shipped effective variance, then PRE-DIVIDE
  // each component by its band's scale — the boot-time stomp
  // (`applyStoredWaterTuning` → amplitude = base · scale) multiplies it
  // straight back, landing the live sea exactly on the designed one. A
  // user's own persisted slider tweak still reads as a proportional
  // delta from that baseline, same as on the default bank.
  const targetVariance = shippedBankVariance()
  let sumA2 = 0
  for (const d of drafts) sumA2 += d.a2
  const scale = Math.sqrt((targetVariance * 2) / Math.max(sumA2, 1e-12))

  const waves: Wave[] = drafts.map((d) => {
    const k = (2 * Math.PI) / d.lambda
    return {
      dirX: Math.cos(d.theta),
      dirZ: Math.sin(d.theta),
      amplitude: (Math.sqrt(d.a2) * scale) / bandTuningScale(d.lambda),
      wavelength: d.lambda,
      speed: d.omega / k,
      phase: d.phase,
      qBase: qBaseForWavelength(d.lambda),
    }
  })

  // 6. Steepness budget — checked on the EFFECTIVE amplitudes (the live
  // post-scale sea is what the Gerstner pinch displaces): rescale qBase
  // (not amplitude — energy is the normalized invariant) if the draw
  // landed hot.
  let qSum = 0
  for (const w of waves) {
    const effAmp = w.amplitude * bandTuningScale(w.wavelength)
    qSum += (w.qBase ?? 0) * effAmp * ((2 * Math.PI) / w.wavelength)
  }
  if (qSum > SPECTRUM_STEEPNESS_BUDGET) {
    const qScale = SPECTRUM_STEEPNESS_BUDGET / qSum
    for (const w of waves) w.qBase = (w.qBase ?? 0) * qScale
  }

  const swellCount = waves.filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN).length
  if (swellCount === 0 || swellCount === waves.length) {
    // Structurally unreachable (bin-0 clamp guarantees ≥1 swell; λmin <
    // threshold guarantees ≥1 chop) — guard it loudly anyway, because the
    // outer/skirt layers and the P1 readability field both assume a
    // non-degenerate split.
    throw new Error(
      `[spectrum] degenerate bank for preset '${spec.preset}' (swellCount=${swellCount}/${waves.length})`,
    )
  }
  return { waves, swellCount }
}

/**
 * Parse the `?spectrum=` boot URL override:
 *   `?spectrum=open-swell`        → preset, default seed/count
 *   `?spectrum=open-swell:3`      → seed 3
 *   `?spectrum=open-swell:3:14`   → seed 3, 14 components
 *   `?spectrum=off`               → force the default hand-tuned bank
 *                                   even if the track authors a spectrum
 * Returns null for absent/unparseable values (boot falls through to the
 * track JSON), 'off' for the explicit kill switch.
 */
export function parseSpectrumParam(raw: string | null): SpectrumSpec | 'off' | null {
  if (!raw) return null
  if (raw === 'off' || raw === '0' || raw === 'none') return 'off'
  const parts = raw.split(':')
  const preset = parts[0]
  if (!isSpectrumPresetName(preset)) return null
  const spec: SpectrumSpec = { preset }
  if (parts.length > 1 && parts[1] !== '') {
    const seed = Number(parts[1])
    if (Number.isFinite(seed)) spec.seed = seed
  }
  if (parts.length > 2 && parts[2] !== '') {
    const components = Number(parts[2])
    if (Number.isFinite(components)) spec.components = components
  }
  return spec
}
