/**
 * Stuck rescue — the arcade safety net the collision playtest showed
 * was missing: a bike can wedge nose-first against a rock shelf (the
 * hover climbs instead of sliding off) or lose its rider to a ragdoll
 * eject, and nothing recovers — the racer grinds until the player
 * finds the pause menu.
 *
 * Two triggers, player-only (AI recovery is level-design work — see
 * README "AI on vertical/elevated terrain"):
 *
 *   - WEDGE: grounded + throttle held + barely moving for
 *     `WEDGE_RESCUE_SEC`. That combination never happens in honest
 *     riding (sand slows the bike but full throttle still moves it),
 *     only when geometry has the bike pinned.
 *   - EJECT: the rider has been `launched` (ragdolled off) for
 *     `EJECT_RESCUE_SEC`. The crash had its comedy beat; put the
 *     racer back together.
 *
 * The sim only *requests* (one-shot `requestedThisTick`, the OOB
 * lethal-flag pattern); the game-loop consumes the flag and performs
 * the actual respawn-to-racing-line + rider reattach. While the OOB
 * leash is mid-drama (warn/brace/lethal) the wedge timer holds — one
 * rescue system at a time.
 */

import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  PlayerTag,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { OutOfBoundsStore } from '@/game/components/out-of-bounds'
import { Racer, RacerStore } from '@/game/components/race'
import { type RescueStateData, RescueStateStore } from '@/game/components/rescue'
import { Rider, RiderStore } from '@/game/components/rider'

// ── Tuning ────────────────────────────────────────────────────────────

/** Throttle at/above which a stationary bike counts as "trying". */
export const WEDGE_THROTTLE_MIN = 0.5
/** Horizontal speed (m/s) below which the bike counts as pinned. */
export const WEDGE_SPEED_MAX = 1.2
/** Seconds of continuous wedge before the rescue fires. */
export const WEDGE_RESCUE_SEC = 2.5
/** Seconds a rider stays ragdolled before the rescue fires. */
export const EJECT_RESCUE_SEC = 2.5

/** Pure wedge-timer step, exported for tests: returns the new
 *  accumulated stuck time given this tick's conditions. */
export function advanceWedgeTimer(
  prevSec: number,
  s: { grounded: boolean; throttle: number; horizSpeed: number; blocked: boolean },
  dt: number,
): number {
  if (s.blocked) return 0
  const wedged = s.grounded && s.throttle >= WEDGE_THROTTLE_MIN && s.horizSpeed <= WEDGE_SPEED_MAX
  return wedged ? prevSec + dt : 0
}

function ensureState(eid: number): RescueStateData {
  let st = RescueStateStore.get(eid)
  if (!st) {
    st = { stuckSec: 0, requestedThisTick: false, reason: 'wedge' }
    RescueStateStore.set(eid, st)
  }
  return st
}

export function stuckRescueSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [PlayerTag, BikeTag, RBHandle, HoverState, Racer])
  for (const eid of eids) {
    const st = ensureState(eid)
    // One-shot edge — consumed by the render frame; cleared next tick.
    st.requestedThisTick = false

    const racer = RacerStore.get(eid)
    if (racer?.finished) {
      st.stuckSec = 0
      continue
    }

    const rb = phys.world.getRigidBody(RBHandleStore.must(eid).handle)
    const hover = HoverStateStore.get(eid)
    if (!rb || !hover) continue

    // Hold while the OOB leash owns the drama (its countdown + shark /
    // autopilot already end in a rescue of their own).
    const oob = OutOfBoundsStore.get(eid)
    const oobBusy = oob !== undefined && oob.phase !== 'in'

    // ── Eject rescue ──────────────────────────────────────────────
    // Rider entities carry a bikeEid backref + a stateAge the pose
    // system already ticks for launched riders — a ready-made timer.
    let riderDown = false
    for (const rEid of query(sim, [Rider])) {
      const r = RiderStore.must(rEid)
      if (r.bikeEid !== eid) continue
      riderDown = r.state === 'launched' && r.stateAge >= EJECT_RESCUE_SEC
      break
    }
    if (riderDown && !oobBusy) {
      st.requestedThisTick = true
      st.reason = 'eject'
      st.stuckSec = 0
      continue
    }

    // ── Wedge rescue ──────────────────────────────────────────────
    const lv = rb.linvel()
    const intent = ControlIntentStore.get(eid)
    st.stuckSec = advanceWedgeTimer(
      st.stuckSec,
      {
        grounded: hover.isGrounded,
        throttle: Math.max(0, intent?.throttle ?? 0),
        horizSpeed: Math.hypot(lv.x, lv.z),
        blocked: oobBusy,
      },
      dt,
    )
    if (st.stuckSec >= WEDGE_RESCUE_SEC) {
      st.requestedThisTick = true
      st.reason = 'wedge'
      st.stuckSec = 0
    }
  }
}
