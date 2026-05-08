// Generate public/tracks/lagoon-edit.json from the procedural Lagoon Loop
// definition. Run once via `node tools/snapshot_lagoon.mjs` to refresh the
// editable copy. Mirrors src/game/tracks/lagoon-loop.ts + spline-utils.ts.
//
// We reimplement the math here in plain JS (rather than importing the .ts
// modules) to avoid pulling in a TS toolchain just for a one-shot. If you
// change lagoon-loop.ts and want to refresh the JSON, also update this
// script and re-run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STADIUM_R = 50
const APEX_INSET = 8

function buildStadiumAISpline(yp) {
  const points = []
  const straightHalfSegs = 10
  const leftStraightSegs = 20
  const curveSegs = 30

  for (let s = 0; s < straightHalfSegs; s++) {
    const t = s / straightHalfSegs
    points.push({
      x: STADIUM_R,
      y: yp.cp0Y + (yp.cp1Y - yp.cp0Y) * t,
      z: STADIUM_R * t,
    })
  }

  const apexHeight = STADIUM_R - APEX_INSET
  const delta = (STADIUM_R * STADIUM_R - apexHeight * apexHeight) / (2 * apexHeight)
  const arcRadius = apexHeight + delta
  const topCenterZ = STADIUM_R - delta
  const startAngle = Math.atan2(delta, STADIUM_R)
  const endAngle = Math.PI - startAngle
  for (let s = 0; s < curveSegs; s++) {
    const t = s / curveSegs
    const a = startAngle + (endAngle - startAngle) * t
    points.push({
      x: arcRadius * Math.cos(a),
      y: yp.topCurveY,
      z: topCenterZ + arcRadius * Math.sin(a),
    })
  }

  for (let s = 0; s < leftStraightSegs; s++) {
    const t = s / leftStraightSegs
    points.push({
      x: -STADIUM_R,
      y: yp.topCurveY + (yp.cp5Y - yp.topCurveY) * t,
      z: STADIUM_R - 2 * STADIUM_R * t,
    })
  }

  const botStartAngle = Math.PI + startAngle
  const botEndAngle = 2 * Math.PI - startAngle
  for (let s = 0; s < curveSegs; s++) {
    const t = s / curveSegs
    const a = botStartAngle + (botEndAngle - botStartAngle) * t
    points.push({
      x: arcRadius * Math.cos(a),
      y: yp.cp5Y + (yp.cp8Y - yp.cp5Y) * t,
      z: -topCenterZ + arcRadius * Math.sin(a),
    })
  }

  for (let s = 0; s < straightHalfSegs; s++) {
    const t = s / straightHalfSegs
    points.push({
      x: STADIUM_R,
      y: yp.cp8Y + (yp.cp0Y - yp.cp8Y) * t,
      z: -STADIUM_R + STADIUM_R * t,
    })
  }

  return points
}

function buildLagoon() {
  const cpY = 1.5
  const halfWidth = 14
  const height = 6

  const positions = [
    { x: 50, y: cpY, z: 0 },
    { x: 50, y: cpY, z: 50 },
    { x: 35, y: cpY, z: 85 },
    { x: -35, y: cpY, z: 85 },
    { x: -50, y: cpY, z: 50 },
    { x: -50, y: cpY, z: -50 },
    { x: -35, y: cpY, z: -85 },
    { x: 35, y: cpY, z: -85 },
    { x: 50, y: cpY, z: -50 },
  ]

  const checkpoints = positions.map((pos, i) => {
    const prevIdx = (i - 1 + positions.length) % positions.length
    const prev = positions[prevIdx]
    const dx = pos.x - prev.x
    const dz = pos.z - prev.z
    const len = Math.hypot(dx, dz) || 1
    const fx = dx / len
    const fz = dz / len
    const alpha = Math.atan2(fx, fz)
    const halfA = alpha / 2
    return {
      index: i,
      position: pos,
      rotation: { x: 0, y: Math.sin(halfA), z: 0, w: Math.cos(halfA) },
      halfWidth,
      height,
    }
  })

  const aiPoints = buildStadiumAISpline({
    cp0Y: 1,
    cp1Y: 1,
    topCurveY: 1,
    cp5Y: 1,
    cp8Y: 1,
  })

  return {
    id: 'lagoon-edit',
    name: 'Lagoon Loop (editable)',
    lapsToFinish: 3,
    water: { height: 0, waveHeight: 1.0, waveFreq: 0.5 },
    start: { position: { x: 50, y: 2, z: -15 }, yaw: 0 },
    checkpoints,
    aiSplines: [{ id: 'main', points: aiPoints }],
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
  `  ${data.checkpoints.length} checkpoints, ${data.aiSplines[0].points.length} spline pts, ${data.pickupSpawns.length} pickups`,
)
