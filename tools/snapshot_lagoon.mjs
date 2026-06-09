// Generate public/tracks/lagoon-edit.json from the procedural Lagoon Loop
// definition. Run once via `node tools/snapshot_lagoon.mjs` to refresh
// the editable copy.
//
// New format (M9.20+):
//   - Spline lives in `aiSplines[0].anchors`, a sparse list of Catmull-Rom
//     control points. The runtime loader samples these into the dense
//     `points` polyline that the AI controller follows.
//   - Each gate carries `splineT` (0..1 along the closed curve). The
//     loader derives the gate's xz position + yaw from the spline at
//     that parameter; the editor's translate gizmo slides bound gates
//     along the curve rather than freely.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STADIUM_R = 50

// Anchor layout — 8 control points placed at the natural corners of the
// stadium. Catmull-Rom interpolates them into a smooth oval. This is
// what the user actually sees and drags in the editor.
function buildAnchors() {
  const y = 1
  return [
    { x: STADIUM_R, y, z: 0 }, // 0 — start/finish straight, mid
    { x: STADIUM_R, y, z: 50 }, // 1 — top-right of right straight
    { x: 35, y, z: 90 }, // 2 — top-curve NE
    { x: -35, y, z: 90 }, // 3 — top-curve NW
    { x: -STADIUM_R, y, z: 50 }, // 4 — top-left of left straight
    { x: -STADIUM_R, y, z: -50 }, // 5 — bottom-left of left straight
    { x: -35, y, z: -90 }, // 6 — bottom-curve SW
    { x: 35, y, z: -90 }, // 7 — bottom-curve SE
    { x: STADIUM_R, y, z: -50 }, // 8 — bottom-right of right straight
  ]
}

// Sparse (8) anchors → 9 gates evenly spaced via splineT. Catmull-Rom
// gives ~uniform parameter spacing for our roughly-uniform anchors, so
// equal-t spacing visually maps to equal-arc spacing reasonably well.
function buildGateTs(numGates) {
  const ts = []
  for (let i = 0; i < numGates; i++) ts.push(i / numGates)
  return ts
}

function buildLagoon() {
  const anchors = buildAnchors()
  const cpY = 1.5
  const halfWidth = 14
  const height = 6
  const numGates = 9

  const gateTs = buildGateTs(numGates)
  const checkpoints = gateTs.map((t, i) => ({
    index: i,
    // Position + rotation are placeholder; loader overwrites them from
    // the spline. Keep cpY here so the gate's vertical placement is
    // correct (the spline is xz-only at y=1).
    position: { x: 0, y: cpY, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth,
    height,
    splineT: t,
  }))

  return {
    id: 'lagoon-edit',
    name: 'Lagoon Loop (editable)',
    lapsToFinish: 3,
    water: { height: 0 },
    start: { position: { x: 50, y: 2, z: -15 }, yaw: 0 },
    checkpoints,
    aiSplines: [{ id: 'main', points: [], anchors }],
    pickupSpawns: [
      { x: 50, y: 1.8, z: 25 },
      { x: 25, y: 1.8, z: 80 },
      { x: -25, y: 1.8, z: 80 },
      { x: -50, y: 1.8, z: 0 },
      { x: -25, y: 1.8, z: -80 },
      { x: 25, y: 1.8, z: -80 },
      { x: 50, y: 1.8, z: -25 },
    ],
    boostPads: [],
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'public', 'tracks', 'lagoon-edit.json')
const data = buildLagoon()
fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
console.log(`wrote ${OUT}`)
console.log(
  `  ${data.checkpoints.length} checkpoints (splineT-bound), ${data.aiSplines[0].anchors.length} anchors, ${data.pickupSpawns.length} pickups`,
)
