import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { ISLAND_RADIUS, ISLAND_TOP_Y } from '@/game/entities/arena'
import type { Checkpoint, Track } from './types'

/**
 * Procedural test track: a rectangular loop on water surrounding the island.
 *
 *   spawn (0,_,20)  →  cp0 (0,_,35)
 *                       │ +Z
 *                      cp1 (0,_,75)        — top
 *                       └─── east
 *                            cp2 (60,_,30) — east side
 *                       │ -Z
 *                            cp3 (60,_,-30)
 *                            └─── west ────────────────
 *                            cp4 (-60,_,-30) — south side
 *                       │ +Z
 *                            cp5 (-60,_,30)
 *                       └─── east ──── back to cp0
 *
 * Each gate's "forward" is the direction OUT of the gate (toward the next).
 * cp 0 specifically faces +Z so the player enters it head-on from the spawn.
 */
export function createLagoonLoop(): Track {
  const cpY = 1.5
  const halfWidth = 8
  const height = 6

  // Ordered checkpoint positions.
  const positions: Vec3[] = [
    { x: 0, y: cpY, z: 35 }, // 0 — start/finish, just past island
    { x: 0, y: cpY, z: 78 }, // 1 — top straight
    { x: 60, y: cpY, z: 50 }, // 2 — NE corner
    { x: 60, y: cpY, z: -40 }, // 3 — east straight south
    { x: -60, y: cpY, z: -40 }, // 4 — south straight west
    { x: -60, y: cpY, z: 50 }, // 5 — NW corner
  ]

  // Forward (gate-cross direction) for each gate.
  // cp 0 is special: the player enters from the spawn moving +Z.
  // For cp i > 0, forward = direction from cp i-1 to cp i (the way the player approaches).
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
    // Quat that rotates (0,0,1) to (fx, 0, fz): Y-rotation by α = atan2(fx, fz).
    const alpha = Math.atan2(fx, fz)
    const halfA = alpha / 2
    const rotation: Quat = {
      x: 0,
      y: Math.sin(halfA),
      z: 0,
      w: Math.cos(halfA),
    }
    return {
      index: i,
      position: pos,
      rotation,
      halfWidth,
      height,
    }
  })

  // AI spline — denser sampling along the same ordered loop.
  const aiPoints: Vec3[] = []
  for (let i = 0; i < positions.length; i++) {
    const here = positions[i]!
    const next = positions[(i + 1) % positions.length]!
    const segments = 6
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
    pickupSpawns: [],
    aiSplines: [{ id: 'main', points: aiPoints }],
  }
}
