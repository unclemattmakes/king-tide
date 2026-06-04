/**
 * Ambient breaking-crest spray driver.
 *
 * The water sheet already shades whitecaps + crest-foam on the GPU, but every
 * particle of spray in the game is keyed off a *bike* (foam wake, belly-flop
 * splash, plunge bubbles) or a *scripted* surge zone — so a wave that steepens
 * and breaks anywhere the player isn't does so silently and flatly, and the
 * ocean reads as a shaded rubber sheet. This driver closes that gap: it sweeps
 * a world-anchored lattice of sample points around the camera each frame, reads
 * the breaking-foam likelihood at each one (from the same wave field buoyancy
 * floats on), and fires a one-off spray burst the moment a crest breaks over a
 * cell — so the whole visible sea poofs at its crests, independent of the rider.
 *
 * Pure logic with its deps injected — a `sample(x, z)` probe and an
 * `emit(x, y, z, strength)` callback — so it unit-tests without Three.js, the
 * wave field, or a live particle system (mirrors `surge-spray.ts`). Render-only:
 * it never writes back to the sim, so it doesn't need to be deterministic for
 * netcode (it reads the camera, which already diverges between peers).
 *
 * The lattice is anchored to a fixed *world* grid (snapped to `spacing`), not to
 * the moving camera, so each cell's armed/fired hysteresis tracks a real point
 * on the sea: a crest sweeping through world space drives that point's foam up
 * (→ fire) then down (→ re-arm), giving exactly one poof per crest per spot.
 * Cells that fall outside the window as the camera moves are pruned.
 */

/** Per-sample probe result the driver consumes. `foam` is a pre-normalised
 *  breaking-likelihood in [0, 1] (the caller folds the wave field's slope +
 *  crest-height into it, mirroring the GPU whitecap recipe); `y` is the world
 *  surface height the spray should erupt from. */
export type CrestSpraySample = { y: number; foam: number }

export type WaveCrestSprayConfig = {
  /** Half-extent of the sampling window around the centre, metres. The window
   *  is a square of side `2·radius`; cells past it are not sampled. */
  radius?: number
  /** Lattice spacing between sample cells, metres. Smaller = denser spray but
   *  more `sample()` calls per frame (cost ∝ (2·radius / spacing)²). */
  spacing?: number
  /** Foam likelihood the rising edge must cross for a cell to fire. */
  fireThreshold?: number
  /** Foam likelihood a fired cell must fall back below to re-arm. Strictly
   *  below `fireThreshold` so a cell hovering at the fire level can't machine-
   *  gun bursts frame after frame. */
  rearmThreshold?: number
  /** Minimum seconds between two fires on the same cell — a floor under the
   *  hysteresis in case foam oscillates fast around the thresholds. */
  cooldownS?: number
  /** Cap on how many cells may fire in a single tick, so a swell breaking
   *  across the whole window at once can't dump the entire pool in one frame. */
  maxFiresPerTick?: number
}

export type WaveCrestSprayDriver = {
  /**
   * Sweep the lattice around world centre (`cx`, `cz`) at field clock `time`
   * and fire bursts on freshly-breaking cells.
   */
  tick(cx: number, cz: number, time: number): void
  /** Live cell count — for the headed-verify / perf introspection. */
  activeCells(): number
}

type CellState = {
  ix: number
  iz: number
  /** Ready to fire (foam has receded below the re-arm threshold since the
   *  last burst). */
  armed: boolean
  /** Foam likelihood last tick — drives the rising-edge test. */
  prevFoam: number
  /** Field-clock time of the last burst, for the cooldown floor. */
  lastFire: number
}

export function createWaveCrestSprayDriver(opts: {
  sample: (x: number, z: number) => CrestSpraySample
  emit: (x: number, y: number, z: number, strength: number) => void
  config?: WaveCrestSprayConfig
}): WaveCrestSprayDriver {
  const radius = opts.config?.radius ?? 72
  const spacing = opts.config?.spacing ?? 9
  const fireThreshold = opts.config?.fireThreshold ?? 0.55
  const rearmThreshold = opts.config?.rearmThreshold ?? 0.3
  const cooldownS = opts.config?.cooldownS ?? 0.5
  const maxFiresPerTick = opts.config?.maxFiresPerTick ?? 14

  // World-anchored hysteresis state keyed by integer lattice coords. Bounded
  // by the window size (~(2·radius/spacing)² entries); cells outside the
  // current window are pruned each tick so the map doesn't grow as the camera
  // travels the track.
  const cells = new Map<number, CellState>()
  // Pack (ix, iz) into one number key. Track coords stay well inside ±2^20
  // lattice units (≈ ±9 km at 9 m spacing), so the offset keeps keys unique
  // and collision-free without string allocation on the hot path.
  const keyOf = (ix: number, iz: number) => (ix + 0x100000) * 0x200000 + (iz + 0x100000)

  function tick(cx: number, cz: number, time: number): void {
    const ixMin = Math.ceil((cx - radius) / spacing)
    const ixMax = Math.floor((cx + radius) / spacing)
    const izMin = Math.ceil((cz - radius) / spacing)
    const izMax = Math.floor((cz + radius) / spacing)

    let fires = 0
    for (let ix = ixMin; ix <= ixMax; ix++) {
      const wx = ix * spacing
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = iz * spacing
        const s = opts.sample(wx, wz)
        const foam = s.foam < 0 ? 0 : s.foam > 1 ? 1 : s.foam
        const key = keyOf(ix, iz)
        let cell = cells.get(key)
        if (!cell) {
          // Seed already-armed but with prevFoam = current, so a cell that
          // scrolls into the window already mid-crest doesn't fire on its
          // first sight (no rising edge yet) — it waits for the next crest.
          cell = { ix, iz, armed: true, prevFoam: foam, lastFire: -Infinity }
          cells.set(key, cell)
          continue
        }
        if (
          cell.armed &&
          foam >= fireThreshold &&
          foam > cell.prevFoam &&
          time - cell.lastFire >= cooldownS &&
          fires < maxFiresPerTick
        ) {
          opts.emit(wx, s.y, wz, foam)
          cell.armed = false
          cell.lastFire = time
          fires++
        } else if (!cell.armed && foam <= rearmThreshold) {
          cell.armed = true
        }
        cell.prevFoam = foam
      }
    }

    // Prune cells that have left the window so the map stays bounded.
    if (cells.size > 0) {
      for (const cell of cells.values()) {
        if (cell.ix < ixMin || cell.ix > ixMax || cell.iz < izMin || cell.iz > izMax) {
          cells.delete(keyOf(cell.ix, cell.iz))
        }
      }
    }
  }

  return { tick, activeCells: () => cells.size }
}

/**
 * Fold a wave-field surface sample into a breaking-foam likelihood in [0, 1],
 * mirroring the GPU whitecap recipe in `water.ts` (`heightWhitecap ·
 * slopeWhitecap`): a crest only counts as breaking when it's both *tall* (a
 * real swell peak, not glassy chop) and *steep* (its face is pinching). Pulled
 * out as a pure helper so the same thresholds drive the particle layer and can
 * be unit-tested against synthetic slopes.
 *
 * `slope` is the surface gradient magnitude |∇y|; the caller derives it from
 * the sampled normal as `hypot(nx, nz) / ny`. `heightAboveBase` is the crest
 * height above the still-water line (`y − baseY`).
 */
export function breakingFoam(
  slope: number,
  heightAboveBase: number,
  cfg?: { slopeMin?: number; slopeFull?: number; crestMin?: number; crestFull?: number },
): number {
  const slopeMin = cfg?.slopeMin ?? 0.32
  const slopeFull = cfg?.slopeFull ?? 0.72
  const crestMin = cfg?.crestMin ?? 0.28
  const crestFull = cfg?.crestFull ?? 0.78
  const slopeGate = smoothstep(slopeMin, slopeFull, slope)
  const crestGate = smoothstep(crestMin, crestFull, heightAboveBase)
  const f = slopeGate * crestGate
  return f < 0 ? 0 : f > 1 ? 1 : f
}

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
