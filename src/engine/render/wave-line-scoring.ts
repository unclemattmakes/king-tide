/**
 * Wave-line shimmer sample fan + pumpability scoring.
 *
 * Pure math, no Three.js — kept testable + replay-safe. The renderer in
 * `wave-line-shimmer.ts` calls `buildSampleFan` each frame to lay out a
 * grid of world-XZ points in front of the player, then asks the wave
 * field for each point's vertical surface velocity (vy) and pipes the
 * value through `scorePumpability` to get a 0..1 "how good a launch
 * would I get if I crossed this point right now" reading.
 *
 * Positive vy = water surface is rising → an approaching crest →
 * potential pump. Negative vy = water is dropping → trough side, no
 * lift. The renderer drives marker opacity / scale off this score.
 */

export type FanConfig = {
  /** Closest sample distance from the player (meters). Below this the
   *  shimmer would cover the bike. */
  minRange: number
  /** Furthest sample distance (meters). Above this the marker is too
   *  far ahead to be a useful guide at race speed. */
  maxRange: number
  /** Sample count along the forward axis between min and max. */
  samplesAlong: number
  /** Half-angle of the fan in radians. The fan covers ±halfAngle from
   *  the player's forward heading. */
  fanHalfAngleRad: number
  /** Sample count across the fan, at each along-range tier. 1 = a
   *  single forward ray; 3 = center + ±half-angle edges. */
  samplesAcross: number
}

export const DEFAULT_FAN_CONFIG: Readonly<FanConfig> = Object.freeze({
  minRange: 6,
  maxRange: 36,
  samplesAlong: 7,
  fanHalfAngleRad: 0.22, // ~12.6° each side, ~25° total spread
  samplesAcross: 3,
})

export type SampleSlot = {
  /** Index in the marker pool — stable across frames so renderers can
   *  rebind a mesh to the same slot when re-using buffers. */
  index: number
  /** World-X for this sample. */
  x: number
  /** World-Z for this sample. */
  z: number
}

/**
 * Build the per-frame sample list. The fan starts from `origin` and
 * extends along the forward direction (`fwdX`, `fwdZ`). Returns the
 * provided buffer (allocation-free) after re-populating slot 0..N-1.
 *
 * Total slot count is `samplesAlong * samplesAcross`. The forward
 * direction is assumed to be unit-length in the XZ plane; the function
 * normalizes defensively but caller responsibility is to feed a sane
 * heading.
 */
export function buildSampleFan(
  buffer: SampleSlot[],
  origin: { x: number; z: number },
  fwdX: number,
  fwdZ: number,
  config: FanConfig = DEFAULT_FAN_CONFIG,
): SampleSlot[] {
  const len = Math.hypot(fwdX, fwdZ)
  if (len < 1e-4) {
    // Degenerate input — caller should hide the shimmer. Keep buffer
    // shape stable by sitting all samples on the origin.
    for (let i = 0; i < buffer.length; i++) {
      const slotI = buffer[i]
      if (!slotI) continue
      slotI.x = origin.x
      slotI.z = origin.z
    }
    return buffer
  }
  const ux = fwdX / len
  const uz = fwdZ / len
  // Perpendicular in XZ (right-hand from forward): rotate 90° CW.
  const rx = uz
  const rz = -ux
  const { minRange, maxRange, samplesAlong, samplesAcross } = config
  const along = Math.max(1, samplesAlong)
  const across = Math.max(1, samplesAcross)
  const rangeStep = along === 1 ? 0 : (maxRange - minRange) / (along - 1)
  const acrossStep = across === 1 ? 0 : (2 * config.fanHalfAngleRad) / (across - 1)
  let slot = 0
  for (let i = 0; i < along; i++) {
    const range = minRange + i * rangeStep
    for (let j = 0; j < across; j++) {
      const angle = across === 1 ? 0 : -config.fanHalfAngleRad + j * acrossStep
      // Rotate the forward unit vector by `angle` in the XZ plane.
      const ca = Math.cos(angle)
      const sa = Math.sin(angle)
      const dirX = ux * ca + rx * sa
      const dirZ = uz * ca + rz * sa
      const s = buffer[slot++]
      if (!s) continue
      s.x = origin.x + dirX * range
      s.z = origin.z + dirZ * range
    }
  }
  return buffer
}

/** Allocate a fresh buffer sized for the given config. */
export function makeFanBuffer(config: FanConfig = DEFAULT_FAN_CONFIG): SampleSlot[] {
  const total = Math.max(1, config.samplesAlong) * Math.max(1, config.samplesAcross)
  const buf: SampleSlot[] = new Array(total)
  for (let i = 0; i < total; i++) buf[i] = { index: i, x: 0, z: 0 }
  return buf
}

/**
 * Map a surface vy reading to a 0..1 pumpability score.
 *
 * - vy ≤ 0      → 0 (water dropping / level, no lift available)
 * - 0 < vy < ceiling → vy / ceiling (linear ramp)
 * - vy ≥ ceiling → 1 (saturated)
 *
 * The ceiling matches the wave-pump detector's `vyCeiling` so the
 * forward-looking signal saturates on the same wave heights the
 * after-the-fact pump signal does — keeping the two cues calibrated.
 */
export function scorePumpability(vy: number, ceiling = 6): number {
  if (!Number.isFinite(vy) || vy <= 0 || ceiling <= 0) return 0
  if (vy >= ceiling) return 1
  return vy / ceiling
}
