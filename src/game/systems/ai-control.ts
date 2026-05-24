import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { buildPumpHints, hasAnyHints } from '@/game/ai/pump-hints'
import { ControlIntent, ControlIntentStore, RBHandle, RBHandleStore } from '@/game/components'
import { AIController, AIControllerStore, AITag } from '@/game/components/ai'
import {
  curvatureAheadLooped,
  findClosestIndexLooped,
  lookaheadIndexLooped,
} from '@/game/tracks/spline-query'
import type { Track } from '@/game/tracks/types'

/**
 * Pure decision helper for AI drift. Given the AI's tuning + current
 * drift state + this-tick race signals (curvature ahead, ground speed,
 * commanded steer), returns the next-tick drift state.
 *
 * Extracted so unit tests can pin the state machine without spinning
 * up the spline / physics loop. The activation rules mirror the
 * player-side `driftSystem` (see `src/game/systems/drift.ts`) — both
 * sides need `Math.sign(intent.steer)` to match the drift direction
 * for the drift to engage, so the AI sets `driftDir` to `sign(steer)`
 * the moment it commits.
 *
 * Cancel rules (any one):
 *  - corner widens below 60% of the trigger threshold
 *  - steer flips opposite the drift direction (AI re-targeted line)
 *  - speed drops below 70% of trigger threshold (lost momentum)
 *  - held longer than `driftMaxHoldS` (caps per-difficulty payoff)
 */
export type AIDriftTuning = {
  driftCurvatureThreshold: number
  driftMinSpeed: number
  driftMaxHoldS: number
}

export type AIDriftState = {
  driftDir: number
  driftHoldS: number
  driftCooldownS: number
}

export function decideAIDrift(
  tuning: AIDriftTuning,
  state: AIDriftState,
  signals: { curvatureAhead: number; speed: number; steer: number; dt: number },
): AIDriftState {
  const cooldown = Math.max(0, state.driftCooldownS - signals.dt)

  if (state.driftDir !== 0) {
    const hold = state.driftHoldS + signals.dt
    const cornerWidened = signals.curvatureAhead < tuning.driftCurvatureThreshold * 0.6
    const steerFlipped = Math.sign(signals.steer) !== state.driftDir
    const tooSlow = signals.speed < tuning.driftMinSpeed * 0.7
    const heldTooLong = hold >= tuning.driftMaxHoldS
    if (cornerWidened || steerFlipped || tooSlow || heldTooLong) {
      // Cooldown matches DRIFT_COOLDOWN_S in drift.ts + a small margin
      // so the AI doesn't immediately re-trigger on the next tick.
      return { driftDir: 0, driftHoldS: 0, driftCooldownS: 0.35 }
    }
    return { driftDir: state.driftDir, driftHoldS: hold, driftCooldownS: cooldown }
  }

  if (
    tuning.driftCurvatureThreshold !== Number.POSITIVE_INFINITY &&
    cooldown <= 0 &&
    signals.curvatureAhead >= tuning.driftCurvatureThreshold &&
    signals.speed >= tuning.driftMinSpeed &&
    Math.abs(signals.steer) >= 0.3
  ) {
    return { driftDir: Math.sign(signals.steer), driftHoldS: 0, driftCooldownS: cooldown }
  }

  return { driftDir: 0, driftHoldS: 0, driftCooldownS: cooldown }
}

/**
 * Spline-following AI: each tick, finds a target ahead on the spline and a
 * stay-close-to-line target right under us, then writes throttle/steer/brake
 * into ControlIntent. Hover system drives the rigid body.
 *
 * Key design points after several iterations:
 * - Lookahead scales with speed (~0.4s ahead) so faster bikes see further.
 * - Steering blends look-ahead heading with a "pull toward the line" term
 *   so the AI doesn't drift wide on long arcs and miss gates.
 * - Curvature scan looks 1.5s ahead along the spline and measures the
 *   total bend. Tight upcoming curves drop the target speed; the AI brakes
 *   when current speed > target. Without this, brake only ever fired
 *   *during* a sharp corner — too late to actually take it.
 * - Throttle scales down with target speed (curvature-driven), not just
 *   with current angle to target.
 */
/** Minimum scan distance even at low speed (m), so we still see the next corner. */
const CURVATURE_LOOKAHEAD_MIN = 18
/** Margin: brake when current speed exceeds target speed by this much (m/s). */
const BRAKE_TRIGGER_MARGIN = 1.5
/** Index window for the cached closest-point search around lastClosestIndex. */
const CLOSEST_SEARCH_WINDOW = 8

// Per-track spline-by-id index. The system used to call
// `track.aiSplines.find(s => s.id === ai.splineId)` once per AI per tick;
// `.find()` is O(N) over a tiny array but defeats the V8 inline cache for
// the loop body and is wasteful when splineId is immutable per AI.
// WeakMap keys on Track so the cache GC's with the track and doesn't go
// stale when the active track changes between races.
type SplineIndex = Map<string, Track['aiSplines'][number]>
const SPLINE_INDEX = new WeakMap<Track, SplineIndex>()
function splineIndexFor(track: Track): SplineIndex {
  let idx = SPLINE_INDEX.get(track)
  if (!idx) {
    idx = new Map()
    for (const s of track.aiSplines) idx.set(s.id, s)
    SPLINE_INDEX.set(track, idx)
  }
  return idx
}

// Per-track AI pump-hint cache: one boolean array per AI spline marking
// indices that lie inside a heavy wave zone. Built lazily on first
// access. Keyed on `Track` so it GC's alongside the spline cache when
// the active track changes — and so re-loading the same track id is a
// hit, not a re-walk.
type PumpHintCache = { hintsBySplineId: Map<string, boolean[]>; anyHints: boolean }
const PUMP_HINTS = new WeakMap<Track, PumpHintCache>()
function pumpHintsFor(track: Track): PumpHintCache {
  let cache = PUMP_HINTS.get(track)
  if (!cache) {
    cache = { hintsBySplineId: new Map(), anyHints: false }
    for (const s of track.aiSplines) {
      const hints = buildPumpHints({ spline: s, zones: track.waveZones })
      cache.hintsBySplineId.set(s.id, hints)
      if (!cache.anyHints && hasAnyHints(hints)) cache.anyHints = true
    }
    PUMP_HINTS.set(track, cache)
  }
  return cache
}

/** Sim-seconds the AI holds `intent.pitch` once a pump fires. Long
 *  enough that hover.ts's pitch torque (PITCH_TORQUE_ACCEL · m · dt
 *  per tick) integrates into a clear nose-up rotation across the burst
 *  window; short enough that the AI is back on its racing line within
 *  ~5 ticks. Pairs with `PUMP_COOLDOWN_S` below. */
const PUMP_HOLD_S = 0.1
/** Sim-seconds between pump fires. Matches the player wave-pump
 *  observer's `cooldownMs` (500 ms) so a heavy-swell hint zone doesn't
 *  chain pumps faster than the player ever could. */
const PUMP_COOLDOWN_S = 0.5
/** Speed-fraction gate for both arming a pump and sustaining it. Same
 *  floor as the player observer's `minSpeedFrac` — a stopped or
 *  cornering-hard AI isn't "intentionally riding the swell". */
const PUMP_MIN_SPEED_FRAC = 0.45

export function aiControlSystem(
  sim: SimWorld,
  phys: PhysicsWorld,
  track: Track,
  waveField: WaveFieldState,
): void {
  const eids = query(sim, [AITag, AIController, RBHandle, ControlIntent])
  const splines = splineIndexFor(track)
  const dt = phys.fixedDt
  const pumpCache = pumpHintsFor(track)
  for (const eid of eids) {
    const ai = AIControllerStore.must(eid)
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue

    const spline = splines.get(ai.splineId)
    if (!spline || spline.points.length < 2) continue

    const t = rb.translation()
    const q = rb.rotation()
    const linvel = rb.linvel()
    const angvel = rb.angvel()
    const speedHoriz = Math.hypot(linvel.x, linvel.z)

    const lookDist = Math.max(6, speedHoriz * 0.4)
    const N = spline.points.length

    // 1. Closest spline point — search a window around the cached cursor.
    const bestIdx = findClosestIndexLooped(
      spline.points,
      t.x,
      t.z,
      ai.lastClosestIndex,
      CLOSEST_SEARCH_WINDOW,
    )

    // 2. Lookahead point.
    const lookIdx = lookaheadIndexLooped(spline.points, bestIdx, lookDist)
    const lookTarget = spline.points[lookIdx]!
    const lineTarget = spline.points[bestIdx]!
    const aheadOfLook = spline.points[(lookIdx + 1) % N]!

    // 3. Blended target — 55% lookahead + 45% line. Pulls the AI back onto
    // the racing line when it's drifting wide.
    const blendT = 0.55
    let targetX = lookTarget.x * blendT + lineTarget.x * (1 - blendT)
    let targetZ = lookTarget.z * blendT + lineTarget.z * (1 - blendT)

    // 3b. Per-AI lateral offset — perpendicular to the spline tangent so each
    //    AI hugs a slightly different line. Prevents convergence pile-ups at gates.
    if (ai.lineOffset !== 0) {
      const tdx = aheadOfLook.x - lookTarget.x
      const tdz = aheadOfLook.z - lookTarget.z
      const tlen = Math.hypot(tdx, tdz) || 1
      // Perpendicular (right of forward).
      const perpX = tdz / tlen
      const perpZ = -tdx / tlen
      targetX += perpX * ai.lineOffset
      targetZ += perpZ * ai.lineOffset
    }

    const dx = targetX - t.x
    const dz = targetZ - t.z
    const dlen = Math.hypot(dx, dz) || 1
    const dirX = dx / dlen
    const dirZ = dz / dlen

    // 4. Local-frame angle.
    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const localX = dirX * right.x + dirZ * right.z
    const localZ = dirX * fwd.x + dirZ * fwd.z
    const angle = Math.atan2(localX, localZ)

    // 5. PD steering.
    // Empirically (verified by e2e auto-play trajectory): with hover.ts's
    // `aTurn = -intent.steer`, *positive* steer rotates the bike's forward from
    // +Z toward -X — what the player perceives as a "right turn" via the chase
    // cam (the world rotates right under them). For the AI to drive toward a
    // target at +localX (right of the bike), it must therefore command a
    // *negative* steer. Hence the angle sign flip below.
    const KP = 0.85
    const KD = 0.45
    const damp = angvel.y * KD
    let steer = -angle * KP + damp
    steer = Math.max(-1, Math.min(1, steer))

    // 6. Curvature look-ahead. Walk ~1.5s ahead along the spline summing arc
    // length and total absolute bend; the implied radius gives a target
    // speed via v = sqrt(latAccel * r). Lookahead horizon + lateral-accel
    // ceiling are per-AI (difficulty-driven) — Hard sees corners sooner
    // and plans for higher lateral G.
    const scanDist = Math.max(CURVATURE_LOOKAHEAD_MIN, speedHoriz * ai.curvatureLookaheadSec)
    const { totalBend, scannedDist } = curvatureAheadLooped(spline.points, bestIdx, scanDist)
    // Implied corner radius: bend (rad) over arclength (m) → curvature (1/m).
    // Cap min radius at 8m so missing data doesn't produce a near-stop target.
    const curvature = scannedDist > 0 ? totalBend / scannedDist : 0
    const impliedRadius = curvature > 1e-4 ? Math.max(8, 1 / curvature) : 1e6
    const cornerSpeedCap = Math.sqrt(ai.maxLateralAccel * impliedRadius)
    const baseTopSpeed = ai.topSpeedFactor * 30 // ~bike topSpeed; a soft target, not a hard cap
    const targetSpeed = Math.min(baseTopSpeed, cornerSpeedCap)

    // Throttle: scale down as we approach the target speed, with a small
    // angle-error term so a steering correction also pulls throttle.
    const angleAbs = Math.abs(angle)
    const speedHeadroom = Math.max(0, (targetSpeed - speedHoriz) / Math.max(targetSpeed, 1))
    const angleScale = Math.max(0.55, 1 - angleAbs / Math.PI)
    const throttle = Math.min(1, ai.topSpeedFactor * (0.45 + 0.65 * speedHeadroom) * angleScale)

    // Brake when current speed exceeds the target by more than the margin.
    // Magnitude scales with overshoot, capped at 0.9 (full brake bogs the
    // chassis and breaks the lean-into-turn weight transfer).
    const overshoot = speedHoriz - targetSpeed
    const brake =
      overshoot > BRAKE_TRIGGER_MARGIN
        ? Math.min(0.9, (overshoot - BRAKE_TRIGGER_MARGIN) * 0.18)
        : 0

    // Wave-pump action (Phase A gap 7). The intent.pitch is the same
    // input the player taps with E to launch off a crest. AI semantics:
    //
    //   1. Holding from a prior tick — keep `intent.pitch` lit until the
    //      burst window expires; decrement both timers.
    //   2. Cooldown ticking down — no new pump until it hits zero.
    //   3. Armed + on a hint index + speed high enough + surface rising
    //      hard enough — fire a fresh pump: hold for PUMP_HOLD_S, then
    //      lock out for PUMP_COOLDOWN_S.
    //
    // Casual AI's `pumpVyThreshold = Infinity` collapses branch 3 to
    // false in the inequality check, so the difficulty acts on per-tick
    // cost without branching on the difficulty itself here.
    let pumpPitch = 0
    let nextPumpHoldS = Math.max(0, ai.pumpHoldS - dt)
    let nextPumpCooldownS = Math.max(0, ai.pumpCooldownS - dt)
    const pumpHints = pumpCache.hintsBySplineId.get(ai.splineId)
    if (ai.pumpHoldS > 0) {
      // Sustaining a pump that fired on a prior tick.
      pumpPitch = ai.pumpPitchStrength
    } else if (
      pumpCache.anyHints &&
      nextPumpCooldownS <= 0 &&
      ai.pumpVyThreshold !== Number.POSITIVE_INFINITY &&
      pumpHints?.[bestIdx] === true
    ) {
      // Pump-eligible — sample the live surface vy under the bike.
      // sampleSurface is the same call buoyancy uses in hover.ts, so the
      // AI's reading is identical to what the player feels.
      const aiSpeedFrac =
        ai.baselineTopSpeedFactor > 0 ? speedHoriz / (ai.baselineTopSpeedFactor * 30) : 0
      if (aiSpeedFrac >= PUMP_MIN_SPEED_FRAC) {
        const { vy } = sampleSurface(waveField, t.x, t.z)
        if (vy >= ai.pumpVyThreshold) {
          pumpPitch = ai.pumpPitchStrength
          nextPumpHoldS = PUMP_HOLD_S
          nextPumpCooldownS = PUMP_COOLDOWN_S
        }
      }
    }

    // AI drift decision — runs through the pure `decideAIDrift` helper
    // so the state machine can be unit-tested in isolation.
    const drift = decideAIDrift(ai, ai, { curvatureAhead: curvature, speed: speedHoriz, steer, dt })

    AIControllerStore.set(eid, {
      ...ai,
      lastClosestIndex: bestIdx,
      pumpHoldS: nextPumpHoldS,
      pumpCooldownS: nextPumpCooldownS,
      driftDir: drift.driftDir,
      driftHoldS: drift.driftHoldS,
      driftCooldownS: drift.driftCooldownS,
    })
    ControlIntentStore.set(eid, {
      throttle,
      steer,
      brake,
      fire: false,
      boost: false,
      pitch: pumpPitch,
      // AI drift — translate the controller's `driftDir` into a held
      // trick-button. driftSystem reads these alongside steer to
      // activate the MT/SMT/UMT charge state. Both false = no drift
      // (also = unchanged for Casual, whose threshold is Infinity).
      trickLeft: drift.driftDir === -1,
      trickRight: drift.driftDir === 1,
    })
  }
}
