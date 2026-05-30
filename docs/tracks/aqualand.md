# Aqualand — Drowned Cup #1

> Cup: Drowned · The chaos slot: a doubly-drowned waterpark with a wave
> pool that escalates per lap.

## Identity

| | |
|---|---|
| **Cup** | Drowned |
| **Lap target** | 22 s |
| **Laps** | 5 (~1:50 total) |
| **Water / Land** | 75 / 25 |
| **Anti-grav** | **none** *(was: light — bowl-wall, mandatory lap 3+ — cut)* |
| **Verticality** | banked pool-bowl rim berm |
| **Difficulty** | chaos |

## Location & fiction

Abandoned Florida waterpark, doubly drowned — the pools and slides designed
to hold water now hold the actual ocean. Lifeguard towers at angles, faded
sun-bleached primary colors, algae everywhere. "Aqualand closed in '32. The
wave generator was on a solar circuit. Nobody turned it off. The Circuit
thinks this is hilarious."

## Layout & beats (per lap, ~22 s)

Short multi-lap chaos arena with per-lap escalating surge. Reference: Sonic
Transformed Adder's Lair (destructible-per-lap) + MK Baby Park (chaos).

| t (s) | Beat | Description |
|---|---|---|
| 0–6 | Lazy river opener | Race the still-running current through fiberglass tube tunnels |
| 6–11 | **Wave-pool tsunami (set-piece)** | Surge amplitude is the lap-dependent hazard |
| 11–17 | Half-pipe slide | Drop down a half-pipe water-slide; brief drop speed |
| 17–22 | Main concourse → start | Past the lifeguard tower's digital countdown, back to start |

## Set-piece — The Tsunami

The wave pool. When the park ran it generated a "tsunami" surge once per
lap; the mechanism still runs and **escalates each lap** — lap 1 a splash
hazard, lap 2 floods the lower concourse, lap 3+ washes it out entirely.
The lifeguard tower's countdown sign tracks the next surge. Visible from the
start grid; plays at 27–50 % of lap distance, every lap.

| Lap | Surge | Lower concourse |
|---|---|---|
| 1 | 1.5 m | Open; splash hazards only |
| 2 | 3.0 m | Partly flooded; damage on water contact |
| 3–5 | 5.0 m | Washed out mid-lap; **the banked bowl rim becomes mandatory** |

## Verticality without anti-grav

**Old:** an `antigrav_curve` Banked strip wall-riding the wave pool's upper
rim (tilt = −π/2, a full wall), used as the escape route once the lower
concourse floods on lap 3+.

**New: a banked pool-bowl rim** (primitive #4 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)).
The wave pool already has a curved concrete bowl; its upper edge is sculpted
into a **banked berm, capped at ~45°**, ridden like a skate-bowl rim at
normal gravity. Same per-lap escalation logic — when the surge floods the
low line on lap 3+, you take the high banked rim — without the gravity flip.
The half-pipe slide and lazy-river tube were already gravity-normal.

## Hard section / branching / per-lap

- **Hard:** 6–11 s (wave pool), skill changes per lap: lap 1 line through
  the low concourse → lap 2 timing the entry to avoid splash damage → lap
  3+ riding the banked bowl rim.
- **Branching:** lower concourse vs upper bowl rim (lower faster but
  lap-dependent); half-pipe drop vs concourse-edge bypass.
- **Per-lap:** **the big one** — surge amplitude driven from the lap counter
  (`surge_amplitude_per_lap: [1.5, 3.0, 5.0, 5.0, 5.0]`; see specs §3.8).
  This is the set's destructible-layout representative.

## Palette & audio

Faded primary colors, sun-bleached plastic, algae greens, pool-tile blue
through grime. `miami_pastel` (faded). Trashy 90s pool-party EDM; the PA
system still cycles ads for snack-bar specials nobody can buy; **low
pump-duck (0.25)**.

## Props — unique to Aqualand

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Lazy river tube | track (tunnel) | Curved fiberglass tube — `tunnel_curve_main`, radius 5, drawn as a U forming the lazy-river footprint. |
| Wave pool | track | Large rectangular plinth bowl + 4 surrounding pool walls (~3 m). |
| `bowl_rim_berm` | track (terrain berm) | **Banked half-arc around the wave-pool's upper rim, ≤45°** — replaces the cut anti-grav bowl-wall. Used lap 3+ but always present. |
| Half-pipe water slide | track | Single curved mesh ~20 m long, ~6 m drop, smooth interior. |
| Lifeguard tower | decoration | With an emissive plane for the digital countdown sign (animated UV). |
| Locker rooms + snack bar | decoration | Small meshes around the concourse for atmosphere. |
| `road_curve_main` | track | Concourse loop, width 6, snapped to the pool-bowl terrain. |
| `scatter_palms` | scatter (`prop_palm`) | Faded sun-bleached (~10) on the concourse periphery. |
| `emitter_pool_chlorine` | emitter (atlas 4) | Over the wave pool — decayed pool chemistry. |
| `emitter_tsunami_spray` | emitter (atlas 3 + 9) | Two empties at the bowl rim; **burst-triggered every surge crest**. |
| `emitter_palm_decay` | emitter (atlas 6) | Falling leaves at each palm. |

> **Retired:** `antigrav_curve_NN` (Banked-strip profile, bowl wall) —
> replaced by `bowl_rim_berm`. Needs the per-lap surge array hook
> (specs §3.8).

## References

- [../track-design-specs.md](../track-design-specs.md) §2.9 (anti-grav
  banked-strip spec there is retired) + §1.4 (per-lap surge rationale).
