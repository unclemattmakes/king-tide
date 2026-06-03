/**
 * Surge-triggered spray driver.
 *
 * Wave zones can carry a periodic half-sine *surge* (`surgePeriodS` +
 * `surgeAmplitude`, see `sim/water/wave-field.ts`) — the timed "launch wave"
 * that powers set-pieces like The Maw. This driver fires a one-off particle
 * burst from the water-spray emitters sitting inside a surge zone each time
 * that zone's surge rises through a peak, so the crown/breaker spray visibly
 * "fires harder on the big swell" instead of emitting at a flat rate.
 *
 * Pure logic with its deps injected (emitter positions, a `triggerBurst`
 * callback) so it unit-tests without Three.js or a live particle system.
 * Wired up in `src/main.ts` next to the particle-system tick.
 */

export type SurgeZoneSpec = {
  /** Zone centre, world XZ. */
  x: number
  z: number
  /** Association radius — emitters within this of the centre are driven by
   *  this zone's surge. Typically `max(halfWidth, halfDepth) + blendRadius`. */
  radius: number
  /** Surge period (s) and peak amplitude (m), from the wave zone. */
  periodS: number
  amplitude: number
}

export type SprayEmitterSpec = { name: string; x: number; z: number }

export type SurgeSprayDriver = {
  /** Advance using the deterministic wave-field clock (seconds). */
  tick(timeSeconds: number): void
}

/** Surge level (m) of a zone at `time`, mirroring `wave-field.ts`'s
 *  `surge = amplitude · max(0, sin(2π·t / period))`. */
function surgeLevel(zone: SurgeZoneSpec, time: number): number {
  if (!(zone.periodS > 0) || !(zone.amplitude > 0)) return 0
  return zone.amplitude * Math.max(0, Math.sin((2 * Math.PI * time) / zone.periodS))
}

export function createSurgeSprayDriver(opts: {
  zones: readonly SurgeZoneSpec[]
  emitters: readonly SprayEmitterSpec[]
  triggerBurst: (name: string, count: number) => void
  /** Surge level (fraction of amplitude) the rising edge must reach to fire. */
  fireFraction?: number
  /** Surge level (fraction of amplitude) the trough must fall below to re-arm. */
  rearmFraction?: number
  /** Particles per burst per emitter. */
  burstCount?: number
}): SurgeSprayDriver {
  const fireFrac = opts.fireFraction ?? 0.72
  const rearmFrac = opts.rearmFraction ?? 0.3
  const burst = opts.burstCount ?? 18

  // Associate each surge zone with the spray emitters inside its radius once,
  // up front (state folded in). Zones with no emitters / no surge are dropped.
  const bound = opts.zones
    .map((zone) => ({
      zone,
      names: opts.emitters
        .filter((e) => Math.hypot(e.x - zone.x, e.z - zone.z) <= zone.radius)
        .map((e) => e.name),
      prevSurge: 0,
      armed: true,
    }))
    .filter((b) => b.names.length > 0 && b.zone.periodS > 0 && b.zone.amplitude > 0)

  return {
    tick(time: number) {
      for (const b of bound) {
        const s = surgeLevel(b.zone, time)
        const fire = fireFrac * b.zone.amplitude
        const rearm = rearmFrac * b.zone.amplitude
        if (b.armed && s >= fire && s > b.prevSurge) {
          for (const name of b.names) opts.triggerBurst(name, burst)
          b.armed = false
        } else if (!b.armed && s <= rearm) {
          b.armed = true
        }
        b.prevSurge = s
      }
    },
  }
}
