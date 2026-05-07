import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { AIController, AIControllerStore, AITag } from '@/game/components/ai'
import { Racer, RacerStore } from '@/game/components/race'
import type { Track } from '@/game/tracks/types'

/**
 * Mario-Kart style rubber band.
 *
 * Race progress is `lap * N + nextCheckpoint`. Compute the delta between the
 * leader and each AI; AIs further behind get a throttle boost via topSpeedFactor.
 * Subtle — we want close races, not unfair comebacks.
 */
const MAX_BOOST = 1.18
const MAX_PENALTY = 0.92

function progress(lap: number, nextCheckpoint: number, totalCheckpoints: number): number {
  return lap * totalCheckpoints + nextCheckpoint
}

export function rubberBandSystem(sim: SimWorld, track: Track): void {
  const racerEids = query(sim, [Racer])
  if (racerEids.length === 0) return

  let leaderProgress = -Infinity
  for (const eid of racerEids) {
    const r = RacerStore.must(eid)
    const p = progress(r.lap, r.nextCheckpoint, track.checkpoints.length)
    if (p > leaderProgress) leaderProgress = p
  }

  const aiEids = query(sim, [AITag, AIController, Racer])
  for (const eid of aiEids) {
    const r = RacerStore.must(eid)
    const ai = AIControllerStore.must(eid)
    const p = progress(r.lap, r.nextCheckpoint, track.checkpoints.length)
    const delta = leaderProgress - p // 0 = tied, positive = behind

    // Map delta in checkpoints to a smoothing target factor.
    // delta = 0 → 1.0
    // delta >= 4 → MAX_BOOST
    // delta <= -2 → MAX_PENALTY
    let target: number
    if (delta > 0) {
      target = 1 + (MAX_BOOST - 1) * Math.min(1, delta / 4)
    } else {
      target = 1 + (MAX_PENALTY - 1) * Math.min(1, -delta / 2)
    }

    // Smooth toward target so AI speed doesn't jitter.
    const smoothed = ai.topSpeedFactor + (target - ai.topSpeedFactor) * 0.05
    AIControllerStore.set(eid, { ...ai, topSpeedFactor: smoothed })
  }
}
