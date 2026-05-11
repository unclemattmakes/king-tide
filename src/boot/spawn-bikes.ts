/**
 * Bike-spawn phase of boot. Two branches with deterministic order so
 * replay parity holds across the boundary:
 *
 *   - Live race: player first (slot 0), then up to NUM_AI bikes on
 *     the grid behind. The replay recorder downstream samples these
 *     in the same order.
 *   - Replay playback: one bike per slot from the recording, with the
 *     recorded variant's stats. They're not Racer-tagged or AI-tagged
 *     — pose comes from interpolated replay frames each tick.
 *
 * Returns the eids in the same shape `main.ts` previously held inline,
 * so downstream wiring (race system, recorder, debug API) doesn't shift.
 */

import type { ReplayFile } from '@/engine/replay/format'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { type BikeVariant, resolveBikeVariant } from '@/game/bikes/variants'
import { createBike } from '@/game/entities/bike'
import type { Track } from '@/game/tracks/types'
import { AI_GRID_SLOTS } from './grid-offsets'

/** Maximum number of AI opponents in a live race. The grid below has
 *  four slots; bumping this also requires extending `aiSlots`. */
export const NUM_AI = 4

/** Player-relative grid offsets for AI spawn positions. The straight
 *  is 28m wide (gate halfWidth × 2); AI bikes spread across ±6m and
 *  hold those lateral offsets via the spline `lineOffset` knob so they
 *  don't all converge on the same racing line.
 *
 *  Source of truth: `specs/grid-offsets.json`. The Blender addon's
 *  racer-at-start preview reads the same file, so the in-Blender
 *  preview matches the actual spawn layout. */
const AI_SLOTS = AI_GRID_SLOTS.map((s) => ({ dx: s.dx, dz: s.dz, off: s.lineOffset }))

export type SpawnBikesResult = {
  /** Always set. In replay mode this is the recording's slot-0 bike. */
  playerEid: number
  /** AI opponent eids. Empty in replay mode. */
  aiEids: number[]
  /** All bikes from the replay recording (slot 0 = player). Empty in
   *  live mode. The replay player writes per-frame poses into these. */
  replayBikeEids: number[]
}

export function spawnBikes(opts: {
  sim: SimWorld
  phys: PhysicsWorld
  track: Track
  /** Player's chosen variant. Ignored when `activeReplay` is present —
   *  the replay's slot-0 variantId wins so visuals match the recording. */
  playerVariant: BikeVariant
  /** Non-null = playback. The roster comes straight from the recording. */
  activeReplay: ReplayFile | null
}): SpawnBikesResult {
  const { sim, phys, track, playerVariant, activeReplay } = opts
  const startPos = track.start.position
  const aiEids: number[] = []
  const replayBikeEids: number[] = []
  let playerEid: number

  if (activeReplay) {
    if (activeReplay.bikes.length === 0) {
      throw new Error('spawnBikes: replay has no bikes')
    }
    activeReplay.bikes.forEach((b, i) => {
      const variant = resolveBikeVariant(b.variantId)
      const eid = createBike(sim, phys, {
        position: startPos,
        yaw: track.start.yaw,
        isPlayer: i === 0,
        asRacer: false,
        stats: {
          ...variant.stats,
          bodyColor: variant.bodyColor,
          variantId: variant.id,
        },
      })
      replayBikeEids.push(eid)
    })
    // Safe — guarded above. Slot 0 is the player by recording convention.
    playerEid = replayBikeEids[0] as number
  } else {
    playerEid = createBike(sim, phys, {
      position: startPos,
      yaw: track.start.yaw,
      isPlayer: true,
      // Slot 0 is the local human in single-player AND the room host's
      // own bike in multiplayer. Future remote-peer bikes get slot 1+.
      peerId: 0,
      asRacer: true,
      stats: {
        ...playerVariant.stats,
        bodyColor: playerVariant.bodyColor,
        variantId: playerVariant.id,
      },
    })

    const grid = AI_SLOTS.slice(0, NUM_AI)
    for (const slot of grid) {
      const aiEid = createBike(sim, phys, {
        position: { x: startPos.x + slot.dx, y: startPos.y, z: startPos.z + slot.dz },
        yaw: track.start.yaw,
        asRacer: true,
        ai: { splineId: 'main', lineOffset: slot.off },
      })
      aiEids.push(aiEid)
    }
  }

  return { playerEid, aiEids, replayBikeEids }
}
