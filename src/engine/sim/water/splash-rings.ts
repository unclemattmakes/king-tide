/**
 * Splash rings — deterministic event waves (water-next-research §7.5,
 * P4.1; Yuksel's wave-particles idea in its smallest shipped form, the
 * Uncharted/Hydro-Thunder lane: LOCAL, TRANSIENT, INTERACTIVE waves from
 * sim events, never the ambient sea).
 *
 * A hard water landing spawns an expanding ring ridge other riders can
 * SEE and FEEL: the sim owns a fixed pool; each ring is a closed-form
 * function of (x, z, t) — origin + birth time + amplitude — so CPU
 * buoyancy, the GPU vertex stage and the renderVertex mirror evaluate
 * the identical surface (uniform mirror like bikes/wakes/stamps; the
 * constants are drift-tested).
 *
 * Ring shape at age a = t − t0:
 *   R(a)   = SPLASH_RING_SPEED · a            (ring radius)
 *   spread = 1 / √(1 + R)                     (cylindrical energy spread)
 *   decay  = (1 − a/LIFE)²                    (smooth die-off)
 *   y      = amp · decay · spread · sech²((r − R)/WIDTH)
 *
 * Pool rules (the wake-trail discipline): fixed MAX_SPLASH_RINGS slots,
 * oldest slot reused when full; spawned only from fixed-step sim events
 * (hover landing detection), so identical inputs reproduce identical
 * rings. Deliberately NOT snapshotted — rings decay in ~4 s and
 * self-heal after a rollback/seek exactly like wake trails.
 *
 * Sim layer: pure math, no Three.js (ADR 0002).
 */

import type { WaveFieldState } from './wave-field'

/** Pool size — sizes the GPU uniform array (unrolled loop). 8 bikes
 *  landing twice in a ring's ~4 s life is the realistic ceiling. */
export const MAX_SPLASH_RINGS = 12
/** Ring expansion speed, m/s — reads as a heavy displacement wave. */
export const SPLASH_RING_SPEED = 7
/** sech² half-width of the ridge along the radius, metres. */
export const SPLASH_RING_WIDTH = 2.2
/** Full fade by this age (s); the slot is then reusable. */
export const SPLASH_RING_LIFE_S = 3.5
/** Minimum downward impact speed (m/s, relative to the surface) that
 *  spawns a ring — chop-skim touchdowns stay silent. */
export const SPLASH_RING_MIN_IMPACT = 3.0
/** Ring amplitude per m/s of impact beyond the minimum… */
export const SPLASH_RING_AMP_PER_MS = 0.06
/** …capped here (m). */
export const SPLASH_RING_AMP_MAX = 0.45

export type SplashRing = {
  x: number
  z: number
  /** Birth time on the field clock. */
  t0: number
  /** Peak ridge amplitude (m), impact-scaled. */
  amp: number
}

/**
 * Spawn a landing ring (fixed-step sim events only — determinism).
 * Gates on the impact threshold and scales amplitude by the excess;
 * reuses the oldest slot when the pool is full. No-op when the field's
 * splash strength is zero (the debug knob's kill switch).
 */
export function spawnSplashRing(
  field: WaveFieldState,
  x: number,
  z: number,
  impactSpeed: number,
): void {
  if (impactSpeed < SPLASH_RING_MIN_IMPACT) return
  if (field.splashRingStrength <= 0) return
  const amp = Math.min(
    SPLASH_RING_AMP_MAX,
    (impactSpeed - SPLASH_RING_MIN_IMPACT) * SPLASH_RING_AMP_PER_MS,
  )
  if (amp <= 0) return
  const rings = field.rings
  if (rings.length < MAX_SPLASH_RINGS) {
    rings.push({ x, z, t0: field.time, amp })
    return
  }
  let oldest = 0
  for (let i = 1; i < rings.length; i++) {
    if (rings[i]!.t0 < rings[oldest]!.t0) oldest = i
  }
  rings[oldest] = { x, z, t0: field.time, amp }
}

// Reused scratch (single-threaded synchronous callers — the _shore
// pattern).
const _rings = { y: 0, dydx: 0, dydz: 0, vy: 0 }

/**
 * Sum every live ring at world (x, z, t) into the returned scratch.
 * `strength` (the field's splashRingStrength) scales amplitude on BOTH
 * sides via the same scalar. vy is exact (ring motion + decay + spread
 * rates); slopes are the radial sech² gradient.
 */
export function sampleSplashRings(
  field: WaveFieldState,
  x: number,
  z: number,
  t: number,
): { y: number; dydx: number; dydz: number; vy: number } {
  _rings.y = 0
  _rings.dydx = 0
  _rings.dydz = 0
  _rings.vy = 0
  const rings = field.rings
  if (rings.length === 0 || field.splashRingStrength <= 0) return _rings
  for (const ring of rings) {
    const age = t - ring.t0
    if (age <= 0 || age >= SPLASH_RING_LIFE_S) continue
    const dx = x - ring.x
    const dz = z - ring.z
    const r = Math.hypot(dx, dz)
    const R = SPLASH_RING_SPEED * age
    const xi = (r - R) / SPLASH_RING_WIDTH
    if (xi < -6 || xi > 6) continue
    const lifeFrac = 1 - age / SPLASH_RING_LIFE_S
    const decay = lifeFrac * lifeFrac
    const spread = 1 / Math.sqrt(1 + R)
    const sech = 1 / Math.cosh(xi)
    const sech2 = sech * sech
    const tanh = Math.tanh(xi)
    const envelope = ring.amp * field.splashRingStrength * decay * spread
    _rings.y += envelope * sech2
    // Radial gradient: ∂y/∂r = envelope · (−2/W)·sech²·tanh; project on
    // the unit radial. r = 0 (dead center) has zero gradient by symmetry.
    if (r > 1e-6) {
      const dyDr = envelope * ((-2 / SPLASH_RING_WIDTH) * sech2 * tanh)
      _rings.dydx += (dyDr * dx) / r
      _rings.dydz += (dyDr * dz) / r
    }
    // ∂y/∂t — three exact terms: the ring expanding (ξ̇ = −Ṙ/W), the decay
    // rate, and the spread rate (Ṙ = SPEED).
    const dDecay = (-2 * lifeFrac) / SPLASH_RING_LIFE_S
    const dSpread = (-0.5 * SPLASH_RING_SPEED) / ((1 + R) * Math.sqrt(1 + R))
    _rings.vy +=
      ring.amp *
      field.splashRingStrength *
      (dDecay * spread * sech2 +
        decay * dSpread * sech2 +
        decay * spread * (2 / SPLASH_RING_WIDTH) * sech2 * tanh * SPLASH_RING_SPEED)
  }
  return _rings
}
