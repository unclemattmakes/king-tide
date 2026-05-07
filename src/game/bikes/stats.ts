import type { BikeStatsData } from '@/game/components'

/**
 * Default bike stats. Tuned for arcade feel — generous handling, snappy accel.
 * Coefficients are in acceleration units (m/s^2 per unit) to keep tuning sane.
 *
 * Hover is a PD controller in acceleration form:
 *   aUp = g + hoverSpring * (target - distance) - hoverDamp * vy
 * With g = 25 (matches PhysicsWorld gravity), so aUp = g cancels gravity at rest.
 */
export function defaultBikeStats(): BikeStatsData {
  return {
    hoverHeight: 1.2,
    hoverSpring: 28, // (m/s^2) per meter of height error
    hoverDamp: 6, // (m/s^2) per m/s of vertical velocity
    accel: 24, // (m/s^2) forward thrust at full throttle, scaled by speedFalloff
    topSpeed: 36, // ~80 mph
    turnTorque: 7, // (rad/s^2) at full steer
    lateralDrag: 7, // (m/s^2) per m/s of lateral drift
    reverseScale: 0.4,
    boostMul: 1.6,
    mass: 120,
  }
}
