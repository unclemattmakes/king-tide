import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { buildStadiumAISpline } from './spline-utils'
import type { Checkpoint, Track } from './types'

/**
 * Stadium-shaped racetrack — two long straights joined by two half-circle
 * curves, NASCAR-style. The start line sits ALONG the loop (on the right
 * straight), so the player spawns on the racing line itself rather than
 * inside a separate infield and hopping on.
 *
 * Layout (top-down, +Z up):
 *
 *               cp3 — cp2  ← top curve (half-circle r=50 around (0, 50))
 *              /         \
 *           cp4           cp1
 *            │             │
 *            │   (infield  │
 *            │   island    │
 *            │   at        │
 *            │   origin)   │
 *            │             │
 *           cp5    spawn → cp0 ← start line, +Z
 *            │             │
 *            │             │
 *           cp5         cp8
 *              \         /
 *              cp6 — cp7 ← bottom curve (half-circle r=50 around (0, -50))
 *
 * cp 0's forward direction is +Z (along the right straight). cp 8 → cp 0 is
 * also pure +Z, so lap completion enters cp 0 in exactly the same direction
 * as the player's first crossing — clean and symmetric.
 */
export function createLagoonLoop(): Track {
  const cpY = 1.5
  const halfWidth = 14
  const height = 6

  // Stadium dims: straights at x=±50 from z=-50 to +50; curves are
  // half-circles of radius 50 around (0, ±50).
  const positions: Vec3[] = [
    { x: 50, y: cpY, z: 0 }, // 0 — START / FINISH (right straight, mid)
    { x: 50, y: cpY, z: 50 }, // 1 — top of right straight
    { x: 35, y: cpY, z: 85 }, // 2 — top curve, NE
    { x: -35, y: cpY, z: 85 }, // 3 — top curve, NW
    { x: -50, y: cpY, z: 50 }, // 4 — top of left straight
    { x: -50, y: cpY, z: -50 }, // 5 — bottom of left straight
    { x: -35, y: cpY, z: -85 }, // 6 — bottom curve, SW
    { x: 35, y: cpY, z: -85 }, // 7 — bottom curve, SE
    { x: 50, y: cpY, z: -50 }, // 8 — bottom of right straight (final approach to cp 0)
  ]

  // Forward at each gate = direction the bike enters from the previous gate.
  // cp 0's previous is cp 8 at (50, -50), so cp 0 forward = (0, 1) = pure +Z.
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

  // Smooth-arc AI spline. The previous chord polyline gave the AI three sharp
  // jogs per curve; with the proper half-circle arc, lookahead sees a
  // continuously bending path and the AI can hold speed through the corners.
  const aiPoints: Vec3[] = buildStadiumAISpline({
    cp0Y: 1,
    cp1Y: 1,
    topCurveY: 1,
    cp5Y: 1,
    cp8Y: 1,
  })

  return {
    id: 'lagoon-loop',
    name: 'Lagoon Loop',
    // Player spawns on the right straight, just south of cp 0, facing +Z.
    // No more "spawn in the middle and hop on" — straight off the line.
    start: {
      position: { x: 50, y: 2, z: -15 },
      yaw: 0,
    },
    lapsToFinish: 3,
    checkpoints,
    surfaces: [],
    boostPads: [],
    pickupSpawns: [
      { x: 50, y: 1.8, z: 25 }, // right straight, between cp 0 and cp 1
      { x: 25, y: 1.8, z: 80 }, // top curve, NE
      { x: -25, y: 1.8, z: 80 }, // top curve, NW
      { x: -50, y: 1.8, z: 0 }, // left straight, mid
      { x: -25, y: 1.8, z: -80 }, // bottom curve, SW
      { x: 25, y: 1.8, z: -80 }, // bottom curve, SE
      { x: 50, y: 1.8, z: -25 }, // right straight, between cp 8 and cp 0
    ],
    aiSplines: [{ id: 'main', points: aiPoints }],
  }
}
