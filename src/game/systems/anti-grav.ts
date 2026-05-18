/**
 * Anti-gravity zone resolver.
 *
 * Per-tick, for each bike: find the first {@link AntiGravZone} whose
 * oriented box contains the bike's center. While inside, the zone's local
 * +Y axis acts as "up" — gravity flips along −up and the hover system
 * retargets its probe rays, spring lift direction, yaw axis, slope
 * momentum, and lateral drag onto the zone's local frame.
 *
 * Vertical walls and inverted loop ceilings are supported: probe rays
 * cast along −up so they find the road surface regardless of world
 * orientation; the hover spring lifts along +up; the yaw axis rotates
 * around up (turn on a wall pivots around the wall's outward normal).
 *
 * Zones are volume-based (oriented box, like a fatter boost pad) so the
 * same authoring works on main-route sections AND on off-route roads
 * (e.g. pipe / halfpipe / box props the user drops in the editor).
 *
 * The system also manages Rapier's per-body gravity scale: it's set to 0
 * while a bike is in a zone so the hover system can take full control of
 * the gravity vector, and restored to 1 on exit. The smoothed
 * {@link AntiGravOverrideData.upX} et al. lerp toward the target on a
 * ~0.15s half-life so the transition isn't a hard pop.
 *
 * Known limitation: steer-driven roll lean (the bike banks into corners
 * via the roll PD on flat ground) is skipped inside zones — the roll PD
 * is world-Y based and would fight the up-plane alignment. The bike
 * still steers and turns; it just doesn't visibly lean. Worth revisiting
 * by retargeting the PD if it feels stiff in playtest.
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
import type { AntiGravZone, Track } from '@/game/tracks/types'

/** Half-life (s) of the up-vector smoothing on enter / exit. */
const UP_SMOOTH_TAU = 0.15

/**
 * Pure containment test. True when world point `p` is inside the zone's
 * oriented box (full extents `2*halfWidth × 2*halfHeight × 2*halfDepth`).
 *
 * Implementation: rotate `p − zone.position` by the inverse zone rotation
 * (which for a unit quaternion is just q* = (-x,-y,-z,w)) to get the point
 * in zone-local coordinates, then test against the axis-aligned extents.
 */
export function isInsideAntiGravZone(p: { x: number; y: number; z: number }, zone: AntiGravZone): boolean {
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

/** Zone's world-space up vector: rotation · (+Y). Always normalized
 *  because `rotation` is a unit quaternion. */
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

export function antiGravSystem(sim: SimWorld, phys: PhysicsWorld, track: Track, dt: number): void {
  // Smoothing factor for an exponential lerp on a `UP_SMOOTH_TAU` half-life.
  // We still iterate when there are no zones because a bike that *just*
  // left a zone needs to finish smoothing back to world up.
  const lerp = 1 - Math.exp(-dt / UP_SMOOTH_TAU)
  const eids = query(sim, [BikeTag, RBHandle])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb || !rb.isDynamic()) continue

    const t = rb.translation()
    const zone = track.antiGravZones.length > 0 ? findContainingZone(t, track.antiGravZones) : null

    // Lazy-init component on first touch so we don't pay for it on tracks
    // that never have anti-grav zones.
    if (!AntiGravOverrideStore.has(eid)) {
      if (!zone) continue // common path: no zones, no override needed
      addComponent(sim, eid, AntiGravOverride)
      AntiGravOverrideStore.set(eid, {
        active: false,
        upX: 0,
        upY: 1,
        upZ: 0,
        targetUpX: 0,
        targetUpY: 1,
        targetUpZ: 0,
      })
    }

    const state = AntiGravOverrideStore.must(eid)

    if (zone) {
      const up = zoneUpVector(zone)
      state.targetUpX = up.x
      state.targetUpY = up.y
      state.targetUpZ = up.z
    } else {
      state.targetUpX = 0
      state.targetUpY = 1
      state.targetUpZ = 0
    }

    // Exponential lerp toward target, then renormalize so the slerp-ish
    // path on the unit sphere doesn't drift.
    state.upX += (state.targetUpX - state.upX) * lerp
    state.upY += (state.targetUpY - state.upY) * lerp
    state.upZ += (state.targetUpZ - state.upZ) * lerp
    const len = Math.hypot(state.upX, state.upY, state.upZ) || 1
    state.upX /= len
    state.upY /= len
    state.upZ /= len

    // Active while in a zone OR until smoothing is essentially complete.
    // The 0.999 cutoff means active stays true for ~5 half-lives after
    // exit — enough that the hover system continues to take over gravity
    // while the up vector lerps back to world-Y, avoiding a one-tick pop
    // back to Rapier gravity mid-transition.
    const alignedToWorldUp = state.upY > 0.999 && Math.abs(state.upX) < 0.02 && Math.abs(state.upZ) < 0.02
    const nowActive = !!zone || !alignedToWorldUp
    if (nowActive !== state.active) {
      state.active = nowActive
      // Rapier's `setGravityScale(0)` stops applying world gravity to this
      // body each step. The hover system applies a manual `−up * GRAVITY`
      // impulse instead while active.
      rb.setGravityScale(nowActive ? 0 : 1, true)
    }
    AntiGravOverrideStore.set(eid, state)
  }
}
