import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { Racer, RacerStore } from '@/game/components/race'
import { raceProgress } from '@/game/systems/race'
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
 * Progress = lap * N + nextCheckpoint (via `raceProgress`).
 *
 * Tie-break among equal progress: the racer who *reached* that progress
 * earlier is ahead, read from `lastCheckpointTime` (stamped at each crossing).
 * `raceTime` cannot be used here — it advances identically for every
 * un-finished racer each tick, so it only ever discriminates *finished*
 * racers; using it for live ties produced frame-to-frame position flicker
 * when bikes ran abreast. A racer with no crossing yet (start grid) sorts
 * after one that has, then falls back to eid for a stable order.
 */
export function computeStandings(sim: SimWorld, track: Track): Standing[] {
  const eids = query(sim, [Racer])
  const list = Array.from(eids).map((eid) => {
    const r = RacerStore.must(eid)
    return {
      eid,
      lap: r.lap,
      nextCheckpoint: r.nextCheckpoint,
      finished: r.finished,
      raceTime: r.raceTime,
      _progress: raceProgress(r, track),
      _arrival: r.lastCheckpointTime ?? Number.POSITIVE_INFINITY,
    }
  })
  list.sort((a, b) => {
    if (b._progress !== a._progress) return b._progress - a._progress
    if (a._arrival !== b._arrival) return a._arrival - b._arrival
    return a.eid - b.eid
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
