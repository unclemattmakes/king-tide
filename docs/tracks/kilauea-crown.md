# Kilauea Crown — Continental Cup (closer, single-lap descent)

> Cup: Continental closer · The spectacle closer: a single-lap volcano
> descent ending at a lava waterfall.

## Identity

| | |
|---|---|
| **Cup** | Continental (spectacle closer) |
| **Format** | **single-lap point-to-point descent**, ~2:30 total |
| **Laps** | 1 |
| **Water / Land** | 50 / 50 |
| **Anti-grav** | **none** *(was: heavy — caldera-rim wall-ride, ~60 s — cut)* |
| **Verticality** | banked caldera-rim road + terrain descent |
| **Difficulty** | mid (cup spectacle closer) |

## Location & fiction

Big Island, Hawaii. Kilauea actively erupting, the caldera enlarged and
reshaped. The mountain is the new high ground; the lowlands are open ocean.
"Pele kept building. The mountain's taller now than it was in '26. The
Circuit times its laps to the eruption schedule."

## Layout & sections

Single-lap descent in three sections (Mount Wario template — the
climb-rim-descend topology is naturally non-loopable).

| t (s) | Section | Description |
|---|---|---|
| 0–45 | **Windward climb** | From a black-sand beach at sea level up through old lava fields, sparse rainforest. Boost-pads on the steep pitches. |
| 45–105 | **Caldera rim (banked road)** | Ride the **banked inside edge of the caldera bowl** — the lava lake 200 m below, heat haze on the air. ~60 s of continuous banked cornering. |
| 105–150 | **Leeward descent + Black Beach (set-piece)** | Steep descent on a single rideable ridge; final 30 s ride *alongside* the lava waterfall pouring into the new sea. Finish at the black-sand beach. |

## Set-piece — The Black Beach

The leeward descent ends with a lava waterfall — molten rock pouring
directly into the ocean, exploding into steam. You ride *alongside* it (not
through it): black basalt sand, white steam plumes, orange glow under blue
sky, finish line at the base. The volcano is visible from the start grid the
whole way up; the waterfall reveals at ~95 s as the rim's east face opens.

## Verticality without anti-grav

**Old:** an `antigrav_curve` Banked strip authored as a full circle around
the caldera rim — you wall-rode the *inside of the bowl* (~70° tilt) for a
continuous ~60 s, gravity flipped onto the crater wall. This was the
heaviest anti-grav stretch in the set.

**New: a banked caldera-rim road** (primitive #4 in the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)) —
the rim is sculpted into a **banked terrain berm, capped at ~45°**, ridden
like a velodrome or bobsled rim at normal gravity, with the lava lake still
the failure consequence below. The continuous-wall-ride becomes continuous
banked cornering — the same "lateral-g, lava below, hold your line" tension,
no gravity flip. The windward climb (terrain ramps + boost pads) and the
leeward descent + Black Beach were always terrain and are unchanged.

## Hard section / branching / per-lap

- **Hard:** 60–95 s (mid-caldera rim) — holding the banked line under
  continuous lateral g with the lava lake below.
- **Branching:** windward left vs right ridge (scenery); caldera rim inside
  vs outside path (inside faster/steeper bank, outside safer); leeward
  waterfall-side vs back-side descent (**pros take the waterfall side
  every time** — ~1.5 s penalty, the set-piece is the whole point).
- **Per-lap:** none — the single-lap format *is* the differentiation.

## Palette & audio

Orange-red lava, black basalt, steam-white, volcanic-blue lake, lush green
windward forest. `kilauea_volcanic` sky (lava reads orange against blue).
Tribal percussion + synth pads, big sub-bass on the grumble; ~2:45 music
with a Section-3 crescendo aligned to the lava waterfall.

## Props — unique to Kilauea Crown

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| `terrain_island` | track (terrain) | Tall central peak + crater; base radius 800 m, top 600 m. Caldera rim sculpted into a drivable banked bowl. |
| Old lava-field shelves | track | Flat drivable shelf meshes across the windward slope (the procedural terrain is the backdrop). |
| `road_curve_main` ×2 | track | Two windward-climb ridge roads, width 12, snapped to terrain. |
| `caldera_rim_road` | track (terrain berm) | **Banked rim road, ≤45° bank**, full circle following the caldera — replaces the cut anti-grav banked strip. |
| Lava waterfall ridge | track | The ridge the bike rides alongside; the lava itself is decoration (orange-emissive, shader-panned UV). |
| Black Beach finish | track | Flat plinth at sea level on the leeward base. |
| `scatter_palms` | scatter (`prop_palm`) | Sparse, sea-level windward beach only (~20). |
| `scatter_rocks` | scatter (`prop_rock`) | Heavy on the windward slope (~80, dark tint). |
| Maui + Mauna Kea horizon ring | bespoke `horizon_ring` | Visible from the rim — Maui north, Mauna Kea west. |
| `emitter_lava_waterfall_*` | emitter (atlas 2 + 1) | Falling embers + steam where lava hits ocean; 5+ empties along the fall. |
| `emitter_caldera_haze` | emitter (atlas 4) | Heat shimmer over the caldera. |
| `emitter_ash_drift` | emitter (atlas 8) | Slow-falling ash over the upper slopes. |
| `emitter_steam_explosion` | emitter (atlas 1) | Burst at the lava-meets-ocean point, synced to the audio cue. |

> **Retired:** `antigrav_curve_NN` (Banked-strip profile, caldera rim) —
> replaced by `caldera_rim_road`. Needs the single-lap race-mode hook
> (`singleLap: true`); see specs §3.8.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.8 (anti-grav
  banked-strip spec there is retired) + §1.1 (single-lap rationale).
