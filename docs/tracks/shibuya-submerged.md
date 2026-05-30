# Shibuya Submerged — Open Sea Cup #2

> Cup: Open Sea · The postcard that goes on the trailer. The city as
> defiant party, not abandoned ruin.

## Identity

| | |
|---|---|
| **Cup** | Open Sea |
| **Lap target** | 58 s |
| **Laps** | 3 (~2:54 total) |
| **Water / Land** | 50 / 50 |
| **Anti-grav** | **none** *(was: medium — Cocoon Tower wall-ride, ~10 s — cut)* |
| **Verticality** | Cocoon Tower collapsed-lattice ramp |
| **Difficulty** | showcase |

## Location & fiction

Drowned Tokyo. Shinjuku skyscraper tops still standing, **neon still on** —
rooftop generators, microgrids. Skytree silhouette on the backdrop. Tonal
register: Wipeout-bright, not Akira-rainy. "Tokyo didn't evacuate. They
moved up. The neon's still on because somebody is still paying the bill."

## Layout & beats

Loop with branching shortcuts + a sloped climb. Reference: MK8 Cloudtop
Cruise (music-synced beats) + MKW Great ? Block Ruins (discreet shortcuts).

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Rooftop-bridge launch | Start wide, drop into the cable network over the crossing |
| 10–22 | **Shibuya Crossing Cables (set-piece)** | Race the powerline cables + toppled neon signage over the 15 m-underwater intersection. Hachiko visible underwater. |
| 22–34 | **Cocoon Cascade (climb)** | Ride the Cocoon Tower's collapsed diagonal exo-lattice as a ramp up-and-over. Music shifts to a higher BPM. |
| 34–46 | Skyscraper canyon | Thread between tower tops; rooftop-bridge path vs water-channel path |
| 46–58 | Finish straight | Wide rooftop loop back to start |

## Set-piece — Shibuya Crossing Cables

Race across the famous five-way scramble on toppled neon signage and
powerline cables, the intersection fifteen meters underwater below you, the
neon reflected up through the water. Hachiko statue still patient on the
seafloor. Visible from the start grid; plays at 17–38 % of lap distance —
early, deliberately, because the set-piece is what hooks lap 1.

## Verticality without anti-grav

**Old:** an `antigrav_curve` Banked strip — you wall-rode one flat vertical
face of the Cocoon Tower (Mode Gakuen) for ~10 s, gravity flipped onto the
glass.

**New: the Cocoon Cascade.** The Cocoon Tower's real architecture is a
curved *diagonal exoskeleton lattice* — perfect as a collapsed **ramp**
(primitive #2/#3 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)).
A section of the lattice has sheared off into a steep diagonal *road* you
ride up-and-over at normal gravity, launching across to the next rooftop.
The window-ledge protrusions that used to be wall-ride obstacles become
ramp-surface obstacles forcing a snaking line — the same skill, no gravity
flip. The "around the tower at water level" safe alternative is preserved.

## Hard section / branching / per-lap

- **Hard:** 22–34 s (the Cocoon Cascade) — holding the line at speed on a
  steep ramp with signage obstacles.
- **Branching:** cables vs rooftop bridge (10–22 — cables faster, fall if
  you mistime a strand jump); cascade ramp vs ground path (22–34 — ground
  ~3 s slower, no ramp skill); rooftop bridge vs water channel (34–46).
- **Per-lap:** **neon glare intensifies** — lap 3's glare emitter rate
  doubles, lighting the underwater intersection more brightly (visual only).

## Palette & audio

Hot pink, electric blue, kanji neon reflections, wet asphalt rooftops.
Saturated, defiant, *bright.* `tokyo_neon` sky (night; the neon is the
light source). City-pop, J-electronic, vocoded hooks; **music BPM/intensity
drop at t=22** for the Cocoon beat (Cloudtop Cruise lesson — the music sells
the section break).

## Props — unique to Shibuya Submerged

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| `downtown_NN` (inverted) | track | Building *tops* are the racing surface; raise the empty so rooftops sit at sea level. X=4 Y=4, Min h 60 Max h 110. |
| Terrain plinth | track | Large flat mesh ~25 m below sea level (the flooded street floor). |
| Cable network mesh | track | 3 parallel ~30 m cables + toppled neon-signage planks bridging gaps; ~0.6 m collider thickness so the bike doesn't slip off. |
| Cocoon Tower (cascade ramp) | track | **Collapsed diagonal lattice ramp** ~80 m run, window-ledge obstacles ~2 m proud — replaces the cut wall-ride. |
| Hachiko statue | decoration | On the seafloor under the crossing, visible through the water shader. |
| `road_curve_main` | track | Rooftop-bridge slab on the 34–46 branch; banked via Tilt at the corner. |
| Skytree + Mt. Fuji horizon ring | bespoke `horizon_ring` | The only Shibuya track in v1 — the horizon has to *say* Tokyo. |
| Neon signage props | decoration / track | Toppled billboards (some are the cable-network planks). |
| `emitter_neon_glare_*` | emitter (atlas 7) | 6+ signage locations — the postcard atmosphere; rate doubles lap 3. |
| `emitter_crossing_reflections` | emitter (atlas 10) | Above the flooded crossing, reflecting up toward the cables. |
| `emitter_skyscraper_haze` | emitter (atlas 4) | High-altitude haze over the buildings. |
| `emitter_cocoon_window_light` | emitter (atlas 0) | Random window ledges — implies the building still has power. |

> **Retired:** `antigrav_curve_NN` (Banked-strip profile, Cocoon wall-ride)
> — replaced by the Cocoon Cascade ramp mesh.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.5 (anti-grav
  banked-strip spec there is retired).
