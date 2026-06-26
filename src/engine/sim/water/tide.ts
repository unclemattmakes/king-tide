/**
 * King-tide controller — a slow vertical offset on the base water height.
 *
 * The whole "King Tide" hook: the mean sea level breathes up and down over a
 * race, exposing reef/sandbar routes at low water and drowning them (and
 * floating beached props) at high water. This is a single scalar — the current
 * absolute water height — that BOTH consumers already read:
 *   • sim buoyancy / hover via `waveField.baseY` (sampleHeight starts there)
 *   • the water render via `waterMesh.mesh.position.y` (synced into the shader
 *     every frame), which carries shoaling + underwater tint with it.
 * So the runtime just assigns `tide.height` to both each frame; everything that
 * samples the surface (buoyancy, floating buoys, the gate bob) follows for free.
 *
 * Pure (no Three.js / Rapier / ECS) so it can live in the sim layer and be
 * unit-tested in isolation. The offset is a plain sine — `amplitudeM` either
 * side of the track's mean `water.height`, one full out→in→out cycle every
 * `periodS` seconds. A track with no `water.tide` (or amplitude 0) never moves,
 * so every existing track is byte-identical.
 */

/** Authored per-track tide spec (`track.water.tide`). Absent = no tide. */
export type TideConfig = {
  /** Peak vertical swing (m) above and below the mean `water.height`. The sea
   *  rises to `height + amplitudeM` and falls to `height − amplitudeM`. 0 = off. */
  amplitudeM: number
  /** Seconds for one full out→in→out cycle. Must be > 0. A race-length feel is
   *  ~90–180 s so a 3-lap run sees roughly one full breath. */
  periodS: number
  /** Where in the cycle the race starts, as a 0..1 fraction. 0 = mean level
   *  rising (default); 0.25 = full high tide; 0.75 = full low tide. */
  phase?: number
}

export type TideState = {
  /** The track's mean water height (`water.height`) — the swing is centred here. */
  readonly baseHeight: number
  readonly amplitudeM: number
  /** Angular frequency, rad/s (= 2π / periodS). */
  readonly omega: number
  /** Start phase in radians (= phase fraction × 2π). */
  readonly phase: number
  /** Elapsed tide clock (s). Advanced by `advanceTide`. */
  time: number
  /** Current absolute water height = baseHeight + amplitudeM·sin(ωt + phase). */
  height: number
}

export function createTide(baseHeight: number, cfg?: TideConfig): TideState {
  const amplitudeM = cfg?.amplitudeM ?? 0
  const periodS = cfg && cfg.periodS > 0 ? cfg.periodS : 1
  const phase = (cfg?.phase ?? 0) * Math.PI * 2
  const state: TideState = {
    baseHeight,
    amplitudeM,
    omega: (2 * Math.PI) / periodS,
    phase,
    time: 0,
    height: baseHeight,
  }
  // Seat `height` at the start phase so frame 0 (before the first advance)
  // already reads the authored opening level.
  state.height = baseHeight + amplitudeM * Math.sin(phase)
  return state
}

/** Advance the tide clock by `dt` seconds and return the new absolute height. */
export function advanceTide(t: TideState, dt: number): number {
  t.time += dt
  t.height = t.baseHeight + t.amplitudeM * Math.sin(t.omega * t.time + t.phase)
  return t.height
}

/** True when the tide actually moves (non-zero amplitude). Lets callers skip
 *  all per-frame work — and leave `baseY`/mesh untouched — on still-water tracks. */
export function tideActive(t: TideState): boolean {
  return t.amplitudeM !== 0
}
