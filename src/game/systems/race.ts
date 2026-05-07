import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { quatRotate } from '@/engine/sim/physics/vec'
import { RBHandle, RBHandleStore } from '@/game/components'
import { Racer, RacerStore } from '@/game/components/race'
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

export function createRaceSystem(track: Track, events: RaceEvents = {}) {
  // Per-eid memory of the previous-tick signed distance to the gate plane.
  const prevSigned = new Map<number, number>()

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
      // moving in +fwd direction).
      const crossed = prev !== undefined && prev < 0 && signed >= 0
      const insideLaterally = Math.abs(lateral) < cp.halfWidth
      const insideVertically = vertical > -1.5 && vertical < cp.height + 2

      if (crossed && insideLaterally && insideVertically) {
        events.onCheckpoint?.(eid, cp.index, racer.lap)

        const wasFirstCrossing = racer.checkpointsCrossed === 0
        const crossingFinishLine = cp.index === 0
        racer.checkpointsCrossed += 1
        racer.nextCheckpoint = (racer.nextCheckpoint + 1) % track.checkpoints.length

        // Lap completes when crossing the start/finish line (cp 0) AFTER the
        // first one (the first cp 0 crossing simply *starts* lap 1).
        if (crossingFinishLine && !wasFirstCrossing) {
          racer.lap += 1
          events.onLap?.(eid, racer.lap)
          if (racer.lap > track.lapsToFinish) {
            racer.finished = true
            events.onFinish?.(eid)
          }
        }
        RacerStore.set(eid, racer)
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
