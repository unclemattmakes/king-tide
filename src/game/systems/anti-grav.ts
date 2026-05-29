/**
 * Anti-gravity resolver.
 *
 * Two source kinds, combined by max-weight per bike per tick:
 *
 *   1. **Curve sample** (the dominant pattern). For each AI spline
 *      flagged `antiGrav: true`, find the nearest sample to the bike,
 *      compute the curve's local "up" from the 3D tangent + the local
 *      banking angle, and weight by `1 − dist/falloff`. Smooth spiral
 *      transitions fall out of authoring banking changes along the
 *      spline — MK8-style helix tracks, banked walls, full loops are
 *      all just banking sweeps.
 *
 *   2. **Volume zone** (off-route / ad-hoc). Per-bike test against
 *      every {@link AntiGravZone}'s oriented box. Contained = weight 1
 *      with the zone's local +Y as up.
 *
 * The combined weight scales Rapier's per-body gravity (`scale = 1−w`)
 * and the manual `−up·G·w` impulse the hover system applies, so the
 * bike's effective gravity is always smoothly blended between world-down
 * and curve-down — no hard cliffs, no orientation pops.
 *
 * Vertical walls and inverted loop ceilings are first-class: the hover
 * system's probe rays, spring lift, yaw axis, slope momentum, and drag
 * all operate in the up's local frame, so any curve banking (including
 * 360° loops) lifts cleanly.
 *
 * The smoothed {@link AntiGravOverrideData.upX} lerps toward the target
 * on a ~0.15s half-life so quick source switches don't snap. The target
 * itself follows the curve smoothly, so steady-state motion is no-latency.
 */

import { addComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import {
  AntiGravOverride,
  AntiGravOverrideStore,
  BikeTag,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { curveUpAtT, tangent3dAtT } from '@/game/tracks/catmull-rom'
import type { AISpline, AntiGravZone, Track } from '@/game/tracks/types'

/** Half-life (s) of the up-vector smoothing on source-switch transients. */
const UP_SMOOTH_TAU = 0.15
const DEFAULT_FALLOFF = 8

/**
 * Pure containment test. True when world point `p` is inside the zone's
 * oriented box (full extents `2*halfWidth × 2*halfHeight × 2*halfDepth`).
 *
 * Implementation: rotate `p − zone.position` by the inverse zone rotation
 * (q* = (-x,-y,-z,w) for a unit quaternion) to get the point in
 * zone-local coordinates, then test against the axis-aligned extents.
 */
export function isInsideAntiGravZone(
  p: { x: number; y: number; z: number },
  zone: AntiGravZone,
): boolean {
  const dx = p.x - zone.position.x
  const dy = p.y - zone.position.y
  const dz = p.z - zone.position.z
  const qInv = {
    x: -zone.rotation.x,
    y: -zone.rotation.y,
    z: -zone.rotation.z,
    w: zone.rotation.w,
  }
  const local = quatRotate(qInv, { x: dx, y: dy, z: dz })
  return (
    Math.abs(local.x) <= zone.halfWidth &&
    Math.abs(local.y) <= zone.halfHeight &&
    Math.abs(local.z) <= zone.halfDepth
  )
}

/** Zone's world-space up vector: rotation · (+Y). */
export function zoneUpVector(zone: AntiGravZone): { x: number; y: number; z: number } {
  return quatRotate(zone.rotation, { x: 0, y: 1, z: 0 })
}

/**
 * Find the first zone whose oriented box contains `p`. First-match wins
 * — overlapping zones are an authoring error, so we don't try to blend.
 */
export function findContainingZone(
  p: { x: number; y: number; z: number },
  zones: readonly AntiGravZone[],
): AntiGravZone | null {
  for (const z of zones) {
    if (isInsideAntiGravZone(p, z)) return z
  }
  return null
}

/**
 * Sample the curve gravity at the nearest point of a flagged spline.
 * Returns `null` when the spline has no banking data or the bike is
 * beyond the falloff distance. The reported weight ∈ (0,1] uses a
 * linear falloff; the up vector is the spline's road-normal at that
 * sample.
 */
export function sampleCurveGravity(
  p: { x: number; y: number; z: number },
  spline: AISpline,
): { upX: number; upY: number; upZ: number; weight: number } | null {
  if (!spline.antiGrav || !spline.bankings || spline.bankings.length !== spline.points.length) {
    return null
  }
  const falloff = spline.antiGravFalloff ?? DEFAULT_FALLOFF
  const pts = spline.points
  let bestI = 0
  let bestD2 = Infinity
  // Full scan — splines are short (a few hundred samples) and we're
  // running per-bike per-tick at 60 Hz, so the closed-form O(N) here
  // costs <1% of frame time even at 8 bikes. If profiling later shows
  // it matters, replace with the AI controller's lastClosestIndex hint.
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i]!
    const dx = s.x - p.x
    const dy = s.y - p.y
    const dz = s.z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      bestI = i
    }
  }
  const dist = Math.sqrt(bestD2)
  if (dist >= falloff) return null
  const t = bestI / pts.length
  const tangent = tangent3dAtT(pts, t)
  const banking = spline.bankings[bestI]!
  const up = curveUpAtT(tangent, banking)
  const weight = 1 - dist / falloff
  return { upX: up.x, upY: up.y, upZ: up.z, weight }
}

export function antiGravSystem(sim: SimWorld, phys: PhysicsWorld, track: Track, dt: number): void {
  const splines = track.aiSplines.filter((s) => s.antiGrav && s.bankings)
  const hasCurves = splines.length > 0
  const hasZones = track.antiGravZones.length > 0
  // Early-exit when this track uses neither anti-grav primitive.
  if (!hasCurves && !hasZones) {
    // Still need to drive any active override toward inactivity (if a
    // bike was anti-gravved on a prior track load mid-session). The
    // bitECS query cost is trivial; check anyway.
    for (const eid of query(sim, [BikeTag, RBHandle, AntiGravOverride])) {
      const state = AntiGravOverrideStore.must(eid)
      if (state.active) {
        state.active = false
        state.weight = 0
        state.upX = 0
        state.upY = 1
        state.upZ = 0
        state.targetUpX = 0
        state.targetUpY = 1
        state.targetUpZ = 0
        const { handle } = RBHandleStore.must(eid)
        const rb = phys.world.getRigidBody(handle)
        if (rb) rb.setGravityScale(1, true)
      }
    }
    return
  }
  const lerp = 1 - Math.exp(-dt / UP_SMOOTH_TAU)
  for (const eid of query(sim, [BikeTag, RBHandle])) {
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb?.isDynamic()) continue

    const t = rb.translation()

    // Pick highest-weight source: any containing zone is weight 1; any
    // curve sample with positive weight competes. The combined "best"
    // up vector + weight drives the override.
    let bestWeight = 0
    let bestUpX = 0
    let bestUpY = 1
    let bestUpZ = 0
    if (hasZones) {
      const zone = findContainingZone(t, track.antiGravZones)
      if (zone) {
        const up = zoneUpVector(zone)
        bestWeight = 1
        bestUpX = up.x
        bestUpY = up.y
        bestUpZ = up.z
      }
    }
    if (hasCurves) {
      for (const s of splines) {
        const cs = sampleCurveGravity(t, s)
        if (cs && cs.weight > bestWeight) {
          bestWeight = cs.weight
          bestUpX = cs.upX
          bestUpY = cs.upY
          bestUpZ = cs.upZ
        }
      }
    }

    // Lazy-init: bikes on tracks that never engage anti-grav never get
    // a component, saving a tiny amount of memory + iteration cost.
    if (!AntiGravOverrideStore.has(eid)) {
      if (bestWeight === 0) continue
      addComponent(sim, eid, AntiGravOverride)
      AntiGravOverrideStore.set(eid, {
        active: false,
        weight: 0,
        upX: 0,
        upY: 1,
        upZ: 0,
        targetUpX: 0,
        targetUpY: 1,
        targetUpZ: 0,
      })
    }
    const state = AntiGravOverrideStore.must(eid)

    state.targetUpX = bestWeight > 0 ? bestUpX : 0
    state.targetUpY = bestWeight > 0 ? bestUpY : 1
    state.targetUpZ = bestWeight > 0 ? bestUpZ : 0

    // Exponential lerp toward the target up + weight. Smooths source-
    // switch transients while keeping zero latency on steady-state
    // motion (target already changes smoothly along the curve).
    state.upX += (state.targetUpX - state.upX) * lerp
    state.upY += (state.targetUpY - state.upY) * lerp
    state.upZ += (state.targetUpZ - state.upZ) * lerp
    const len = Math.hypot(state.upX, state.upY, state.upZ) || 1
    state.upX /= len
    state.upY /= len
    state.upZ /= len
    state.weight += (bestWeight - state.weight) * lerp

    // Active while weight is non-negligible — drives whether the hover
    // system reroutes its forces along this up vector and whether we
    // disable Rapier's per-body gravity. Below the threshold we restore
    // world gravity and let the override go dormant so its smoothed
    // values don't accumulate drift across many idle ticks.
    const nowActive = state.weight > 0.005
    if (nowActive !== state.active) {
      state.active = nowActive
      // Per-body gravity scale fades with weight. When inactive (weight
      // ≈ 0), restore to 1.0 (world gravity normal). When active, set
      // to 1−weight so the hover system's manual `−up·G·weight` impulse
      // sums with Rapier gravity for total magnitude G in the blended
      // direction. Updated each tick below — this branch only handles
      // the binary on/off transition.
      rb.setGravityScale(nowActive ? Math.max(0, 1 - state.weight) : 1, true)
    } else if (nowActive) {
      rb.setGravityScale(Math.max(0, 1 - state.weight), true)
    }
    AntiGravOverrideStore.set(eid, state)
  }
}
