/**
 * Replays the missile + explosion tracks from a v2 replay file by
 * spawning short-lived ECS entities at the right times. Both the
 * render-side combat system (mesh display) and the FX system (missile
 * trail particles, explosion bursts) read straight from ECS, so once
 * we recreate the entities along their recorded path the visuals
 * "just work" without any FX-system changes.
 *
 * Lifecycle:
 *   • missile track — at `spawnT`, addEntity + MissileTag + MissileState
 *     with sampled position / velocity. Each tick we interpolate the
 *     sample window and update MissileState. At `endT`, if `detonated`
 *     we flip `MissileState.detonated = true` so combat-render fades
 *     the mesh and fx/index's per-eid burst dedup engages. The entity
 *     is removed one tick later.
 *   • explosion burst — at `t`, addEntity + ExplosionTag + ExplosionState
 *     with position + colour + lifetime. The render + FX systems own
 *     their own decay loops from there; we forget the eid.
 *
 * Seek handling — when the player's `time` jumps backwards (left-arrow
 * scrub), we wipe every entity we've spawned and re-arm the active set
 * by reseeding fired-marker indices. Without that, scrubbing past a
 * missile detonation would leave its entity orphaned.
 */

import { addComponent, addEntity, removeEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MissileState,
  MissileStateStore,
  MissileTag,
} from '@/game/components/combat'
import type { ReplayExplosion, ReplayFile, ReplayMissileTrack } from './format'

const SAMPLE_STRIDE = 7 // (t, px, py, pz, vx, vy, vz) per missile sample window
/** How long a detonated missile's entity sticks around so the trail
 *  particles in fx/index can finish fading. Matches the explosion
 *  default lifetime — empirically the trail tail is gone by then. */
const MISSILE_DETONATE_LINGER_S = 0.6

export type CombatReplayDriver = {
  /**
   * Advance to the given playback time, spawning / updating / despawning
   * combat entities as needed. Idempotent for the same `time`; safe to
   * call on every render frame.
   */
  syncTo(time: number): void
  /** Free every entity this driver has spawned. Called on exit. */
  dispose(): void
}

export type CreateCombatReplayDriverOpts = {
  sim: SimWorld
  replay: ReplayFile
}

export function createCombatReplayDriver(opts: CreateCombatReplayDriverOpts): CombatReplayDriver {
  const { sim, replay } = opts
  const missiles = replay.missiles
  const explosions = replay.explosions

  // Live state for each missile track. `eid` is null while the missile
  // hasn't spawned yet or has already despawned; non-null while the
  // entity is alive in the sim world.
  const activeMissiles = new Map<number, { eid: number; lingerUntil: number | null }>()
  // Indices of explosion bursts already spawned at or before the
  // current `time`. We use a high-water-mark cursor so the inner loop
  // is O(new bursts) per tick on normal forward playback.
  let explosionCursor = 0
  let lastTime = -Infinity

  function clearAllSpawnedEntities() {
    for (const { eid } of activeMissiles.values()) {
      removeEntity(sim, eid)
    }
    activeMissiles.clear()
  }

  function readMissileSampleAt(track: ReplayMissileTrack, time: number) {
    // Tracks are sampled at the same cadence as bikes; we linearly
    // interpolate inside the bracketing sample window for a clean
    // visual trail. SLERP-on-velocity isn't needed (velocity is a
    // vector, not a rotation) — straight LERP is correct.
    const samples = track.samples
    if (samples.length === 0) {
      return null
    }
    // Binary-bisect the t-column to find the bracket. The streams are
    // short (a missile lives ~1–2 s = ~30–60 samples) so a linear
    // scan would also work, but bisect keeps long flights cheap.
    let lo = 0
    let hi = (samples.length / SAMPLE_STRIDE) | 0
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      const midT = samples[mid * SAMPLE_STRIDE]!
      if (midT <= time) lo = mid
      else hi = mid
    }
    const i0 = lo * SAMPLE_STRIDE
    const i1 = Math.min(i0 + SAMPLE_STRIDE, samples.length - SAMPLE_STRIDE)
    const t0 = samples[i0]!
    const t1 = samples[i1]!
    const span = t1 - t0
    const u = span > 0 ? Math.max(0, Math.min(1, (time - t0) / span)) : 0
    return {
      x: samples[i0 + 1]! + (samples[i1 + 1]! - samples[i0 + 1]!) * u,
      y: samples[i0 + 2]! + (samples[i1 + 2]! - samples[i0 + 2]!) * u,
      z: samples[i0 + 3]! + (samples[i1 + 3]! - samples[i0 + 3]!) * u,
      vx: samples[i0 + 4]! + (samples[i1 + 4]! - samples[i0 + 4]!) * u,
      vy: samples[i0 + 5]! + (samples[i1 + 5]! - samples[i0 + 5]!) * u,
      vz: samples[i0 + 6]! + (samples[i1 + 6]! - samples[i0 + 6]!) * u,
    }
  }

  function spawnExplosionBurst(burst: ReplayExplosion) {
    const eid = addEntity(sim)
    addComponent(sim, eid, ExplosionTag)
    addComponent(sim, eid, ExplosionState)
    ExplosionStateStore.set(eid, {
      position: { x: burst.x, y: burst.y, z: burst.z },
      ageSec: 0,
      lifetime: burst.lifetime,
      color: burst.color,
    })
    // We don't track these — combat-render and fx/index drive their
    // own lifecycle once spawned, and the explosion-tick sim system
    // (which the live race uses) isn't ticked in replay. The render
    // system's per-eid pool will pool the entity until the mesh ages
    // out; the FX burst fires once via the explosionsBurst dedup Set.
  }

  function syncTo(time: number): void {
    // Detect a seek backwards (scrub). Wipe spawned entities and
    // re-arm the cursors so we don't end up with stale missiles in
    // flight at a moment they hadn't yet launched.
    if (time < lastTime) {
      clearAllSpawnedEntities()
      explosionCursor = 0
    }
    lastTime = time

    // Explosions — spawn every burst whose t ≤ time and that we
    // haven't yet emitted. Cheap monotonic cursor since the array is
    // recorded in t-order.
    while (explosionCursor < explosions.length) {
      const burst = explosions[explosionCursor]!
      if (burst.t > time) break
      spawnExplosionBurst(burst)
      explosionCursor += 1
    }

    // Missiles — for each track, either spawn it (just entered its
    // alive window), update it (still alive), or despawn it (passed
    // endT plus linger). Tracks are kept in spawn-time order at
    // finalize, so we could early-out, but the count is small
    // (<10 per race typically) so the linear scan is fine.
    for (const track of missiles) {
      const alive = time >= track.spawnT && time < track.endT
      const lingering = time >= track.endT
      const active = activeMissiles.get(track.id)

      if (alive) {
        const sample = readMissileSampleAt(track, time)
        if (!sample) continue
        if (!active) {
          const eid = addEntity(sim)
          addComponent(sim, eid, MissileTag)
          addComponent(sim, eid, MissileState)
          MissileStateStore.set(eid, {
            ownerEid: -1, // replay doesn't preserve owner; cosmetic only
            targetEid: -1,
            position: { x: sample.x, y: sample.y, z: sample.z },
            velocity: { x: sample.vx, y: sample.vy, z: sample.vz },
            ageSec: time - track.spawnT,
            detonated: false,
          })
          activeMissiles.set(track.id, { eid, lingerUntil: null })
        } else {
          const ms = MissileStateStore.get(active.eid)
          if (ms) {
            ms.position.x = sample.x
            ms.position.y = sample.y
            ms.position.z = sample.z
            ms.velocity.x = sample.vx
            ms.velocity.y = sample.vy
            ms.velocity.z = sample.vz
            ms.ageSec = time - track.spawnT
            ms.detonated = false
          }
        }
      } else if (lingering && active) {
        if (active.lingerUntil === null) {
          // Just entered the post-detonation linger. Flip detonated so
          // the FX system stops emitting new trail particles for this
          // missile, mark the despawn moment, and pin position at the
          // recorded detonation point if we have one.
          const ms = MissileStateStore.get(active.eid)
          if (ms) {
            ms.detonated = track.detonated
            if (track.detonatedAt) {
              ms.position.x = track.detonatedAt[0]
              ms.position.y = track.detonatedAt[1]
              ms.position.z = track.detonatedAt[2]
            }
          }
          active.lingerUntil = track.endT + MISSILE_DETONATE_LINGER_S
        }
        if (active.lingerUntil !== null && time >= active.lingerUntil) {
          removeEntity(sim, active.eid)
          activeMissiles.delete(track.id)
        }
      } else if (!alive && active) {
        // Seek pulled us back before this missile's spawn window —
        // tear it down so it'll respawn cleanly on the next forward
        // pass through `spawnT`.
        removeEntity(sim, active.eid)
        activeMissiles.delete(track.id)
      }
    }
  }

  return {
    syncTo,
    dispose() {
      clearAllSpawnedEntities()
    },
  }
}
