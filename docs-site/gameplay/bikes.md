# Bikes & stats

The garage menu (HUD button, top-right) lets you pick a bike. The URL also accepts `?bike=cruiser|racer|stunt`. The default is **Racer**.

## Archetypes

Three flavors with explicit handling tradeoffs so picking a bike feels like a real choice, not a recolor.

| | Cruiser | Racer | Stunt |
|---|---|---|---|
| Tagline | Heavy hitter — big top speed, plows through chop | Balanced all-rounder — the default | Light + agile — banks every wave |
| Mass (kg) | 160 | 120 | 90 |
| Top speed (m/s) | **32** | 28 | 25 |
| Accel (m/s²) | 18 | 22 | **26** |
| Turn torque (rad/s²) | 3.5 | 4.5 | **5.5** |
| Lateral drag | 6 | 7 | **8** |
| Surface follow | 0.3 | 0.5 | **0.7** |
| Hover spring | 24 | 28 | **32** |
| Hover damp | **7** | 6 | 5 |

Source of truth: [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts). The defaults each variant inherits live in [`stats.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/stats.ts).

## What each stat actually does

| Stat | Units | Effect |
|---|---|---|
| `mass` | kg | Rapier rigid-body mass. Higher mass = more inertia in collisions, less affected by impulses from mines/missiles. |
| `accel` | m/s² | Forward thrust at full throttle. Tapers off via `speedFalloff` as you approach `topSpeed`. |
| `topSpeed` | m/s | Soft cap on forward speed. Boost multiplies through this; you can briefly exceed it. |
| `turnTorque` | rad/s² | Yaw torque at full steer. Applied around **world Y**, not bike-local-up — see [Conventions](/reference/conventions#sign-conventions). |
| `lateralDrag` | m/s² per m/s | How aggressively the sim bleeds sideways drift. Higher values feel grippier; lower values feel slidy. |
| `reverseScale` | unitless | Multiplier on accel when throttle is negative. Default 0.4 — reverse is intentionally feeble. |
| `boostMul` | unitless | Throttle multiplier while a Boost pickup is active. Default 1.6. |
| `surfaceFollow` | 0..1 | How much the bike kinematically tilts to match the wave surface normal. Faded by altitude — see below. |
| `hoverSpring` | m/s² per m | Stiffness of the PD hover controller. Higher = punchier ride, more prone to overshoot. |
| `hoverDamp` | m/s² per m/s | Damping coefficient on vertical velocity. Above water it's **one-sided** — only damps upward velocity, so dive momentum can punch through into the water. |
| `hoverHeight` | m | Target ride height above the surface. The PD spring tracks this. Pitch input modulates it ±0.5 m. |

## Hover physics in one paragraph

The hover is a PD controller in **acceleration form**:

```
aUp = g + hoverSpring * (target - distance) - hoverDamp * vy
```

With `g = 25` (matches Rapier gravity), `aUp = g` cancels gravity at rest. The bike sits at `target = hoverHeight` with no extra force. Above-water `hoverDamp` only fires on upward velocity (one-sided) so dive momentum off a ramp punches through. Underwater (`groundDistance < 0` on water) the spring is replaced with depth-proportional buoyancy + asymmetric quadratic drag — see [`status.md` §"Underwater dive feel"](https://github.com/occ-matt/hoverbike/blob/main/docs/status.md#underwater-dive-feel-m923--load-bearing-for-wave-race-feel) for the constants.

## Surface follow is altitude-faded

`surfaceFollow` is the **peak** responsiveness. The runtime applies `surfaceFollow * altitudeFactor`, where the factor falls linearly from 1.0 at the water surface to 0 at the grounded/airborne boundary (`groundDistance = hoverHeight * 1.6`). At nominal hover the factor is ~0.37 — so a Racer's effective follow is ~0.19, not 0.5. Dipping into a trough kicks reaction back up; cresting a wave eases it off. This is what makes the bike read as a **hovercraft** rather than a jet ski.

## Air control

Off a ramp (or off the Cliffside drop), the bike enters an **airborne** state:

- **60 % gravity counter** — effective fall rate ~10 m/s² instead of 25. Hang time is generous.
- **Pitch-vectored thrust** — throttle while airborne pushes along the bike's *real* forward vector. Pitch up (`E`) extends air time; pitch down (`Q`) dives.

This is intentional, and tuned for the Cliffside cliff drop. Constants live in [`src/game/systems/hover.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/systems/hover.ts) (`AIR_LIFT_FRAC`, `AIR_THRUST_MUL`).

## Pitch + throttle on water — *intentional*

Holding `Q` (dive) at full throttle plants the nose into wave troughs and submerge-and-bounces. Speed swings 10 → 25 → 10 m/s as buoyancy kicks back. This is the desired Wave Race feel — diving into a wave should *cost* you. Don't "fix" it; it's the bike's collider being driven through the wave field at speed, not a thrust-direction bug.
