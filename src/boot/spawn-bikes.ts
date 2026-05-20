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

import { playerSettings } from '@/engine/player-settings'
import type { ReplayFile } from '@/engine/replay/format'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { type BikeVariant, resolveBikeVariant } from '@/game/bikes/variants'
import { RBHandleStore } from '@/game/components'
import { createBike } from '@/game/entities/bike'
import { createRider } from '@/game/entities/rider'
import type { Track } from '@/game/tracks/types'
import { AI_GRID_SLOTS, resolveGridSlotWorld } from './grid-offsets'

/** Maximum number of AI opponents in a live race. The grid is 2x4 — the
 *  player takes the pole position (slot 0), leaving seven AI slots. */
export const NUM_AI = AI_GRID_SLOTS.length

export type SpawnBikesResult = {
  /** Always set. In replay mode this is the recording's slot-0 bike. */
  playerEid: number
  /** AI opponent eids. Empty in replay mode or when `aiCount` is 0
   *  (Time Trial). */
  aiEids: number[]
  /** All bikes from the replay recording (slot 0 = player). Empty in
   *  live mode. The replay player writes per-frame poses into these. */
  replayBikeEids: number[]
  /** Optional Time Trial ghost — render-only, no physics. The ghost
   *  runner drives its Transform from a saved single-lap replay each
   *  frame. Null when no ghost was requested. */
  ghostEid: number | null
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
  /** Number of AI opponents to spawn (0..NUM_AI). Time Trial passes 0. */
  aiCount?: number
  /** When set, spawn a render-only ghost bike using this variant. The
   *  caller (main.ts) is responsible for installing a `GhostRunner`
   *  against the returned `ghostEid`. */
  ghostVariant?: BikeVariant | null
}): SpawnBikesResult {
  const { sim, phys, track, playerVariant, activeReplay, ghostVariant } = opts
  const aiCount = Math.max(0, Math.min(NUM_AI, opts.aiCount ?? NUM_AI))
  const startPos = track.start.position
  const aiEids: number[] = []
  const replayBikeEids: number[] = []
  let playerEid: number
  let ghostEid: number | null = null

  const startYaw = track.start.yaw
  const halfYaw = startYaw / 2
  const startQuat = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  }
  const spawnRider = (bikeEid: number, pos: { x: number; y: number; z: number }) => {
    const handle = RBHandleStore.get(bikeEid)
    if (!handle) return
    createRider(sim, phys, {
      bikeEid,
      bikeRbHandle: handle.handle,
      bikePos: pos,
      bikeRot: startQuat,
    })
  }

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
      spawnRider(eid, startPos)
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
    spawnRider(playerEid, startPos)

    const grid = AI_GRID_SLOTS.slice(0, aiCount)
    // Snapshot the difficulty at spawn time — changing the setting
    // mid-race won't retune already-spawned AIs (matches kart-game
    // precedent + avoids a sudden personality flip mid-lap).
    const difficulty = playerSettings.aiDifficulty
    for (const slot of grid) {
      const aiPos = resolveGridSlotWorld(startPos, startYaw, slot.dx, slot.dz)
      const aiEid = createBike(sim, phys, {
        position: aiPos,
        yaw: track.start.yaw,
        asRacer: true,
        ai: { splineId: 'main', lineOffset: slot.lineOffset, difficulty },
      })
      spawnRider(aiEid, aiPos)
      aiEids.push(aiEid)
    }

    if (ghostVariant) {
      // The ghost spawns at the start gate. The ghost runner will
      // overwrite its Transform on the first tick — the start pose
      // here just ensures it exists somewhere reasonable if the runner
      // hasn't been installed yet.
      ghostEid = createBike(sim, phys, {
        position: startPos,
        yaw: track.start.yaw,
        ghost: true,
        stats: {
          ...ghostVariant.stats,
          bodyColor: ghostVariant.bodyColor,
          variantId: ghostVariant.id,
        },
      })
    }
  }

  return { playerEid, aiEids, replayBikeEids, ghostEid }
}
