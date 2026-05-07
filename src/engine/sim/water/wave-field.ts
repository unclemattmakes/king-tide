/**
 * Sum-of-sines Gerstner wave field. Pure math — no Three.js, runs in sim layer.
 *
 * The CPU sampler here is the source of truth for buoyancy. The render-side
 * water shader reads the SAME parameters and time so visuals match physics.
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
  time: number
}

export function createWaveField(waves: Wave[]): WaveFieldState {
  return { waves, time: 0 }
}

export function advanceWaveField(field: WaveFieldState, dt: number): void {
  field.time += dt
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
  // Normal of y = f(x, z) is (−∂y/∂x, 1, −∂y/∂z), normalized.
  const nx = -dydx
  const ny = 1
  const nz = -dydz
  const len = Math.hypot(nx, ny, nz)
  return { y, nx: nx / len, ny: ny / len, nz: nz / len, vy }
}

/**
 * Default wave preset — a swell-plus-chop mix tuned to feel Wave-Race-y at
 * arcade speeds. Tweak amplitudes for calmer/rougher seas.
 */
export function defaultWaves(): Wave[] {
  return [
    { dirX: 1, dirZ: 0, amplitude: 0.6, wavelength: 22, speed: 4.0, phase: 0 },
    { dirX: 0.707, dirZ: 0.707, amplitude: 0.42, wavelength: 14, speed: 3.6, phase: 1.1 },
    { dirX: 0.3, dirZ: -0.954, amplitude: 0.25, wavelength: 9, speed: 3.0, phase: 2.3 },
    { dirX: -0.5, dirZ: 0.866, amplitude: 0.14, wavelength: 5.5, speed: 2.4, phase: 3.7 },
  ]
}
