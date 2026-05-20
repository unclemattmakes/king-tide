import { addComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
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
import { BoostEffect, BoostEffectStore } from '@/game/components/pickup'

/**
 * MK8-style hop physics with credibility-aware launch height + post-hop drift.
 *
 * Per bike, per fixed tick:
 *
 *   1. Maintain a recent-vy-peak tracker (mirror of the observer's
 *      same tracker) so the sim can decide hop magnitude without
 *      crossing the sim/render boundary.
 *   2. Decrement the cooldown timer and the visual-spin lifetime.
 *      The spin axis + lifetime are *started* externally (by the
 *      credible-trick handler in game-loop); this system only decays.
 *   3. Tick the hop-lockout state machine. On the airborne→grounded
 *      transition, hand off to the drift system if the same trick
 *      button is still held with commit-level steering.
 *   4. Sustain or release an active drift: apply per-tick yaw torque +
 *      outward lateral push + roll lean (the powerslide forces), tick
 *      the charge gauge, and on a clean release convert any tier-1+
 *      charge into a sustained `BoostEffect` mini-turbo plus a
 *      one-shot forward kick.
 *   5. Detect rising edges on `intent.trickLeft` / `intent.trickRight`.
 *      Holding the button does nothing — only fresh presses count.
 *   6. On a rising edge while grounded + past cooldown:
 *        - Credible apex (vyPeak ≥ HOP_CREDIBILITY_VY)
 *          → big hop velocity. Visible launch, real airtime, the
 *            spin animation has room to play out.
 *        - Otherwise (flatground, weak chop)
 *          → small hop velocity. The bike clearly leaves the ground
 *            but doesn't soar; no spin, no boost — just lift.
 *      Either way, arm the drift handoff with the pressed button so
 *      step 3 can pick it up on landing.
 *
 * The credibility threshold matches the trick observer's `minVyPeak`
 * so the two stay in lockstep: every credible-trick boost event also
 * gets the big hop, every flatground press gets the small hop with
 * no boost.
 *
 * Visual-only spin: the spin path never torques the rigid body. The
 * render layer multiplies a quaternion (axis from `spinAxis*`,
 * angle from `1 − spinPhase`) onto the bike mesh so tricks read as
 * mid-air rotations without changing the bike's heading. The DRIFT
 * forces (yaw / roll / lateral) *do* touch the rigid body — the
 * powerslide is a physical handling state, not a cosmetic overlay.
 */

/** Big vertical velocity (m/s) when the press lands on a credible
 *  apex — bike clears the surface by a couple of meters and the spin
 *  animation has the air time to play out. */
const HOP_VELOCITY_BIG = 11.0
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

// ── MK8 post-hop drift ───────────────────────────────────────────────
// The drift state engages on the airborne→grounded landing if the
// player still holds the same trick button they pressed for the hop
// AND has commit-level steering. Hold to charge a mini-turbo; release
// the button (or break the drift) to spend the charge.

/** |intent.steer| must exceed this at landing to enter a drift. The
 *  lock direction is captured from the sign — a feathered stick can't
 *  accidentally commit you to a powerslide on a straight. */
export const DRIFT_STEER_DEADZONE = 0.35
/** Up-plane speed (m/s) under which the drift won't engage and an
 *  active drift breaks. MK8 lets you "fake drift" at standstill, but
 *  the visual rear-slide only reads at speed, and the mini-turbo
 *  reward goes from "earned" to "free" if walking-speed drifts charge
 *  it. 6 m/s ≈ 22% of topSpeed — about the point the bike actually
 *  banks into a corner. */
export const DRIFT_MIN_SPEED = 6
/** While the stick is held opposite the drift direction past this
 *  magnitude, the drift breaks (charge converts to whatever tier was
 *  reached). Without an opposite-steer break the player can't bail out
 *  of a misaligned drift cleanly — they'd be stuck plowing into a wall
 *  while the bike keeps yaw-biased the wrong way. */
export const DRIFT_OPPOSITE_STEER_BREAK = 0.5
/** Charge thresholds (seconds). Below tier-1 the drift releases with
 *  nothing — the player gets the visual + tighter turn but no boost.
 *  Two tiers keeps the gauge readable; MK8's purple-spark third tier
 *  is overkill for our cup length. */
export const DRIFT_TIER1_SEC = 1.0
export const DRIFT_TIER2_SEC = 2.4
/** Mini-turbo `BoostEffect` parameters per tier. The multiplier lifts
 *  the bike's accel just past topSpeed (boostMul on Racer is ~1.4),
 *  and the duration is short enough that two drifts in a row chain
 *  cleanly without breaking the cap on `applyPumpImpulse`. */
export const DRIFT_TURBO_TIER1_DUR = 0.7
export const DRIFT_TURBO_TIER1_MUL = 1.45
export const DRIFT_TURBO_TIER2_DUR = 1.4
export const DRIFT_TURBO_TIER2_MUL = 1.65
/** Instant kick (m/s of Δv along bike-fwd) applied on tier release —
 *  matches the "trick lands" tactile snap from `applyPumpImpulse`,
 *  but sized smaller because the sustained multiplier above carries
 *  most of the speed payoff. */
export const DRIFT_TURBO_TIER1_KICK = 4.5
export const DRIFT_TURBO_TIER2_KICK = 8.0
/** Drift-only yaw torque coefficient (multiplies `mass * dt` to form
 *  a torque impulse around world up). Sits on top of the player's
 *  normal steer torque — the bike turns harder than steering alone
 *  could achieve, which is the whole point of drifting in MK8. */
const DRIFT_YAW_TORQUE = 7.0
/** Drift-only outward lateral push (m/s² along bike-right, pointed
 *  AWAY from the drift direction). Reads as the rear of the bike
 *  sliding outward — the iconic powerslide tell. The bike's normal
 *  lateral drag bleeds this back over ~250 ms once the drift breaks,
 *  so a clean release straightens out without a lingering crab. */
const DRIFT_OUTWARD_PUSH = 5.0
/** Drift-only roll torque (around bike-fwd) for visual lean. Positive
 *  driftDirection (right) → top of bike rolls right. Sits on top of
 *  the hover.ts roll PD, which also leans the bike from steer input;
 *  this just deepens the commitment so a drift reads visibly heavier
 *  than a sharp turn. */
const DRIFT_ROLL_TORQUE = 6.0

/**
 * Tier 0 = no release reward (drift broke before reaching the gauge).
 * Tier 1 / 2 = small / large mini-turbo. Exported for tests.
 */
export function driftTier(chargeSec: number): 0 | 1 | 2 {
  if (chargeSec >= DRIFT_TIER2_SEC) return 2
  if (chargeSec >= DRIFT_TIER1_SEC) return 1
  return 0
}

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

    // One-shot drift-release tier is consumed by the render side on the
    // very next frame. Clear it AT THE TOP of the next sim tick so
    // we don't blow away a freshly-set value from this same tick's
    // release branch below. Serial counter stays — the render side
    // diffs against it to detect releases that happened across one
    // or more sim ticks since its last poll.
    if (trick.driftReleaseTier > 0) trick.driftReleaseTier = 0

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

    // Drift handoff — decoupled from the hop-lockout's airborne-seen
    // gate. A small flatground hop (HOP_VELOCITY_SMALL = 4.5 m/s,
    // peak ~0.4 m) often doesn't clear the hover spring's grounded
    // threshold, so the bike never registers as airborne and the
    // landing-detect path used to never fire. Real MK8 drifts on
    // flatground too — you press, the bike hops a few cm, and the
    // drift kicks in as soon as it's settled. So: every tick while
    // `driftArmedButton != 0` and `!driftActive`, check the activation
    // gates. The hop impulse fired earlier this same loop, so we
    // require the bike to be grounded AND the press tick to have
    // already passed (`hopLockoutSafetyTicks < HOP_LOCKOUT_MAX_TICKS`
    // ensures we skip the press-tick itself).
    if (trick.driftArmedButton !== 0 && !trick.driftActive) {
      const driftBtnHeld =
        (trick.driftArmedButton < 0 && intent.trickLeft) ||
        (trick.driftArmedButton > 0 && intent.trickRight)
      if (!driftBtnHeld) {
        // Player released before the drift could engage — clear
        // arming so a later re-press doesn't latch a stale drift.
        trick.driftArmedButton = 0
      } else if (
        hover.isGrounded &&
        trick.hopLockoutSafetyTicks < HOP_LOCKOUT_MAX_TICKS &&
        Math.abs(intent.steer) >= DRIFT_STEER_DEADZONE
      ) {
        // Bike has settled with the button still held + committed
        // steer. Speed gate uses the rigid body's live linvel —
        // drift only engages above the floor speed so we don't
        // commit a parking-lot wiggle into a powerslide.
        const handleArm = RBHandleStore.must(eid).handle
        const rbArm = phys.world.getRigidBody(handleArm)
        let speedH = 0
        if (rbArm) {
          const v = rbArm.linvel()
          speedH = Math.hypot(v.x, v.z)
        }
        if (speedH >= DRIFT_MIN_SPEED) {
          trick.driftActive = true
          trick.driftDirection = intent.steer >= 0 ? 1 : -1
          trick.driftChargeSec = 0
        }
        // Below the speed floor we leave the arm in place so the
        // player can speed back up while still holding the button
        // and the drift engages then. Steer below the deadzone is
        // also a "wait" — the player might still be aligning the
        // corner — so we also leave the arming alone in that case
        // (handled by the outer `else if` guard above).
      }
    }

    // Drift sustain + release. Runs every tick after the lockout block
    // so a drift activated this tick gets a fresh charge tick too.
    // Break conditions in priority order:
    //   1. Drift-armed button released — primary release path. Tier
    //      from `driftChargeSec` decides the mini-turbo payoff.
    //   2. Bike airborne again — broke contact with the surface, drift
    //      ends without a payoff (you can't powerslide off a ramp).
    //   3. Speed dropped below the drift floor — the visual stops
    //      reading; ending here avoids the bike snapping mid-arc.
    //   4. Player jammed the stick opposite the lock direction past
    //      the break threshold — explicit cancel input, no payoff.
    // On a clean release (#1) tier-1+ awards a mini-turbo through
    // `BoostEffect`; lower tiers exit with state cleared. Other paths
    // exit without a release event so the FX hook doesn't fire on a
    // broken drift.
    if (trick.driftActive) {
      const driftBtnHeld =
        (trick.driftArmedButton < 0 && intent.trickLeft) ||
        (trick.driftArmedButton > 0 && intent.trickRight)
      const handleDrift = RBHandleStore.must(eid).handle
      const rbDrift = phys.world.getRigidBody(handleDrift)
      const vDrift = rbDrift ? rbDrift.linvel() : { x: 0, y: 0, z: 0 }
      const speedHDrift = Math.hypot(vDrift.x, vDrift.z)
      const oppositeSteer =
        Math.sign(intent.steer) === -trick.driftDirection &&
        Math.abs(intent.steer) >= DRIFT_OPPOSITE_STEER_BREAK

      const releaseClean = !driftBtnHeld
      const breakAirborne = !hover.isGrounded
      const breakSlow = speedHDrift < DRIFT_MIN_SPEED
      const breakCancel = oppositeSteer

      if (releaseClean || breakAirborne || breakSlow || breakCancel) {
        // Award only on a clean release — break paths just cancel the
        // gauge so an unintended drift (e.g., player accidentally held
        // the bumper through a slow corner) doesn't pay out.
        if (releaseClean) {
          const tier = driftTier(trick.driftChargeSec)
          if (tier > 0 && rbDrift?.isDynamic()) {
            const mDrift = rbDrift.mass()
            if (Number.isFinite(mDrift) && mDrift > 0) {
              const dur = tier === 2 ? DRIFT_TURBO_TIER2_DUR : DRIFT_TURBO_TIER1_DUR
              const mul = tier === 2 ? DRIFT_TURBO_TIER2_MUL : DRIFT_TURBO_TIER1_MUL
              if (!BoostEffectStore.has(eid)) addComponent(sim, eid, BoostEffect)
              const existing = BoostEffectStore.get(eid)
              // Refresh-style boost: take the longer of the two
              // durations + the larger of the two multipliers, so a
              // mini-turbo that fires while a pickup boost is still
              // active doesn't shorten or weaken the active effect.
              const useDur = existing && existing.remaining > dur ? existing.remaining : dur
              const useMul =
                existing && existing.remaining > 0 ? Math.max(existing.multiplier, mul) : mul
              BoostEffectStore.set(eid, { remaining: useDur, multiplier: useMul })

              // Forward kick along bike-fwd in the up-plane — sized
              // like a half-strength trick land for the tactile snap
              // that signals "you earned the turbo". The sustained
              // BoostEffect above carries the speed payoff.
              const kickDv = tier === 2 ? DRIFT_TURBO_TIER2_KICK : DRIFT_TURBO_TIER1_KICK
              const qRel = rbDrift.rotation()
              const fwdRel = quatRotate(qRel, { x: 0, y: 0, z: 1 })
              const horiz = Math.hypot(fwdRel.x, fwdRel.z)
              if (horiz > 1e-4) {
                const ux = fwdRel.x / horiz
                const uz = fwdRel.z / horiz
                rbDrift.applyImpulse(
                  { x: ux * kickDv * mDrift, y: 0, z: uz * kickDv * mDrift },
                  true,
                )
              }
            }
            // Render-side FX hook — game-loop polls these each frame.
            // Bumping the serial signals "a release happened since you
            // last looked"; the tier tells it which sound/flash to fire.
            trick.driftReleaseTier = tier
            trick.driftReleaseSerial = (trick.driftReleaseSerial + 1) >>> 0
          }
        }
        trick.driftActive = false
        trick.driftDirection = 0
        trick.driftChargeSec = 0
        trick.driftArmedButton = 0
      } else {
        // Sustain. Apply drift forces directly to the rigid body, then
        // tick the gauge. The forces sit on top of hover.ts's normal
        // steer torque + roll PD — drift just deepens the commitment.
        if (rbDrift?.isDynamic()) {
          const mDrift = rbDrift.mass()
          if (Number.isFinite(mDrift) && mDrift > 0) {
            // Yaw torque around world up. Positive driftDirection
            // (right) needs torque around −Y to rotate the heading
            // clockwise from above (same sign convention as the
            // hover system's steer torque, where +steer → −aTurn
            // around the +up yaw axis).
            const aYaw = -trick.driftDirection * DRIFT_YAW_TORQUE
            rbDrift.applyTorqueImpulse({ x: 0, y: aYaw * mDrift * dt, z: 0 }, true)

            // Outward lateral push + roll lean — both expressed in the
            // bike's local frame, so we need bike-right + bike-fwd.
            const qDrift = rbDrift.rotation()
            const rightW = quatRotate(qDrift, { x: 1, y: 0, z: 0 })
            const fwdW = quatRotate(qDrift, { x: 0, y: 0, z: 1 })

            // Rear-sweep illusion: push the chassis AWAY from the
            // turn so the bike crabs slightly outward, reading as a
            // powerslide. Drifting right → push along −right (which
            // is the bike's left side); drifting left → +right.
            const aLat = -trick.driftDirection * DRIFT_OUTWARD_PUSH
            rbDrift.applyImpulse(
              {
                x: rightW.x * aLat * mDrift * dt,
                y: rightW.y * aLat * mDrift * dt,
                z: rightW.z * aLat * mDrift * dt,
              },
              true,
            )

            // Roll lean — torque around bike-fwd. Sign: positive
            // angle around +fwd rolls the top of the bike toward +X
            // local (toward the right side), so driftDirection (+1
            // for right) maps directly to the torque sign.
            const aRoll = trick.driftDirection * DRIFT_ROLL_TORQUE
            rbDrift.applyTorqueImpulse(
              {
                x: fwdW.x * aRoll * mDrift * dt,
                y: fwdW.y * aRoll * mDrift * dt,
                z: fwdW.z * aRoll * mDrift * dt,
              },
              true,
            )
          }
        }
        trick.driftChargeSec += dt
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
      // Arm the drift handoff. The landing block reads this and
      // activates a drift if the same button is still held. Both
      // buttons pressed on the same tick → no drift arm (that combo
      // is reserved for the barrel-roll trick variant); a clean
      // single press arms left or right. Cancels any in-progress
      // drift on the same bike — chaining hop-out-of-drift restarts
      // the drift state machine from scratch rather than letting the
      // old charge bleed into the new press.
      if (leftEdge && rightEdge) {
        trick.driftArmedButton = 0
      } else {
        trick.driftArmedButton = leftEdge ? -1 : 1
      }
      trick.driftActive = false
      trick.driftDirection = 0
      trick.driftChargeSec = 0
      // Spin axis + direction + boost reward are gated on credibility
      // downstream — see the game-loop trick-event handler.
    }

    // Latent arming-button release: if the player let go of the
    // arming button before landing, cancel the drift opportunity so
    // a subsequent re-press doesn't get a free drift attached to the
    // old hop. Doesn't affect an already-active drift — those have
    // their own release path above.
    if (!trick.driftActive && trick.driftArmedButton !== 0) {
      const stillHeld =
        (trick.driftArmedButton < 0 && intent.trickLeft) ||
        (trick.driftArmedButton > 0 && intent.trickRight)
      if (!stillHeld) trick.driftArmedButton = 0
    }
  }
}
