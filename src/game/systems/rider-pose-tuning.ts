/**
 * Rider pose-response tuning table.
 *
 * `RIDER_POSE_TUNING` is the shared DEFAULT table + the DEV OVERRIDE the
 * calibration / rider-editor scenes mutate live (`window.__hover.riderTuning`
 * style — rebound from devtools with no page reload). Production poses read a
 * PER-ENTITY tuning ref (`RiderData.tuning`) that defaults to this object, so
 * mutating the global only affects entities that share it — see the
 * per-entity wiring in `rider-pose.ts`.
 */

import type { Vec3 } from '@/engine/sim/physics/vec'

/** Rider pose-response tuning. Exposed as a mutable object so the
 *  calibration scene can rebind values live from devtools without a
 *  page reload — `window.__hover.riderTuning = { ... }` style. */
export const RIDER_POSE_TUNING = {
  /** Seat anchor in BIKE-LOCAL space. The pelvis sits here every tick;
   *  moving it back/forward/up/down translates the whole rider. Lowered from
   *  y=0.94 when the rider dropped to true human scale (RIDER_SCALE) for the
   *  1× bike — a starting value; live-tunable in the calibration scene. */
  seatLocal: { x: 0, y: 0.6, z: -0.4 } as Vec3,

  /** Seat ROTATION (degrees) applied to the pelvis in bike-local space, on
   *  top of the bike's own orientation. Lets the whole rider tilt / twist /
   *  bank relative to the seat without moving the anchor. pitch=X, yaw=Y,
   *  roll=Z. */
  seatRot: { pitch: 0, yaw: 0, roll: 0 },

  /** Bounce: critically-damped spring driven by vertical acceleration.
   *  Defaults pushed for visibility — earlier values were so subtle the
   *  chest tilt was sub-degree under normal turbulence. */
  bounceSpringK: 14,
  bounceSpringDamping: 4.5,
  bounceForceGain: 0.1,
  /** Clamp on total chest pitch offset (rad). Lifted to 0.7 (~40°) so a
   *  hard landing reads as a real abdomen crunch, not a polite nod. */
  bounceMaxPitch: 0.7,
  /** Per-spine-segment fraction of `bouncePitch` applied as a reactive
   *  offset. Two segments → two entries, summing to 1.0 so the total
   *  flex equals `bouncePitch`. Tweak the distribution to bias lower or
   *  upper spine compression. */
  bounceDistribution: {
    spine_lower: 0.55,
    spine_upper: 0.45,
  },

  /** Flow: low-pass on a target yaw derived from bike yaw rate. */
  flowSmoothing: 0.08,
  /** Conversion factor from bike yaw rate (rad/s) to torso yaw target
   *  (rad). At yawRate = 1 rad/s, the torso pivots ~0.6 rad (~34°) into
   *  the turn. Tuned alongside hand IK — the elbows absorb most of the
   *  visible flex, so we can push this fairly hard without the rider
   *  looking like a noodle. */
  flowYawPerYawRate: 0.6,
  /** Clamp on chest yaw offset (rad). */
  flowMaxYaw: 0.8,

  /** Head yaw — the look LEADS the bike. Driven by raw stick steer (the
   *  player's declared future heading, ahead of any physics yaw), with an
   *  asymmetric response: a fast ATTACK so the head is visibly the first
   *  thing to move on input — before the bike or torso react — and a lazy
   *  RELEASE so it eases back to centre instead of snapping. Per-tick lerp
   *  factors at the fixed sim rate (attack 0.45 ≈ 90% of target in ~60 ms;
   *  release 0.12 ≈ the old smoothing). */
  headYawAttack: 0.45,
  headYawRelease: 0.12,
  headYawMax: 0.7,

  /** Head pitch: low-pass on ControlIntent.throttle - brake. */
  headPitchSmoothing: 0.06,
  headPitchMax: 0.18,

  /** Drift lean — the rider banks the torso into a drift. The lean
   *  target is `leanDir × magnitude`, where magnitude grows when the
   *  player steers INTO the drift and shrinks on counter-steer:
   *    - neutral steer mid-drift → `driftLeanBase`
   *    - full steer into the turn → up to `driftLeanMax` (deep bank)
   *    - full counter-steer       → down to `driftLeanMin` (shallow)
   *  Zero when not drifting. Low-passed by `driftLeanSmoothing`. Applied
   *  at `spine_lower` so the whole upper body banks from the hips. */
  driftLeanBase: 0.22,
  driftLeanIntoGain: 0.5,
  driftLeanMin: 0.06,
  driftLeanMax: 0.55,
  driftLeanSmoothing: 0.12,

  /** Strength of hand + foot IK. 1 = hard-locked to derived anchor, 0 =
   *  limbs follow rest pose only (no IK). Future: ramp to 0 during stun /
   *  launch transitions so the limbs flop instead of snapping. */
  handIKStrength: 1,
  footIKStrength: 1,

  /** IK pole vectors (bike-local) — the "preferred bend direction" for the
   *  elbow / knee. The 2-bone solver projects this onto the plane perp to
   *  shoulder→hand (hip→foot) and bends toward it, so the Z (forward/back)
   *  sign decides which way the joint folds. `armPole.z` is NEGATIVE so the
   *  elbows fold back-and-down toward the rider (positive Z folded them
   *  forward — the "elbows look backwards" report). */
  armPole: { x: 0, y: -1, z: -0.2 } as Vec3,
  legPole: { x: 0, y: -0.3, z: 1 } as Vec3,

  /** Rest-pose joint angles (degrees). Read live each tick — the
   *  calibration scene's slider panel mutates these directly so the rider
   *  re-poses without a respawn.
   *
   *  Shoulders and hips get THREE axes each (pitch, yaw, roll). Pitch
   *  is shared L/R; yaw and roll are mirrored on the right side so a
   *  positive shoulder roll opens both arms outward. Knees + elbows are
   *  single-axis hinges. */
  restAngles: {
    /** Lower spine forward pitch (degrees). Adds with spine_upper for the
     *  total motocross "attack" lean. */
    spine_lower: 32,
    spine_upper: 30,
    /** Neck pitch — relative to the (forward-leaning) chest. */
    neck: 11,
    /** Shoulder forward pitch (shared L/R).
     *
     *  SIGN CONVENTION (matters): upper_arm attaches to chest via its +Y
     *  END (top of the capsule). Positive pitch around X rotates the top
     *  of the bone forward, which sends the rest of the bone (and the
     *  hand) BACKWARD. To swing the arm forward to the handlebars — what
     *  the IK target is derived from — we need a NEGATIVE pitch. This
     *  matches the convention used by `hip_pitch`. */
    shoulder_pitch: -120,
    /** Shoulder twist around the bone's long axis. Mirrored on the right. */
    shoulder_yaw: -10,
    /** Shoulder outward roll. Left side gets +roll, right gets -roll. */
    shoulder_roll: 9,
    /** Elbow bend. */
    elbow: 30,
    /** Hip pitch — negative because of the +Y-end attachment convention
     *  (positive pitch sends the knee backward into the bike). */
    hip_pitch: 5,
    /** Hip yaw (twist around leg's long axis). Mirrored. */
    hip_yaw: -46,
    /** Hip roll — splays the leg outward. Mirrored L/R. */
    hip_roll: 7,
    /** Knee bend relative to upper leg. Pairs with hip so the lower leg
     *  drops vertical to the footpeg. Mostly cosmetic because foot IK
     *  overrides. */
    knee: 63,
  },
}

/** Shape of the rider pose-response tuning. A per-entity `RiderData.tuning`
 *  uses this type and defaults to `RIDER_POSE_TUNING`. */
export type RiderTuning = typeof RIDER_POSE_TUNING
