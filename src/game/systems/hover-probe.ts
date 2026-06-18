/**
 * Surface probing + frame-of-reference resolution for the hover system.
 *
 * Split out of `hover.ts` (docs/systems-review.md §4): the ray/footprint
 * sampling, the reused `scratchRay`, the anti-grav frame build, and the
 * debug-corner scratch. Three-free; the only physics dependency is the
 * Rapier raycast through `PhysicsWorld`.
 *
 * Probe geometry (half-length / half-width / lift / speed-scale) arrives via
 * `SimTuning`, NOT the `devSettings` singleton — the deterministic step
 * snapshots it once per tick (§1.2).
 */

import type RAPIER from '@dimforge/rapier3d-compat'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { SurfaceType, type SurfaceTypeValue } from '@/engine/sim/surface-types'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import type { BikeStatsData, ControlIntentData, HoverProbe } from '@/game/components'
import { AntiGravOverrideStore } from '@/game/components'
import type { SimTuning } from '@/game/sim-step'
import { GROUNDED_DISTANCE_MUL, MAX_HOVER_PROBE, SLOPE_FILTER_TAU } from './hover-tuning'
import type { Footprint, HoverFrame, SurfaceProbe } from './hover-types'

// ============================================================================
// Surface probing
// ============================================================================

// Reused per-probe Ray. Each bike fires 5 probes per fixed tick (1 center +
// 4 footprint); at 5 bikes × 60 Hz that's ~1500 allocations/sec if we new
// the Ray every call. Lazy-init on first use because the Ray constructor is
// only valid after Rapier WASM has loaded — `phys.rapier` carries it in.
// `castRay` reads origin/dir synchronously and doesn't retain a reference,
// so reuse across sequential calls in the same tick is safe. (NOT safe
// across threads — any Web Worker physics offload will need a per-context
// allocator here.)
let scratchRay: RAPIER.Ray | null = null
function rayAlong(
  phys: PhysicsWorld,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): RAPIER.Ray {
  if (!scratchRay) {
    scratchRay = new phys.rapier.Ray({ x, y, z }, { x: dx, y: dy, z: dz })
    return scratchRay
  }
  scratchRay.origin.x = x
  scratchRay.origin.y = y
  scratchRay.origin.z = z
  scratchRay.dir.x = dx
  scratchRay.dir.y = dy
  scratchRay.dir.z = dz
  return scratchRay
}

/**
 * Center probe. Casts from (fromX,fromY,fromZ) along (dx,dy,dz) and also
 * samples the wave field for water. Returns the higher surface (projected
 * on up) as the ride surface — same controller for land and water, just a
 * different surface y. Water sampling is XZ-only — only call with a
 * non-null `field` when up ≈ world-Y (anti-grav callers pass null).
 */
export function probeSurface(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  upX: number,
  upY: number,
  upZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): SurfaceProbe {
  const ray = rayAlong(phys, fromX, fromY, fromZ, dx, dy, dz)
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  let groundProj = Number.NEGATIVE_INFINITY
  let groundSurface: SurfaceTypeValue = SurfaceType.DEFAULT
  if (hit) {
    const hx = fromX + dx * hit.timeOfImpact
    const hy = fromY + dy * hit.timeOfImpact
    const hz = fromZ + dz * hit.timeOfImpact
    groundProj = hx * upX + hy * upY + hz * upZ
    groundSurface = phys.surfaces.get(hit.collider.handle)
  }
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY

  if (groundProj === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return { surfaceProj: 0, isWater: false, hasSurface: false, surfaceType: SurfaceType.DEFAULT }
  }
  if (groundProj > waterY) {
    return { surfaceProj: groundProj, isWater: false, hasSurface: true, surfaceType: groundSurface }
  }
  // Water can be sampled anywhere, so water is "always reachable" — but
  // only counts as a ride surface if the bike is within probe range of
  // it. When `field` is non-null we're in world-up land, so fromY is the
  // bike's proj on up and waterY is the surface proj.
  const reachable = fromY - waterY < MAX_HOVER_PROBE
  return {
    surfaceProj: waterY,
    isWater: true,
    hasSurface: reachable,
    surfaceType: SurfaceType.WATER,
  }
}

/**
 * Footprint probe: returns the surface projection on up at the probe's
 * XYZ. Returns NEGATIVE_INFINITY if neither ground nor water is found
 * (caller falls back to the center probe).
 *
 * `lift` raises the ray origin `lift` metres along +up so the cast can
 * see surface rising ABOVE the probe — critical for ramp / wall
 * anticipation. A bow probe at the bike's level casting along the bike's
 * "down" would MISS an upcoming ramp face. Cast distance grows to
 * compensate so the same set of surface beyond stays reachable.
 */
function probeSurfaceY(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  upX: number,
  upY: number,
  upZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
  lift = 0,
): number {
  const ox = fromX + upX * lift
  const oy = fromY + upY * lift
  const oz = fromZ + upZ * lift
  const ray = rayAlong(phys, ox, oy, oz, dx, dy, dz)
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE + lift,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  let groundProj = Number.NEGATIVE_INFINITY
  if (hit) {
    const hx = ox + dx * hit.timeOfImpact
    const hy = oy + dy * hit.timeOfImpact
    const hz = oz + dz * hit.timeOfImpact
    groundProj = hx * upX + hy * upY + hz * upZ
  }
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY
  if (groundProj === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return Number.NEGATIVE_INFINITY
  }
  return Math.max(groundProj, waterY)
}

// ============================================================================
// Anti-grav frame resolution
// ============================================================================

/** Per-bike dedup for the AG degenerate-blend warning. Logging once per
 *  bike (not per tick) keeps the signal clear without spamming the
 *  console if a track author drives a bike into a pathological banking. */
const _agDegenerateWarned = new Set<number>()
function warnAGDegenerateBlend(eid: number): void {
  if (_agDegenerateWarned.has(eid)) return
  _agDegenerateWarned.add(eid)
  console.warn(
    `[hover] anti-grav up-blend collapsed for bike eid=${eid}. Source up is ~opposite world up at a half-blend weight. Smooth out the banking transition or move the inversion outside the falloff radius.`,
  )
}

/**
 * Build the bike's frame-of-reference for this tick. Reads the anti-grav
 * override (written by `antiGravSystem` earlier in the same tick) and
 * blends the source up vector with world up by weight. When no anti-grav
 * source is active the frame degenerates to (upY=1, agWeight=0) and
 * every downstream phase reduces to world-down behaviour.
 */
export function buildHoverFrame(
  eid: number,
  rb: RAPIER.RigidBody,
  stats: BikeStatsData,
  intent: ControlIntentData,
  dt: number,
  gravity: number,
): HoverFrame {
  const t = rb.translation()
  const linvel = rb.linvel()
  const q = rb.rotation()

  let agActive = false
  let upX = 0
  let upY = 1
  let upZ = 0
  let agWeight = 0
  const agOverride = AntiGravOverrideStore.get(eid)
  if (agOverride?.active) {
    agActive = true
    agWeight = agOverride.weight
    // Effective up = blend(worldUp, sourceUp, weight). Normalize so the
    // probe / spring math stays unit-length-correct. Degenerate only
    // when source up ≈ −worldUp at exactly weight=0.5 (a half-blend
    // between right-side-up and upside-down). Fallback warns dev once.
    const blendX = agWeight * agOverride.upX
    const blendY = 1 - agWeight + agWeight * agOverride.upY
    const blendZ = agWeight * agOverride.upZ
    const bLen = Math.hypot(blendX, blendY, blendZ)
    if (bLen > 1e-3) {
      upX = blendX / bLen
      upY = blendY / bLen
      upZ = blendZ / bLen
    } else {
      warnAGDegenerateBlend(eid)
      upX = agOverride.upX
      upY = agOverride.upY
      upZ = agOverride.upZ
    }
  }
  return {
    eid,
    rb,
    stats,
    intent,
    dt,
    m: stats.mass,
    gravity,
    t,
    linvel,
    q,
    upX,
    upY,
    upZ,
    dnX: -upX,
    dnY: -upY,
    dnZ: -upZ,
    agActive,
    agWeight,
    waterSurfaceVy: 0,
  }
}

// ============================================================================
// Multi-probe footprint sampling
// ============================================================================

/**
 * Read the surface height at four points around the bike — bow, stern,
 * port, starboard — and derive the bow→stern forward slope.
 *
 * Multi-probe sampling (SoT/Atlas-style), unified across water + ground:
 * each probe takes max(ground raycast, wave field height), so a bike
 * straddling the shoreline correctly reads the high terrain on one side
 * and the wave on the other. More correct than reading the local wave
 * normal under the bike's center because the bike has a real footprint:
 *   1. Long swells naturally tilt the bike across the wave.
 *   2. Short chops + sub-footprint terrain bumps average between probes
 *      so the bike doesn't whip-snap to every ripple or trimesh edge.
 *   3. Mixed water/terrain transitions read continuously instead of
 *      flickering between water-only and ground-only branches.
 *
 * Slope is computed raw and low-pass-filtered (~50ms tau, dt-aware) so
 * lumpy trimeshes don't translate to single-tick thrust/torque kicks.
 * The raw slope is preserved on the footprint for landing-transition
 * gates that need a fresh reading.
 */
export function sampleSurfaceFootprint(
  frame: HoverFrame,
  phys: PhysicsWorld,
  probe: SurfaceProbe,
  probeField: WaveFieldState | null,
  debugOn: boolean,
  debugCorners: HoverProbe[],
  prevForwardSlope: number,
  tuning: SimTuning,
): Footprint {
  const { upX, upY, upZ, dnX, dnY, dnZ, t, linvel, q, rb, dt } = frame

  // Probe footprint matches the bike's visual scale (~1.6m × 0.8m) at
  // rest, then extends fore/aft with bike speed (anticipation: at 25 m/s
  // the bow probe is ~2m out in front, so the bike pitches to match the
  // slope it's about to hit). Speed measured in the up-plane so the
  // anticipation works on tilted anti-grav roads too.
  const linvelUp = linvel.x * upX + linvel.y * upY + linvel.z * upZ
  const planeVx = linvel.x - upX * linvelUp
  const planeVy = linvel.y - upY * linvelUp
  const planeVz = linvel.z - upZ * linvelUp
  const speedPlane = Math.hypot(planeVx, planeVy, planeVz)
  // Probe geometry is read live from tuning (snapshotted off devSettings) so
  // the F4 hover-debug overlay can preview tuning changes immediately. The
  // anticipation cap (1.4 m) stays hardcoded — it's a guard against
  // speed-driven overshoot, not a tuning knob.
  const probeHalfLength =
    tuning.hoverProbeHalfLength + Math.min(speedPlane * tuning.hoverProbeSpeedScale, 1.4)
  const probeHalfWidth = tuning.hoverProbeHalfWidth

  // Full 3D bike-fwd / bike-right (used for spring force positions).
  const fwd3D = quatRotate(q, { x: 0, y: 0, z: 1 })
  const right3D = quatRotate(q, { x: 1, y: 0, z: 0 })

  // Project bike-fwd onto the up-plane, then normalize → the "horizontal"
  // forward in zone-local frame. Used to position the probe samples.
  // Falls back to fwd3D when degenerate (bike-fwd colinear with up).
  const fwdDotUp = fwd3D.x * upX + fwd3D.y * upY + fwd3D.z * upZ
  let pfX = fwd3D.x - upX * fwdDotUp
  let pfY = fwd3D.y - upY * fwdDotUp
  let pfZ = fwd3D.z - upZ * fwdDotUp
  const pfLen = Math.hypot(pfX, pfY, pfZ)
  if (pfLen > 0.01) {
    pfX /= pfLen
    pfY /= pfLen
    pfZ /= pfLen
  } else {
    pfX = fwd3D.x
    pfY = fwd3D.y
    pfZ = fwd3D.z
  }
  // Right = up × fwdInUpPlane (unit, since both are unit and orthogonal).
  const sampleRightX = upY * pfZ - upZ * pfY
  const sampleRightY = upZ * pfX - upX * pfZ
  const sampleRightZ = upX * pfY - upY * pfX

  // Each probe casts from PROBE_LIFT *along +up* of the bike center so a
  // rising surface in front of the bike (a ramp face, a wall on
  // approach) is correctly intersected from above. Live-tunable.
  const PROBE_LIFT = tuning.hoverProbeLift
  // Falls back to the center probe's surface projection if neither
  // hit (bike overhanging an edge with nothing below — read the missing
  // side as flat with the center rather than NaN).
  const fallbackProj = probe.surfaceProj
  // Edge gate: a corner whose surface sits more than the grounded cutoff
  // below the bike is over a LEDGE / VOID — a rooftop or cliff edge, or
  // (on the flooded maps) open water far below — not a slope to follow.
  // Read it as flat with the center, same as the no-hit overhang above.
  // Mirrors the per-corner spring's `localDist > groundedCutoff` skip so
  // the slope read stays consistent with which corners the spring trusts.
  // Without it the speed-anticipated bow probe reads the drop as a steep
  // phantom downhill, the grounded pitch PD noses the bike DOWN to
  // "follow" it, and the rider gets yanked straight down off the edge
  // instead of launching off it. (The corner probe samples the wave field
  // with no range limit, so on flooded maps the bow always "finds" the sea
  // far below an edge — the center probe gates that by reachability, here
  // we gate by the same grounded cutoff the spring uses.)
  const bikeProj = t.x * upX + t.y * upY + t.z * upZ
  const cliffCutoff = frame.stats.hoverHeight * GROUNDED_DISTANCE_MUL
  const sampleAt = (px: number, py: number, pz: number, dbgIdx: number): number => {
    const v = probeSurfaceY(
      phys,
      probeField,
      px,
      py,
      pz,
      dnX,
      dnY,
      dnZ,
      upX,
      upY,
      upZ,
      rb,
      PROBE_LIFT,
    )
    if (debugOn) {
      const c = debugCorners[dbgIdx]!
      // Lifted origin = (px,py,pz) + up * PROBE_LIFT — what the ray
      // actually starts from. Stored so the renderer can draw the
      // probe ray from its true origin.
      c.ox = px + upX * PROBE_LIFT
      c.oy = py + upY * PROBE_LIFT
      c.oz = pz + upZ * PROBE_LIFT
      if (v !== Number.NEGATIVE_INFINITY) {
        const liftedProj = c.ox * upX + c.oy * upY + c.oz * upZ
        const along = liftedProj - v
        c.hx = c.ox + dnX * along
        c.hy = c.oy + dnY * along
        c.hz = c.oz + dnZ * along
      } else {
        c.hx = Number.NEGATIVE_INFINITY
      }
    }
    if (v === Number.NEGATIVE_INFINITY || bikeProj - v > cliffCutoff) return fallbackProj
    return v
  }
  const bowProj = sampleAt(
    t.x + pfX * probeHalfLength,
    t.y + pfY * probeHalfLength,
    t.z + pfZ * probeHalfLength,
    0,
  )
  const sternProj = sampleAt(
    t.x - pfX * probeHalfLength,
    t.y - pfY * probeHalfLength,
    t.z - pfZ * probeHalfLength,
    1,
  )
  const starboardProj = sampleAt(
    t.x + sampleRightX * probeHalfWidth,
    t.y + sampleRightY * probeHalfWidth,
    t.z + sampleRightZ * probeHalfWidth,
    2,
  )
  const portProj = sampleAt(
    t.x - sampleRightX * probeHalfWidth,
    t.y - sampleRightY * probeHalfWidth,
    t.z - sampleRightZ * probeHalfWidth,
    3,
  )
  const surfaceForwardSlopeRaw = (bowProj - sternProj) / (2 * probeHalfLength)
  // Exponential low-pass toward this tick's raw reading. dt-aware so a
  // stretched frame catches up faster instead of doubling the lag. The
  // HoverState write resets `forwardSlope` to 0 while airborne, so on
  // the first ground tick after a flight the filter seeds cleanly.
  const slopeAlpha = 1 - Math.exp(-dt / SLOPE_FILTER_TAU)
  const surfaceForwardSlope =
    prevForwardSlope + (surfaceForwardSlopeRaw - prevForwardSlope) * slopeAlpha

  return {
    bowProj,
    sternProj,
    starboardProj,
    portProj,
    surfaceForwardSlope,
    surfaceForwardSlopeRaw,
    probeHalfLength,
    probeHalfWidth,
    sampleFwdX: pfX,
    sampleFwdY: pfY,
    sampleFwdZ: pfZ,
    sampleRightX,
    sampleRightY,
    sampleRightZ,
    forceFwdX: fwd3D.x,
    forceFwdY: fwd3D.y,
    forceFwdZ: fwd3D.z,
    forceRightX: right3D.x,
    forceRightY: right3D.y,
    forceRightZ: right3D.z,
  }
}

// ============================================================================
// Debug overlay scratch
// ============================================================================

export function makeDebugCorners(): HoverProbe[] {
  return [
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
  ]
}
