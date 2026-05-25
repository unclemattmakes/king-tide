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
 * Geometric trick system. The window is armed by the bike's *pose*, not
 * by a vertical-velocity threshold: the moment the bike leaves its
 * fully-planted stance — the nose lifting off a bump / lip / ramp crest
 * while the base is still down, a clean full takeoff, or riding up a
 * ramp / sandbar transition at speed (a kicker, where the nose stays
 * grounded on the rising slope so no pop fires until the crest) — the
 * window opens and stays open the whole airtime, closing when the bike
 * re-plants. Any rising-edge press inside the window fires the trick
 * (once per airtime). This is the naive, readable model: nose airborne +
 * base grounded + press = trick, with the window persisting through the
 * fully-airborne phase so a press *just after* the base lifts off still
 * lands.
 *
 * Why geometry beats the old vy gate: lips, humps, and ramp crests pop
 * the nose long before the *center* probe registers `isGrounded` false
 * or the vertical velocity crosses a threshold, so the old model simply
 * never opened the window on most terrain features. The per-end contact
 * flags (`HoverState.noseGrounded` / `baseGrounded`, computed by the
 * hover spring's bow/stern probes with chatter-debouncing hysteresis)
 * make the pop a first-class signal.
 *
 * Eligibility still requires the launch be surface-driven (not the
 * bike's own courtesy hop — `hopLockoutActive`) and ridden with intent
 * (speed ≥ `MIN_SPEED_FRAC` * topSpeed, throttle ≥ `MIN_THROTTLE`). On
 * flat ground the bike never leaves its planted stance, so those gates
 * plus the geometry naturally reject parked / coasting tricks without a
 * separate vy check. Vertical velocity now scales *reward only*:
 * `max(vy, vyPeak)` is captured at the pop and floored so even a gentle
 * bump-crest pop pays, while a big launch pays more.
 *
 * Pre-input buffer: a press while still planted, with a plausible pop
 * imminent (recent `vyPeak ≥ MIN_VY_PEAK`, speed/throttle OK, no
 * hop-lockout), is held for `PRE_PRESS_BUFFER_SEC` (200 ms). If the bike
 * pops inside that window the buffered press fires the trick at the pop.
 * If no pop arrives but the climb context is still credible at expiry
 * (the wave-crest / gentle-hump case the geometric pop misses), the
 * press is honored anyway — a synthesized launch fires the trick, so the
 * prompt that elicited the press never lies. Only a fully decayed climb
 * (throttle released) expires to a plain courtesy hop.
 *
 * Flatground press with no plausible pop = small courtesy hop. No boost,
 * no spin, no meter — just a polite lift at the player's command.
 *
 * Per bike, per fixed tick:
 *
 *   1. Decay cooldown + spin lifetime.
 *   2. Tick the hop-lockout state machine (ends on airborne→grounded
 *      after a courtesy hop).
 *   3. Maintain the vy-peak tracker (climb context for the buffer +
 *      reward scaling at the pop).
 *   4. Geometric window: leaving the fully-planted stance arms it
 *      (consuming any buffered press); re-planting closes it.
 *   5. Tick the pre-press buffer; on expiry, fire a courtesy hop.
 *   6. Detect rising-edge press:
 *      - Window open: fire (once per airtime), else swallow.
 *      - Grounded with climb context: buffer.
 *      - Grounded flat: fire courtesy hop.
 *
 * The render-side `wave-pump-observer` is a thin shim that reads the
 * `trickFiredThisTick` flag and translates it to a `PumpEvent` for
 * HUD/audio/FX.
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
/** Filtered bow→stern surface slope (rise/run, ≈ tan θ) above which a
 *  grounded bike at speed is treated as "on a kicker" and the trick
 *  window arms. Going UP a ramp / sandbar transition the nose stays
 *  grounded (it samples the rising slope ahead), so the pop-pose never
 *  fires until the crest — but players read the up-ramp as launchable.
 *  0.12 ≈ 7°: steep enough to exclude flat chop + gentle road grades,
 *  shallow enough to catch a sandbar lip. Tunable. */
const TRICK_RAMP_SLOPE_MIN = 0.12

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

    // ── Trick window ─────────────────────────────────────────────────
    // Open when the bike leaves its planted stance, two ways:
    //   - pop pose: nose off the surface while the base + center are
    //     still down — the lip / crest / bump moment the player reads as
    //     "pop a trick". The nose probe samples *ahead*, so on a climb it
    //     reads the rising slope and stays grounded; it only lifts at a
    //     genuine crest, which keeps a steep climb from arming early.
    //   - full launch: the center leaves the ground.
    // Stays open the whole airtime and closes once the bike re-plants
    // (center down + nose back down). The `!trickWindowOpen` latch means
    // one episode arms once — probe flicker can't re-arm mid-flight or
    // re-fire after the dedup. (Base contact only qualifies the pop pose;
    // the stern probe samples *behind* / downhill while climbing and is
    // too noisy to gate the airborne window on.)
    const centerAirborne = !hover.isGrounded
    const popPose = hover.isGrounded && !hover.noseGrounded && hover.baseGrounded
    // Kicker state: riding up a ramp / sandbar transition at speed. The
    // nose stays grounded going uphill so the pop never fires until the
    // crest, but the up-ramp itself reads as launchable — arm here and
    // let the trick's loft pop the bike off. `settled` excludes it so the
    // window doesn't close mid-climb.
    const onRampUp = hover.isGrounded && hover.forwardSlope >= TRICK_RAMP_SLOPE_MIN
    const settled = hover.isGrounded && hover.noseGrounded && !onRampUp
    if (trick.trickWindowOpen && settled) {
      // Re-planted — close + clear the per-airtime dedup.
      trick.trickWindowOpen = false
      trick.trickWindowTakeoffVy = 0
      trick.trickFiredThisAirborne = false
    } else if (
      !trick.trickWindowOpen &&
      (centerAirborne || popPose || onRampUp) &&
      !trick.hopLockoutActive &&
      speedOK &&
      throttleOK
    ) {
      // Left the planted stance under power — arm. Reward scales on
      // launch energy: `max(vy, vyPeak)` captures the climb's peak even
      // if the instantaneous vy has eased off the crest. `fireTrick`
      // floors the strength so a gentle pop still pays.
      trick.trickWindowOpen = true
      trick.trickWindowTakeoffVy = Math.max(vy, trick.vyPeak)
      trick.trickFiredThisAirborne = false
      // Consume a buffered early-press, if any — fire at the pop.
      // Direction was captured at press time so a committed "left"
      // still spins left even if the stick moved before the pop landed.
      if (trick.bufferedPressTimerSec > 0 && trick.bufferedPressDir !== 0) {
        fireTrick(trick, trick.bufferedPressDir, trick.trickWindowTakeoffVy)
        trick.bufferedPressTimerSec = 0
        trick.bufferedPressDir = 0
      }
    }

    // Tick down + expire the pre-press buffer. Skipped if the arm above
    // already consumed it at a clean pop. On expiry no geometric pop
    // arrived — but the prompt that elicited this press lights on the
    // climb context (recent vyPeak), so if that's still credible we must
    // honor it rather than silently dropping to a hop. This is the
    // wave-race common case: the bike rides a wave crest (or a gentle
    // hump) without the center ever leaving the surface and without the
    // nose clearing the grounded cutoff, so neither the geometric pop nor
    // a hard takeoff fires. Synthesize the launch: a small lift so the
    // bike visibly leaves, open the window, fire at the peak vy. The
    // hop-lockout engages because that lift is self-induced and must not
    // re-arm. If the climb decayed (throttle released, slowed down) fall
    // back to the courtesy hop so the press still does something visible.
    if (trick.bufferedPressTimerSec > 0) {
      trick.bufferedPressTimerSec = Math.max(0, trick.bufferedPressTimerSec - dt)
      if (trick.bufferedPressTimerSec === 0 && trick.bufferedPressDir !== 0) {
        const stillCredible =
          !trick.hopLockoutActive && trick.vyPeak >= MIN_VY_PEAK && speedOK && throttleOK
        if (stillCredible) {
          applySmallHop(rb)
          trick.trickWindowOpen = true
          trick.trickWindowTakeoffVy = trick.vyPeak
          trick.trickFiredThisAirborne = false
          fireTrick(trick, trick.bufferedPressDir, trick.vyPeak)
        } else {
          applySmallHop(rb)
        }
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

    if (trick.trickWindowOpen) {
      // Open window: fire once per airtime. Strength uses the captured
      // pop vy, not press-time vy, so the reward is committed at the pop
      // regardless of when in the arc the player presses. A re-press
      // after the first fire (or while already firing) is swallowed —
      // no courtesy hop mid-episode.
      if (!trick.trickFiredThisAirborne) {
        fireTrick(trick, pressDir, trick.trickWindowTakeoffVy)
      }
      continue
    }

    if (!hover.isGrounded) {
      // Airborne with no open window (self-hop, anti-grav weirdness).
      // Drop the press.
      continue
    }

    // Grounded press, window closed. Buffer if a pop looks imminent
    // (recent climb + gates), else fire the courtesy hop.
    if (trick.cooldownSec > 0) continue
    const climbContext = trick.vyPeak >= MIN_VY_PEAK
    if (climbContext && speedOK && throttleOK && !trick.hopLockoutActive) {
      // Plausibly about to pop — hold the press. Don't reset the
      // cooldown yet: if the pop happens the trick fires (no hop
      // cooldown needed); if the buffer expires the courtesy-hop branch
      // sets things up.
      trick.bufferedPressTimerSec = PRE_PRESS_BUFFER_SEC
      trick.bufferedPressDir = pressDir
      continue
    }

    // Flatground press, no plausible pop — fire the small courtesy hop.
    // No boost, no spin, no meter charge.
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
  // Floor the vy at MIN_VY_PEAK so a geometric pop with little vertical
  // speed (cresting a flat-topped bump) still pays the "I made it count"
  // floor (0.4); stronger launches scale up toward 1.0.
  trick.trickFiredStrength = strengthFromTakeoffVy(Math.max(takeoffVy, MIN_VY_PEAK))
  trick.trickFiredDirection = dir
  trick.trickFiredThisAirborne = true
}
