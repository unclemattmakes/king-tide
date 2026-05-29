/**
 * Reconstructs the per-bike state that the render-side FX system reads —
 * `HoverState`, `ControlIntent`, `DriftState`, and the rigid-body linear
 * velocity — for replay playback. Combines two sources:
 *
 *   • Recorded inputs (v2 replays) — `pitch`, `throttle`, `boost`,
 *     `driftDir`, `driftTier` from the replay file's per-bike state
 *     slots. Drives the boost-blossom exhaust, tuck slipstream, and
 *     drift-spark FX gates against the original race state.
 *   • Derived signals — velocity from the position delta between
 *     consecutive interpolated poses, plus `surfaceIsWater` /
 *     `groundDistance` / `isGrounded` from the wave-field + optional
 *     terrain heightmap. These are computed every frame regardless of
 *     replay version since they're not in the file.
 *
 * For v1 (legacy) replays, the per-bike state slots aren't present and
 * the player exposes neutral defaults; we fall back to a coarse
 * throttle-from-speed heuristic so foam / sparks / dust / exhaust still
 * fire, with drift / tuck / boost left at their defaults (no false
 * positives).
 */

import { sampleTerrainHeightAtXZ, type TerrainHeightmap } from '@/engine/render/terrain-heightmap'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  ControlIntentStore,
  DriftStateStore,
  HoverStateStore,
  RBHandleStore,
} from '@/game/components'
import type { ReplayBikePose } from './player'

// Same tunings the FX gates assume. Replay bikes don't read their
// per-variant hoverHeight (stats aren't in the replay file in v1), so we
// use the canonical bike's 1.2 m hover target — matches the comment in
// `fx/index.ts` and is within ~10% of every shipping bike variant.
const NOMINAL_HOVER_HEIGHT = 1.2
const GROUNDED_DISTANCE_MUL = 1.6
const GROUNDED_CUTOFF = NOMINAL_HOVER_HEIGHT * GROUNDED_DISTANCE_MUL

// Minimum forward speed before we synthesise a throttle press in the
// v1-fallback path. Below this the bike is parked / drifting to a stop,
// so no exhaust.
const THROTTLE_MIN_SPEED = 1.5

export type ReplayStateReconstructor = {
  /**
   * Update synthesised per-bike state. Call AFTER the replay player has
   * sampled new poses into `poseBuffer` and written them to
   * `TransformStore`, and BEFORE `fxTick(dt)` runs.
   */
  tick(dt: number, poseBuffer: ReplayBikePose[]): void
}

export type CreateReplayStateReconstructorOpts = {
  sim: SimWorld
  phys: PhysicsWorld
  /** Maps replay slot index → ECS entity id. Same order as `poseBuffer`. */
  bikeEids: readonly number[]
  waveField: WaveFieldState
  /** Optional — when present, sparks / dust over land become available.
   *  Null for procedural / editor tracks; foam still works without it. */
  terrainHeightmap: TerrainHeightmap | null
  /** True when the replay is v1 (legacy, pose-only). The reconstructor
   *  then falls back to throttle-from-speed and leaves drift / boost
   *  / pitch at their neutral defaults. */
  isLegacyV1: boolean
}

export function createReplayStateReconstructor(
  opts: CreateReplayStateReconstructorOpts,
): ReplayStateReconstructor {
  const { sim: _sim, phys, bikeEids, waveField, terrainHeightmap, isLegacyV1 } = opts
  // `_sim` is currently unused — kept in the opts so callers can pass it
  // without ceremony when we extend to e.g. AI-handle reconstruction.
  void _sim

  // Last interpolated pose per slot — initialised on the first tick to
  // the current pose so the first frame's velocity is zero (rather than
  // a huge spike from spawn → first sample).
  const prevPos: { x: number; y: number; z: number }[] = bikeEids.map(() => ({
    x: 0,
    y: 0,
    z: 0,
  }))
  let primed = false

  return {
    tick(dt, poseBuffer) {
      if (!primed) {
        for (let i = 0; i < bikeEids.length; i++) {
          const p = poseBuffer[i]
          const dst = prevPos[i]
          if (!p || !dst) continue
          dst.x = p.x
          dst.y = p.y
          dst.z = p.z
        }
        primed = true
        return
      }

      const invDt = dt > 0 ? 1 / dt : 0

      for (let i = 0; i < bikeEids.length; i++) {
        const eid = bikeEids[i]
        const p = poseBuffer[i]
        const prev = prevPos[i]
        if (eid === undefined || !p || !prev) continue

        // 1. Velocity from frame delta. The replay player interpolates
        //    SLERP/LERP between recorded frames, so consecutive
        //    interpolated poses give a smooth instantaneous velocity at
        //    the current playback speed.
        const vx = (p.x - prev.x) * invDt
        const vy = (p.y - prev.y) * invDt
        const vz = (p.z - prev.z) * invDt
        prev.x = p.x
        prev.y = p.y
        prev.z = p.z

        const rbh = RBHandleStore.get(eid)
        if (rbh) {
          const rb = phys.world.getRigidBody(rbh.handle)
          // `false` = don't wake the body — physics isn't stepping anyway,
          // and we just need `rb.linvel()` to read the synthesised value.
          if (rb) rb.setLinvel({ x: vx, y: vy, z: vz }, false)
        }
        const speed = Math.hypot(vx, vz)

        // 2. Surface classification. Treat the higher of (wave-field water
        //    height, terrain height) as the local surface. Where the
        //    heightmap returns null we're either off the heightmap
        //    footprint (deep ocean) or on a track without baked terrain
        //    (editor / procedural) — both cases default to "water below".
        const waterY = sampleHeight(waveField, p.x, p.z)
        const terrainY = terrainHeightmap
          ? sampleTerrainHeightAtXZ(terrainHeightmap, p.x, p.z)
          : null
        const surfaceIsWater = terrainY === null || waterY >= terrainY
        const surfaceY = surfaceIsWater ? waterY : terrainY
        const groundDistance = p.y - surfaceY
        const isGrounded = groundDistance > -0.5 && groundDistance < GROUNDED_CUTOFF

        const hover = HoverStateStore.get(eid)
        if (hover) {
          hover.groundDistance = groundDistance
          hover.isGrounded = isGrounded
          hover.surfaceIsWater = surfaceIsWater
        }

        // 3. Input state. v2 replays carry the original pedal / lean /
        //    drift state in the pose buffer; v1 has none, so fall back
        //    to a speed-based throttle heuristic and leave boost / pitch
        //    / drift at neutral defaults so we don't fire those layers
        //    at random.
        const intent = ControlIntentStore.get(eid)
        if (intent) {
          if (isLegacyV1) {
            intent.throttle = speed > THROTTLE_MIN_SPEED ? 1 : 0
            intent.boost = false
            intent.pitch = 0
          } else {
            intent.throttle = p.throttle
            intent.boost = p.boost
            intent.pitch = p.pitch
          }
        }

        // 4. Drift state — only the fields the FX system actually reads
        //    (driftDir + highestTier). Other DriftStateData fields are
        //    sim-internal and don't affect playback visuals; leaving
        //    them stale is fine.
        const drift = DriftStateStore.get(eid)
        if (drift) {
          if (isLegacyV1) {
            drift.driftDir = 0
            drift.highestTier = 0
          } else {
            drift.driftDir = p.driftDir
            drift.highestTier = p.driftTier
          }
        }
      }
    },
  }
}
