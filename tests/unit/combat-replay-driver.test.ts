/**
 * Verifies that the combat replay driver spawns / updates / despawns
 * missile and explosion ECS entities from a v2 replay file's combat
 * tracks. The render + FX systems read straight from ECS, so once the
 * entities are present they light up automatically — the driver's job
 * is exactly the entity lifecycle.
 */

import { query } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createCombatReplayDriver } from '../../src/engine/replay/combat-replay-driver'
import {
  REPLAY_VERSION,
  type ReplayFile,
  type ReplayMissileTrack,
} from '../../src/engine/replay/format'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MissileState,
  MissileStateStore,
  MissileTag,
} from '../../src/game/components/combat'

function emptyReplayFile(overrides: Partial<ReplayFile> = {}): ReplayFile {
  return {
    version: REPLAY_VERSION,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon',
      recordedAt: '2026-05-28T00:00:00.000Z',
      durationSeconds: 10,
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'Racer',
        bodyColor: 0xff0000,
      },
    ],
    sampleRateHz: 30,
    frames: [],
    events: [],
    missiles: [],
    explosions: [],
    isLegacyV1: false,
    ...overrides,
  }
}

function makeMissileTrack(
  id: number,
  spawnT: number,
  endT: number,
  startPos: [number, number, number],
  endPos: [number, number, number],
  detonated = true,
): ReplayMissileTrack {
  // Two-sample track: just spawn + end so interpolation has a clear
  // bracket to LERP across.
  const [sx, sy, sz] = startPos
  const [ex, ey, ez] = endPos
  return {
    id,
    spawnT,
    endT,
    detonated,
    detonatedAt: detonated ? endPos : null,
    samples: [
      spawnT,
      sx,
      sy,
      sz,
      ex - sx,
      ey - sy,
      ez - sz,
      endT,
      ex,
      ey,
      ez,
      ex - sx,
      ey - sy,
      ez - sz,
    ],
  }
}

describe('combat replay driver', () => {
  it('spawns no entities before a missile track starts', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      missiles: [makeMissileTrack(0, 5, 7, [0, 0, 0], [10, 0, 0])],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(4.9)
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(0)
  })

  it('spawns a MissileTag entity while the track is alive and interpolates position', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      missiles: [makeMissileTrack(0, 5, 7, [0, 0, 0], [10, 0, 0])],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(6) // halfway through
    const eids = query(sim, [MissileTag, MissileState])
    expect(eids).toHaveLength(1)
    const ms = MissileStateStore.get(eids[0]!)!
    expect(ms.position.x).toBeCloseTo(5, 5)
    expect(ms.detonated).toBe(false)
  })

  it('flips MissileState.detonated and despawns after the linger window', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      missiles: [makeMissileTrack(0, 0, 1, [0, 0, 0], [10, 0, 0], true)],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(0.5) // alive
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(1)
    driver.syncTo(1.2) // post-end, mid-linger
    const lingering = query(sim, [MissileTag, MissileState])
    expect(lingering).toHaveLength(1)
    expect(MissileStateStore.get(lingering[0]!)?.detonated).toBe(true)
    driver.syncTo(2) // past linger (~0.6s default)
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(0)
  })

  it('spawns explosion entities at the recorded burst time', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      explosions: [{ t: 2.5, x: 1, y: 2, z: 3, color: 0xff5577, lifetime: 0.6 }],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(2.4)
    expect(query(sim, [ExplosionTag, ExplosionState])).toHaveLength(0)
    driver.syncTo(2.6)
    const eids = query(sim, [ExplosionTag, ExplosionState])
    expect(eids).toHaveLength(1)
    const ex = ExplosionStateStore.get(eids[0]!)!
    expect(ex.position.x).toBe(1)
    expect(ex.color).toBe(0xff5577)
  })

  it('clears spawned missiles when playback seeks backwards', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      missiles: [makeMissileTrack(0, 1, 3, [0, 0, 0], [10, 0, 0])],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(2) // alive
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(1)
    driver.syncTo(0.5) // backwards seek — before spawn
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(0)
  })

  it('dispose() removes any in-flight missile entities', () => {
    const sim = createSimWorld({ seed: 0 })
    const replay = emptyReplayFile({
      missiles: [makeMissileTrack(0, 0, 5, [0, 0, 0], [10, 0, 0])],
    })
    const driver = createCombatReplayDriver({ sim, replay })
    driver.syncTo(2)
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(1)
    driver.dispose()
    expect(query(sim, [MissileTag, MissileState])).toHaveLength(0)
  })
})
