import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
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
 * MK8-style hop physics with credibility-aware launch height.
 *
 * Per bike, per fixed tick:
 *
 *   1. Maintain a recent-vy-peak tracker (mirror of the observer's
 *      same tracker) so the sim can decide hop magnitude without
 *      crossing the sim/render boundary.
 *   2. Decrement the cooldown timer and the visual-spin lifetime.
 *      The spin axis + lifetime are *started* externally (by the
 *      credible-trick handler in game-loop); this system only decays.
 *   3. Tick the hop-lockout state machine. The lockout ends on the
 *      airborne→grounded transition (or the safety timeout).
 *   4. Detect rising edges on `intent.trickLeft` / `intent.trickRight`.
 *      Holding the button does nothing — only fresh presses count.
 *   5. On a rising edge while grounded + past cooldown:
 *        - Credible apex (vyPeak ≥ HOP_CREDIBILITY_VY)
 *          → big hop velocity. Visible launch, real airtime, the
 *            spin animation has room to play out.
 *        - Otherwise (flatground, weak chop)
 *          → small hop velocity. The bike clearly leaves the ground
 *            but doesn't soar; no spin, no boost — just lift.
 *
 * The credibility threshold matches the trick observer's `minVyPeak`
 * so the two stay in lockstep: every credible-trick boost event also
 * gets the big hop, every flatground press gets the small hop with
 * no boost.
 *
 * Visual-only spin: the spin path never torques the rigid body. The
 * render layer multiplies a quaternion (axis from `spinAxis*`,
 * angle from `1 − spinPhase`) onto the bike mesh so tricks read as
 * mid-air rotations without changing the bike's heading.
 */

/** Big vertical velocity (m/s) when the press lands on a credible
 *  apex — bike clears the surface by ~5 m above takeoff and the spin
 *  animation has the full ~1.3 s air time to play out. The credible-
 *  trick path stacks this with the forward boost-impulse + sustained
 *  meter accel, so the hop itself reads as a "you nailed it" launch
 *  rather than a meek lift. Boosted from the original 11 m/s once
 *  playtesters confirmed the smaller version felt indistinguishable
 *  from the flatground small hop on most ramps. */
const HOP_VELOCITY_BIG = 16.0
/** Small vertical velocity (m/s) for a flatground hop. Visibly leaves
 *  the ground but doesn't fly — telegraphs "yes the button works"
 *  without earning the trick payoff. */
const HOP_VELOCITY_SMALL = 4.5
/** vyPeak floor (m/s) above which a hop counts as a credible trick.
 *  Matches `DEFAULT_DETECTOR_TUNING.minVyPeak` on the observer side
 *  — both must agree, or the sim awards the big hop while the
 *  observer rejects the boost (or vice versa). 3.5 m/s catches a
 *  ridable wave climb without tripping on flat-ground chop. */
const HOP_CREDIBILITY_VY = 3.5
/** Sim-tick lifetime of the vy-peak before it goes stale. At a fixed
 *  60 Hz step, 18 ticks ≈ 300 ms — matches the observer's
 *  `peakStaleMs`. Short window forces the press to land *while*
 *  the bike is still climbing, not a beat after the crest has
 *  already passed. */
const VY_PEAK_STALE_TICKS = 18
/** Maximum sim ticks the hop lockout stays active before timing
 *  out. 180 ticks ≈ 3 s — covers the big hop's full airborne arc
 *  (~2.2 s) plus margin in case the airborne→grounded transition
 *  never fires (kinematic edge cases, anti-grav weirdness, etc.). */
const HOP_LOCKOUT_MAX_TICKS = 180
/** Seconds between consecutive hops on the same bike. Long enough that
 *  the bike has time to leave + return to the ground at HOP_VELOCITY_BIG,
 *  short enough that a deliberate hop-on-landing chain still flows. */
const HOP_COOLDOWN_SEC = 0.35

export function trickHopSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [BikeTag, RBHandle, ControlIntent, HoverState, TrickState])
  for (const eid of eids) {
    const intent = ControlIntentStore.must(eid)
    const hover = HoverStateStore.must(eid)
    const trick = TrickStateStore.must(eid)

    // Tick down the cooldown + the visual spin lifetime. The spin is
    // started externally by the credible-trick event handler — here
    // we just decay it. Visual phase drops linearly 1 → 0 over
    // `spinDurationSec`; render reads `(1 - spinPhase)` to drive the
    // twist.
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

    // Hop lockout — set when a hop fires, cleared when the bike
    // completes the airborne arc and lands again. While active, the
    // vy-peak tracker ignores updates because the bike's vertical
    // velocity is being driven by the hop's own impulse, not by the
    // surface. Without this gate the hop's lift poisons the peak,
    // arming the next press as a credible "trick" off thin air.
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

    // vy-peak tracker. Pull live vy from the rigid body so the peak
    // reflects this tick's physics, not last tick's snapshot. While
    // the bike is in a post-hop lockout, NEW peak updates are
    // skipped (the lift is hop-driven, not surface-driven) but the
    // pre-existing peak is preserved so the credibility check on
    // *this* press tick — which sets the lockout — can still see
    // the surface-driven climb. The stale-tick window expires the
    // peak naturally during the airborne arc.
    const handle = RBHandleStore.must(eid).handle
    const rb = phys.world.getRigidBody(handle)
    const vy = rb ? rb.linvel().y : 0
    if (!trick.hopLockoutActive && vy > trick.vyPeak) {
      trick.vyPeak = vy
      trick.vyPeakTicksAgo = 0
    } else {
      trick.vyPeakTicksAgo += 1
      if (trick.vyPeakTicksAgo > VY_PEAK_STALE_TICKS) {
        trick.vyPeak = 0
      }
    }

    // Rising-edge detection. `prev*Down` is the previous tick's input
    // state — flipping `false → true` (and only that) registers as a
    // press. Released-and-re-pressed counts; held-down does not.
    const leftEdge = intent.trickLeft && !trick.prevLeftDown
    const rightEdge = intent.trickRight && !trick.prevRightDown
    trick.prevLeftDown = intent.trickLeft
    trick.prevRightDown = intent.trickRight

    const canHop = (leftEdge || rightEdge) && hover.isGrounded && trick.cooldownSec <= 0
    if (canHop) {
      if (rb?.isDynamic()) {
        const m = rb.mass()
        if (Number.isFinite(m) && m > 0) {
          // Vertical impulse along world up. Anti-grav sections live on
          // their own gravity vector, but the bike's "up" relative to
          // the player visual frame is still world-Y on every flagged
          // ship track — sticking with world up keeps the hop readable
          // in loops without retargeting through AntiGravOverride.
          const credible = trick.vyPeak >= HOP_CREDIBILITY_VY
          const hopV = credible ? HOP_VELOCITY_BIG : HOP_VELOCITY_SMALL
          rb.applyImpulse({ x: 0, y: hopV * m, z: 0 }, true)
        }
      }
      trick.cooldownSec = HOP_COOLDOWN_SEC
      // Engage the hop lockout so neither this system's nor the
      // observer's vy-peak tracker registers the hop's own lift as a
      // "credible climb" for the next press.
      trick.hopLockoutActive = true
      trick.hopLockoutAirborneSeen = false
      trick.hopLockoutSafetyTicks = HOP_LOCKOUT_MAX_TICKS
      // Spin axis + direction + boost reward are gated on credibility
      // downstream — see the game-loop trick-event handler.
    }
  }
}
