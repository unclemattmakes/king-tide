import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, vecHorizontalLength } from '@/engine/sim/physics/vec'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  BikeStats,
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'

const MAX_HOVER_PROBE = 6
const GRAVITY = 25 // must match PhysicsWorld gravity magnitude

// Slope-momentum tuning — exported for tests / debug overlays. Asymmetric
// gain: a hard 1.0× push down a wave face, a gentle 0.5× drag up one.
export const SLOPE_DOWN_GAIN = 1.0
export const SLOPE_UP_BRAKE = 0.5

/**
 * Marble-on-incline acceleration along the bike's horizontal forward axis.
 *
 * Driven by `surfacePitchTarget` — the *terrain-tracking* pitch (positive =
 * nose-down on a downslope, zero on flat ground, negative on an upslope).
 * Crucially this is the surface signal, not the chassis's current pitch:
 * the chassis pitch also folds in the player's Q/E input, and feeding that
 * in would let the rider farm free downhill thrust by tipping the nose on
 * flat ground.
 */
export function slopeMomentumAccel(
  surfacePitchTarget: number,
  gravity: number = GRAVITY,
  downGain: number = SLOPE_DOWN_GAIN,
  upBrake: number = SLOPE_UP_BRAKE,
): number {
  const gain = surfacePitchTarget > 0 ? downGain : upBrake
  return Math.sin(surfacePitchTarget) * gravity * gain
}

/**
 * Surface probe: looks below an XZ point for the closest "ride surface".
 * Either a hard physical collider (raycast) or the wave field water surface,
 * whichever is *higher* (closer to the bike) wins. This unifies driving on
 * land and driving on water — same controller, different surface y.
 *
 * Used both as the *center probe* (one per bike, drives hover spring +
 * grounded gating + dive logic) and as the *footprint probes* (four per
 * bike at bow / stern / port / starboard, drive surface alignment). The
 * footprint version (`probeSurfaceY`) only needs the height — it doesn't
 * care about isWater/hasSurface gating.
 */
type SurfaceProbe = {
  surfaceY: number
  isWater: boolean
  hasSurface: boolean
}

function probeSurface(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): SurfaceProbe {
  const ray = new phys.rapier.Ray({ x: fromX, y: fromY, z: fromZ }, { x: 0, y: -1, z: 0 })
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  const groundY = hit ? fromY - hit.timeOfImpact : Number.NEGATIVE_INFINITY
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY

  // Higher surface wins — that's what the bike rides on.
  if (groundY === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return { surfaceY: 0, isWater: false, hasSurface: false }
  }
  if (groundY > waterY) {
    return { surfaceY: groundY, isWater: false, hasSurface: true }
  }
  // Water can be sampled anywhere, so water is "always reachable" — but only
  // counts as a ride surface if the bike is within probe range of it.
  const reachable = fromY - waterY < MAX_HOVER_PROBE
  return { surfaceY: waterY, isWater: true, hasSurface: reachable }
}

/**
 * Footprint probe: just the height at (x, z), max of ground raycast and
 * wave field. Returns NEGATIVE_INFINITY if neither is found (caller falls
 * back to the center probe — see surface alignment block).
 *
 * `lift` raises the ray origin above the bike center so the cast can see
 * terrain rising ABOVE the bike — critical for ramp anticipation. A bow
 * probe at t.y casting down will MISS an upcoming ramp face that climbs
 * higher than the bike's current Y. Lifting the origin lets the same
 * ray hit that face from above instead of passing through the air over it.
 * Cast distance grows to compensate so the same set of terrain below
 * remains reachable.
 */
function probeSurfaceY(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  x: number,
  fromY: number,
  z: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
  lift = 0,
): number {
  const originY = fromY + lift
  const ray = new phys.rapier.Ray({ x, y: originY, z }, { x: 0, y: -1, z: 0 })
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE + lift,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  const groundY = hit ? originY - hit.timeOfImpact : Number.NEGATIVE_INFINITY
  const waterY = field ? sampleHeight(field, x, z) : Number.NEGATIVE_INFINITY
  if (groundY === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return Number.NEGATIVE_INFINITY
  }
  return Math.max(groundY, waterY)
}

/**
 * Per-bike: probe ground/water, apply hover/thrust/steer/lateral-drag.
 * All coefficients are in acceleration units (m/s^2 per unit). Impulses are
 * computed as accel * mass * dt so tuning stays decoupled from mass.
 */
export function hoverSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState | null): void {
  const eids = query(sim, [BikeTag, RBHandle, BikeStats, ControlIntent, HoverState])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const stats = BikeStatsStore.must(eid)
    const intent = ControlIntentStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    // M10.11 — kinematic bikes (remote players on non-host, AI bikes on
    // non-host) are pose-driven by network snapshots. The hover spring,
    // surface alignment, and angular damping below all mutate the rigid
    // body, which would fight `setNextKinematicTranslation`. Skip.
    if (!rb.isDynamic()) continue

    const t = rb.translation()
    const linvel = rb.linvel()
    const dt = phys.fixedDt
    const m = stats.mass

    const probe = probeSurface(phys, field, t.x, t.y, t.z, rb)
    const groundDistance = probe.hasSurface ? t.y - probe.surfaceY : MAX_HOVER_PROBE
    const isGrounded = probe.hasSurface && groundDistance < stats.hoverHeight * 1.6

    // Surface alignment: figure out how the chassis should sit relative to
    // the surface it's riding. When airborne we don't know what surface the
    // bike is heading toward, so the targets stay 0 and the bike just holds
    // its current attitude.
    //
    // Multi-probe sampling (SoT/Atlas-style), unified across water + ground.
    // Read the surface height at four points around the bike — bow, stern,
    // port, starboard — and let pitch/roll fall out of differential heights:
    //
    //     pitch ≈ atan2(y_bow − y_stern, 2·halfLength)
    //     roll  ≈ atan2(y_starboard − y_port, 2·halfWidth)
    //
    // Each probe takes max(ground raycast, wave field height), so a bike
    // straddling the shoreline correctly reads the high terrain on one side
    // and the wave on the other. This is *more correct* than reading the
    // local wave normal under the bike's center, because the bike has a
    // real footprint in world space:
    //   1. Long swells naturally tilt the bike across the wave.
    //   2. Short chops + sub-footprint terrain bumps average between probes
    //      so the bike doesn't whip-snap to every ripple or trimesh edge.
    //   3. Mixed water/terrain transitions (water lapping a ledge, bow over
    //      a ramp with stern still on water) read continuously instead of
    //      flickering between water-only and ground-only branches.
    //
    // `surfaceForwardSlope` is the bow→stern height differential as a
    // dy/dx ratio along the bike's forward direction (negative ⇒ downslope
    // ahead). Captured outside the grounded gate so the landing-redirect
    // block below can read it without re-sampling.
    // Surface alignment + multi-probe sampling. Read the surface height
    // at four points around the bike — bow, stern, port, starboard — so
    // the multi-point hover spring below can apply differential vertical
    // forces at each probe position. Differential forces produce
    // physically correct alignment torques: bow lower than nominal hover
    // height → bigger upward force at bow → bike pitches nose-up to match
    // the surface. Same trick rolls the bike into a wave normal across
    // port/starboard. No kinematic re-imposition anywhere — the rider
    // asked for full physics, this is how a hover-bike self-aligns
    // physically (Trials feel).
    //
    // `surfaceForwardSlope` is the bow→stern height differential as a
    // dy/dx ratio along the bike's forward direction (negative ⇒ downslope
    // ahead). Captured at outer scope so the landing-redirect block below
    // can read it without re-sampling.
    let surfaceForwardSlope = 0
    let yBow = Number.NEGATIVE_INFINITY
    let yStern = Number.NEGATIVE_INFINITY
    let yStarboard = Number.NEGATIVE_INFINITY
    let yPort = Number.NEGATIVE_INFINITY
    let probeHalfLength = 0.8
    let probeHalfWidth = 0.4
    let probeFwdX = 0
    let probeFwdZ = 1
    let probeRightX = 1
    let probeRightZ = 0
    if (isGrounded) {
      const q0_ = rb.rotation()
      const r02_ = 2 * (q0_.x * q0_.z + q0_.y * q0_.w)
      const r22_ = 1 - 2 * (q0_.x * q0_.x + q0_.y * q0_.y)
      const yaw_ = Math.atan2(r02_, r22_)
      const cy_ = Math.cos(yaw_)
      const sy_ = Math.sin(yaw_)

      // Probe footprint matches the bike's visual scale (~1.6m × 0.8m) at
      // rest, then extends fore/aft with horizontal speed. The point of
      // the speed scaling is *anticipation*: at 25 m/s the bow probe is
      // ~2m out in front of the chassis, so the bike starts pitching to
      // match the slope it's about to hit, not the flat ground it's
      // currently on. Width stays small — no need to anticipate sideways
      // terrain, the bike doesn't strafe.
      const speedHoriz = Math.hypot(linvel.x, linvel.z)
      probeHalfLength = 0.8 + Math.min(speedHoriz * 0.05, 1.4)
      probeHalfWidth = 0.4
      // Bike-fwd in world XZ: (sin(yaw), cos(yaw)).
      // Bike-right in world XZ: (cos(yaw), -sin(yaw)).
      probeFwdX = sy_
      probeFwdZ = cy_
      probeRightX = cy_
      probeRightZ = -sy_
      // Each probe casts from PROBE_LIFT *above* the bike center so a
      // rising surface in front of the bike (a ramp face, a hill) is
      // correctly intersected from above.
      const PROBE_LIFT = 3
      // probeSurfaceY returns max(ground, water) per location; falls back to
      // the center probe's surfaceY if neither hit (bike overhanging an edge
      // with nothing below — read the missing side as flat with the center
      // rather than NaN).
      const fallbackY = probe.surfaceY
      const sampleAt = (px: number, pz: number): number => {
        const y = probeSurfaceY(phys, field, px, t.y, pz, rb, PROBE_LIFT)
        return y === Number.NEGATIVE_INFINITY ? fallbackY : y
      }
      yBow = sampleAt(t.x + probeFwdX * probeHalfLength, t.z + probeFwdZ * probeHalfLength)
      yStern = sampleAt(t.x - probeFwdX * probeHalfLength, t.z - probeFwdZ * probeHalfLength)
      yStarboard = sampleAt(t.x + probeRightX * probeHalfWidth, t.z + probeRightZ * probeHalfWidth)
      yPort = sampleAt(t.x - probeRightX * probeHalfWidth, t.z - probeRightZ * probeHalfWidth)
      surfaceForwardSlope = (yBow - yStern) / (2 * probeHalfLength)
    }

    // Attitude is FULLY PHYSICS-DRIVEN in this build — no kinematic
    // re-imposition of pitch or roll, no angvel stripping. The bike
    // tilts in response to:
    //   - Multi-point hover spring (below): differential vertical forces
    //     at bow/stern/port/starboard align the chassis to the local
    //     surface contour automatically.
    //   - Steer → roll torque around bike-fwd axis (lean into corners).
    //   - Player pitch input → torque around bike-right axis (commit
    //     to a nose-up or nose-down attitude that *persists*: holding
    //     the stick in the air integrates to a full backflip / dive;
    //     releasing lets Rapier angular damping bleed the spin but
    //     leaves the ANGLE wherever physics left it).
    //   - Yaw torque around world Y (unchanged) + lateral fishtail bias.
    //
    // Trials-style: input commands forces, not orientations. Sim "takes
    // over" the moment you let go.
    const prevHover = HoverStateStore.get(eid)
    const prevGrounded = prevHover?.isGrounded ?? false

    // Bad-landing crash. On the airborne→grounded transition over LAND,
    // if the chassis is wildly off the surface contour while moving
    // forward, kill horizontal velocity — the rider-crash Δv detector
    // picks up the dump next tick and ragdolls. Gated by speed so slow
    // tumbles just bounce. Water is exempt: nose-diving into water is
    // supposed to plough under, not ragdoll the rider.
    if (!prevGrounded && isGrounded && !probe.isWater) {
      const qLand = rb.rotation()
      const r12Land = 2 * (qLand.y * qLand.z - qLand.x * qLand.w)
      const pitchLand = Math.asin(Math.max(-1, Math.min(1, -r12Land)))
      const surfacePitchAtLanding = -Math.atan(surfaceForwardSlope)
      const pitchOffSurface = Math.abs(pitchLand - surfacePitchAtLanding)
      const horizSpeedLand = Math.hypot(linvel.x, linvel.z)
      const BAD_LAND_PITCH = Math.PI / 3 // 60° off the surface contour
      const BAD_LAND_MIN_SPEED = 8 // m/s — slow tumbles just snap, no crash
      if (pitchOffSurface > BAD_LAND_PITCH && horizSpeedLand > BAD_LAND_MIN_SPEED) {
        rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      }
    }

    // Continuous bad-attitude crash on land. Multi-point hover's
    // alignment torque is `r × F` from per-corner lift forces, and at
    // extreme pitch (nose down past 75° or so) the corner-to-CoM
    // displacement becomes parallel to the upward force vector — the
    // cross product collapses to zero, no restoring torque at all.
    // Without this check the bike would sit happily at vertical nose-
    // down on flat ground, hovered up by the bow's pure-linear lift
    // with nothing to right it. Crash instead: kill horizontal velocity,
    // rider-crash picks up the Δv next tick. Water is exempt — diving
    // into water is supposed to work.
    if (isGrounded && !probe.isWater) {
      const qBad = rb.rotation()
      const r12Bad = 2 * (qBad.y * qBad.z - qBad.x * qBad.w)
      const pitchBad = Math.asin(Math.max(-1, Math.min(1, -r12Bad)))
      const BAD_GROUND_PITCH = (75 * Math.PI) / 180
      if (Math.abs(pitchBad) > BAD_GROUND_PITCH) {
        rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      }
    }

    const q = rb.rotation()

    // Multi-point hover spring. Fires only while grounded. Instead of a
    // single force at CoM, apply 1/4-mass vertical impulses at each of
    // the bow, stern, port, starboard probe positions. Each point's
    // upward force is sized by its LOCAL height error vs the surface
    // below it; differential forces naturally torque the chassis to
    // align with the surface contour — bow dips on flat ground →
    // strong upward kick at bow → pitch nose-up to neutral; starboard
    // sinks into a wave trough → strong kick on starboard → roll left.
    //
    // Sum of per-point forces equals the old single-point force when all
    // four heights agree, so vertical tuning (hoverSpring, hoverDamp)
    // transfers directly. The alignment torque is a free byproduct of
    // the multi-point geometry — no PD reading orientation, no kinematic
    // re-imposition.
    //
    // Underwater branch (M9.23 — Wave Race feel) stays single-point: when
    // the bike has dived below the water surface (groundDistance < 0 on
    // water), depth-proportional buoyancy + quadratic drag take over.
    // Symmetric spring would slam the bike back up the instant it dipped
    // below; instead we let dive momentum carry it under, drag bleeds the
    // momentum off, capped buoyancy walks it back up. Tuning targets a
    // peak depth around 1–2m on a hard dive.
    if (probe.hasSurface && isGrounded) {
      if (probe.isWater && groundDistance < 0) {
        const submersion = -groundDistance
        const BUOYANCY_PER_M = 14
        const BUOYANCY_CAP = 20
        // Asymmetric Y-axis drag: full strength when SINKING (kills dive
        // momentum so the bike actually slows as it reaches max depth),
        // much weaker when RISING so the accumulated buoyancy isn't
        // fought by drag on the way up.
        const DRAG_K_HORIZ = 0.1
        const DRAG_K_SINK = 0.1
        const DRAG_K_RISE = 0.03
        const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
        const speed = Math.hypot(linvel.x, linvel.y, linvel.z)
        const horizDragCoef = -DRAG_K_HORIZ * speed
        const yDragK = linvel.y > 0 ? DRAG_K_RISE : DRAG_K_SINK
        const yDragCoef = -yDragK * speed
        rb.applyImpulse(
          {
            x: linvel.x * horizDragCoef * m * dt,
            y: (GRAVITY + aBuoy + linvel.y * yDragCoef) * m * dt,
            z: linvel.z * horizDragCoef * m * dt,
          },
          true,
        )
      } else {
        const angv = rb.angvel()
        const POINT_MASS_FRAC = 0.25
        // Full 3D probe offsets. XZ uses the yaw-only projection (which
        // is also where the surface was sampled), Y uses the bike's true
        // forward/right vectors so a pitched-up bike's bow is genuinely
        // higher in world. That y-difference is what gives flat-ground
        // roll/pitch their restoring force: lean the bike right →
        // starboard point's world-y drops → bigger heightError on
        // starboard → bigger upward force → torque rolls bike back level.
        //
        // `longitudinal` tags the bow/stern probes vs port/starboard.
        // On water, the longitudinal spring is softened so the bike
        // pushes THROUGH chop instead of pitching to match every wave
        // crest. Lateral (roll-axis) spring keeps full stiffness — the
        // bike still banks into long swells.
        const fwd3D = quatRotate(q, { x: 0, y: 0, z: 1 })
        const right3D = quatRotate(q, { x: 1, y: 0, z: 0 })
        const points: {
          ox: number
          oy: number
          oz: number
          surfY: number
          longitudinal: boolean
        }[] = [
          {
            ox: probeFwdX * probeHalfLength,
            oy: fwd3D.y * probeHalfLength,
            oz: probeFwdZ * probeHalfLength,
            surfY: yBow,
            longitudinal: true,
          },
          {
            ox: -probeFwdX * probeHalfLength,
            oy: -fwd3D.y * probeHalfLength,
            oz: -probeFwdZ * probeHalfLength,
            surfY: yStern,
            longitudinal: true,
          },
          {
            ox: probeRightX * probeHalfWidth,
            oy: right3D.y * probeHalfWidth,
            oz: probeRightZ * probeHalfWidth,
            surfY: yStarboard,
            longitudinal: false,
          },
          {
            ox: -probeRightX * probeHalfWidth,
            oy: -right3D.y * probeHalfWidth,
            oz: -probeRightZ * probeHalfWidth,
            surfY: yPort,
            longitudinal: false,
          },
        ]
        // Tuned by playtest: 0.4× reads as "the bow plows through chop
        // without losing all wave-following on long swells." Drop further
        // to make it feel like a boat slamming through, raise toward 1
        // to bring back the strict wave-conforming feel.
        const WATER_LONGITUDINAL_SPRING_MUL = 0.4
        // Per-corner buoyancy constants for submerged corners on water.
        // Matches the center-submerged underwater branch so the transition
        // (corner-by-corner submersion → full center submersion) is smooth.
        const BUOYANCY_PER_M = 14
        const BUOYANCY_CAP = 20
        for (const p of points) {
          const worldY = t.y + p.oy
          const localDist = worldY - p.surfY
          // Per-corner "locally grounded" gate. The bow probe, with its
          // speed-anticipation reach, projects past a ramp lip before the
          // bike does — past the lip it samples the much lower ground
          // beyond, and a naive heightError would fire a huge DOWNWARD
          // spring force at the bow right at takeoff (the "sticky nose"
          // nose-dive). Skip a corner once its local surface is further
          // than the grounded threshold below it; that corner is
          // effectively airborne even though another corner is still on
          // the ramp.
          if (localDist > stats.hoverHeight * 1.6) continue
          // v_y at this offset = linvel.y + (ω × offset).y = linvel.y + ω.z*ox − ω.x*oz
          const vAtPointY = linvel.y + angv.z * p.ox - angv.x * p.oz
          const dampVy = Math.max(vAtPointY, 0)
          let aUp: number
          if (probe.isWater && localDist < 0) {
            // Submerged on water. Use capped buoyancy instead of the
            // stiff hover spring so a nose-dive with enough inertia
            // actually goes under — the spring's unbounded heightError
            // (1.2 − negative = arbitrarily large) would otherwise
            // shove a submerged corner back up violently and prevent
            // any dive at all.
            const submersion = -localDist
            const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
            aUp = GRAVITY + aBuoy - dampVy * stats.hoverDamp
          } else {
            const heightError = stats.hoverHeight - localDist
            const springMul =
              probe.isWater && p.longitudinal ? WATER_LONGITUDINAL_SPRING_MUL : 1.0
            aUp = GRAVITY + heightError * stats.hoverSpring * springMul - dampVy * stats.hoverDamp
          }
          rb.applyImpulseAtPoint(
            { x: 0, y: aUp * POINT_MASS_FRAC * m * dt, z: 0 },
            { x: t.x + p.ox, y: worldY, z: t.z + p.oz },
            true,
          )
        }
      }
    }

    // Water pitch damping. The multi-point hover's asymmetry on big swells
    // (bow over crest fires, stern in deep trough hits the locally-airborne
    // gate and contributes nothing) pumps pitch angvel faster than Rapier's
    // default 2.5 angular damping can bleed it — the bike would otherwise
    // pitch toward vertical inside a few seconds. Adds modest viscous
    // resistance to pitch-axis rotation while grounded over water. Kept
    // low (2 vs Rapier's default 2.5) because per-corner buoyancy already
    // caps the wave-forcing on submerged corners — pushing damping higher
    // here makes the player's pitch input feel sticky on water and then
    // suddenly loose when the bike pops above the surface.
    if (isGrounded && probe.isWater) {
      const rightWater = quatRotate(rb.rotation(), { x: 1, y: 0, z: 0 })
      const angvWater = rb.angvel()
      const pitchVelWater =
        angvWater.x * rightWater.x + angvWater.y * rightWater.y + angvWater.z * rightWater.z
      const PITCH_WATER_DAMP = 2 // rad/s² per rad/s of pitch velocity
      const aPitchDamp = -pitchVelWater * PITCH_WATER_DAMP
      rb.applyTorqueImpulse(
        {
          x: rightWater.x * aPitchDamp * m * dt,
          y: rightWater.y * aPitchDamp * m * dt,
          z: rightWater.z * aPitchDamp * m * dt,
        },
        true,
      )
    }

    HoverStateStore.set(eid, {
      groundDistance,
      isGrounded,
      surfaceIsWater: probe.hasSurface && probe.isWater,
      // inputPitch is deprecated since pitch is now physics-driven
      // (torque, not a stored bias). Kept at 0 for backwards compat.
      inputPitch: 0,
    })

    // Player pitch torque — applied around the bike's right axis in both
    // ground and air. The stick commands an angular *force*; pitch ANGLE
    // integrates from there. On ground, the multi-point hover spring fights
    // it (a held stick settles at an offset pitch where torque balances the
    // spring's restoring torque); release lets the spring re-level. In
    // air, only Rapier's angular damping bleeds the angvel — the pitch
    // angle persists wherever physics left it (Trials backflip feel).
    //
    // Sign: intent.pitch=+1 (E, "nose up") → torque around -rightAxis,
    // which rotates fwd toward +y (nose up).
    if (Math.abs(intent.pitch) > 0.05) {
      const rightP = quatRotate(q, { x: 1, y: 0, z: 0 })
      const PITCH_TORQUE_ACCEL = 6 // rad/s² at full input
      const aPitch = -intent.pitch * PITCH_TORQUE_ACCEL
      rb.applyTorqueImpulse(
        {
          x: rightP.x * aPitch * m * dt,
          y: rightP.y * aPitch * m * dt,
          z: rightP.z * aPitch * m * dt,
        },
        true,
      )
    }

    if (!isGrounded) {
      // --- Air control ---
      // Hang-time: counter ~60% of gravity so the bike floats through
      // arcs JetMoto-style instead of dropping like a brick. Effective
      // gravity in air ≈ 10 m/s² vs 25 on the ground — close to
      // real-world Earth pull, well below arcade ground gravity.
      const AIR_LIFT_FRAC = 0.6
      rb.applyImpulse({ x: 0, y: GRAVITY * AIR_LIFT_FRAC * m * dt, z: 0 }, true)

      // Pitch-vectored thrust: airborne thrust pushes along the bike's
      // true forward direction. The bike's visual nose orientation
      // matches its body +Z axis, so:
      //   Q (intent.pitch=-1) → fwd.y < 0 (nose visibly down) → thrust
      //     along fwd pushes the bike DOWN = dives.
      //   E (intent.pitch=+1) → fwd.y > 0 (nose visibly up) → thrust
      //     pushes the bike UP = extends air time.
      // The keyboard.ts comments ("Q = pitch up / jump off a wave")
      // describe the rider's body action ("lean back"), not the bike's
      // pitch — playtest is the source of truth here. Slightly weaker
      // than ground thrust so the player can't infinite-hover by aiming
      // up + boost; speedFalloff in 3D also caps any sustained climb at
      // topSpeed.
      const fwdAir = quatRotate(q, { x: 0, y: 0, z: 1 })
      if (Math.abs(intent.throttle) > 0) {
        const speed3d = Math.hypot(linvel.x, linvel.y, linvel.z)
        const dirAir = intent.throttle >= 0 ? 1 : -1
        const scaleAir = intent.throttle >= 0 ? 1 : stats.reverseScale
        const speedFalloff3d = Math.max(0, 1 - speed3d / stats.topSpeed)
        const boostAir = (intent.boost ? stats.boostMul : 1) * getCurrentBoostMultiplier(eid)
        const AIR_THRUST_MUL = 0.85
        const aAir =
          Math.abs(intent.throttle) *
          stats.accel *
          scaleAir *
          speedFalloff3d *
          boostAir *
          dirAir *
          AIR_THRUST_MUL
        rb.applyImpulse(
          {
            x: fwdAir.x * aAir * m * dt,
            y: fwdAir.y * aAir * m * dt,
            z: fwdAir.z * aAir * m * dt,
          },
          true,
        )
      }

      // Yaw around the "pure heading" axis: world-up with the bike-fwd
      // projection removed (then normalised). Perpendicular to bike-fwd
      // by construction, so steering in the air can't leak into roll
      // even when the bike is pitched up after a ramp. Plain world-Y
      // here would project onto bike-fwd whenever fwd.y ≠ 0 and roll
      // the bike sideways — the angvel strip at the top of the next
      // tick zeroes the roll velocity, but the rotation has already
      // integrated during phys.step. Pure-heading axis avoids the leak
      // entirely.
      //
      // Reduced authority (×0.3) preserved for landing alignment.
      const AIR_TURN_MUL = 0.3
      const aTurnAir = -intent.steer * stats.turnTorque * AIR_TURN_MUL
      const fwdAxisDot = fwdAir.y // (0,1,0) · fwdAir
      const yawAxXAir = -fwdAxisDot * fwdAir.x
      const yawAxYAir = 1 - fwdAxisDot * fwdAir.y
      const yawAxZAir = -fwdAxisDot * fwdAir.z
      const yawAxLenAir = Math.hypot(yawAxXAir, yawAxYAir, yawAxZAir)
      if (yawAxLenAir > 0.01) {
        const invLen = 1 / yawAxLenAir
        rb.applyTorqueImpulse(
          {
            x: yawAxXAir * invLen * aTurnAir * m * dt,
            y: yawAxYAir * invLen * aTurnAir * m * dt,
            z: yawAxZAir * invLen * aTurnAir * m * dt,
          },
          true,
        )
      }

      // Air roll leveler — gentle PD toward zero roll. The roll ANGLE at
      // takeoff (e.g. a fully laid-over corner) is preserved by the air
      // branch's "free physics" approach, which left the bike stuck on
      // its side mid-jump. Low gain so steer-driven aerial banking still
      // works as a transient, but neutral is the attractor over ~2s.
      // Skipped past 60° of pitch so backflips/dives aren't fought.
      const r10A = 2 * (q.x * q.y + q.z * q.w)
      const r11A = 1 - 2 * (q.x * q.x + q.z * q.z)
      const r12A = 2 * (q.y * q.z - q.x * q.w)
      const pitchA = Math.asin(Math.max(-1, Math.min(1, -r12A)))
      if (Math.abs(pitchA) < Math.PI / 3) {
        const currentRollA = Math.atan2(r10A, r11A)
        const angvA = rb.angvel()
        const rollVelA = angvA.x * fwdAir.x + angvA.y * fwdAir.y + angvA.z * fwdAir.z
        const AIR_ROLL_P = 3
        const AIR_ROLL_D = 2
        const aRollAir = -currentRollA * AIR_ROLL_P - rollVelA * AIR_ROLL_D
        rb.applyTorqueImpulse(
          {
            x: fwdAir.x * aRollAir * m * dt,
            y: fwdAir.y * aRollAir * m * dt,
            z: fwdAir.z * aRollAir * m * dt,
          },
          true,
        )
      }

      continue
    }

    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

    const speed = vecHorizontalLength({ x: linvel.x, y: 0, z: linvel.z })

    // Brake — opposes current horizontal velocity. Lets the AI (and the
    // player) actually slow down before a corner instead of relying solely
    // on letting off the throttle.
    if (intent.brake > 0 && speed > 0.5) {
      const brakeAccel = intent.brake * 18 // m/s^2 at full brake
      rb.applyImpulse(
        {
          x: -(linvel.x / speed) * brakeAccel * m * dt,
          y: 0,
          z: -(linvel.z / speed) * brakeAccel * m * dt,
        },
        true,
      )
    }

    // Forward thrust (water adds extra drag — slightly less responsive).
    const throttle = intent.throttle
    const direction = throttle >= 0 ? 1 : -1
    const scale = throttle >= 0 ? 1 : stats.reverseScale
    const speedFalloff = Math.max(0, 1 - speed / stats.topSpeed)
    const heldBoost = intent.boost ? stats.boostMul : 1
    const pickupBoost = getCurrentBoostMultiplier(eid)
    const boost = heldBoost * pickupBoost
    const surfaceMul = probe.isWater ? 0.85 : 1.0
    const aThrust =
      Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction * surfaceMul
    rb.applyImpulse({ x: fwd.x * aThrust * m * dt, y: 0, z: fwd.z * aThrust * m * dt }, true)

    // Slope momentum — going down a wave is faster than climbing one.
    // The chassis tilts to track the surface (multi-probe alignment above);
    // we project gravity along the horizontal forward axis to get the
    // marble-on-incline behaviour: down-slope → accelerate; up-slope →
    // decelerate. The hover spring cancels gravity vertically, so without
    // this the chassis would pitch but coast at the same horizontal speed
    // regardless of wave face.
    //
    // Driven by `surfacePitchTarget` (the terrain-tracking pitch), NOT by
    // the chassis's current `fwd.y`. The chassis pitch also folds in the
    // player's Q/E input bias, so using `fwd.y` here would let the rider
    // pitch the nose down on flat ground and harvest free downhill thrust.
    // `surfacePitchTarget` is 0 when airborne and `followNow * -atan(slope)`
    // when grounded — exactly the contour signal the gravity projection
    // wants.
    //
    // Asymmetric coupling — motocross feel: a strong downhill push (1.0×
    // gravity) makes hitting a downslope read as the slingshot it is; the
    // uphill brake stays gentle (0.5×) so a long climb doesn't grind the
    // bike to a crawl. On a 16° downramp that's +6.9 m/s² of forward push
    // (enough to easily exceed topSpeed with momentum), while climbing the
    // same slope costs only -3.4 m/s² of drag, which the bike's 19 m/s²
    // thrust eats through comfortably.
    const fwdHorizLen = Math.hypot(fwd.x, fwd.z)
    if (fwdHorizLen > 0.01) {
      // Slope momentum reads the *surface* contour, not chassis pitch —
      // so the rider can't farm free downhill thrust by pitching the
      // nose forward. `-atan(surfaceForwardSlope)` matches the previous
      // `surfacePitchTarget` sign (negative on upslope, positive on down).
      const aSlope = slopeMomentumAccel(-Math.atan(surfaceForwardSlope))
      rb.applyImpulse(
        {
          x: (fwd.x / fwdHorizLen) * aSlope * m * dt,
          y: 0,
          z: (fwd.z / fwdHorizLen) * aSlope * m * dt,
        },
        true,
      )
    }

    // Landing momentum redirect — the motocross "hit the lip right" reward.
    // On the airborne→grounded transition, if the bike is descending onto a
    // downward-sloping surface, convert part of the vertical descent into
    // forward velocity along the slope direction. The hover spring would
    // otherwise eat the descent (its damp term kills upward velocity, but
    // the descending kinetic energy gets traded out for height-error work
    // — wasted as wobble). Redirecting before the spring does its thing
    // means a clean ramp landing reads as a slingshot exit, not a slap.
    //
    // Gated by all three of:
    //   - prev tick was airborne (one impulse per landing, not every tick)
    //   - descent rate is meaningful (|vy| > 2; trivial dips don't qualify)
    //   - surface ahead of the bike is sloping DOWN (slope < -0.1, i.e.
    //     >5.7° of downslope)
    // Plus an alignment factor that scales redirect strength with how
    // steep the down-slope actually is, so a 6° dip is a hint and a 30°
    // drop is a payoff.
    if (!prevGrounded && linvel.y < -2 && surfaceForwardSlope < -0.1 && fwdHorizLen > 0.01) {
      const descend = -linvel.y // positive m/s
      const slopeAngle = Math.atan(-surfaceForwardSlope) // positive radians
      const REDIRECT_MAX = 0.7 // fraction of descent converted at full alignment
      const REDIRECT_SLOPE_FULL = Math.PI / 4 // 45° of downslope = full payoff
      const redirectFrac = Math.min(slopeAngle / REDIRECT_SLOPE_FULL, 1) * REDIRECT_MAX
      const dvForward = descend * redirectFrac
      rb.applyImpulse(
        {
          x: (fwd.x / fwdHorizLen) * dvForward * m,
          y: 0,
          z: (fwd.z / fwdHorizLen) * dvForward * m,
        },
        true,
      )
    }

    // Yaw torque around the "pure heading" axis: world-up with the
    // bike-fwd projection removed (then normalised). Perpendicular to
    // bike-fwd by construction, so steering can't leak into roll
    // regardless of pitch. M9.3 tried bike-local up and produced a
    // worse bug because the roll PD of the day read bikeRight.y; the
    // current roll PD reads true YXZ Euler roll, so the pure-heading
    // axis is safe and strictly better (no leak for either ground or
    // air to chase).
    const turnMul = probe.isWater ? 1.1 : 1.0
    const aTurn = -intent.steer * stats.turnTorque * turnMul
    const fwdDotUp = fwd.y
    const yawAxXG = -fwdDotUp * fwd.x
    const yawAxYG = 1 - fwdDotUp * fwd.y
    const yawAxZG = -fwdDotUp * fwd.z
    const yawAxLenG = Math.hypot(yawAxXG, yawAxYG, yawAxZG)
    if (yawAxLenG > 0.01) {
      const invLenG = 1 / yawAxLenG
      rb.applyTorqueImpulse(
        {
          x: yawAxXG * invLenG * aTurn * m * dt,
          y: yawAxYG * invLenG * aTurn * m * dt,
          z: yawAxZG * invLenG * aTurn * m * dt,
        },
        true,
      )
    }

    // Fishtail bias — shifts the perceived yaw pivot forward of CoM so the
    // front "bites" and the rear sweeps out, Jet-Moto-style. Implementation:
    // add a lateral CoM acceleration timed with the yaw torque, magnitude
    // `α × pivotOffset`. Geometrically this makes the point YAW_PIVOT_FWD
    // metres ahead of CoM the instantaneous rotation centre instead of CoM
    // itself; the rear swings outward by `2 × YAW_PIVOT_FWD × ω`. Faded in
    // with speed so parking-lot wiggles don't slide the bike sideways —
    // fishtail is a high-speed feel.
    const YAW_PIVOT_FWD = 0.7 // metres forward of CoM
    const fishtailFade = Math.min(speed / 8, 1)
    if (fishtailFade > 0) {
      const rightYaw = quatRotate(q, { x: 1, y: 0, z: 0 })
      const aLatFish = -aTurn * YAW_PIVOT_FWD * fishtailFade
      rb.applyImpulse(
        {
          x: rightYaw.x * aLatFish * m * dt,
          y: 0,
          z: rightYaw.z * aLatFish * m * dt,
        },
        true,
      )
    }

    // Roll PD controller — GROUND ONLY. The bike is corralled toward
    // `targetRoll = surfaceRoll + steer × leanLimit × speed-scale`, the
    // same target the prior kinematic block used. P pulls roll toward
    // target, D damps the rate. Unlike the kinematic snap, this is a
    // *physical* spring — the bike can be pushed off-target by jumps,
    // collisions, ramps; it just gets pulled back. Critical for keeping
    // racers from spinning out of control after a fishtail or a wave
    // strike (free roll without a restoring force runs away inside a
    // few hundred ms).
    //
    // The M9.x roll PD bug was caused by reading `bikeRight.y` as a
    // proxy for roll, which mis-fires under yaw-while-pitched. Here we
    // pull a true YXZ Euler roll out of the quaternion, so the signal
    // is clean across any yaw/pitch combination.
    //
    // In AIR: skipped. Pitch, roll, yaw are all free physics — backflips,
    // barrel rolls, whatever the player commits to with their inputs.
    const ROLL_LEAN_LIMIT = (40 * Math.PI) / 180 // 40° at "normal" speed
    const LEAN_SPEED_FULL = 6 // m/s — base lean curve hits 1.0 here
    const LEAN_SPEED_HIGH = 24 // m/s — high-speed boost saturates here
    const LEAN_HIGH_SPEED_BOOST = 0.5 // up to 50% more lean at top speed → ~60°
    const LEAN_BASE = 0.4 // stationary lean = 40% of base limit (~16°)
    const speedFracR = Math.min(speed / LEAN_SPEED_FULL, 1)
    const baseLeanScale = LEAN_BASE + (1 - LEAN_BASE) * speedFracR
    const highSpeedFrac = Math.min(
      Math.max(speed - LEAN_SPEED_FULL, 0) / (LEAN_SPEED_HIGH - LEAN_SPEED_FULL),
      1,
    )
    const leanScale = baseLeanScale + highSpeedFrac * LEAN_HIGH_SPEED_BOOST
    // Surface roll component — multi-probe height differential across the
    // bike's width. Mirrors the prior kinematic `surfaceRollTarget` so the
    // bike banks into a wave normal when riding diagonally across chop.
    const surfaceRollTarget = Math.atan2(yStarboard - yPort, 2 * probeHalfWidth)
    const targetRoll = surfaceRollTarget + intent.steer * ROLL_LEAN_LIMIT * leanScale
    // Extract true YXZ roll from current rotation.
    const r10R = 2 * (q.x * q.y + q.z * q.w)
    const r11R = 1 - 2 * (q.x * q.x + q.z * q.z)
    const currentRoll = Math.atan2(r10R, r11R)
    const fwdR = quatRotate(q, { x: 0, y: 0, z: 1 })
    // Roll angular velocity = angvel · bikeFwd.
    const angvR = rb.angvel()
    const rollVel = angvR.x * fwdR.x + angvR.y * fwdR.y + angvR.z * fwdR.z
    // PD gains tuned for a ~0.3s settle, slightly underdamped (lively).
    const ROLL_P = 40
    const ROLL_D = 8
    const aRollPD = (targetRoll - currentRoll) * ROLL_P - rollVel * ROLL_D
    rb.applyTorqueImpulse(
      {
        x: fwdR.x * aRollPD * m * dt,
        y: fwdR.y * aRollPD * m * dt,
        z: fwdR.z * aRollPD * m * dt,
      },
      true,
    )

    // (Pitch on the ground stays pure physics: player input torque +
    // multi-point hover handles surface alignment + flat-ground restoration.
    // Roll is corralled by the PD above to keep racers from spinning out.
    // Yaw torque + fishtail bias does the steering. Attitude in air is
    // fully free physics.)

    // Lateral drag — water has *more* lateral resistance (skis don't slide sideways easily).
    const dragMul = probe.isWater ? 1.4 : 1.0
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const lateralVel = linvel.x * right.x + linvel.z * right.z
    const aDrag = -lateralVel * stats.lateralDrag * dragMul
    rb.applyImpulse({ x: right.x * aDrag * m * dt, y: 0, z: right.z * aDrag * m * dt }, true)
  }
}
