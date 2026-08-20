/**
 * Launch/landing grade — the minimal feedback loop for the v2
 * wave-mastery model ("master the jump": pitch the takeoff, pitch the
 * landing — CLAUDE.md "signature mechanic", product-plan pillar 1).
 *
 * Before this system existed the pitch inputs (E/Q, stick Y) genuinely
 * shaped how the bike rode swells (hover-attitude.ts), but nothing
 * *graded* the player: air happened, no reward or verdict followed, and
 * the signature skill was undiscoverable. This closes the loop at its
 * cheapest useful size:
 *
 *   - grounded → airborne edge: grade the TAKEOFF — did the nose come
 *     up into the pop band as the bike left the surface? (motocross
 *     "pitch the takeoff")
 *   - airborne → grounded edge (after a credible airtime): grade the
 *     LANDING — does the bike's pitch match the surface tangent it
 *     lands on? (motocross "match the slope") — and pay a boost-meter
 *     reward scaled by landing quality.
 *
 * Verdicts surface render-side as a two-word chyron
 * (launch-grade-hud.ts) and feed the tutorial's LAUNCH / LAND beats.
 *
 * Sim-side + deterministic: pure math over rigid-body pose and
 * HoverState, one-shot edge flags consumed by the render frame (same
 * pattern as TrickState.trickFiredThisTick / DriftState.releasedThisTick).
 * Applies to every racer (player + AI) so lockstep multiplayer and
 * replays stay consistent; magnitudes are small enough not to reshape
 * AI balance (a clean landing ≈ one trick's worth of meter).
 */

import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  HoverState,
  HoverStateStore,
  LaunchGradeStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { Racer } from '@/game/components/race'
import { chargeBoostMeter } from './boost-meter'

// ── Tuning ────────────────────────────────────────────────────────────

/** Minimum airtime (s) before a landing is graded. Filters ordinary
 *  chop skips — parity with the "credible air" feel the trick window
 *  uses, without coupling to its geometry rules. */
export const MIN_AIRTIME_SEC = 0.45

/** Minimum vertical velocity (m/s) at the grounded→airborne edge for
 *  the takeoff itself to flash a verdict. Mirrors the wave-pump
 *  observer's MIN_VY_PEAK so "a real launch" means the same thing in
 *  both systems. Landings are still graded below this (airtime gates
 *  those); this only stops takeoff chyron spam over chop. */
export const MIN_TAKEOFF_VY = 2.0

/** Ideal nose-up pitch (rad) at the takeoff edge — the middle of the
 *  motocross pop band (~14°). */
export const TAKEOFF_IDEAL_PITCH_RAD = 0.24
/** Tolerance (rad) around the ideal before takeoff quality hits 0. */
export const TAKEOFF_PITCH_TOL_RAD = 0.3

/** Landing pitch error (rad) at which quality reaches 0 (~23°). Within
 *  a few degrees of the surface tangent grades near 1. */
export const LANDING_ERR_MAX_RAD = 0.4

/** Boost-meter reward for a landing: floor + quality-scaled slice.
 *  A clean landing (~q=1) pays 0.5 — the same as one credible trick
 *  (game-loop charges 0.5 per trick) — so the two skill loops stay in
 *  the same economy. A cased landing still pays a taste. */
export const LANDING_REWARD_FLOOR = 0.12
export const LANDING_REWARD_SCALE = 0.38

/** Quality breakpoints for the 3-tier verdict. */
export const VERDICT_CLEAN_MIN = 0.72
export const VERDICT_OK_MIN = 0.4

// ── Pure helpers (unit-tested; shared with any HUD readout) ──────────

/** Bike pitch angle (rad, positive = nose up) from a rigid-body
 *  quaternion. Same extraction as hover-attitude's grounded PD
 *  (applyGroundedPitchPD) so "level with the surface" means one thing
 *  everywhere: pitch = asin(-2*(qy*qz - qx*qw)). */
export function pitchAngleFromQuat(q: { x: number; y: number; z: number; w: number }): number {
  const r12 = 2 * (q.y * q.z - q.x * q.w)
  return Math.asin(Math.max(-1, Math.min(1, -r12)))
}

/** Takeoff quality 0..1 — plateau curve peaking at the ideal pop
 *  pitch, fading linearly to 0 at ±TAKEOFF_PITCH_TOL_RAD. */
export function gradeTakeoff(pitchRad: number): number {
  const err = Math.abs(pitchRad - TAKEOFF_IDEAL_PITCH_RAD)
  return Math.max(0, Math.min(1, 1 - err / TAKEOFF_PITCH_TOL_RAD))
}

/** Landing quality 0..1 — how closely the bike's pitch matches the
 *  landing surface's tangent (`-atan(forwardSlope)`, the same target
 *  hover-attitude's self-righting PD steers toward). */
export function gradeLanding(pitchRad: number, surfaceForwardSlope: number): number {
  const target = -Math.atan(surfaceForwardSlope)
  const err = Math.abs(pitchRad - target)
  return Math.max(0, Math.min(1, 1 - err / LANDING_ERR_MAX_RAD))
}

export type LaunchVerdict = 'clean' | 'ok' | 'sloppy'

export function verdictFor(quality: number): LaunchVerdict {
  if (quality >= VERDICT_CLEAN_MIN) return 'clean'
  if (quality >= VERDICT_OK_MIN) return 'ok'
  return 'sloppy'
}

// ── System ────────────────────────────────────────────────────────────

export function launchGradeSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const dt = phys.fixedDt
  const eids = query(sim, [BikeTag, RBHandle, HoverState, Racer])
  for (const eid of eids) {
    const hover = HoverStateStore.must(eid)
    const handle = RBHandleStore.must(eid).handle
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue

    let g = LaunchGradeStore.get(eid)
    if (!g) {
      g = {
        prevGrounded: true,
        airborneSec: 0,
        takeoffQuality: 0,
        firedThisTick: false,
        firedKind: 'launch',
        firedQuality: 0,
      }
      LaunchGradeStore.set(eid, g)
    }

    // One-shot edge — consumed by the render hook the same frame it's
    // set; cleared at the top of the next sim tick (trick-hop pattern).
    g.firedThisTick = false

    const grounded = hover.isGrounded

    if (g.prevGrounded && !grounded) {
      // ── Takeoff edge ────────────────────────────────────────────
      const pitch = pitchAngleFromQuat(rb.rotation())
      g.takeoffQuality = gradeTakeoff(pitch)
      g.airborneSec = 0
      if (rb.linvel().y >= MIN_TAKEOFF_VY) {
        g.firedThisTick = true
        g.firedKind = 'launch'
        g.firedQuality = g.takeoffQuality
      }
    } else if (!grounded) {
      g.airborneSec += dt
    } else if (!g.prevGrounded && grounded && g.airborneSec >= MIN_AIRTIME_SEC) {
      // ── Landing edge (credible air only) ────────────────────────
      // hoverSystem ran earlier this tick with the bike grounded, so
      // HoverState.forwardSlope is the fresh landing-surface tangent
      // (it is zeroed while airborne — writeHoverState).
      const pitch = pitchAngleFromQuat(rb.rotation())
      const quality = gradeLanding(pitch, hover.forwardSlope)
      g.firedThisTick = true
      g.firedKind = 'landing'
      g.firedQuality = quality
      chargeBoostMeter(eid, LANDING_REWARD_FLOOR + quality * LANDING_REWARD_SCALE)
      g.airborneSec = 0
    }

    g.prevGrounded = grounded
  }
}
