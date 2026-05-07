import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { Racer, RacerStore } from '@/game/components/race'
import type { Track } from '@/game/tracks/types'

export type Standing = {
  eid: number
  position: number // 1 = first place
  lap: number
  nextCheckpoint: number
  finished: boolean
  raceTime: number
}

/**
 * Sort all racers by progress (descending) and return rank-ordered standings.
 * Progress = lap * N + nextCheckpoint. Ties broken by raceTime (earlier = better).
 */
export function computeStandings(sim: SimWorld, track: Track): Standing[] {
  const eids = query(sim, [Racer])
  const N = track.checkpoints.length
  const list = Array.from(eids).map((eid) => {
    const r = RacerStore.must(eid)
    return {
      eid,
      lap: r.lap,
      nextCheckpoint: r.nextCheckpoint,
      finished: r.finished,
      raceTime: r.raceTime,
      _progress: r.lap * N + r.nextCheckpoint,
    }
  })
  list.sort((a, b) => {
    if (b._progress !== a._progress) return b._progress - a._progress
    return a.raceTime - b.raceTime
  })
  return list.map((entry, i) => ({
    eid: entry.eid,
    position: i + 1,
    lap: entry.lap,
    nextCheckpoint: entry.nextCheckpoint,
    finished: entry.finished,
    raceTime: entry.raceTime,
  }))
}
