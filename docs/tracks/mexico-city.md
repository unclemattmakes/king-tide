# Mexico City — Reef Cup #1

> Cup: Reef · The opener: bright, shallow, instructive — first racing track
> after the Mayday Bay tutorial. *(Replaced South Beach Sunken / Miami in the
> 2026-06 content pass.)*

## Identity

| | |
|---|---|
| **Cup** | Reef |
| **Lap target** | 45 s |
| **Laps** | 3 (~2:15 total) |
| **Water / Land** | 65 / 35 |
| **Anti-grav** | **none** |
| **Verticality** | collapsed elevated-freeway deck (ramp + apex launch) |
| **Difficulty** | intro |

## Location & fiction

Drowned **Mexico City**. The twist of the set: it's not a coast everyone
knew was doomed — it's an inland megacity at 2,240 m that *no one* planned to
flood. But Mexico City was built on the drained bed of **Lake Texcoco**, the
Aztec island-capital Tenochtitlán; the basin has no natural outlet and the
city has been sinking for a century. In the post-warming world the
overwhelmed reservoirs and the failed Gran Canal drainage let the old lake
reclaim the valley. Not the ocean — the lake that was always trying to come
back.

The reborn lake leaves the Aztec **causeways** (calzadas) as the only land,
**Xochimilco's trajinera** party-boats floating for real again, the **Zócalo**
cathedral half-sunk beside the re-emerging **Templo Mayor**, and the gold
**Ángel de la Independencia** standing on her column over the water. The twin
volcanoes **Popocatépetl** (smoking) and **Iztaccíhuatl** watch from the high
ground. *"They drained the lake to build the city. The lake was patient."*

## Layout & beats

Causeway loop over the new lake — a cluttered-but-readable grid of raised
Aztec roadways threaded between drowned landmarks. Bright, calm water, wide
forgiving lines: the handshake track.

| t (s) | Beat | Description |
|---|---|---|
| 0–10 | Calzada de Tlalpan start | Causeway straight, drowned Centro Histórico facades either side, calm lake |
| 10–20 | Zócalo lagoon | Weave the half-sunk Catedral Metropolitana + the re-emerging Templo Mayor steps; trajineras fanned across the water |
| 20–28 | Reforma run-up | Speed line down Paseo de la Reforma toward the gold Ángel |
| 28–36 | **El Ángel (set-piece)** | Ride up the collapsed Segundo Piso freeway deck and launch past the golden statue |
| 36–45 | Chapultepec turn / finish | Bank through drowned Chapultepec park back to the causeway start |

## Set-piece — El Ángel

The **Ángel de la Independencia** — the golden Winged Victory on her tall
column — stands intact in the lake on Paseo de la Reforma. A collapsed
section of the **Segundo Piso** (the double-decker elevated freeway) lies
fallen across the avenue; you ride **up its tilted deck as a ramp** and launch
off the broken lip, flying past the gold statue with the lake and the fanned
trajineras spread below and Popocatépetl smoking on the horizon. The postcard
moment of the opener.

Normal gravity — a rideable fallen-roadway incline + apex launch, the inland
answer to Liberty's fallen torch arm but gentler (opener difficulty). The
statue is decoration (no collision); the freeway deck is `kind=track`.
Distinct from Liberty's fallen-statue climb and Angkor's temple stairs — here
the ramp is a **fallen road deck.** Sits at ~62–80% of lap distance (the
hard-section slot). Skill: timing the launch off the broken freeway lip.

## Verticality without anti-grav

Replacement primitive **#2 — Ramps & launches** (collapsed structure as a
takeoff lip): the fallen Segundo Piso deck. Plus gentle causeway crests.
No surface is ridden inverted; banking stays well under 45°.

## Hard section / branching / per-lap

- **Hard:** 28–36 s (El Ángel approach) — timing the launch off the broken
  freeway lip. Beginner-forgiving, as befits the opener.
- **Branching:** trajinera-raft line across the Zócalo lagoon vs. the
  causeway line (~1.5 s, costs the cathedral-gap angle); the freeway ramp is
  bypassable on Casual (skim around at water level); pro line always takes the
  ramp.
- **Per-lap:** none. Simplest track in the set; the lake stays calm.

## Palette & audio

Rosa mexicano (Mexican pink), marigold/cempasúchil orange, papel-picado
multicolor banners, gold (the Ángel + cathedral altarpieces), lake teal-green,
volcanic basalt black, jacaranda purple. `mexico_city_rosa` sky;
late-afternoon warm light. Cumbia / sonidero / Latin-electronic with
mariachi-horn stabs and marimba — the city that throws a party on the water.
Standard pump-duck (the lake is calm but the open stretches still pump).

## Props — unique to Mexico City

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Aztec causeway (calzada) clusters | track | Raised stone roadways — the only "land"; the loop's spine. |
| Collapsed Segundo Piso freeway deck | track | The **El Ángel ramp** — fallen elevated-roadway span; tilted deck is the takeoff, broken lip the launch lip. |
| Ángel de la Independencia column | decoration | Gold winged statue on her column; the postcard landmark (no collision). |
| Templo Mayor pyramid steps | track | Re-emerging Aztec pyramid; stepped stone, skimmed past in the Zócalo beat. |
| Catedral Metropolitana (half-sunk) | track + decoration | Tilted cathedral facade + towers at the Zócalo; lower mass `kind=track`. |
| Drowned colonial facades | decoration | Centro Histórico buildings lining the causeways. |
| Trajinera boats | decoration | Xochimilco party boats — riot of colour, fanned across the lagoon. |
| Popocatépetl + Iztaccíhuatl horizon ring | bespoke `horizon_ring` | Twin-volcano silhouette (one smoking) — the track's distant identity; **lock early.** |
| `scatter_jacaranda` | scatter | Purple jacarandas + ahuehuete cypress on the causeway edges. |
| `emitter_papel_picado` | emitter | Drifting cut-paper banner motes / colour over the Zócalo. |
| `scatter_rocks` | scatter (`prop_rock`) | Submerged rubble + chinampa debris under the waterline. |

## Build status

**Geometry + gameplay BUILT; art pass in progress** (2026-06-08). Catalog tile
still `status: 'pending'` — playable via `?track=mexico-city`. Authored from
scratch the **current way** in `tracks-src/mexico-city.blend`, exported to
`public/assets/tracks/mexico-city.glb` + `public/tracks/mexico-city.json`.
**Loads + drives clean in-engine** (headed WebGPU autopilot completes, 0 console
errors).

> **Mirror gotcha:** the `.blend` is built **N-S mirrored** so Blender's top view
> reads north-up like the concept sketch (three.js `Z→−Y` flips the editor view);
> the exported coords are therefore the N-S mirror of the sketch. Author in
> Blender's north-up view; don't "fix" the flip.

**In:** shallow lake (−8 floor) + twin volcanoes rising from the water (Popo
smoking via `emitter_volcano_smoke`), Chapultepec hill+castle (east), gentle
terrain rises the line conforms to; **hover-on-the-lake** line snapped just under
the waterline (no continuous causeway); El Ángel **launch ramp** embedded in the
terrain; 13 checkpoints + start + 3 boosts + 9 pickups + wave zone + buoys; all
landmarks **collidable** + pushed clear of the line; POIs **Diana Cazadora**
(Reforma glorieta) + **Palacio de Bellas Artes**; jungle ahuehuete placeholders.

**Art-pass TODO:** painterly-vinyl materials + waterline trio; the collapsed
Segundo-Piso freeway-deck look on the ramp; landmark detail; discrete raised
calzada modules for the 35% "land"; trajineras + papel-picado + jacaranda
dressing; remaining VFX. Workflow refs: **Mayday Bay** + **Cape Town Drift**.

## References

- [../track-design-specs.md](../track-design-specs.md) §2.1.
- [../track-themes.md](../track-themes.md) — content bible (lore, palette).
- [mexico-city-art-target.md](./mexico-city-art-target.md) — the look spec.
- [mexico-city-concept-pass.md](./mexico-city-concept-pass.md) — per-beat concept prompts.
- [mexico-city-prop-manifest.md](./mexico-city-prop-manifest.md) — bespoke props + ComfyUI sculpt prompts.
