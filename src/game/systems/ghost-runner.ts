/**
 * Ghost runner — drives a render-only ghost bike entity from a
 * single-lap `ReplayPlayer` during a live race. Time Trial only.
 *
 * The ghost replay is a slice of the player's previous best lap
 * (`best-lap-slice.ts`), rebased to t=0. We tick the replay player off
 * the player's *current lap time* — not wall-clock — so a faster player
 * sees the ghost as a visible target that they're catching up to /
 * pulling away from. When the player crosses the finish line and
 * starts a new lap, the ghost seeks back to t=0 so it races every lap.
 *
 * If the ghost lap is shorter than the player's current lap, the
 * ghost reaches the end of its single-lap recording and freezes at
 * its final pose (visually: the ghost crossed the line first and is
 * waiting). When the player crosses too, the ghost re-arms at t=0.
 *
 * The runner writes directly into `TransformStore` for the ghost eid.
 * The ghost has no RigidBody (see `createBike({ ghost: true })`), so
 * `syncFromPhysics` skips it and our write survives to the next render.
 */

import type { ReplayFile } from '@/engine/replay/format'
import {
  createReplayPlayer,
  makePoseBuffer,
  type ReplayBikePose,
  type ReplayPlayer,
} from '@/engine/replay/player'
import { TransformStore } from '@/game/components'

export type GhostRunner = {
  /** Ghost ECS entity id. */
  readonly ghostEid: number
  /** Underlying replay player (exposed for tests / HUD delta readouts). */
  readonly player: ReplayPlayer
  /**
   * Advance the ghost by `dt` seconds. Pass the player's current lap
   * time so the runner can detect a fresh lap (lapTime regressing
   * toward 0) and re-arm the ghost. `arm` controls whether the ghost
   * moves at all — pre-countdown the race is locked so we hold the
   * ghost at its start pose.
   */
  tick(dt: number, playerLapTime: number, arm: boolean): void
  /** Seek the ghost back to its start. Used on respawn / restart. */
  reset(): void
}

export type CreateGhostRunnerOpts = {
  ghostEid: number
  ghostReplay: ReplayFile
}

export function createGhostRunner(opts: CreateGhostRunnerOpts): GhostRunner {
  const player = createReplayPlayer(opts.ghostReplay)
  const buf = makePoseBuffer(1)
  let prevLapTime = 0
  // Plant the ghost at the very first frame so the pre-countdown view
  // has it on the grid rather than at the world origin.
  player.paused = true
  player.seek(0)
  writeGhost(opts.ghostEid, player.sample.bind(player), buf)
  player.paused = false

  return {
    ghostEid: opts.ghostEid,
    player,
    tick(dt, playerLapTime, arm) {
      // Lap reset: lap time monotonically increases inside a lap; when
      // it drops we crossed the finish line. The `> 0.05` floor avoids
      // a spurious reset on the very first frame after spawn when
      // lapStartRaceTime hasn't been seeded yet.
      if (playerLapTime + 0.05 < prevLapTime) {
        player.seek(0)
      }
      prevLapTime = playerLapTime

      if (!arm) {
        // Race locked (pre-countdown). Hold the ghost at start.
        player.paused = true
        player.seek(0)
        writeGhost(opts.ghostEid, player.sample.bind(player), buf)
        return
      }

      player.paused = false
      // Drive replay time off the player's lap time — this is what
      // makes the ghost a meaningful pacing target.
      player.seek(playerLapTime)
      writeGhost(opts.ghostEid, player.sample.bind(player), buf)
      // Advance dt anyway so an external HUD can ask `player.time` for
      // a delta display. seek() above is authoritative for what gets
      // written to TransformStore; the tick() advances cursor state.
      player.tick(0, buf)
    },
    reset() {
      prevLapTime = 0
      player.seek(0)
      writeGhost(opts.ghostEid, player.sample.bind(player), buf)
    },
  }
}

function writeGhost(
  ghostEid: number,
  sample: (out: ReplayBikePose[]) => void,
  buf: ReplayBikePose[],
): void {
  sample(buf)
  const p = buf[0]
  if (!p) return
  TransformStore.set(ghostEid, {
    x: p.x,
    y: p.y,
    z: p.z,
    qx: p.qx,
    qy: p.qy,
    qz: p.qz,
    qw: p.qw,
  })
}
