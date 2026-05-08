import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { MESA_TOP_Y } from '@/game/entities/cliffside-terrain'
import { buildStadiumAISpline } from './spline-utils'
import type { Checkpoint, Track } from './types'

/**
 * Cliffside — second track. Same stadium gate layout as Lagoon Loop, but
 * the top half of the loop sits on a mesa at MESA_TOP_Y; the right
 * straight has a long ramp climbing up to it; the left straight begins
 * at the cliff edge with a 15m drop straight into the water below. That
 * drop is the JetMoto signature moment.
 *
 * This track is also the reference layout for our (still-procedural)
 * Blender export pipeline. Each named entity here corresponds to an
 * object you'd author in Blender:
 *
 *   - terrain meshes (mesa, climb_ramp, cliff_face) live in
 *     cliffside-terrain.ts / cliffside-mesh.ts
 *   - checkpoints `cp_NN` (zero-padded) → checkpoints array below
 *   - AI spline `ai_spline_main` → aiSplines below
 *   - pickup spawns `pickup_NN` → pickupSpawns below
 *   - player start `start_00` → start below
 *
 * When the .glb loader lands, this whole module collapses into "load
 * cliffside.glb and walk its scene graph".
 */
export function createCliffside(): Track {
  const halfWidth = 14
  const height = 6

  // Same xz layout as Lagoon, but cp 1 / 2 / 3 / 4 sit on top of the mesa
  // (cp 0 / 5..8 stay at water level).
  const lowY = 1.5
  const highY = MESA_TOP_Y + 0.5 // gate sits just above the mesa surface

  const positions: Vec3[] = [
    { x: 50, y: lowY, z: 0 }, // 0 — START / FINISH (right straight, mid)
    { x: 50, y: highY, z: 50 }, // 1 — mesa rim, top of climb
    { x: 35, y: highY, z: 85 }, // 2 — top curve, NE (mesa)
    { x: -35, y: highY, z: 85 }, // 3 — top curve, NW (mesa)
    { x: -50, y: highY, z: 50 }, // 4 — mesa rim, top of cliff drop
    { x: -50, y: lowY, z: -50 }, // 5 — bottom of left straight (water)
    { x: -35, y: lowY, z: -85 }, // 6 — bottom curve, SW
    { x: 35, y: lowY, z: -85 }, // 7 — bottom curve, SE
    { x: 50, y: lowY, z: -50 }, // 8 — bottom of right straight (water)
  ]

  // Forward at each gate = direction the bike enters from the previous gate.
  const forwards: { fx: number; fz: number }[] = positions.map((_, i) => {
    const prevIdx = (i - 1 + positions.length) % positions.length
    const prev = positions[prevIdx]!
    const here = positions[i]!
    const dx = here.x - prev.x
    const dz = here.z - prev.z
    const len = Math.hypot(dx, dz) || 1
    return { fx: dx / len, fz: dz / len }
  })

  const checkpoints: Checkpoint[] = positions.map((pos, i) => {
    const { fx, fz } = forwards[i]!
    const alpha = Math.atan2(fx, fz)
    const halfA = alpha / 2
    const rotation: Quat = {
      x: 0,
      y: Math.sin(halfA),
      z: 0,
      w: Math.cos(halfA),
    }
    return { index: i, position: pos, rotation, halfWidth, height }
  })

  // Smooth-arc AI spline. xz layout matches Lagoon Loop; y values follow the
  // mesa profile (cp 1..cp 4 high, cp 5..cp 8 low). The AI's steer math only
  // uses x/z, but a sensible y keeps later 3D-aware logic correct.
  const aiPoints: Vec3[] = buildStadiumAISpline({
    cp0Y: lowY,
    cp1Y: highY,
    topCurveY: highY,
    cp5Y: lowY,
    cp8Y: lowY,
  })

  return {
    id: 'cliffside',
    name: 'Cliffside',
    // Spawn just south of cp 0, on water, facing +Z (up the right straight
    // toward the climb ramp).
    start: {
      position: { x: 50, y: 2, z: -15 },
      yaw: 0,
    },
    lapsToFinish: 3,
    checkpoints,
    surfaces: [],
    boostPads: [],
    pickupSpawns: [
      { x: 50, y: 1.8, z: -25 }, // right straight south, before the climb
      { x: 50, y: highY + 0.3, z: 70 }, // mesa, near cp 1 → cp 2 corner
      { x: 0, y: highY + 0.3, z: 95 }, // mesa, top of the curve
      { x: -50, y: highY + 0.3, z: 70 }, // mesa, near cp 3 → cp 4 corner (right before the drop!)
      { x: -50, y: 1.8, z: 0 }, // left straight, mid (post-landing)
      { x: -25, y: 1.8, z: -80 }, // bottom curve, SW
      { x: 25, y: 1.8, z: -80 }, // bottom curve, SE
    ],
    aiSplines: [{ id: 'main', points: aiPoints }],
  }
}
