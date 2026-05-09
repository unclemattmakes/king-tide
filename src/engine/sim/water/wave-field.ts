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

export type WaveFieldState = {
  waves: Wave[]
  /** Live wake sources — refreshed each fixed step before hoverSystem reads
   * the surface for buoyancy. Empty by default. */
  wakes: WakeSource[]
  time: number
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

export function createWaveField(waves: Wave[]): WaveFieldState {
  return { waves, wakes: [], time: 0 }
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
 * Static profile (no longitudinal sin) — the V follows the bike like a
 * stable shape and just decays in amplitude with `behind`. Real wakes
 * have transverse waves too, but for arcade clarity a clean Kelvin-style
 * V reads better than oscillating ridges.
 *
 * Mirrored bit-for-bit by the TSL shader's bikeSurfaceContrib block —
 * keep them in sync.
 */
export function sampleWakeFromSource(
  src: WakeSource,
  x: number,
  z: number,
  _t: number,
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
  const fadeOut = Math.max(
    0,
    1 - Math.max(0, perp - wakeWidth) / WAKE_EDGE_BELL_HALFWIDTH,
  )
  // For perp <= wakeWidth: insidePart∈[-1,1], fadeOut=1. profile = insidePart.
  // For perp > wakeWidth:  insidePart=1 (clamped),  fadeOut∈[0,1]. profile = fadeOut.
  const transverseSigned = insidePart * fadeOut

  const longRamp = 1 - Math.exp(-behind * WAKE_LONG_RAMP)
  const longDecay = Math.exp(-behind * WAKE_LONG_DECAY)

  const amp = WAKE_DISP_AMP * speedGate * src.weight * longRamp * longDecay
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
  let y = 0
  const t = field.time
  for (const w of field.waves) {
    const k = (2 * Math.PI) / w.wavelength
    const omega = w.speed * k
    const phase = k * (w.dirX * x + w.dirZ * z) - omega * t + w.phase
    y += w.amplitude * Math.sin(phase)
  }
  for (const src of field.wakes) {
    y += sampleWakeFromSource(src, x, z, t).y
  }
  return y
}

/** Full sample including normal and ∂y/∂t. */
export function sampleSurface(field: WaveFieldState, x: number, z: number): WaveSample {
  let y = 0
  let dydx = 0
  let dydz = 0
  let vy = 0
  const t = field.time
  for (const w of field.waves) {
    const k = (2 * Math.PI) / w.wavelength
    const omega = w.speed * k
    const phase = k * (w.dirX * x + w.dirZ * z) - omega * t + w.phase
    const s = Math.sin(phase)
    const c = Math.cos(phase)
    y += w.amplitude * s
    dydx += w.amplitude * c * (k * w.dirX)
    dydz += w.amplitude * c * (k * w.dirZ)
    vy += w.amplitude * c * -omega
  }
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
    // every ~25–30 s.
    { dirX: 0.92, dirZ: 0.39, amplitude: 0.55, wavelength: 60, speed: 10.0, phase: 0.4 },
    { dirX: 0.6, dirZ: 0.8, amplitude: 0.4, wavelength: 85, speed: 11.0, phase: 2.2 },
    // Wind chop across four scales for varied surface texture.
    { dirX: 1, dirZ: 0, amplitude: 0.5, wavelength: 22, speed: 4.0, phase: 0 },
    { dirX: 0.707, dirZ: 0.707, amplitude: 0.34, wavelength: 14, speed: 3.6, phase: 1.1 },
    { dirX: 0.3, dirZ: -0.954, amplitude: 0.22, wavelength: 9, speed: 3.0, phase: 2.3 },
    { dirX: -0.5, dirZ: 0.866, amplitude: 0.12, wavelength: 5.5, speed: 2.4, phase: 3.7 },
  ]
}
