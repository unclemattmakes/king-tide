# Golden Gate Drowned — Harbor Cup #2

> Cup: Harbor · The track that proved the no-anti-grav direction:
> *land as waves frozen in time.* The model for the whole reconciliation
> pass.

## Identity

| | |
|---|---|
| **Cup** | Harbor (#2 — moved up from Continental in the harbor-cup rework) |
| **Lap target** | 58 s |
| **Laps** | 3 (~2:54 total) |
| **Water / Land** | 55 / 45 |
| **Anti-grav** | **none** *(designed terrain-first from the start)* |
| **Verticality** | frozen-wave hills + a street-to-bay cliff drop |
| **Difficulty** | mid (spectacle) |

## Location & fiction

Drowned San Francisco. The Pacific came back through the Golden Gate and
stayed. The Financial District stands waist-deep — Salesforce Tower and the
Transamerica Pyramid rising straight out of the bay, streets between them
flooded canyons. But the hills held: Nob, Russian, Telegraph, the climb
toward Twin Peaks. The Golden Gate Bridge is a fog-bound silhouette; over
all of it, *Karl* — the fog tide. "They said the bridge would outlast the
city. They were right — it outlasted the coastline too."

## Layout & beats

Loop alternating tight urban canyon ↔ open bay ↔ hill-surf, with a terrain
cliff-drop finish. Reference: Wave Race (hills ridden as frozen swell) +
Jet Moto Cliffdiver (lap-ending water drop) + MK8 urban tracks.

| t (s) | Beat | Description |
|---|---|---|
| 0–14 | Open bay / drowned FiDi | Gentle Beaufort-3 swell, pump rhythm; the downtown towers rise ahead. Fog state established. |
| 14–28 | **Downtown canyon (tight)** | Thread the flooded skyscraper grid — narrow walled "street canals," clip the walls = damage |
| 28–44 | **The hills (frozen waves)** | Streets ramp up out of the water; surf 3–4 steep hill crests, catching air off each |
| 44–52 | **The Break (set-piece)** | Crest the steepest street; the road plunges straight down into the bay. Big terrain drop + splashdown. |
| 52–58 | Bay return | Low open-water run back to start; Alcatraz + the bridge silhouette in fog |

## Set-piece — The Break

You crest the classic near-vertical San Francisco street — except the
bottom is gone, the road plunging straight into the drowned bay. The frozen
wave breaking into the real one: bike airborne over the crest, the fallen
city and tower-tops spread below through the fog, then a big splashdown at
sea level. Terrain-only, and it *lands* every lap. Sits at ~80 % of lap
distance — the closer flourish after the hard hills.

## Verticality without anti-grav — the template

This track is the **proof of the whole pass.** Its verticality is entirely
terrain: the hills are authored as a *frozen-swell heightfield* (the same
waveform as the bay's swell), so you surf up the back of each crest and
launch off the top — **the same gesture you pump on water.** No anti-grav
was ever specced; this is where the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)
primitives #1 (frozen-wave terrain) and #5 (cliff drop) come from. The
other seven reworked tracks borrow this language.

**The fog (signature):** SF's marine layer rolls in and clears on a world
timer (same world-time read as the Maw's swell). Thick, and the canyon and
crests are read by memory and street-lights; peeled back, the drowned
skyline reveals. The one true weather mechanic in the set. *Hatteras grades
how you read the sea; Golden Gate grades how you read the fog.* Telegraphed,
never blinding.

## Hard section / branching / per-lap

- **Hard:** 14–44 s (canyon + hills, ~24–76 %) — threading the tight canyon
  under fog, then carrying speed over crests without bottoming the troughs.
- **Branching:** inside tower slot vs outer flooded avenue (canyon); hill
  crest pump timing (3–5 % carry into The Break); steep plunge vs shallower
  side-street descent at The Break.
- **Per-lap:** **fog tide** — density swells/clears on a ~18 s world timer
  (not lap-keyed) so each lap sees both states. Otherwise constant.

## Palette & audio

International Orange bridge steel, fog white-grey in volume, bay steel
blue-green, warm low sun through the marine layer. New `golden_gate_fog`
sky grade (or `cape_town_blue` warmed as fallback); **fog is animated** —
oscillate `fogNear` 150↔40 / `fogFar` 700↔250 on the ~18 s timer.
Bay-Area hyphy / west-coast hip-hop under foghorn drones.

## Props — unique to Golden Gate Drowned

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Hill landmass | track (terrain) | Primary verticality — a **frozen-swell heightfield** (displace a plane with swell-profile noise), hills +40–70 m; windward face ramps from the waterline. Bake biome/AO/path attrs. |
| Drowned street grid | track (terrain) | Flooded canyon floors at / just below z=0 between the towers. |
| Downtown towers | track | Salesforce (tapered round top), Transamerica (pyramid), Coit Tower, + 6–10 generic FiDi boxes; lower floors capped below the waterline. Shared `downtown_NN` kit where they repeat. |
| Sutro Tower | decoration (silhouette) | Distant skyline break (camera-locked, not raced). |
| Golden Gate Bridge | decoration (silhouette) | NW-horizon silhouette near the horizon ring (not a raced surface). |
| Alcatraz | track | Low island in the bay — turn landmark. |
| The Break | track (terrain) | The steepest-street cliff drop into the bay (part of the hill landmass). |
| `scatter_debris` | scatter | Floating cars, kelp, dock wreckage along canyon edges / shoals (`HV_Scatter*`, height/biome-gated). |
| `scatter_rooftop` | scatter | Survivor microgrid clutter (warm-light props) on the hill streets. |
| `emitter_fog_bank` | emitter (atlas 1) | The signature emitter — ~3 empties across the strait mouth, drifting east; ties to the fog tide. |
| `emitter_bay_spray` | emitter (atlas 9) | ~3 across the bay + one at The Break splashdown. |
| `emitter_canyon_steam` | emitter (atlas 1) | At a survivor microgrid vent (warm-lit) in the canyon. |

## References

- [../track-design-specs.md](../track-design-specs.md) §2.12 — the original
  terrain-verticality spec this pass generalizes from.
