import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { ISLAND_RADIUS, ISLAND_TOP_Y } from '@/game/entities/arena'
import type { Checkpoint, Track } from './types'

/**
 * Procedural test track: a true closed loop around the island.
 *
 *   Player spawns just south of cp 0 facing +Z. Drives through cp 0
 *   (start/finish), then up the centre, swings east through cp 2/3, sweeps
 *   south through cp 4/5, comes back up the west side via cp 6/7, then a
 *   final approach gate (cp 8) just south-west of the start so lap
 *   completion lines up with cp 0's +Z crossing direction.
 *
 *   Layout (top-down, +Z up):
 *
 *                  cp 7 ─── cp 1 ───── (top)
 *                                         │
 *                  cp 6                 cp 2
 *                                         │
 *                                       cp 3 (east straight)
 *                                         │
 *                  ............ cp 0      │
 *                  cp 8         spawn     │
 *                                       cp 4
 *                                         │
 *                  cp 5 ─────────── (bottom)
 *
 * cp 0's forward is hardcoded +Z so the player's first crossing
 * (driving north out of the spawn) registers correctly. Other gates use
 * the direction from the previous gate as their forward.
 */
export function createLagoonLoop(): Track {
  const cpY = 1.5
  const halfWidth = 14
  const height = 6

  const positions: Vec3[] = [
    { x: 0, y: cpY, z: 30 }, // 0 — start/finish (forward = +Z)
    { x: 0, y: cpY, z: 70 }, // 1 — north straight
    { x: 60, y: cpY, z: 60 }, // 2 — NE corner
    { x: 75, y: cpY, z: 0 }, // 3 — east straight (mid)
    { x: 60, y: cpY, z: -60 }, // 4 — SE corner
    { x: -60, y: cpY, z: -60 }, // 5 — SW corner (across the south)
    { x: -75, y: cpY, z: 0 }, // 6 — west straight (mid)
    { x: -60, y: cpY, z: 60 }, // 7 — NW corner
    { x: -25, y: cpY, z: 10 }, // 8 — final approach, south of cp 0 so the bike
    //     enters cp 0 from below for clean lap detection
  ]

  // Forward direction at each gate. cp 0 is special (player's start direction);
  // other gates inherit the direction from the previous gate.
  const forwards: { fx: number; fz: number }[] = positions.map((_, i) => {
    if (i === 0) return { fx: 0, fz: 1 }
    const prev = positions[i - 1]!
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

  // Dense AI spline — 10 sub-segments per checkpoint pair = 90 points around
  // the loop, plenty of resolution for the closest-point search.
  const aiPoints: Vec3[] = []
  for (let i = 0; i < positions.length; i++) {
    const here = positions[i]!
    const next = positions[(i + 1) % positions.length]!
    const segments = 10
    for (let s = 0; s < segments; s++) {
      const t = s / segments
      aiPoints.push({
        x: here.x + (next.x - here.x) * t,
        y: 1,
        z: here.z + (next.z - here.z) * t,
      })
    }
  }

  return {
    id: 'lagoon-loop',
    name: 'Lagoon Loop',
    start: {
      position: { x: 0, y: ISLAND_TOP_Y + 2, z: ISLAND_RADIUS - 4 },
      yaw: 0,
    },
    lapsToFinish: 3,
    checkpoints,
    surfaces: [],
    pickupSpawns: [
      { x: 0, y: 1.8, z: 28 }, // right past the start line
      { x: 30, y: 1.8, z: 70 }, // along cp 1 → cp 2
      { x: 75, y: 1.8, z: 30 }, // east straight, top
      { x: 75, y: 1.8, z: -30 }, // east straight, bottom
      { x: 0, y: 1.8, z: -65 }, // bottom centre (cp 4 → cp 5)
      { x: -75, y: 1.8, z: -30 }, // west straight, bottom
      { x: -75, y: 1.8, z: 30 }, // west straight, top
      { x: -40, y: 1.8, z: 35 }, // top-west (cp 7 → cp 8)
    ],
    aiSplines: [{ id: 'main', points: aiPoints }],
  }
}
