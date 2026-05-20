import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import type { Checkpoint, Track } from './types'

/**
 * Focused drift-verification track — a flat oval on the drift-test
 * arena plate.
 *
 * Designed specifically so a player (or an e2e harness) can verify the
 * MK8 hop-drift mini-turbo end-to-end in under a minute:
 *
 *   1. Spawn on a long straight at the south end of the oval, facing
 *      north. Throttle gets you to drift-floor speed (≥ 6 m/s) in
 *      under a second.
 *   2. Press the trick button on the straight → small hop fires.
 *   3. Still holding the trick button, steer into the sweeping east
 *      corner. Drift activates the moment the bike grounds and you
 *      have committed steer.
 *   4. Hold through the corner — tier-0 blue wisps appear immediately,
 *      escalate to full blue stream at 1 s charge, then orange at
 *      ~2.4 s. Release the button to fire the mini-turbo.
 *
 * No water, no anti-grav, no AI traffic, no pickups — only the gates
 * + the flat plate. Lap target deliberately loose; the point is to
 * exercise the drift state machine, not race time.
 *
 * Oval dimensions match the visual reference line on the arena mesh
 * (innerR=60, x-stretch 1.4 → x≈84, z≈60). Checkpoints sit a little
 * outside that line so the gate triggers fire even if the player
 * drifts wide.
 */
export function createDriftTest(): Track {
  const cpY = 1.5
  const halfWidth = 18
  const height = 6

  // Oval: long axis along x, short axis along z. Eight checkpoints —
  // 2 per straight + 1 per corner apex — so a wide drift through any
  // corner still trips its gates in order.
  const positions: Vec3[] = [
    { x: 0, y: cpY, z: -65 }, // 0 — START / FINISH (south straight, mid), heading +X
    { x: 65, y: cpY, z: -55 }, // 1 — SE corner entry
    { x: 90, y: cpY, z: 0 }, // 2 — east apex
    { x: 65, y: cpY, z: 55 }, // 3 — NE corner exit
    { x: 0, y: cpY, z: 65 }, // 4 — north straight, mid
    { x: -65, y: cpY, z: 55 }, // 5 — NW corner entry
    { x: -90, y: cpY, z: 0 }, // 6 — west apex
    { x: -65, y: cpY, z: -55 }, // 7 — SW corner exit
  ]

  // Forward at each gate = direction the bike enters from the
  // previous gate (chord vector between consecutive checkpoints).
  const forwards = positions.map((_, i) => {
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

  // AI spline — a finer-grained loop along the same oval. Mostly here
  // so any (debug) AI bike that happens to spawn doesn't get stuck;
  // the drift-test player flow doesn't depend on AI.
  const aiPoints: Vec3[] = []
  const SAMPLES = 48
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2
    aiPoints.push({
      x: Math.cos(t) * 80,
      y: 1.0,
      z: Math.sin(t) * 58,
    })
  }

  return {
    id: 'drift-test',
    name: 'Drift Test',
    // Player spawns on the south straight, ~10 m east of cp 0, facing
    // +X (east) — directly into the SE corner approach so they can
    // commit a hop on the straight and drift through cp 1 / 2 / 3.
    start: {
      // Half-yaw quaternion for yaw = π/2 (+X) is sin(π/4)=√2/2:
      // q = (0, √2/2, 0, √2/2). The track uses the `yaw` field; the
      // boot converts to a quaternion. yaw = π/2 → heading +X.
      position: { x: -10, y: 2, z: -65 },
      yaw: Math.PI / 2,
    },
    lapsToFinish: 3,
    checkpoints,
    surfaces: [],
    boostPads: [],
    antiGravZones: [],
    waveZones: [],
    props: [],
    pickupSpawns: [],
    aiSplines: [{ id: 'main', points: aiPoints }],
  }
}
