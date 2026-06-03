/**
 * Out-of-bounds detection + escalation state machine (sim layer, deterministic,
 * no Three.js). Runs for the local player's bike only. Writes the
 * `OutOfBounds` component; the loop/render layer reflects it (warning popup,
 * autopilot handoff, shark cutscene) and owns the lethal resolution.
 *
 * Boundary model — decision #1/#2 in docs/out-of-bounds-design.md: a single
 * **leash** measured as the 3D distance from the bike to the nearest sample on
 * the racing line. The soft wall sits at 1.5x the per-track corridor
 * half-width (the buoy placement distance); the hard wall at 2.5x.
 */

import { addComponent, hasComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { PlayerTag, RBHandle, RBHandleStore } from '@/game/components'
import type { OutOfBoundsData } from '@/game/components/out-of-bounds'
import { initialOob, OutOfBounds, OutOfBoundsStore } from '@/game/components/out-of-bounds'
import { Racer, RacerStore } from '@/game/components/race'
import type { Track } from '@/game/tracks/types'
import {
  BRACE_S,
  DEFAULT_CORRIDOR_HALF_WIDTH_M,
  HARD_LEASH_MULT,
  INWARD_SMOOTH,
  MIN_CORRIDOR_HALF_WIDTH_M,
  NEAR_MISS_LOOKAHEAD_S,
  NEAR_MISS_MIN_INWARD_SPEED,
  REENTRY_FRAC,
  SOFT_LEASH_MULT,
} from './oob-tuning'

/** Config threaded from the loop (derived from player settings + the track).
 *  Kept out of the component so the sim stays a pure function of its inputs. */
export type OobConfig = {
  /** Master gate. When false the system no-ops (Settings → Off, or modes that
   *  opt out: multiplayer, tutorial, attract). */
  enabled: boolean
  /** WARN-phase grace seconds before escalation (the adjustable timing). */
  graceS: number
}

export type Leash = { soft: number; hard: number; points: readonly Vec3[] }

const LEASH_CACHE = new WeakMap<Track, Leash | null>()

function mainSpline(track: Track) {
  return track.aiSplines.find((s) => s.id === 'main') ?? track.aiSplines[0]
}

/** Median of a numeric array (sorted copy; does not mutate the input). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/**
 * Corridor half-width (m) = the buoys' median XZ distance to the racing line —
 * the buoys are the channel walls (art-pass playbook §4). Falls back to a
 * default for buoy-less tracks and is floored so a freak tight cluster can't
 * make the leash punishing. Pure + exported for unit tests.
 */
export function corridorHalfWidth(buoys: readonly Vec3[], points: readonly Vec3[]): number {
  if (points.length < 2) return DEFAULT_CORRIDOR_HALF_WIDTH_M
  const dists: number[] = []
  for (const b of buoys) {
    let best = Number.POSITIVE_INFINITY
    for (const p of points) {
      const dx = p.x - b.x
      const dz = p.z - b.z
      const d2 = dx * dx + dz * dz
      if (d2 < best) best = d2
    }
    dists.push(Math.sqrt(best))
  }
  const hw = dists.length > 0 ? median(dists) : DEFAULT_CORRIDOR_HALF_WIDTH_M
  return hw >= MIN_CORRIDOR_HALF_WIDTH_M ? hw : MIN_CORRIDOR_HALF_WIDTH_M
}

/** Compute (and cache) the soft / hard leash for a track. Null when the track
 *  has no usable racing line. */
export function leashFor(track: Track): Leash | null {
  const cached = LEASH_CACHE.get(track)
  if (cached !== undefined) return cached
  const spline = mainSpline(track)
  if (!spline || spline.points.length < 2) {
    LEASH_CACHE.set(track, null)
    return null
  }
  const buoys: Vec3[] = []
  for (const p of track.props) {
    if (p.assetId === 'buoy') buoys.push(p.position)
  }
  const hw = corridorHalfWidth(buoys, spline.points)
  const leash: Leash = {
    soft: hw * SOFT_LEASH_MULT,
    hard: hw * HARD_LEASH_MULT,
    points: spline.points,
  }
  LEASH_CACHE.set(track, leash)
  return leash
}

/** 3D distance from (x,y,z) to the nearest sample on the racing line. Exported
 *  for unit tests. */
export function distToLine3D(points: readonly Vec3[], x: number, y: number, z: number): number {
  let best = Number.POSITIVE_INFINITY
  for (const p of points) {
    const dx = p.x - x
    const dy = p.y - y
    const dz = p.z - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

function enterBrace(oob: OutOfBoundsData): void {
  oob.phase = 'brace'
  oob.braceRemaining = BRACE_S
}

/**
 * Advance the escalation state machine one tick for the given distance. Pure
 * mutation of `oob` (+ `racer.forfeited`) so unit tests can drive it directly
 * with a synthetic distance sequence. The loop owns the 'lethal' resolution —
 * while in 'lethal' this is a no-op until `resolveOob` is called.
 */
export function stepOob(
  oob: OutOfBoundsData,
  dist: number,
  dt: number,
  graceS: number,
  leash: { soft: number; hard: number },
  racer: { forfeited: boolean },
): void {
  oob.softLeash = leash.soft
  oob.hardLeash = leash.hard
  const prev = oob.distance
  oob.distance = dist
  if (dt > 0) {
    const inst = (prev - dist) / dt
    oob.inwardSpeed += (inst - oob.inwardSpeed) * INWARD_SMOOTH
  }

  switch (oob.phase) {
    case 'lethal':
      return
    case 'in':
      if (dist > leash.hard) {
        racer.forfeited = true
        enterBrace(oob)
      } else if (dist > leash.soft) {
        racer.forfeited = true
        oob.phase = 'warn'
        oob.graceRemaining = graceS
      }
      return
    case 'warn':
      if (dist < leash.soft * REENTRY_FRAC) {
        oob.phase = 'in'
        oob.graceRemaining = 0
      } else if (dist > leash.hard) {
        enterBrace(oob)
      } else {
        oob.graceRemaining -= dt
        if (oob.graceRemaining <= 0) enterBrace(oob)
      }
      return
    case 'brace': {
      oob.braceRemaining -= dt
      if (oob.braceRemaining > 0) return
      // Last-chance recovery: closing on the line fast enough (or already
      // back inside the soft wall) turns the attack into a near-miss.
      const projected = dist - oob.inwardSpeed * NEAR_MISS_LOOKAHEAD_S
      const recovering =
        oob.inwardSpeed >= NEAR_MISS_MIN_INWARD_SPEED &&
        (dist < leash.soft || projected < leash.soft)
      oob.lethalKind = recovering ? 'nearmiss' : 'hit'
      oob.phase = 'lethal'
      oob.lethalTriggeredThisTick = true
      return
    }
  }
}

/** Reset to 'in' after the loop has handled a lethal resolution. */
export function resolveOob(oob: OutOfBoundsData): void {
  oob.phase = 'in'
  oob.graceRemaining = 0
  oob.braceRemaining = 0
  oob.inwardSpeed = 0
  oob.lethalKind = null
  oob.lethalTriggeredThisTick = false
}

export function outOfBoundsSystem(
  sim: SimWorld,
  phys: PhysicsWorld,
  track: Track,
  dt: number,
  config: OobConfig,
): void {
  if (!config.enabled) return
  const eids = query(sim, [PlayerTag, RBHandle, Racer])
  if (eids.length === 0) return
  const leash = leashFor(track)
  if (!leash) return

  for (const eid of eids) {
    if (!hasComponent(sim, eid, OutOfBounds)) {
      addComponent(sim, eid, OutOfBounds)
      OutOfBoundsStore.set(eid, initialOob())
    }
    const oob = OutOfBoundsStore.must(eid)
    const racer = RacerStore.must(eid)

    // Finished racers are immune — never yank a player who already crossed.
    if (racer.finished) {
      if (oob.phase !== 'in') resolveOob(oob)
      continue
    }
    // The loop owns the lethal resolution; hold until it calls resolveOob.
    if (oob.phase === 'lethal') continue

    const rbh = RBHandleStore.get(eid)
    if (!rbh) continue
    const rb = phys.world.getRigidBody(rbh.handle)
    if (!rb) continue
    const t = rb.translation()
    const dist = distToLine3D(leash.points, t.x, t.y, t.z)
    stepOob(oob, dist, dt, config.graceS, leash, racer)
  }
}
