import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { quatRotate } from '@/engine/sim/physics/vec'
import { RBHandle, RBHandleStore } from '@/game/components'
import { Racer, RacerStore } from '@/game/components/race'
import { gateFloatsOnWaves } from '@/game/tracks/gate-float'
import type { Track } from '@/game/tracks/types'

/**
 * Detect checkpoint crossings.
 *
 * Each tick: for every Racer, find the next checkpoint they need to cross,
 * compute the racer's offset from the gate plane, and check if they've
 * crossed it (signed distance flipped from + to -, AND landed inside the
 * gate's lateral extent).
 *
 * Track progress + lap counting ride on top of crossings.
 */
export type RaceEvents = {
  onCheckpoint?(eid: number, cpIndex: number, lap: number): void
  onLap?(eid: number, lap: number): void
  onFinish?(eid: number): void
}

/**
 * Monotonic race progress: `lap * checkpointCount + nextCheckpoint`. Higher
 * = further along. The single source of truth for ordering — both
 * `computeStandings` and `rubberBandSystem` consume it so the metric can
 * never drift between the HUD and the AI catch-up logic.
 */
export function raceProgress(
  racer: { lap: number; nextCheckpoint: number },
  track: { checkpoints: { length: number } },
): number {
  return racer.lap * track.checkpoints.length + racer.nextCheckpoint
}

/** A bike can't travel this far in one 60 Hz tick under its own power
 *  (top speed ≈ 28 m/s → ~0.5 m/tick). Larger per-tick jumps are warps:
 *  respawn after out-of-bounds, a multiplayer snapshot catch-up sweep
 *  after a packet gap, a recycled entity slot at race start. A warp's
 *  path crossing the gate plane is not a gate crossing — see the
 *  teleport handling below (docs/m10-11-state-sync.md §11). */
const TELEPORT_DIST_SQ = 5 * 5

export function createRaceSystem(track: Track, events: RaceEvents = {}) {
  // Per-eid memory of the previous-tick signed distance to the gate plane.
  const prevSigned = new Map<number, number>()
  // Per-eid previous-tick position — the teleport detector's memory.
  const prevPos = new Map<number, Vec3>()

  return function tick(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
    const eids = query(sim, [Racer, RBHandle])
    for (const eid of eids) {
      const racer = RacerStore.must(eid)
      const { handle } = RBHandleStore.must(eid)
      const rb = phys.world.getRigidBody(handle)
      if (!rb) continue

      racer.raceTime += dt
      RacerStore.set(eid, racer)

      if (racer.finished) continue

      const cp = track.checkpoints[racer.nextCheckpoint]
      if (!cp) continue

      const t = rb.translation()

      // Teleport guard: a super-physical jump since last tick invalidates
      // the prev-tick signed distance — without this, a warp whose
      // straight-line path happens to sweep through the gate plane scores
      // a phantom checkpoint (false positives observed with multiplayer
      // snapshot corrections; also covers OOB respawns).
      const lp = prevPos.get(eid)
      let teleported = false
      if (lp) {
        const jx = t.x - lp.x
        const jy = t.y - lp.y
        const jz = t.z - lp.z
        teleported = jx * jx + jy * jy + jz * jz > TELEPORT_DIST_SQ
        lp.x = t.x
        lp.y = t.y
        lp.z = t.z
      } else {
        prevPos.set(eid, { x: t.x, y: t.y, z: t.z })
      }

      const dx = t.x - cp.position.x
      const dy = t.y - cp.position.y
      const dz = t.z - cp.position.z

      // Gate's "forward" axis (the direction you cross in). Local +Z rotated by gate quat.
      const fwd = quatRotate(cp.rotation, { x: 0, y: 0, z: 1 })
      const right = quatRotate(cp.rotation, { x: 1, y: 0, z: 0 })

      const signed = dx * fwd.x + dy * fwd.y + dz * fwd.z
      const lateral = dx * right.x + dy * right.y + dz * right.z
      const vertical = dy // approximate — gate is upright

      const prev = prevSigned.get(eid)
      prevSigned.set(eid, signed)

      // Crossed = signed flipped from < 0 to >= 0 (player passes through gate
      // moving in +fwd direction). A teleport re-seeds `prevSigned` (the
      // set() above) without testing the flip.
      const crossed = !teleported && prev !== undefined && prev < 0 && signed >= 0
      const insideLaterally = Math.abs(lateral) < cp.halfWidth
      // Trigger extends 2× further below the gate origin than its original
      // tight box, so a bike skimming the water or briefly dipping below
      // the gate's base still registers the crossing. Slipping under was
      // a common bug — the player would pass between the pillars but at a
      // y the trigger rejected.
      let lowerBound = -3
      let upperBound = cp.height + 2
      if (gateFloatsOnWaves(track, cp)) {
        // The gate VISUAL bobs on the swell while this trigger plane stays
        // put, so widen the vertical window enough to catch a crossing at
        // any wave phase. Constant 4 m covers the wave envelope at every
        // shipped sea state (peak ambient crest ≈ 2 m at Beaufort 5 plus
        // zone multipliers); it used to scale off the per-track
        // `water.waveHeight`, a dead knob the wave field never read
        // (range 2.5–4 m across shipped tracks), now removed.
        const amp = 4
        lowerBound -= amp
        upperBound += amp
      }
      const insideVertically = vertical > lowerBound && vertical < upperBound

      if (crossed && insideLaterally && insideVertically) {
        const wasFirstCrossing = racer.checkpointsCrossed === 0
        const crossingFinishLine = cp.index === 0
        racer.checkpointsCrossed += 1
        racer.nextCheckpoint = (racer.nextCheckpoint + 1) % track.checkpoints.length
        // Stamp arrival time at this new progress level for the standings
        // tie-break (earlier arrival = ahead among equal-progress racers).
        racer.lastCheckpointTime = racer.raceTime

        // Lap completes when crossing the start/finish line (cp 0) AFTER the
        // first one (the first cp 0 crossing simply *starts* lap 1).
        let lapped = false
        if (crossingFinishLine && !wasFirstCrossing) {
          racer.lap += 1
          lapped = true
          if (racer.lap > track.lapsToFinish) {
            racer.finished = true
          }
        }
        RacerStore.set(eid, racer)

        // Callbacks fire AFTER the state is updated so listeners see the new
        // nextCheckpoint / lap. (Earlier ordering caused gate visuals to mark
        // the just-crossed gate as still "next" because the index was stale.)
        events.onCheckpoint?.(eid, cp.index, racer.lap)
        if (lapped) {
          events.onLap?.(eid, racer.lap)
          if (racer.finished) {
            events.onFinish?.(eid)
          }
        }
      }
    }
  }
}

/**
 * Distance from a racer's position to the next checkpoint along the gate's
 * forward axis. Used by the HUD to show "10m to next gate" or similar.
 */
export function distanceToNextCheckpoint(
  track: Track,
  racer: { nextCheckpoint: number },
  pos: Vec3,
): number {
  const cp = track.checkpoints[racer.nextCheckpoint]
  if (!cp) return 0
  return Math.hypot(pos.x - cp.position.x, pos.y - cp.position.y, pos.z - cp.position.z)
}
