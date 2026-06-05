# The Maw — parked to the B-list (was Open Sea Cup)

> **Parked (v2 — no-open-water pass).** The Maw is 100 % open water — the
> exact archetype the [no-open-water rework](./README.md) retired — so it was
> pulled from the ship cups and parked to the
> [B-list](../track-themes.md#b-list--future-content-packs). Its build (one of
> the few art-dressed tracks) and the design below are kept intact for a
> future content pack; it is simply off the cup roster. The wave-mastery test
> it embodied now lives across the Harbor-Cup tracks' open-water stretches.
>
> Cup: *(parked)* · The purest test of the signature mechanic. The wave *is*
> the track.

## Identity

| | |
|---|---|
| **Cup** | Open Sea |
| **Lap target** | 60 s |
| **Laps** | 3 (~3:00 total) |
| **Water / Land** | 100 / 0 |
| **Anti-grav** | **none** *(never used it — unchanged by the pass)* |
| **Verticality** | wave launch through the arches |
| **Difficulty** | showcase |

## Location & fiction

Big Sur, California — what's left of it. Bixby Bridge collapsed; the rock
arches and a chunk of highway superstructure form a natural tunnel system.
McWay Falls still pours from the cliff into the new ocean. "The bridge
fell. The arches stayed. Locals call it the Maw — the way it eats riders
who can't read the sea."

## Layout & beats

All-ocean arena loop, sparse. Reference: Wave Race 64 Glacier Coast /
Southern Island.

| t (s) | Beat | Description |
|---|---|---|
| 0–15 | Open Pacific opener | No structure but swell. Pumping pays ~5 s top-speed gain. |
| 15–28 | First arch + small Maw | Two smaller arches in series; either-or path on the second |
| 28–42 | **The Maw (set-piece)** | The largest arch. Swell-timed launch through with the crest = ~10 % top-speed bonus |
| 42–52 | Inner channel | Calmer in the arches' lee. Recovery beat. |
| 52–60 | Finish + McWay drift | Past McWay Falls' spray; finish line |

## Set-piece — The Maw

The largest arch. On the right swell you're launched through with the
crest, hitting the back of the next wave already at speed; on the wrong
swell a wall of water hits the arch as you enter and you eat ocean. Visible
from the start grid in the middle distance; dominates the frame at t≈22.
The swell pattern that decides launch-vs-eaten is **legible 4–6 s in
advance** — the whole skill. **Wave timing = world wave timing**, so the
same lap plays differently each attempt.

## Hard section / branching / per-lap

- **Hard:** 28–42 s (the Maw) — pure wave timing; nothing else matters.
- **Branching:** second small arch left vs right (right usually launches
  faster on the prevailing swell); inside vs outside the Maw column
  (cosmetic).
- **Per-lap:** **wave timing changes the lap** — lap 1 and lap 3 feel
  materially different. Intentional: "no two runs are the same; learn to
  read it."

## Palette & audio

Golden-hour Pacific: deep navy, gold rocks, white foam, dramatic cloud
shadows. `big_sur_golden` sky (`seaStateBeaufort=5`). Cinematic surf-rock,
big strings + drums + reverb; **highest pump-duck in the set (0.45)** —
pumping is the whole point.

## Props — unique to The Maw

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Rock arches ×3 | track | Hand-modeled, ≥4 m wall thickness; the Maw is ~50 m span × ~30 m height, weathered surfaces. |
| McWay Falls cliff | track | Tall mesh on the east edge; the waterfall itself is decoration + emitter. |
| Bixby Bridge remnant | track | Collapsed concrete chunk forming a small jump in the opener — rewards pumpers who hit the rhythm. |
| `scatter_rocks` | scatter (`prop_rock`) | ~15 sea stacks between arches, larger than default. |
| `emitter_mcway_falls` | emitter (atlas 9) | Column of falling spray off the cliff. |
| `emitter_maw_spray` | emitter (atlas 9) | At the arch crown; fires harder on big swells (`triggerBurst` on surge peaks). |
| `emitter_arch_haze` | emitter (atlas 4) | Sun-haze inside the arch — sells the volume. |

> The most tuned wave-zone config in the v1 set (open-Pacific surge +
> funneled `wave_zone_maw_throat`) — see specs §2.4.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.4.
