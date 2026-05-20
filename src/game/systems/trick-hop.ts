import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  MIN_SPEED_FRAC,
  MIN_THROTTLE,
  MIN_VY_PEAK,
  PRE_PRESS_BUFFER_SEC,
  strengthFromTakeoffVy,
} from '@/engine/wave-pump-observer'
import {
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
  TrickState,
  TrickStateStore,
} from '@/game/components'

/**
 * Airborne-gated trick system. MK-style: the trick window opens on
 * the grounded→airborne transition of a *qualifying* takeoff and
 * stays open until landing. Any rising-edge press inside the window
 * fires the trick — no apex-timing dance, no separate credibility
 * check at press time. The window is closed silently on landing if
 * the player doesn't press.
 *
 * Qualifying takeoff = surface-driven (not from the bike's own small
 * hop, i.e. not in `hopLockoutActive`) AND vy at takeoff ≥
 * `MIN_VY_PEAK` AND speed ≥ `MIN_SPEED_FRAC` * topSpeed AND throttle
 * ≥ `MIN_THROTTLE`. The takeoff-vy is captured for reward scaling so
 * a stronger launch pays a bigger boost — the wave-mastery reward
 * hierarchy survives the simplification.
 *
 * Pre-input buffer: if the player presses while still grounded but
 * a qualifying takeoff is plausibly imminent (recent vyPeak crossed
 * `MIN_VY_PEAK`, speed/throttle OK, no hop-lockout), the press is
 * held for `PRE_PRESS_BUFFER_SEC` (200 ms). If the bike takes off
 * inside that window, the buffered press fires the trick at takeoff.
 * If not, the buffer expires to a small flatground hop so the input
 * still registers as something rather than vanishing.
 *
 * Flatground press with no qualifying context = small hop only. No
 * boost, no spin, no meter — just a polite lift so the bike can
 * choose to leave the ground at the player's command.
 *
 * Per bike, per fixed tick:
 *
 *   1. Decay cooldown + spin lifetime.
 *   2. Tick the pre-press buffer; expire it to a small hop if 200 ms
 *      elapsed without a qualifying takeoff.
 *   3. Tick the hop-lockout state machine (unchanged — ends on
 *      airborne→grounded after a small hop).
 *   4. Maintain the vy-peak tracker (still used as the "climb
 *      context" signal that gates whether a press should buffer).
 *   5. Detect grounded↔airborne transitions:
 *      - takeoff (qualifying): open trick window, capture takeoff-vy,
 *        consume any buffered press as a fire-at-takeoff trick.
 *      - landing: close window, clear airborne-dedup.
 *   6. Detect rising-edge press:
 *      - In an open window (already airborne): fire immediately.
 *      - On the ground with climb context: buffer.
 *      - On flat ground: fire small hop.
 *
 * The render-side `wave-pump-observer` is now a thin shim that reads
 * the `trickFiredThisTick` flag and translates it to a `PumpEvent`
 * for HUD/audio/FX — no independent credibility check, no duplicated
 * vy-peak tracker.
 */

/** Vertical velocity (m/s) for a flatground courtesy lift. Visible
 *  enough that the button isn't silent, small enough that it's clearly
 *  not a trick. */
const HOP_VELOCITY_SMALL = 4.5
/** Sim-tick lifetime of the vy-peak (≈ 300 ms at 60 Hz). Matches the
 *  buffer's pre-takeoff plausibility window — if the peak is stale,
 *  the player isn't "about to launch" any more, so a press goes to
 *  the small-hop path instead of buffering. */
const VY_PEAK_STALE_TICKS = 18
/** Maximum sim ticks the hop lockout stays active before timing
 *  out. 180 ticks ≈ 3 s — covers the small hop's airborne arc plus
 *  margin if the landing transition never fires. */
const HOP_LOCKOUT_MAX_TICKS = 180
/** Seconds between consecutive small hops on the same bike. Stops
 *  button-mash spam from chaining tiny lifts. */
const HOP_COOLDOWN_SEC = 0.35

export function trickHopSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [BikeTag, RBHandle, ControlIntent, HoverState, TrickState])
  for (const eid of eids) {
    const intent = ControlIntentStore.must(eid)
    const hover = HoverStateStore.must(eid)
    const trick = TrickStateStore.must(eid)
    const stats = BikeStatsStore.get(eid)

    // The one-shot fire flag is consumed by the render hook the same
    // frame it's set; clear it at the top of the next sim tick so a
    // skipped render frame can't double-fire.
    trick.trickFiredThisTick = false

    // Cooldown + spin lifetime decay.
    if (trick.cooldownSec > 0) trick.cooldownSec = Math.max(0, trick.cooldownSec - dt)
    if (trick.spinPhase > 0) {
      const stepFrac = trick.spinDurationSec > 0 ? dt / trick.spinDurationSec : 1
      trick.spinPhase = Math.max(0, trick.spinPhase - stepFrac)
      if (trick.spinPhase === 0) {
        trick.spinAxisX = 0
        trick.spinAxisY = 0
        trick.spinAxisZ = 0
      }
    }

    const handle = RBHandleStore.must(eid).handle
    const rb = phys.world.getRigidBody(handle)
    const lv = rb ? rb.linvel() : { x: 0, y: 0, z: 0 }
    const vy = lv.y
    const horizSpeed = Math.hypot(lv.x, lv.z)
    const topSpeed = stats?.topSpeed ?? 0
    const speedFrac = topSpeed > 0 ? horizSpeed / topSpeed : 0
    const speedOK = speedFrac >= MIN_SPEED_FRAC
    const throttleOK = Math.max(0, intent.throttle) >= MIN_THROTTLE

    // Hop lockout — set when a small hop fires, cleared when the bike
    // completes that airborne arc. While active, the airborne window
    // is suppressed: the bike's own lift is not allowed to count as a
    // qualifying surface takeoff.
    if (trick.hopLockoutActive) {
      trick.hopLockoutSafetyTicks -= 1
      if (!trick.hopLockoutAirborneSeen && !hover.isGrounded) {
        trick.hopLockoutAirborneSeen = true
      }
      const landedAfterAirborne = trick.hopLockoutAirborneSeen && hover.isGrounded
      if (landedAfterAirborne || trick.hopLockoutSafetyTicks <= 0) {
        trick.hopLockoutActive = false
        trick.hopLockoutAirborneSeen = false
      }
    }

    // vy-peak tracker — still useful as the "climb context" signal that
    // decides whether a grounded press should buffer (recent climb =
    // takeoff plausible) or fall through to the small-hop path. Same
    // hop-lockout suppression as before: a small hop's own lift must
    // not arm the next press.
    if (!trick.hopLockoutActive && vy > trick.vyPeak) {
      trick.vyPeak = vy
      trick.vyPeakTicksAgo = 0
    } else {
      trick.vyPeakTicksAgo += 1
      if (trick.vyPeakTicksAgo > VY_PEAK_STALE_TICKS) {
        trick.vyPeak = 0
      }
    }

    // Transition detection. Both takeoff and landing read from the
    // previous tick's grounded state stored on the component.
    const justTookOff = trick.wasGroundedLastTick && !hover.isGrounded
    const justLanded = !trick.wasGroundedLastTick && hover.isGrounded
    trick.wasGroundedLastTick = hover.isGrounded

    if (justTookOff) {
      // Takeoff qualifies if it's surface-driven (no active hop-lockout)
      // and the speed/throttle/vy gates pass. Hop-lockout would still be
      // active for ~1 sim tick after the small hop's impulse fired, so
      // checking it here cleanly rejects self-hop takeoffs.
      const surfaceDriven = !trick.hopLockoutActive
      const qualifying = surfaceDriven && vy >= MIN_VY_PEAK && speedOK && throttleOK
      if (qualifying) {
        trick.trickWindowOpen = true
        trick.trickWindowTakeoffVy = vy
        trick.trickFiredThisAirborne = false
        // Consume a buffered press, if any. Direction was captured at
        // press time so a buffered "I committed left" still spins
        // left even if the stick moved before takeoff landed.
        if (trick.bufferedPressTimerSec > 0 && trick.bufferedPressDir !== 0) {
          fireTrick(trick, trick.bufferedPressDir, vy)
          trick.bufferedPressTimerSec = 0
          trick.bufferedPressDir = 0
        }
      }
    }

    if (justLanded) {
      trick.trickWindowOpen = false
      trick.trickWindowTakeoffVy = 0
      trick.trickFiredThisAirborne = false
    }

    // Tick down + expire the pre-press buffer. Expiry without takeoff
    // falls through to a small hop so the press still registers as
    // *something* — better than vanishing inputs. Skipped if a trick
    // already consumed the buffer this tick.
    if (trick.bufferedPressTimerSec > 0) {
      trick.bufferedPressTimerSec = Math.max(0, trick.bufferedPressTimerSec - dt)
      if (trick.bufferedPressTimerSec === 0 && trick.bufferedPressDir !== 0) {
        // Buffer expired without a qualifying takeoff. Fire the small
        // hop now as the courtesy-lift fallback. Don't re-set cooldown
        // beyond what the original press already set.
        applySmallHop(rb)
        trick.hopLockoutActive = true
        trick.hopLockoutAirborneSeen = false
        trick.hopLockoutSafetyTicks = HOP_LOCKOUT_MAX_TICKS
        trick.bufferedPressDir = 0
      }
    }

    // Rising-edge detection on the trick buttons. Held-down doesn't
    // re-arm — released-and-re-pressed is the only valid input.
    const leftEdge = intent.trickLeft && !trick.prevLeftDown
    const rightEdge = intent.trickRight && !trick.prevRightDown
    trick.prevLeftDown = intent.trickLeft
    trick.prevRightDown = intent.trickRight
    const pressDir = leftEdge ? -1 : rightEdge ? +1 : 0
    if (pressDir === 0) continue

    if (trick.trickWindowOpen && !trick.trickFiredThisAirborne) {
      // Press inside the open window — fire immediately. Strength uses
      // the captured takeoff-vy, not press-time vy, so the reward is
      // committed at takeoff regardless of when in the arc the player
      // presses.
      fireTrick(trick, pressDir, trick.trickWindowTakeoffVy)
      continue
    }

    if (!hover.isGrounded) {
      // Airborne but either no qualifying window (self-hop, anti-grav
      // weirdness) or we already fired this airtime — drop the press.
      continue
    }

    // Grounded press. Decide whether to buffer or fire a small hop.
    if (trick.cooldownSec > 0) continue
    const climbContext = trick.vyPeak >= MIN_VY_PEAK
    const noHopLockout = !trick.hopLockoutActive
    if (climbContext && speedOK && throttleOK && noHopLockout) {
      // Plausibly about to launch — hold the press. Don't reset the
      // cooldown yet: if takeoff happens, the trick fires (no hop
      // cooldown needed); if the buffer expires to a small hop, the
      // expiry branch sets things up.
      trick.bufferedPressTimerSec = PRE_PRESS_BUFFER_SEC
      trick.bufferedPressDir = pressDir
      continue
    }

    // Flatground press, no plausible takeoff — fire the small courtesy
    // hop. No boost, no spin, no meter charge.
    applySmallHop(rb)
    trick.cooldownSec = HOP_COOLDOWN_SEC
    trick.hopLockoutActive = true
    trick.hopLockoutAirborneSeen = false
    trick.hopLockoutSafetyTicks = HOP_LOCKOUT_MAX_TICKS
  }
}

function applySmallHop(rb: ReturnType<PhysicsWorld['world']['getRigidBody']>): void {
  if (!rb?.isDynamic()) return
  const m = rb.mass()
  if (!Number.isFinite(m) || m <= 0) return
  rb.applyImpulse({ x: 0, y: HOP_VELOCITY_SMALL * m, z: 0 }, true)
}

function fireTrick(
  trick: ReturnType<typeof TrickStateStore.must>,
  dir: number,
  takeoffVy: number,
): void {
  trick.trickFiredThisTick = true
  trick.trickFiredStrength = strengthFromTakeoffVy(takeoffVy)
  trick.trickFiredDirection = dir
  trick.trickFiredThisAirborne = true
}
