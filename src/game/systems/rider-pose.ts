/**
 * Rider pose system — kinematic chain walker with reactive offsets and
 * hand IK to the bike's handlebars.
 *
 * Pipeline per fixed step:
 *   1. Pelvis world pose = bike_pose ⊗ (SEAT_LOCAL, identity).
 *   2. Walk the joint list in parent-before-child order. Each child's
 *      world pose is derived from its parent: anchor matching on the
 *      joint position, target relative rotation modulated by per-bone
 *      reactive offsets.
 *   3. Run 2-bone IK for each arm so the hand lands on the bike's
 *      handlebar anchor regardless of the chest's current yaw. The
 *      shoulder moves with the chest, the hand stays planted, and the
 *      elbow bends to compensate.
 *   4. setNextKinematicTranslation / setNextKinematicRotation on every
 *      bone's rigid body.
 *
 * The chain walker is the load-bearing fix for the "torso looks like it
 * lags in translation" symptom from the calibration scene. With each
 * bone's world transform derived from its parent (not stored against the
 * bike directly), any reactive rotation on the chest carries the head,
 * arms, and IK targets along with it — the visual chain stays connected.
 *
 * Reactive offsets:
 *   - Chest pitch (bounce) — vertical accel drives a critically-damped
 *     spring. Hard landings flex the torso forward, then settle.
 *   - Chest yaw (flow) — bike yaw rate drives a low-pass yaw offset.
 *     The whole upper body pivots from the hips toward the turn.
 *   - Head yaw / pitch — raw stick steer (pre the player steer scale +
 *     smoothing, so the head leads the bike) + (throttle - brake).
 *
 * Launched riders are skipped: their bones are dynamic at that point and
 * are owned by Rapier's iterative solver.
 *
 * Tuning constants are exported as `RIDER_POSE_TUNING` so the calibration
 * scene can mutate them at runtime via the debug console.
 */

import { query } from 'bitecs'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { ControlIntentStore, DriftStateStore, RBHandleStore } from '@/game/components'
import {
  Rider,
  type RiderBoneName,
  type RiderJointKind,
  type RiderPoseResponse,
  RiderStore,
} from '@/game/components/rider'
import { rawSteerFor } from '@/game/systems/input-apply'

const IDENT_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 }

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Rotate a vector by a unit quaternion. Inlined here for hot-path use. */
function rotByQuat(q: Quat, vx: number, vy: number, vz: number): Vec3 {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  return {
    x: vx + q.w * tx + (q.y * tz - q.z * ty),
    y: vy + q.w * ty + (q.z * tx - q.x * tz),
    z: vz + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** Quaternion from axis-angle (axis must be unit). */
function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle * 0.5
  const s = Math.sin(h)
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) }
}

/** Build a quaternion that maps the unit `from` vector onto the unit `to`
 *  vector by the shortest rotation. Used by the arm IK to compute world
 *  bone orientations from "down the bone" target directions. */
function quatFromTo(from: Vec3, to: Vec3): Quat {
  const d = from.x * to.x + from.y * to.y + from.z * to.z
  if (d > 0.999999) return { x: 0, y: 0, z: 0, w: 1 }
  if (d < -0.999999) {
    // 180° rotation around any axis perpendicular to `from`.
    let ax = -from.y
    let ay = from.x
    let az = 0
    if (Math.hypot(ax, ay) < 1e-6) {
      ax = 0
      ay = -from.z
      az = from.y
    }
    const len = Math.hypot(ax, ay, az)
    return { x: ax / len, y: ay / len, z: az / len, w: 0 }
  }
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  const w = 1 + d
  const len = Math.hypot(cx, cy, cz, w)
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len }
}

function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function vscale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}
function vlen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}
function vnorm(v: Vec3): Vec3 {
  const L = vlen(v)
  if (L < 1e-6) return { x: 0, y: 1, z: 0 }
  return { x: v.x / L, y: v.y / L, z: v.z / L }
}

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

/** Convert degrees → radians. */
const D2R = Math.PI / 180

/** Compose pitch + yaw + roll into a single quaternion. Rotation order:
 *  Y (yaw) → Z (roll) → X (pitch), so q = pitch · roll · yaw. Picked to
 *  match the way "pitch the bone forward, roll it out, twist it" reads
 *  intuitively when scrubbing the sliders in the calibration scene. */
function quatPYR(pitchDeg: number, yawDeg: number, rollDeg: number): Quat {
  const pitch = quatAxisAngle(1, 0, 0, pitchDeg * D2R)
  const yaw = quatAxisAngle(0, 1, 0, yawDeg * D2R)
  const roll = quatAxisAngle(0, 0, 1, rollDeg * D2R)
  return quatMul(pitch, quatMul(roll, yaw))
}

/** Compute the rest-pose `targetRelRot` for a joint kind from the live
 *  tuning angles. Replaces the static `joint.targetRelRot` that was baked
 *  at spawn time, so the calibration scene's sliders take effect with no
 *  respawn. Pure of inputs — same kind + same tuning → same quat. */
function targetRelRotFor(kind: RiderJointKind): Quat {
  const a = RIDER_POSE_TUNING.restAngles
  switch (kind) {
    case 'spine_lower':
      return quatAxisAngle(1, 0, 0, a.spine_lower * D2R)
    case 'spine_upper':
      return quatAxisAngle(1, 0, 0, a.spine_upper * D2R)
    case 'neck':
      return quatAxisAngle(1, 0, 0, a.neck * D2R)
    case 'shoulder_L':
      return quatPYR(a.shoulder_pitch, a.shoulder_yaw, a.shoulder_roll)
    case 'shoulder_R':
      return quatPYR(a.shoulder_pitch, -a.shoulder_yaw, -a.shoulder_roll)
    case 'elbow_L':
    case 'elbow_R':
      return quatAxisAngle(1, 0, 0, a.elbow * D2R)
    case 'hip_L':
      return quatPYR(a.hip_pitch, a.hip_yaw, a.hip_roll)
    case 'hip_R':
      return quatPYR(a.hip_pitch, -a.hip_yaw, -a.hip_roll)
    case 'knee_L':
    case 'knee_R':
      return quatAxisAngle(1, 0, 0, a.knee * D2R)
  }
}

function zeroPoseResponse(r: RiderPoseResponse): void {
  r.prevVel.x = 0
  r.prevVel.y = 0
  r.prevVel.z = 0
  r.bouncePitch = 0
  r.bouncePitchVel = 0
  r.flowYaw = 0
  r.headYaw = 0
  r.headPitch = 0
  r.leanRoll = 0
}

/**
 * Target torso roll (radians) for the rider's drift bank. Pure +
 * exported so the lean curve is unit-pinned.
 *
 *  - `driftDir` 0 (not drifting) → 0 (the rider returns upright).
 *  - Otherwise leans toward the drift direction with a magnitude that
 *    grows when `steer` points INTO the drift and shrinks on
 *    counter-steer (`intoSigned = steer × driftDir`, range ≈ ±0.7
 *    after the player steer pre-scale).
 *
 * Sign: a left drift (`driftDir = -1`) returns a NEGATIVE roll, which
 * `quatAxisAngle(0,0,1,·)` on `spine_lower` (chest-forward axis) banks
 * the torso to the rider's left — into the corner. (Playtest confirmed
 * the initial `-1` banked the wrong way; `+1` leans into the turn.)
 */
const DRIFT_LEAN_SIGN = 1
export function driftLeanTarget(driftDir: number, steer: number): number {
  if (driftDir === 0) return 0
  const t = RIDER_POSE_TUNING
  const intoSigned = steer * driftDir
  const mag = clamp(
    t.driftLeanBase + t.driftLeanIntoGain * intoSigned,
    t.driftLeanMin,
    t.driftLeanMax,
  )
  return DRIFT_LEAN_SIGN * driftDir * mag
}

/** Per-joint reactive rotation offset that the chain walker right-multiplies
 *  onto the live `targetRelRotFor(kind)` quaternion.
 *
 *  - **spine_lower / spine_upper** — each gets a fraction of the chest's
 *    bouncePitch so the flex visibly travels up the torso through both
 *    segments. The chest joint (spine_upper) ALSO carries flowYaw so the
 *    upper body twists from the abdomen.
 *  - **neck** — head yaw + head pitch.
 *  - All other joints: identity (no reactive offset).
 */
function reactiveOffsetFor(kind: RiderJointKind, resp: RiderPoseResponse): Quat {
  if (kind === 'spine_lower') {
    const share = RIDER_POSE_TUNING.bounceDistribution.spine_lower
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch * share)
    // Drift bank — roll the torso around its forward (Z) axis. Lives
    // at the base of the spine so the whole upper body (and, via the
    // chain, the head) banks from the hips while hand IK keeps the
    // grips planted.
    const rollQ = quatAxisAngle(0, 0, 1, resp.leanRoll)
    return quatMul(rollQ, pitchQ)
  }
  if (kind === 'spine_upper') {
    const share = RIDER_POSE_TUNING.bounceDistribution.spine_upper
    const pitchQ = quatAxisAngle(1, 0, 0, resp.bouncePitch * share)
    const yawQ = quatAxisAngle(0, 1, 0, resp.flowYaw)
    return quatMul(yawQ, pitchQ)
  }
  if (kind === 'neck') {
    const yawQ = quatAxisAngle(0, 1, 0, resp.headYaw)
    const pitchQ = quatAxisAngle(1, 0, 0, resp.headPitch)
    return quatMul(yawQ, pitchQ)
  }
  return IDENT_QUAT
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function tickPoseResponse(
  resp: RiderPoseResponse,
  bikeLinvel: Vec3,
  bikeAngvel: Vec3,
  intent: Intent | undefined,
  /** Unshaped stick steer for the head-look (player: raw input, pre the
   *  PLAYER_STEER_SCALE + smoothing the bike's steering goes through; AI:
   *  same as `intent.steer`). The head must lead the bike, so it can't
   *  read the bike's own filtered steer. */
  lookSteer: number,
  driftDir: number,
  dt: number,
): void {
  // Bounce: critically-damped spring driven by vertical accel.
  const safeDt = Math.max(dt, 1e-4)
  const accelY = (bikeLinvel.y - resp.prevVel.y) / safeDt
  const force = -accelY * RIDER_POSE_TUNING.bounceForceGain
  const accel =
    -RIDER_POSE_TUNING.bounceSpringK * resp.bouncePitch -
    RIDER_POSE_TUNING.bounceSpringDamping * resp.bouncePitchVel +
    force
  resp.bouncePitchVel += accel * dt
  resp.bouncePitch += resp.bouncePitchVel * dt
  if (resp.bouncePitch > RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel > 0) resp.bouncePitchVel = 0
  } else if (resp.bouncePitch < -RIDER_POSE_TUNING.bounceMaxPitch) {
    resp.bouncePitch = -RIDER_POSE_TUNING.bounceMaxPitch
    if (resp.bouncePitchVel < 0) resp.bouncePitchVel = 0
  }

  // Flow yaw: low-pass toward bike yaw rate scaled.
  const yawRate = bikeAngvel.y
  const flowTarget = clamp(
    yawRate * RIDER_POSE_TUNING.flowYawPerYawRate,
    -RIDER_POSE_TUNING.flowMaxYaw,
    RIDER_POSE_TUNING.flowMaxYaw,
  )
  resp.flowYaw = lerp(resp.flowYaw, flowTarget, RIDER_POSE_TUNING.flowSmoothing)

  // Head yaw: driven by the RAW stick (`lookSteer`), attack/release
  // asymmetric — the head whips toward where the player is steering
  // (deeper deflection or a direction flip both attack) and drifts back
  // when the stick releases.
  const headYawTarget = clamp(
    lookSteer * RIDER_POSE_TUNING.headYawMax,
    -RIDER_POSE_TUNING.headYawMax,
    RIDER_POSE_TUNING.headYawMax,
  )
  const headYawFlip = headYawTarget * resp.headYaw < 0
  const headYawRate =
    headYawFlip || Math.abs(headYawTarget) > Math.abs(resp.headYaw)
      ? RIDER_POSE_TUNING.headYawAttack
      : RIDER_POSE_TUNING.headYawRelease
  resp.headYaw = lerp(resp.headYaw, headYawTarget, headYawRate)

  // Head pitch: throttle - brake.
  const throttle = intent?.throttle ?? 0
  const brake = intent?.brake ?? 0
  const pitchTarget = clamp(
    (throttle - brake * 1.5) * RIDER_POSE_TUNING.headPitchMax,
    -RIDER_POSE_TUNING.headPitchMax,
    RIDER_POSE_TUNING.headPitchMax,
  )
  resp.headPitch = lerp(resp.headPitch, pitchTarget, RIDER_POSE_TUNING.headPitchSmoothing)

  // Drift bank: low-pass toward the lean target (0 when not drifting,
  // so the torso eases back upright on release). Stays on the bike's
  // SHAPED steer — driftLeanIntoGain is tuned against its ±0.7 range.
  const leanTarget = driftLeanTarget(driftDir, intent?.steer ?? 0)
  resp.leanRoll = lerp(resp.leanRoll, leanTarget, RIDER_POSE_TUNING.driftLeanSmoothing)

  resp.prevVel.x = bikeLinvel.x
  resp.prevVel.y = bikeLinvel.y
  resp.prevVel.z = bikeLinvel.z
}

/** World-space rigid pose used by the chain walker. */
type WorldPose = { pos: Vec3; rot: Quat }

/** Run 2-bone IK and overwrite upper / lower arm world poses to land the
 *  hand at `handTargetWorld`. Both arms share the same algorithm with
 *  L/R differing only in which handlebar they aim at.
 *
 *  - `upperArmHalfHeight` / `lowerArmHalfHeight` are the bone capsule's
 *    cylindrical half-heights (Rapier convention). The bone's full length
 *    end-to-end is `2 * halfHeight + 2 * radius`, but for joint-anchor
 *    purposes we treat the bone-length axis as `2 * halfHeight` because
 *    that matches the `parentLocal`/`childLocal` anchors authored in
 *    `buildAnatomy()` (top of arm at +halfHeight, bottom at -halfHeight). */
function solveArmIK(
  shoulderWorld: Vec3,
  handTargetWorld: Vec3,
  upperArmHalfHeight: number,
  lowerArmHalfHeight: number,
  polePerpHint: Vec3,
): { upperArm: WorldPose; lowerArm: WorldPose } {
  const L1 = 2 * upperArmHalfHeight
  const L2 = 2 * lowerArmHalfHeight

  // Distance shoulder → hand, clamped to a reachable range.
  const sToH = vsub(handTargetWorld, shoulderWorld)
  const D = vlen(sToH)
  // Clamp to (|L1-L2|, L1+L2). Tiny epsilons so acos never sees ±1.
  const minD = Math.abs(L1 - L2) + 0.001
  const maxD = L1 + L2 - 0.001
  const clampedD = clamp(D, minD, maxD)

  // Direction shoulder → hand (unit).
  const sToHDir = D > 1e-6 ? vscale(sToH, 1 / D) : ({ x: 0, y: -1, z: 0 } as Vec3)

  // Shoulder offset angle off the shoulder→hand line, toward the elbow.
  const cosShoulder = (L1 * L1 + clampedD * clampedD - L2 * L2) / (2 * L1 * clampedD)
  const shoulderAngle = Math.acos(clamp(cosShoulder, -1, 1))

  // Pole-vector direction perpendicular to sToHDir. We project the hint
  // onto the plane perpendicular to sToHDir, then normalize. If the hint
  // is parallel to sToHDir we fall back to a fixed down-and-back vector.
  const hintDotDir =
    polePerpHint.x * sToHDir.x + polePerpHint.y * sToHDir.y + polePerpHint.z * sToHDir.z
  let perpRaw: Vec3 = {
    x: polePerpHint.x - sToHDir.x * hintDotDir,
    y: polePerpHint.y - sToHDir.y * hintDotDir,
    z: polePerpHint.z - sToHDir.z * hintDotDir,
  }
  if (vlen(perpRaw) < 1e-4) {
    // Fallback: any perpendicular to sToHDir.
    perpRaw = Math.abs(sToHDir.y) < 0.99 ? { x: 0, y: -1, z: 0 } : { x: 0, y: 0, z: -1 }
    const fbDot = perpRaw.x * sToHDir.x + perpRaw.y * sToHDir.y + perpRaw.z * sToHDir.z
    perpRaw = {
      x: perpRaw.x - sToHDir.x * fbDot,
      y: perpRaw.y - sToHDir.y * fbDot,
      z: perpRaw.z - sToHDir.z * fbDot,
    }
  }
  const perp = vnorm(perpRaw)

  // Elbow world position.
  const cosA = Math.cos(shoulderAngle)
  const sinA = Math.sin(shoulderAngle)
  const elbowWorld: Vec3 = {
    x: shoulderWorld.x + L1 * (cosA * sToHDir.x + sinA * perp.x),
    y: shoulderWorld.y + L1 * (cosA * sToHDir.y + sinA * perp.y),
    z: shoulderWorld.z + L1 * (cosA * sToHDir.z + sinA * perp.z),
  }
  // Hand world position — actual point we reach (clamped via clampedD if
  // the target was out of range, so the IK still produces a stable pose
  // when the hand can't quite get there).
  const handReached: Vec3 =
    D > 1e-6
      ? {
          x: shoulderWorld.x + sToHDir.x * clampedD,
          y: shoulderWorld.y + sToHDir.y * clampedD,
          z: shoulderWorld.z + sToHDir.z * clampedD,
        }
      : handTargetWorld

  // Upper arm: +Y in arm-local must point from shoulder toward elbow.
  const upperArmDir = vnorm(vsub(elbowWorld, shoulderWorld))
  const upperArmRot = quatFromTo({ x: 0, y: 1, z: 0 }, upperArmDir)
  // Bone center sits halfway along its +Y axis from the shoulder anchor.
  const upperArmPos: Vec3 = {
    x: shoulderWorld.x + upperArmDir.x * upperArmHalfHeight,
    y: shoulderWorld.y + upperArmDir.y * upperArmHalfHeight,
    z: shoulderWorld.z + upperArmDir.z * upperArmHalfHeight,
  }

  // Lower arm: +Y points from elbow toward hand.
  const lowerArmDir = vnorm(vsub(handReached, elbowWorld))
  const lowerArmRot = quatFromTo({ x: 0, y: 1, z: 0 }, lowerArmDir)
  const lowerArmPos: Vec3 = {
    x: elbowWorld.x + lowerArmDir.x * lowerArmHalfHeight,
    y: elbowWorld.y + lowerArmDir.y * lowerArmHalfHeight,
    z: elbowWorld.z + lowerArmDir.z * lowerArmHalfHeight,
  }

  return {
    upperArm: { pos: upperArmPos, rot: upperArmRot },
    lowerArm: { pos: lowerArmPos, rot: lowerArmRot },
  }
}

/** Walk the rider's joint hierarchy with applyOffsets enabled or disabled.
 *  Pelvis is anchored at `RIDER_POSE_TUNING.seatLocal` in bike-local space
 *  (so when frame=identity, the result is the rider's bike-local pose).
 *  With frame = bike's world transform, the result is the live world pose.
 *
 *  When `applyOffsets` is false the reactive offsets (bounce/flow/head)
 *  are skipped — used to produce the static REST pose from which the IK
 *  targets (hand + foot positions) are derived. */
function walkChain(
  rider: ReturnType<typeof RiderStore.must>,
  frameOrigin: Vec3,
  frameRot: Quat,
  applyOffsets: boolean,
): Map<RiderBoneName, WorldPose> {
  const poses = new Map<RiderBoneName, WorldPose>()
  const seat = RIDER_POSE_TUNING.seatLocal
  const pelvisOffset = rotByQuat(frameRot, seat.x, seat.y, seat.z)
  // Seat rotation — tilt / twist / bank the whole rider relative to the
  // bike's orientation. Composed onto the frame so the rest of the chain
  // (and the IK targets derived from it) rotate with the pelvis.
  const sr = RIDER_POSE_TUNING.seatRot
  const pelvisRot = quatMul(frameRot, quatPYR(sr.pitch, sr.yaw, sr.roll))
  poses.set('pelvis', {
    pos: {
      x: frameOrigin.x + pelvisOffset.x,
      y: frameOrigin.y + pelvisOffset.y,
      z: frameOrigin.z + pelvisOffset.z,
    },
    rot: pelvisRot,
  })
  for (const j of rider.joints) {
    const parent = poses.get(j.parentName)
    if (!parent) continue
    const baseRel = targetRelRotFor(j.kind)
    const offset = applyOffsets ? reactiveOffsetFor(j.kind, rider.poseResponse) : IDENT_QUAT
    const childRot = quatMul(parent.rot, quatMul(baseRel, offset))
    const parentAnchorWorld = rotByQuat(
      parent.rot,
      j.parentLocal.x,
      j.parentLocal.y,
      j.parentLocal.z,
    )
    const childAnchorLocal = rotByQuat(childRot, j.childLocal.x, j.childLocal.y, j.childLocal.z)
    const childPos: Vec3 = {
      x: parent.pos.x + parentAnchorWorld.x - childAnchorLocal.x,
      y: parent.pos.y + parentAnchorWorld.y - childAnchorLocal.y,
      z: parent.pos.z + parentAnchorWorld.z - childAnchorLocal.z,
    }
    poses.set(j.childName, { pos: childPos, rot: childRot })
  }
  return poses
}

/** Find the world position of the -Y "tip" end of a bone — used for
 *  IK end-effector targets (hand at the end of `lower_arm`, foot at the
 *  end of `lower_leg`). */
function tipOfBone(pose: WorldPose, halfHeight: number): Vec3 {
  const tip = rotByQuat(pose.rot, 0, -halfHeight, 0)
  return {
    x: pose.pos.x + tip.x,
    y: pose.pos.y + tip.y,
    z: pose.pos.z + tip.z,
  }
}

/** Lookup table for bone half-heights so the IK pass doesn't have to walk
 *  boneDims with a string-name match each call. Cached in the rider's
 *  Map<name, halfHeight>. Cheap — populated lazily on first use. */
function boneHalfHeights(rider: ReturnType<typeof RiderStore.must>): Map<RiderBoneName, number> {
  const out = new Map<RiderBoneName, number>()
  for (const name of Object.keys(rider.bones) as RiderBoneName[]) {
    const eid = rider.bones[name]
    const h = RBHandleStore.get(eid)
    if (!h) continue
    const dim = rider.boneDims.find((d) => d.rbHandle === h.handle)
    if (dim) out.set(name, dim.halfHeight)
  }
  return out
}

/** Apply 2-bone IK to either arm or leg. `parentBoneName` is the chest
 *  (for arms) or pelvis (for legs); `upperName` / `lowerName` are the
 *  bones to override; `tipTarget` is the world point the bone tip
 *  (hand / foot) should hit. */
function applyLimbIK(
  rider: ReturnType<typeof RiderStore.must>,
  poses: Map<RiderBoneName, WorldPose>,
  halfHeights: Map<RiderBoneName, number>,
  parentBoneName: RiderBoneName,
  upperName: RiderBoneName,
  lowerName: RiderBoneName,
  tipTarget: Vec3,
  poleHint: Vec3,
): void {
  const parent = poses.get(parentBoneName)
  if (!parent) return
  // Shoulder / hip world position = parent-side joint anchor in world.
  const upperJoint = rider.joints.find(
    (j) => j.parentName === parentBoneName && j.childName === upperName,
  )
  if (!upperJoint) return
  const anchorOffset = rotByQuat(
    parent.rot,
    upperJoint.parentLocal.x,
    upperJoint.parentLocal.y,
    upperJoint.parentLocal.z,
  )
  const anchorWorld: Vec3 = {
    x: parent.pos.x + anchorOffset.x,
    y: parent.pos.y + anchorOffset.y,
    z: parent.pos.z + anchorOffset.z,
  }
  const upperHH = halfHeights.get(upperName)
  const lowerHH = halfHeights.get(lowerName)
  if (upperHH === undefined || lowerHH === undefined) return
  // Add the lower bone's tip extent to the IK target — the user's IK
  // anchor is the END of the lower limb (hand / foot), but the 2-bone
  // solver places the LOWER joint anchor at `tipTarget`. So push the
  // target back by lowerHH along the natural "down-the-limb" axis...
  // simplest: just pass `tipTarget` shifted along the arm so the lower
  // bone's tip (not its anchor) lands on tipTarget.
  //
  // solveArmIK puts the lower bone's TOP (parent-anchor end) at the
  // elbow it solves for, then extends the bone by 2*halfHeight along the
  // arm direction. The "hand" tip is therefore elbow + 2*lowerHH along
  // (target - elbow) direction. To make the TIP land on `tipTarget`, we
  // pass IK a target that's `tipTarget` minus lowerHH along (target -
  // shoulder) direction. Approximated by shrinking the chain by lowerHH
  // along (target - shoulder).
  // But the existing solveArmIK already calls the second-bone tip "hand
  // reached" — we should just pass tipTarget directly. Verify with a
  // visual; if hands sit short, retune.
  const ik = solveArmIK(anchorWorld, tipTarget, upperHH, lowerHH, poleHint)
  poses.set(upperName, ik.upperArm)
  poses.set(lowerName, ik.lowerArm)
}

export function riderPoseSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const eids = query(sim, [Rider])
  for (const eid of eids) {
    const rider = RiderStore.must(eid)
    rider.stateAge += dt

    if (rider.state !== 'attached') continue

    const bikeRb = phys.world.getRigidBody(rider.bikeRbHandle)
    if (!bikeRb) continue
    const bikePos = bikeRb.translation() as Vec3
    const bikeRot = bikeRb.rotation() as Quat
    const bikeLinvel = bikeRb.linvel()
    const bikeAngvel = bikeRb.angvel()
    const intent = ControlIntentStore.get(rider.bikeEid)
    const driftDir = DriftStateStore.get(rider.bikeEid)?.driftDir ?? 0
    // Head-look source: the raw stick when this bike routes through the
    // player input pipeline, else the bike's ControlIntent (AI / replay —
    // already unshaped).
    const lookSteer = rawSteerFor(rider.bikeEid) ?? intent?.steer ?? 0

    tickPoseResponse(rider.poseResponse, bikeLinvel, bikeAngvel, intent, lookSteer, driftDir, dt)

    const halfHeights = boneHalfHeights(rider)

    // Pass 1 — REST pose in bike-local space. Used to derive IK end-effector
    // targets. Walking from frame=(origin, identity) means every pose is in
    // bike-local. Skipping reactive offsets gives the static rest pose.
    const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }
    const restPoses = walkChain(rider, ORIGIN, IDENT_QUAT, false)

    const lowerArmHH_L = halfHeights.get('lower_arm_L') ?? 0.18
    const lowerArmHH_R = halfHeights.get('lower_arm_R') ?? 0.18
    const lowerLegHH_L = halfHeights.get('lower_leg_L') ?? 0.24
    const lowerLegHH_R = halfHeights.get('lower_leg_R') ?? 0.24
    const handLocalL = tipOfBone(
      restPoses.get('lower_arm_L') ?? { pos: ORIGIN, rot: IDENT_QUAT },
      lowerArmHH_L,
    )
    const handLocalR = tipOfBone(
      restPoses.get('lower_arm_R') ?? { pos: ORIGIN, rot: IDENT_QUAT },
      lowerArmHH_R,
    )
    const footLocalL = tipOfBone(
      restPoses.get('lower_leg_L') ?? { pos: ORIGIN, rot: IDENT_QUAT },
      lowerLegHH_L,
    )
    const footLocalR = tipOfBone(
      restPoses.get('lower_leg_R') ?? { pos: ORIGIN, rot: IDENT_QUAT },
      lowerLegHH_R,
    )

    // Pass 2 — REACTIVE pose in world space. Reactive offsets applied;
    // pelvis world transform = bike transform * seat anchor.
    const poses = walkChain(rider, bikePos, bikeRot, true)

    // Convert each rest-derived limb-tip target from bike-local → world.
    const toWorld = (local: Vec3): Vec3 => {
      const r = rotByQuat(bikeRot, local.x, local.y, local.z)
      return { x: bikePos.x + r.x, y: bikePos.y + r.y, z: bikePos.z + r.z }
    }
    const handTargetL = toWorld(handLocalL)
    const handTargetR = toWorld(handLocalR)
    const footTargetL = toWorld(footLocalL)
    const footTargetR = toWorld(footLocalR)

    // Pole hints — "preferred elbow / knee bend direction" in bike-local
    // space (tunable via the rider editor), rotated into world by bike
    // orientation. The IK projects this onto the plane perpendicular to
    // shoulder→hand (or hip→foot) and bends toward it. See the
    // `armPole` / `legPole` notes on RIDER_POSE_TUNING for the sign.
    const armPoleLocal = RIDER_POSE_TUNING.armPole
    const legPoleLocal = RIDER_POSE_TUNING.legPole
    const armPole = rotByQuat(bikeRot, armPoleLocal.x, armPoleLocal.y, armPoleLocal.z)
    const legPole = rotByQuat(bikeRot, legPoleLocal.x, legPoleLocal.y, legPoleLocal.z)

    if (RIDER_POSE_TUNING.handIKStrength > 0) {
      applyLimbIK(
        rider,
        poses,
        halfHeights,
        'chest',
        'upper_arm_L',
        'lower_arm_L',
        handTargetL,
        armPole,
      )
      applyLimbIK(
        rider,
        poses,
        halfHeights,
        'chest',
        'upper_arm_R',
        'lower_arm_R',
        handTargetR,
        armPole,
      )
    }
    if (RIDER_POSE_TUNING.footIKStrength > 0) {
      applyLimbIK(
        rider,
        poses,
        halfHeights,
        'pelvis',
        'upper_leg_L',
        'lower_leg_L',
        footTargetL,
        legPole,
      )
      applyLimbIK(
        rider,
        poses,
        halfHeights,
        'pelvis',
        'upper_leg_R',
        'lower_leg_R',
        footTargetR,
        legPole,
      )
    }

    // Write out world poses to Rapier.
    for (const [name, pose] of poses) {
      const boneEid = rider.bones[name]
      const handle = RBHandleStore.get(boneEid)
      if (!handle) continue
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue
      rb.setNextKinematicTranslation(pose.pos)
      rb.setNextKinematicRotation(pose.rot)
    }
  }
}

/**
 * Reset a rider to its attached rest pose. If the rider was launched, this
 * tears down the ragdoll: removes its joints + colliders, swaps the bones
 * back to KinematicPositionBased, and clears the bone velocities so the
 * next pose tick places everything at the bike's seat without a one-frame
 * teleport visible.
 *
 * Safe to call when the rider is already attached — it just zeroes the
 * pose-response state so any in-progress bounce/flow lerp lands at zero.
 */
export function resetRider(phys: PhysicsWorld, rider: ReturnType<typeof RiderStore.must>): void {
  if (rider.state === 'launched') {
    for (let i = rider.joints.length - 1; i >= 0; i--) {
      const j = rider.joints[i]
      if (!j || j.jointHandle === null) continue
      try {
        const joint = phys.world.getImpulseJoint(j.jointHandle)
        if (joint) phys.world.removeImpulseJoint(joint, true)
      } catch {
        // Joint may already be invalid; not a reset blocker.
      }
      j.jointHandle = null
    }
    const Kinematic = phys.rapier.RigidBodyType.KinematicPositionBased
    for (const dim of rider.boneDims) {
      const rb = phys.world.getRigidBody(dim.rbHandle)
      if (!rb) continue
      while (rb.numColliders() > 0) {
        const c = rb.collider(0)
        if (!c) break
        phys.world.removeCollider(c, true)
      }
      rb.setBodyType(Kinematic, true)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
    rider.state = 'attached'
    rider.motorScale = 1
    rider.stateAge = 0
  }
  zeroPoseResponse(rider.poseResponse)
}

export function resetRiderForBike(sim: SimWorld, phys: PhysicsWorld, bikeEid: number): boolean {
  const eids = query(sim, [Rider])
  for (const eid of eids) {
    const r = RiderStore.must(eid)
    if (r.bikeEid === bikeEid) {
      resetRider(phys, r)
      return true
    }
  }
  return false
}
