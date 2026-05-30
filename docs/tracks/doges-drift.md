# Doge's Drift — Continental Cup #2

> Cup: Continental · Elegant Venetian spectacle: a low-clearance bridge
> tunnel and a toppled bell-tower launch.

## Identity

| | |
|---|---|
| **Cup** | Continental |
| **Lap target** | 60 s |
| **Laps** | 3 (~3:00 total) |
| **Water / Land** | 70 / 30 |
| **Anti-grav** | **none** *(was: medium — Campanile climb, ~10 s — cut)* |
| **Verticality** | toppled-Campanile ramp + big air |
| **Difficulty** | mid |

## Location & fiction

Drowned Venice. Acqua alta finally won. St. Mark's Campanile, Doge's Palace
facade half-submerged, the lion-column tops in Piazza San Marco poking out.
Murano glassblower furnaces still burning on rooftop islands. "Venice was
already half-flooded; the rest just took longer."

## Layout & beats

Loop with an arch tunnel + a tower-ramp launch. Reference: Wave Race 64
Twilight City (urban canal racing) + Marine Fortress (clearance-critical
tunnel).

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Doge's Palace facade | Open-water straight past the half-submerged palace, lion columns visible |
| 12–22 | **Rialto tunnel** | Through the partially-collapsed Rialto Bridge arch — low-clearance tunnel; walls damage on contact |
| 22–34 | Murano furnace stretch | Past glassblower-furnace rooftops; warm orange light, brief calm |
| 34–48 | **The Campanile Fall (set-piece)** | Ride up the toppled brick shaft, launch off the belfry stub over St. Mark's domes |
| 48–60 | Descent + finish straight | Long glide down past the basilica back to start |

## Set-piece — The Campanile Fall

St. Mark's Campanile has come down (it famously collapsed once before, in
1902) and lies toppled across the piazza. You ride **up its fallen brick
shaft as a ramp** (~20° incline), launch off the belfry stub for big air
with the golden St. Mark's domes spread below, and splash down. The bell
still hangs in the belfry stub at the launch lip — a swinging hazard. The
tower is visible from the start grid (still the tallest mass in flooded
Venice).

## Verticality without anti-grav

**Old:** an `antigrav_curve` Tube — an ~80 m anti-grav climb *up the
vertical brick shaft*, exiting horizontally through the belfry arch.

**New:** the tower is **toppled into a ramp** (primitive #2 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)) —
you ride up its fallen length at normal gravity and launch off the belfry
stub. Same brick-shaft hero geometry, same bell-timing hazard (Hard: the
bell blocks the launch window ~0.4 s of every 3 s), same domes-below money
shot — without a gravity flip. The "circle the base instead" safe
alternative is preserved (~4 s slower).

## Hard section / branching / per-lap

- **Hard:** 34–48 s (the Campanile Fall) — holding the ramp line + timing
  the belfry launch around the swinging bell.
- **Branching:** Rialto tunnel center vs sides (center: more clearance, no
  boost; sides: tighter, boost pads); up the toppled shaft vs around the
  base.
- **Per-lap:** bell swing phase **persists across laps** — a hazard on lap
  1, a metronome by lap 3. Hard randomizes phase per race.

## Palette & audio

Ochre and terracotta, mossy waterline green, Adriatic teal, gold Byzantine
domes, warm furnace orange. `venice_warm` sky. Vivaldi-step — baroque
strings sampled and broken-beat'd; the strings motif swells on the launch
(t=34–48).

## Props — unique to Doge's Drift

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Doge's Palace facade | track | Iconic arched colonnade, lower half submerged; ~50 m wide. |
| Lion columns ×2 | decoration | Venetian lion-column tops poking above water. |
| Rialto Bridge arch | track (tunnel) | Central arch is the low-clearance tunnel — `tunnel_curve_main` + Build Tunnel, radius 4, ~6 m clearance, walls collide. |
| `ramp_campanile_fall` | track | **Toppled brick bell-tower shaft as a ramp** (~20° incline) + belfry-stub launch lip — replaces the cut anti-grav shaft. |
| Bell | track (runtime-animated) | Swinging hazard at the launch lip; glTF animation channel. |
| St. Mark's basilica domes | decoration | Byzantine dome cluster, visible from the launch apex. |
| Murano furnace rooftops ×3 | track + decoration | Plinths with glowing furnace decoration meshes on top. |
| Dolomites horizon ring | bespoke `horizon_ring` | Venice's actual far-north horizon. |
| `emitter_murano_furnace_*` | emitter (atlas 2) | Rising embers at each rooftop (3 instances). |
| `emitter_bell_ripple` | emitter (atlas 10) | `triggerBurst` on each bell-swing apex. |
| `emitter_basilica_dust` | emitter (atlas 4) | Dust over the domes. |
| `emitter_palace_moss` | emitter (atlas 4) | Algae/decay along the palace waterline. |

> **Retired:** `antigrav_curve_NN` (Tube profile, Campanile climb) —
> replaced by `ramp_campanile_fall`.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.7 (anti-grav tube
  spec there is retired).
