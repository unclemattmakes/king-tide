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
    hoverSpring: 34, // (m/s^2) per meter of height error — firmer push so the bike lifts cleanly over rising terrain (SF-grade climbs) instead of dragging its belly
    hoverDamp: 8.5, // (m/s^2) per m/s of vertical velocity — bumped in step with spring to keep ζ≈0.73 (lively, not bobbly)
    accel: 19, // (m/s^2) forward thrust at full throttle, scaled by speedFalloff
    topSpeed: 28, // dialed down: easier to keep on the line and collisions less violent
    turnTorque: 4.0, // (rad/s^2) at full steer — gentle enough that the AI's PD doesn't oscillate
    lateralDrag: 8, // (m/s^2) per m/s of lateral drift — slightly grippier; less hover-skate
    reverseScale: 0.4,
    boostMul: 1.6,
    // Heavier baseline mass (was 120) — physics applies forces in
    // acceleration units, so accel feel is mass-independent, but the
    // higher inertia shows through clearly in collisions, mine pushback,
    // and pickup impulses. Combined with the lowered accel/turnTorque
    // above, the bike now reads as a chunkier machine.
    mass: 150,
    // 0.85 reads as an attentive hover bike that rocks/rolls with chop
    // and swells without getting whipped around. Future bike variants can
    // dial this up (~1.0 for a twitchy jet ski that fully matches the
    // surface differential) or down (~0.55 for a heavy cruiser that
    // ploughs through). Note: ground always uses 1.0 base follow; this
    // is the water-side base only.
    surfaceFollow: 0.85,
    // Tuck tuning — snowboarder ducking down a hill, driven by the
    // nose-down lean (see tuckFactor in hover.ts). At the sweet spot the
    // +15% cap reads as +5 m/s of "found speed" on a sustained downslope
    // where slope-momentum was already pushing the bike toward the cap,
    // and halved drag lets it track a clean line. Lean too far and the
    // factor goes negative — these invert into a cap cut + drag spike, so
    // burying the nose (belly-scrape) actively bleeds speed.
    tuckSpeedBoost: 1.15,
    tuckDragMul: 0.5,
  }
}
