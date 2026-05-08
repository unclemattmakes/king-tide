import type { Vec3 } from '@/engine/sim/physics/vec'

/**
 * Stadium-track AI spline. Both Lagoon Loop and Cliffside share the same
 * top-down xz layout — two long straights at x = ±50 from z = -50 to +50,
 * joined by curves over center points (0, ±50). Earlier versions of this
 * builder connected the gate centres with chord polylines, which gave the
 * AI three sharp jogs (45° + 90° + 45°) per curve instead of a smooth
 * arc. The AI couldn't take those jogs at speed, so it overshot cp 1 /
 * cp 4 and the lap-completion rate sat below 50%.
 *
 * This helper samples a smooth tangent-arc geometry, so the AI's lookahead
 * sees a continuously bending path with no sudden angle spikes. Y values
 * are provided per-section by the caller — Lagoon is flat, Cliffside has
 * the mesa top.
 *
 * Curve geometry — the natural radius-50 half-circle has its apex at
 * z = ±100, which is exactly Cliffside's mesa edge (mesa half-extent z =
 * 25 around z = 75 → north edge at z = 100). Any inertial overshoot
 * puts the bike off the cliff on the wrong side. We inset the apex by
 * APEX_INSET so the racing line stays inside the mesa with margin, and
 * solve for the unique tangent-arc that:
 *   - starts at corner-start (e.g. (50, 50))
 *   - ends at corner-end   (e.g. (-50, 50))
 *   - has its apex at (0, ±(50 + (50 - APEX_INSET)))
 * The arc center sits south of the corner-start z by δ = (R²−r²)/(2r),
 * where R = 50 (corner-half-width), r = 50 − APEX_INSET (apex height
 * above the corner-line). The arc radius works out to r + δ.
 *
 * Layout (CCW from cp 0 going +Z):
 *   right straight  cp 0 → cp 1   (x = +50, z: 0 → +50)
 *   top curve       cp 1 → cp 4   (tangent arc, apex at (0, 50+r))
 *   left straight   cp 4 → cp 5   (x = -50, z: +50 → -50)
 *   bottom curve    cp 5 → cp 8   (tangent arc, apex at (0, -50-r))
 *   close           cp 8 → cp 0   (x = +50, z: -50 → 0)
 */
const STADIUM_R = 50
/** Distance the curve apex sits below the natural-radius value (50).
 *  Set to 8 → apex z = ±92, leaving 8m of margin from Cliffside's mesa edge.
 *  Smaller = tighter racing line, more cornering speed, less safety margin. */
const APEX_INSET = 8

export type StadiumYProfile = {
  /** y at cp 0 (right straight, mid). */
  cp0Y: number
  /** y at cp 1 (top of right straight, where the climb finishes on Cliffside). */
  cp1Y: number
  /** y across the top curve (mesa or water). cp 2..cp 4 share this y. */
  topCurveY: number
  /** y at cp 5 (top of left straight, after the cliff drop on Cliffside). */
  cp5Y: number
  /** y at cp 8 (bottom of right straight, before the climb on Cliffside). */
  cp8Y: number
}

export function buildStadiumAISpline(yp: StadiumYProfile): Vec3[] {
  const points: Vec3[] = []

  const straightHalfSegs = 10 // each half of the right straight (north / south of cp 0)
  const leftStraightSegs = 20
  const curveSegs = 30

  // Right straight, north half: cp 0 (50, 0) → cp 1 (50, 50).
  for (let s = 0; s < straightHalfSegs; s++) {
    const t = s / straightHalfSegs
    points.push({
      x: STADIUM_R,
      y: yp.cp0Y + (yp.cp1Y - yp.cp0Y) * t,
      z: STADIUM_R * t,
    })
  }

  // Top curve: tangent arc starting at (50, 50), ending at (-50, 50),
  // apex at (0, 50 + apexHeight). See header for geometry derivation.
  const apexHeight = STADIUM_R - APEX_INSET // 42 with default inset
  const delta = (STADIUM_R * STADIUM_R - apexHeight * apexHeight) / (2 * apexHeight)
  const arcRadius = apexHeight + delta
  // Top arc center is south of the corner line by `delta`.
  const topCenterZ = STADIUM_R - delta // 50 - δ
  // Angles span [startAngle, π - startAngle], CCW.
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

  // Left straight: cp 4 (-50, 50) → cp 5 (-50, -50). Y lerps top → cp5.
  for (let s = 0; s < leftStraightSegs; s++) {
    const t = s / leftStraightSegs
    points.push({
      x: -STADIUM_R,
      y: yp.topCurveY + (yp.cp5Y - yp.topCurveY) * t,
      z: STADIUM_R - 2 * STADIUM_R * t,
    })
  }

  // Bottom curve: mirror of the top curve. Starts at (-50, -50), ends at
  // (50, -50), apex at (0, -50 - apexHeight). Center is north of the
  // corner line by `delta`, i.e., at z = -(STADIUM_R - delta) = -topCenterZ.
  // Angle parameterisation: π + startAngle → 2π - startAngle (CCW).
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

  // Right straight, south half: cp 8 (50, -50) → cp 0 (50, 0). Y lerps cp8 → cp0.
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
