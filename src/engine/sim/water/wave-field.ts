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

/** Peak vertical displacement of the wake oscillation, meters. */
export const WAKE_DISP_AMP = 0.32
/** Wake wavelength (meters between crests along the wake's axis). */
export const WAKE_DISP_WAVELENGTH = 3.5
/** Wake angular frequency, rad/s. Chosen so phase is roughly stationary in
 * world space when the bike moves at ~8 m/s — wakes left at typical race
 * speed look "set" in the water rather than scrolling backward with the
 * bike. */
export const WAKE_DISP_OMEGA = ((2 * Math.PI) / WAKE_DISP_WAVELENGTH) * 8
/** Speed at which the wake starts to appear (m/s). */
export const WAKE_SPEED_LOW = 1.5
/** Speed at which the wake reaches full strength (m/s). */
export const WAKE_SPEED_HIGH = 8.0
/** Tan of the V-wake half-angle (V opens at this rate behind the bike). */
export const WAKE_HALF_ANGLE_TAN = 0.4
/** Width of the V-wake at the bike before it widens behind, meters. */
export const WAKE_BASE_WIDTH = 0.55
/** Transverse feathering — softens the wake's outer edge across this many
 * meters past the V boundary. */
export const WAKE_TRANSVERSE_FEATHER = 1.2
/** Longitudinal ramp-in (1 / meters). Gives the wake a soft start so it
 * doesn't punch up directly under the bike. */
export const WAKE_LONG_RAMP = 0.6
/** Longitudinal decay (1 / meters). Wake fades to ~e^-1 at 1/this distance
 * behind the bike. 0.04 → e-folds at ~25 m. */
export const WAKE_LONG_DECAY = 0.04

const WAKE_K = (2 * Math.PI) / WAKE_DISP_WAVELENGTH

export function createWaveField(waves: Wave[]): WaveFieldState {
  return { waves, wakes: [], time: 0 }
}

export function advanceWaveField(field: WaveFieldState, dt: number): void {
  field.time += dt
}

/**
 * Wake displacement at (x, z) from a single source at time t. Returns 0 when
 * the source is in front, slow, or perpendicular to a non-V band.
 *
 * Mirrored bit-for-bit by the TSL shader's `wakeAt` block. Keep them in sync.
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
  // Transverse envelope: peak inside the V, fades over WAKE_TRANSVERSE_FEATHER
  // past the boundary.
  const transverse = 1 - smoothstep(wakeWidth, wakeWidth + WAKE_TRANSVERSE_FEATHER, perp)
  const longRamp = 1 - Math.exp(-behind * WAKE_LONG_RAMP)
  const longDecay = Math.exp(-behind * WAKE_LONG_DECAY)

  const amp = WAKE_DISP_AMP * speedGate * src.weight * transverse * longRamp * longDecay
  const phase = WAKE_K * behind - WAKE_DISP_OMEGA * t
  const s = Math.sin(phase)
  const c = Math.cos(phase)

  const y = amp * s
  // Approximate gradient: dominated by sin(phase) variation; the slowly-
  // varying envelope contributes a smaller cross-term we ignore. ∂phase/∂x
  // = k · ∂behind/∂x = -k · hatX (and similarly for z) when behind > 0.
  const dpdx = -WAKE_K * hatX
  const dpdz = -WAKE_K * hatZ
  const dydx = amp * c * dpdx
  const dydz = amp * c * dpdz
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
 * seconds), while the shorter chop fills in surface texture.
 */
export function defaultWaves(): Wave[] {
  return [
    // Big swells — long wavelengths, low frequencies. These are what make
    // "the bigger waves show up periodically": their slightly different
    // periods (≈6.0 s and ≈7.7 s) beat against each other so peaks align
    // every ~25–30 s.
    { dirX: 0.92, dirZ: 0.39, amplitude: 0.5, wavelength: 60, speed: 10.0, phase: 0.4 },
    { dirX: 0.6, dirZ: 0.8, amplitude: 0.36, wavelength: 85, speed: 11.0, phase: 2.2 },
    // Wind chop — original arcade preset, slightly trimmed to keep the
    // combined max in a sane range.
    { dirX: 1, dirZ: 0, amplitude: 0.5, wavelength: 22, speed: 4.0, phase: 0 },
    { dirX: 0.707, dirZ: 0.707, amplitude: 0.34, wavelength: 14, speed: 3.6, phase: 1.1 },
    { dirX: 0.3, dirZ: -0.954, amplitude: 0.22, wavelength: 9, speed: 3.0, phase: 2.3 },
    { dirX: -0.5, dirZ: 0.866, amplitude: 0.12, wavelength: 5.5, speed: 2.4, phase: 3.7 },
  ]
}
