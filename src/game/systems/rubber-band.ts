import { query } from 'bitecs'
import { playerSettings } from '@/engine/player-settings'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { AIController, AIControllerStore, AITag } from '@/game/components/ai'
import { Racer, RacerStore } from '@/game/components/race'
import { raceProgress } from '@/game/systems/race'
import type { Track } from '@/game/tracks/types'

/**
 * Mario-Kart style rubber band.
 *
 * Race progress is `lap * N + nextCheckpoint`. Compute the delta between the
 * leader and each AI; AIs further behind get a throttle boost via topSpeedFactor.
 * Subtle — we want close races, not unfair comebacks.
 *
 * Two knobs from `playerSettings`:
 *  - `aiDifficulty` is *baked* per-AI on spawn (boost cap / penalty
 *    floor / baseline speed factor live on the controller component);
 *    so a difficulty change takes effect on the next race, not mid-lap.
 *  - `rubberBandAssist` is read here each tick — flipping the toggle
 *    mid-race smoothly settles AI back to baseline.
 *
 * When the assist is off the system still runs to drive `topSpeedFactor`
 * back to the per-AI baseline (instead of hard-snapping), so a player
 * who toggles mid-race doesn't see an instant AI personality flip.
 */

/** Checkpoints behind/ahead of the leader at which the boost / penalty
 *  saturates. ±N below; smaller penalty window means leaders feel the
 *  brake faster than chasers feel the boost. */
const BOOST_SATURATION_CP = 4
const PENALTY_SATURATION_CP = 2

/** Per-tick smoothing factor for the move from current → target. 0.05
 *  is slow enough that the AI doesn't jitter when delta flips sign at
 *  a checkpoint boundary. */
const SMOOTHING = 0.05

export function rubberBandSystem(sim: SimWorld, track: Track): void {
  const racerEids = query(sim, [Racer])
  if (racerEids.length === 0) return

  let leaderProgress = -Infinity
  for (const eid of racerEids) {
    const p = raceProgress(RacerStore.must(eid), track)
    if (p > leaderProgress) leaderProgress = p
  }

  const assistOn = playerSettings.rubberBandAssist
  const aiEids = query(sim, [AITag, AIController, Racer])
  for (const eid of aiEids) {
    const r = RacerStore.must(eid)
    const ai = AIControllerStore.must(eid)
    const baseline = ai.baselineTopSpeedFactor

    let target: number
    if (assistOn) {
      const p = raceProgress(r, track)
      const delta = leaderProgress - p // 0 = tied, positive = behind
      const boostCap = ai.rubberBandBoostCap
      const penaltyFloor = ai.rubberBandPenaltyFloor
      // Modulate around the per-difficulty baseline rather than 1.0 —
      // a Casual AI's "boost" tops out at baseline×ratio so it stays
      // visibly slower than a Standard AI even when far behind.
      if (delta > 0) {
        target = baseline * (1 + (boostCap - 1) * Math.min(1, delta / BOOST_SATURATION_CP))
      } else {
        target = baseline * (1 + (penaltyFloor - 1) * Math.min(1, -delta / PENALTY_SATURATION_CP))
      }
    } else {
      // Assist off: settle topSpeedFactor back to baseline so flipping
      // the toggle mid-race doesn't snap AI speed.
      target = baseline
    }

    const smoothed = ai.topSpeedFactor + (target - ai.topSpeedFactor) * SMOOTHING
    AIControllerStore.set(eid, { ...ai, topSpeedFactor: smoothed })
  }
}
