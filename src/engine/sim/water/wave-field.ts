import { buildPhillipsSpectrum, type PhillipsParams } from './phillips'
import {
  sampleSpectrumHeightFromModes,
  sampleSpectrumSurfaceFromModes,
  selectTopKModes,
  type SpectrumMode,
} from './spectrum-modes'

/**
 * Sum-of-sines Gerstner wave field. Pure math — no Three.js, runs in sim layer.
 *
 * The CPU sampler here is the source of truth for buoyancy. The render-side
 * water shader reads the SAME parameters and time so visuals match physics.
 *
 * Two contributions are summed:
 *   1. Ambient Gerstner waves (wind-driven swell + chop). Static parameters,
 *      animate via time only.
 *   2. Per-bike wakes — each moving bike carries a transverse oscillating
 *      wake stripe behind it. The same closed-form function is mirrored in
 *      the GPU shader so visuals and buoyancy stay locked. This is what
 *      lets a trailing rider "jump" the player's wake.
 *
 * For arcade purposes we use the simplified "vertical-only" Gerstner formulation:
 *   y(x, z, t) = Σ A_i · sin(k_i · (D_i · xz) − ω_i · t + φ_i)
 * skipping the horizontal displacement term. This is dramatically faster to
 * sample (no inverse mapping needed for a given (x,z)) and the visual error
 * is small for the wave amplitudes we use. The wake-and-launch feel comes from
 * the slope/normal more than from horizontal water-particle motion.
 */

export type Wave = {
  /** Unit-length 2D direction (xz plane). */
  dirX: number
  dirZ: number
  /** Peak amplitude, meters. */
  amplitude: number
  /** Crest-to-crest distance, meters. */
  wavelength: number
  /** Phase speed, m/s. */
  speed: number
  /** Static phase offset, radians. */
  phase: number
}

/**
 * A single bike "wake source". Position + horizontal velocity + a 0..1 weight
 * that fades the wake when the bike lifts off the surface. Mirror of the
 * shader's bike-slot uniform — populated once per fixed step from the bike
 * rigid bodies.
 */
export type WakeSource = {
  x: number
  z: number
  vx: number
  vz: number
  /** 0 = inactive (airborne / disabled), 1 = full strength. */
  weight: number
}

export type WaveSample = {
  /** Surface height at (x, z, t). */
  y: number
  /** Surface normal (unit). */
  nx: number
  ny: number
  nz: number
  /** ∂y/∂t — vertical velocity of the surface itself. Useful for damping. */
  vy: number
}

/**
 * The wave field can be in one of two modes:
 *
 *   - 'gerstner' — the legacy 6-wave analytic sum. Default, hand-tuned,
 *     matches the visual character the game has shipped with.
 *   - 'spectrum' — a top-K Phillips spectrum sampled deterministically
 *     from a seeded PRNG. Activated by `?waves=fft` at boot; richer
 *     statistical content, but visual character is different and the
 *     debug menu's swell/chop scales become no-ops (Phase A5 will
 *     replace them with wind-speed / cutoff knobs).
 *
 * Both modes share the wake list, time scalar, and base sea level —
 * the wake system is an additive analytic layer independent of the
 * underlying spectrum, and shipping it unchanged keeps "bike jumps own
 * wake" intact across the migration.
 */
export type WaveFieldState = GerstnerWaveField | SpectrumWaveField

export type GerstnerWaveField = {
  kind: 'gerstner'
  waves: Wave[]
  wakes: WakeSource[]
  time: number
  baseY: number
  /** Global wave-field bearing in radians (CCW). Rotates ALL per-wave
   *  travel directions by the same angle at sample time. Lets the
   *  user re-aim the swell train (e.g. "waves should be coming
   *  toward the island") without rebuilding the wave list. Default 0
   *  = directions as authored in `defaultWaves()`. */
  waveBearing: number
}

export type SpectrumWaveField = {
  kind: 'spectrum'
  /** Top-K most-energetic Phillips modes. CPU buoyancy sums these
   *  analytically; GPU shader converts them to Gerstner-shape via
   *  `spectrumModesToGerstnerShape` at build time. Both paths produce
   *  the identical heightfield — see `spectrum-to-gerstner.ts`. */
  spectrum: SpectrumMode[]
  /** Echo of the build params. Lets consumers introspect / hash the
   *  field for replay validation. */
  spectrumParams: PhillipsParams
  wakes: WakeSource[]
  time: number
  baseY: number
  /** Global wave-field bearing in radians (CCW). Applied as a 2D
   *  rotation on the sample (x, z) before spectrum evaluation. */
  waveBearing: number
}

// ---- Wake parameters -----------------------------------------------------
//
// These constants must EXACTLY match the values baked into the TSL shader in
// `src/engine/render/water.ts`. Any change here without a matching shader
// change will desync visuals from buoyancy.

/** Peak vertical displacement of the wake's ridge, meters. The wake
 * appears as a real bump in the geometry, not just a foam stripe. */
export const WAKE_DISP_AMP = 0.6
/** Speed at which the wake starts to appear (m/s). */
export const WAKE_SPEED_LOW = 1.5
/** Speed at which the wake reaches full strength (m/s). */
export const WAKE_SPEED_HIGH = 8.0
/** Tan of the V-wake half-angle (V opens at this rate behind the bike). */
export const WAKE_HALF_ANGLE_TAN = 0.4
/** Width of the V-wake at the bike before it widens behind, meters. */
export const WAKE_BASE_WIDTH = 0.55
/** Half-width of the amplitude bell that rides along each V edge, meters.
 * The wake's height peaks AT the V boundary (real Kelvin-style diverging
 * wave look) rather than uniformly across the inside of the V. Anything
 * past this many meters from the boundary fades to zero. */
export const WAKE_EDGE_BELL_HALFWIDTH = 0.7
/** Longitudinal ramp-in (1 / meters). Gives the wake a soft start so it
 * doesn't punch up directly under the bike. */
export const WAKE_LONG_RAMP = 0.6
/** Longitudinal decay (1 / meters). Wake fades to ~e^-1 at 1/this distance
 * behind the bike. 0.04 → e-folds at ~25 m. */
export const WAKE_LONG_DECAY = 0.04
/** Transverse-wave wavenumber (rad / meter, M9.35). Real Kelvin wakes
 * have oscillating ridges along the bike's heading axis — the "scallops"
 * behind a moving boat. K = 0.7 → wavelength ≈ 9m, so ~3 visible
 * scallops fit in the 25m wake length. Chosen so sin(K · 10) > 0 at the
 * unit-test sample point (behind=10, t=0), which keeps the existing
 * "yEdge > 0.3 / yAxis < -0.3" assertions firmly in the pass region
 * (modulation BOOSTS by ~20% there rather than reducing amplitude). */
export const WAKE_TRANS_K = 0.7
/** Transverse-wave angular frequency (rad / s). 1.0 → period ≈ 6.3s,
 * a gentle scroll that makes the scallops feel alive without pulsing
 * distractingly. */
export const WAKE_TRANS_OMEGA = 1.0
/** Modulation amplitude (dimensionless multiplier, range 1 ± value).
 * 0.3 → wake amplitude varies between 0.7× and 1.3× of base across
 * each scallop period. Larger = more dramatic peaks/troughs along
 * the wake; capped here so sin = -1 doesn't push the V edge below
 * the unit-test floor. */
export const WAKE_TRANS_AMP = 0.3

export function createWaveField(waves: Wave[], opts?: { baseY?: number }): WaveFieldState {
  return {
    kind: 'gerstner',
    waves,
    wakes: [],
    time: 0,
    baseY: opts?.baseY ?? 0,
    waveBearing: 0,
  }
}

/**
 * Build a wave field driven by a top-K Phillips spectrum. The CPU
 * buoyancy path samples the spectrum analytically; the GPU shader
 * converts the same modes to Gerstner-shape so its unrolled wave
 * iteration stays bit-identical. Behind the `?waves=fft` boot flag
 * during Phase A; the default stays on the legacy 6-wave Gerstner.
 */
export function createSpectrumWaveField(
  spectrumParams: PhillipsParams,
  opts?: { baseY?: number; topK?: number },
): SpectrumWaveField {
  const grid = buildPhillipsSpectrum(spectrumParams)
  // Default top-K kept at 32. Bumping it higher (e.g. 128) gives a
  // tighter CPU-vs-GPU buoyancy match but bloats the analytic-path
  // vertex shader — `water.ts`'s `gerstnerHeight` / `gerstnerDisp`
  // unroll a JS `for` over `waveConsts.length` (= top-K) and
  // `foamAccumulator` re-invokes them at 4 past time samples. At
  // top-K=128 the unrolled shader took some drivers' compile path
  // long enough to drop the WebGPU device entirely (TDR). 32 keeps
  // both paths fast at the cost of a few percent buoyancy-vs-render
  // gap, which the arcade physics tolerates fine.
  const spectrum = selectTopKModes(grid, { topK: opts?.topK ?? 32 })
  return {
    kind: 'spectrum',
    spectrum,
    spectrumParams,
    wakes: [],
    time: 0,
    baseY: opts?.baseY ?? 0,
    waveBearing: 0,
  }
}

/**
 * Default spectrum parameters tuned to read as open ocean — visible
 * rolling swells, foam-catching chop, blue-teal coloring, comparable
 * to the v2 Gerstner default's visual character. Hand-tuned via the
 * water-debug menu on the lagoon track at sunset palette; values are
 * the ones that survived the in-browser A/B against `?water=v2`.
 *
 * Knobs that matter:
 *
 *   - `N`: grid resolution. 64 trades 16× more inner-loop compute
 *     (still <1.5 ms on a modern dGPU) for noticeably less of the
 *     obvious diagonal banding the N=32 spectrum showed when viewed
 *     from grazing angles. The kernel cost still doesn't dominate.
 *   - `windSpeed`: 13 m/s puts the dominant Phillips wavelength at
 *     `L = V²/g ≈ 17 m`. That's solidly in the chop band of the
 *     Gerstner default and produces visible mid-frequency wave fronts
 *     across the visible viewport rather than the sub-meter ripples
 *     a lower V was producing.
 *   - `amplitude` (Phillips `A`): tuned against the summed-spectrum
 *     RMS height. At V=13 / N=64 / tileSize=90, `A = 4.5e-6` lands
 *     RMS heights in the ~0.9 m range — close to the v2 Gerstner
 *     amplitudes' peak excursions, deep enough that the
 *     deep-trough → cream-crest scatter blend fully traverses its
 *     smoothstep window. (Earlier checkpoints had A=1.5e-6 calibrated
 *     for N=32; the bump compensates for the grid change.)
 *   - `smallWavelengthCutoff`: 1.2 m damps modes shorter than 1.2 m
 *     (per Tessendorf §4.3) — keeps the per-pixel chop from aliasing
 *     into noise. Slightly tighter than the Gerstner chop's shortest
 *     wavelength of 5.5 m, leaving the FFT-side a band of fine chop
 *     to add character.
 *
 * `seed` is fixed so two sessions with no track-specific override
 * get the same sea state.
 */
export function defaultSpectrumParams(): PhillipsParams {
  return {
    N: 32,
    tileSize: 90,
    windSpeed: 11,
    // Wind direction rotated 45° from the previous axis-aligned tune.
    // The Phillips spectrum's `|k̂·ŵ|²` directional cosine zeroes
    // out perpendicular modes, so any single wind direction produces
    // a striped wave pattern along that axis. Picking a diagonal
    // breaks the alignment with both world-axis race straightaways
    // and with the bike's nominal forward direction, so the
    // resulting wave fronts cross the visible viewport at an angle
    // rather than as horizontal/vertical "venetian blind" stripes.
    windDirX: 0.6,
    windDirZ: 0.8,
    // Phillips amplitude pulled up from 1e-6 → 4e-6 so the wireframe
    // view actually shows real wave silhouette — at 1e-6 the surface
    // was nearly flat (RMS ~0.3 m on a 240 m mesh = sub-pixel relief
    // at the bike camera height). 4e-6 lands RMS in the 0.8–1.2 m
    // band, which gives the swells visible 3-D shape without the
    // Tessendorf horizontal pinch dragging Jacobian foam back into
    // "white blanket" territory (we softened the foam pipeline in a
    // prior change so this bigger amplitude is safe). CPU buoyancy
    // also reads from this spectrum, so bike physics inherits the
    // larger heave automatically — the analytic Gerstner gap budget
    // tolerates it.
    amplitude: 4e-6,
    // Mitsuyasu cos²ˢ(α/2) directional spread exponent. SoT/Horvath
    // use s ∈ [2, 10]; pulled down to s=2 (slightly wider than the
    // tight default) so the main wind-sea cascade contributes some
    // off-axis energy and doesn't read as parallel sine-wave stripes
    // on the close-in race-camera band. Combined with the chop
    // cascade's near-isotropic spread the surface reads as chaotic
    // ocean rather than banded ripple-pond.
    directionalSpread: 2,
    smallWavelengthCutoff: 1.2,
    seed: 0x515a,
  }
}

export function advanceWaveField(field: WaveFieldState, dt: number): void {
  field.time += dt
}

/**
 * Wake displacement at (x, z) from a single source at time t. Returns 0
 * when the source is in front of the sample point, slow, or off in
 * perpendicular space.
 *
 * Profile across the V (perp = perpendicular distance from the bike's
 * heading axis):
 *   - Inside the V (perp < wakeWidth): a half-cosine trough, going from
 *     -AMP at perp=0 to +AMP at perp=wakeWidth. The water "channels"
 *     down between the diverging wave arms.
 *   - At the boundary (perp = wakeWidth): peak (+AMP), the wake's
 *     visible ridge.
 *   - Just outside (wakeWidth < perp < wakeWidth + EDGE_BELL_HALFWIDTH):
 *     linear fade to 0.
 *   - Beyond: 0.
 *
 * Longitudinal modulation (M9.35): the V's amplitude is multiplied by
 * `(1 + WAKE_TRANS_AMP · sin(K · behind − ω · t))` to produce the
 * transverse "scallops" seen in real ship wakes. The whole V breathes
 * up and down along its length, with the modulation pattern slowly
 * scrolling backward as time advances. Pre-M9.35 the V was a static
 * Kelvin shape — the new modulation makes the wake feel alive without
 * disturbing the V's silhouette.
 *
 * Mirrored bit-for-bit by the TSL shader's bikeSurfaceContrib block —
 * keep them in sync.
 */
export function sampleWakeFromSource(
  src: WakeSource,
  x: number,
  z: number,
  t: number,
): { y: number; dydx: number; dydz: number } {
  const speed = Math.hypot(src.vx, src.vz)
  if (speed < WAKE_SPEED_LOW || src.weight <= 0) {
    return { y: 0, dydx: 0, dydz: 0 }
  }
  const dx = x - src.x
  const dz = z - src.z
  const hatX = src.vx / speed
  const hatZ = src.vz / speed
  const parallel = dx * hatX + dz * hatZ
  const behind = Math.max(-parallel, 0)
  if (behind <= 0) return { y: 0, dydx: 0, dydz: 0 }
  const perp = Math.abs(dx * hatZ - dz * hatX)

  const speedGate = smoothstep(WAKE_SPEED_LOW, WAKE_SPEED_HIGH, speed)
  const wakeWidth = behind * WAKE_HALF_ANGLE_TAN + WAKE_BASE_WIDTH

  // Two-piece signed profile across the V:
  //   inside V:  -cos(π · perp / wakeWidth)         // -1..+1
  //   outside V: 1 · max(0, 1 - (perp - wakeWidth) / halfwidth)  // fade 1→0
  // Combined via min/max so it's branchless-friendly for the shader.
  const insideArg = (Math.min(perp, wakeWidth) / wakeWidth) * Math.PI
  const insidePart = -Math.cos(insideArg) // varies -1 (perp=0) → +1 (perp=wakeWidth)
  const fadeOut = Math.max(0, 1 - Math.max(0, perp - wakeWidth) / WAKE_EDGE_BELL_HALFWIDTH)
  // For perp <= wakeWidth: insidePart∈[-1,1], fadeOut=1. profile = insidePart.
  // For perp > wakeWidth:  insidePart=1 (clamped),  fadeOut∈[0,1]. profile = fadeOut.
  const transverseSigned = insidePart * fadeOut

  const longRamp = 1 - Math.exp(-behind * WAKE_LONG_RAMP)
  const longDecay = Math.exp(-behind * WAKE_LONG_DECAY)
  // Transverse "scallops": the V's amplitude oscillates along its length.
  // sin(K · behind − ω · t) drifts backward in the bike's frame as t
  // advances (the pattern travels with the wake's tail).
  const longPhase = WAKE_TRANS_K * behind - WAKE_TRANS_OMEGA * t
  const transverseMod = 1 + WAKE_TRANS_AMP * Math.sin(longPhase)

  const amp = WAKE_DISP_AMP * speedGate * src.weight * longRamp * longDecay * transverseMod
  const y = amp * transverseSigned

  // Analytic gradient — dominated by the perp direction (the V shape) and
  // by the longitudinal decay (slow change with `behind`). The cross
  // terms involving ∂(longRamp·longDecay)/∂behind are small relative to
  // the perp slope at typical arcade scales; including them complicates
  // the shader without a visible payoff.
  //
  // d transverseSigned / d perp:
  //   inside V:  (π / wakeWidth) · sin(π · perp / wakeWidth)
  //   in fade:   -1 / EDGE_BELL_HALFWIDTH
  //   outside:   0
  let dProfileDPerp: number
  if (perp < wakeWidth) {
    dProfileDPerp = (Math.PI / wakeWidth) * Math.sin(insideArg)
  } else if (perp < wakeWidth + WAKE_EDGE_BELL_HALFWIDTH) {
    dProfileDPerp = -1 / WAKE_EDGE_BELL_HALFWIDTH
  } else {
    dProfileDPerp = 0
  }
  // ∂perp/∂x = sign(c) · hatZ, where c = dx·hatZ − dz·hatX.
  const c = dx * hatZ - dz * hatX
  const signC = c >= 0 ? 1 : -1
  const dPerpDx = signC * hatZ
  const dPerpDz = -signC * hatX
  const dydx = amp * dProfileDPerp * dPerpDx
  const dydz = amp * dProfileDPerp * dPerpDz
  return { y, dydx, dydz }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Surface y only — the cheap path used per-bike per-tick. */
export function sampleHeight(field: WaveFieldState, x: number, z: number): number {
  let y = field.baseY
  const t = field.time
  const cosB = Math.cos(field.waveBearing)
  const sinB = Math.sin(field.waveBearing)
  // Rotate sample coords by -bearing — equivalent to rotating each
  // per-wave direction by +bearing. Lets one global angle re-aim the
  // whole wave train without mutating per-wave dirX/dirZ.
  const xRot = x * cosB + z * sinB
  const zRot = -x * sinB + z * cosB
  if (field.kind === 'spectrum') {
    y += sampleSpectrumHeightFromModes(field.spectrum, xRot, zRot, t)
  } else {
    for (const w of field.waves) {
      const k = (2 * Math.PI) / w.wavelength
      const omega = w.speed * k
      const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
      y += w.amplitude * Math.sin(phase)
    }
  }
  for (const src of field.wakes) {
    y += sampleWakeFromSource(src, x, z, t).y
  }
  return y
}

/** Full sample including normal and ∂y/∂t. */
export function sampleSurface(field: WaveFieldState, x: number, z: number): WaveSample {
  let y = field.baseY
  // Slopes are accumulated in the ROTATED frame (using xRot/zRot
  // below), then rotated back to world frame via the inverse of the
  // input rotation so the returned dy/dx, dy/dz remain in world XZ.
  let rotDydx = 0
  let rotDydz = 0
  let vy = 0
  const t = field.time
  const cosB = Math.cos(field.waveBearing)
  const sinB = Math.sin(field.waveBearing)
  const xRot = x * cosB + z * sinB
  const zRot = -x * sinB + z * cosB
  if (field.kind === 'spectrum') {
    const surf = sampleSpectrumSurfaceFromModes(field.spectrum, xRot, zRot, t)
    y += surf.y
    rotDydx += surf.dydx
    rotDydz += surf.dydz
    vy += surf.vy
  } else {
    for (const w of field.waves) {
      const k = (2 * Math.PI) / w.wavelength
      const omega = w.speed * k
      const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
      const s = Math.sin(phase)
      const c = Math.cos(phase)
      y += w.amplitude * s
      rotDydx += w.amplitude * c * (k * w.dirX)
      rotDydz += w.amplitude * c * (k * w.dirZ)
      vy += w.amplitude * c * -omega
    }
  }
  // Convert rotated-frame slopes back to world frame.
  let dydx = rotDydx * cosB - rotDydz * sinB
  let dydz = rotDydx * sinB + rotDydz * cosB
  for (const src of field.wakes) {
    const wk = sampleWakeFromSource(src, x, z, t)
    y += wk.y
    dydx += wk.dydx
    dydz += wk.dydz
    // Wake's ∂y/∂t is small relative to swell; skip for buoyancy damping.
  }
  // Normal of y = f(x, z) is (−∂y/∂x, 1, −∂y/∂z), normalized.
  const nx = -dydx
  const ny = 1
  const nz = -dydz
  const len = Math.hypot(nx, ny, nz)
  return { y, nx: nx / len, ny: ny / len, nz: nz / len, vy }
}

/**
 * Default wave preset — a swell-plus-chop mix tuned to feel Wave-Race-y at
 * arcade speeds. Two long-period swells beat against each other so big
 * "sets" come in periodically (constructive interference around every ~30
 * seconds); the four chop bands fill in surface texture across multiple
 * scales (22 m down to 5.5 m).
 *
 * Each wave is unrolled into the vertex shader as a sin+cos pair, so the
 * count is a direct multiplier on per-vertex cost. Tests run headed (real
 * GPU) so we don't need to keep this as small as the headless WebGL2
 * software fallback would prefer.
 */
export function defaultWaves(): Wave[] {
  return [
    // Big swells — long wavelengths, low frequencies. These are what make
    // "the bigger waves show up periodically": their slightly different
    // periods (≈6.0 s and ≈7.7 s) beat against each other so peaks align
    // every ~25–30 s. Swell amplitudes unchanged from M9.26 — they drive
    // the periodic-set rhythm and bumping them risks the buoyancy field
    // throwing the bike around at race speeds.
    { dirX: 0.92, dirZ: 0.39, amplitude: 0.55, wavelength: 60, speed: 10.0, phase: 0.4 },
    { dirX: 0.6, dirZ: 0.8, amplitude: 0.4, wavelength: 85, speed: 11.0, phase: 2.2 },
    // Wind chop across four scales for varied surface texture. Amplitudes
    // bumped ~30% from the original [0.5, 0.34, 0.22, 0.12] in M9.34 so the
    // short-wavelength pinching from horizontal-displacement Gerstner reads
    // more dramatically — chop ridges visibly sharpen on the v2 shader,
    // and physical chop bumps the bike's hull probes by a noticeable
    // amount without overpowering the multi-probe averaging.
    { dirX: 1, dirZ: 0, amplitude: 0.65, wavelength: 22, speed: 4.0, phase: 0 },
    { dirX: 0.707, dirZ: 0.707, amplitude: 0.44, wavelength: 14, speed: 3.6, phase: 1.1 },
    { dirX: 0.3, dirZ: -0.954, amplitude: 0.29, wavelength: 9, speed: 3.0, phase: 2.3 },
    { dirX: -0.5, dirZ: 0.866, amplitude: 0.16, wavelength: 5.5, speed: 2.4, phase: 3.7 },
  ]
}
