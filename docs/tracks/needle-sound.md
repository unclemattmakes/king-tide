# Needle Sound — Harbor Cup #1 (opener)

> Cup: Harbor · The cup handshake: a structure-dense harbor slalom and one
> postcard launch through the Space Needle. The *cluttered* harbor — every
> metre is land or prop over water, never open sea.

## Identity

| | |
|---|---|
| **Cup** | Harbor (opener) |
| **Lap target** | 55 s |
| **Laps** | 3 (~2:45 total) |
| **Water / Land** | 55 / 45 |
| **Anti-grav** | **none** (designed terrain/prop-first) |
| **Verticality** | pier/ferry ramps + the Space Needle saucer big-air; one short downtown hill |
| **Difficulty** | showcase (the gentlest of the three — cup opener) |
| **Status** | concept — greybox/build pending |

## Location & fiction

Drowned Seattle. Puget Sound rose and took the waterfront — Alaskan Way, the
piers, the lower Pike Place market all under Elliott Bay now. But Seattle is
a city of hills and the hills held: downtown's grid plunges to the water,
Queen Anne and Capitol Hill stay dry above it. The Space Needle still stands
over the flooded Seattle Center, its saucer a low ring just above the chop;
the Great Wheel tilts on its drowned pier; Washington State ferries swing at
anchor in green-and-white. Mount Rainier owns the eastern horizon — the
unmistakable snow cone, doing for Seattle what Table Mountain does for Cape
Town. The city kept its lights and its music. "The Sound took the waterfront
back. The Needle still stands; the band still plays. Seattle never minded
the rain."

## Layout & beats

A harbor-slalom loop, deliberately dense with structure (the anti-open-water
identity), with one short downtown-hill crest and the Space Needle big-air.
Reference: Wave Race harbor chop + MK city-track prop slalom + Cape Town's
dense-structure slalom counterweight.

| t (s) | Beat | Description |
|---|---|---|
| 0–12 | Elliott Bay start | Gentle Beaufort-3 chop off the drowned piers; pump rhythm. Ferries + the tilted Great Wheel ahead, Rainier on the horizon. |
| 12–24 | **Pier slalom** | Thread the drowned finger-piers + anchored ferries — tight, structure-dense, never open water. Clip a hull = damage. |
| 24–34 | Pike Hill crest | Streets ramp up out of the water at Pike Place; one short steep hill (a frozen-wave crest) past the market clock + neon sign, then back to the waterline. |
| 34–46 | **The Saucer (set-piece)** | Launch off the tilted Great Wheel gantry / a beached ferry car-ramp; big air across the drowned Seattle Center, threading the Space Needle saucer, Rainier glowing behind. |
| 46–55 | Waterfront return | Low run back past the aquarium roofs + Lake-Union houseboats to the start. |

## Set-piece — The Saucer

The Space Needle stands over the flooded Seattle Center, its observation
saucer now a low ring just above the water. You hit a ramp — the tilted
Great Wheel's boarding gantry, or a half-beached ferry's car-ramp — and
launch into big air across the Center, threading the gap between the
saucer's underside and the chop, **Mount Rainier framed dead-centre behind
the Needle.** The postcard. Normal gravity throughout — a launch + thread,
not a wall-ride. Sits at ~70 % of lap distance, the flourish before the
waterfront return.

## Verticality without anti-grav

Needle Sound never specced anti-grav. Its air comes from the
[replacement vocabulary](./README.md#replacement-verticality-vocabulary)
primitives **#2 (ramps & launches** — the Great Wheel gantry / ferry
car-ramp into the Saucer) and **#1 (frozen-wave terrain** — the single short
Pike Hill crest). Where its cup-mate **Golden Gate** leans on big open
terrain (long hills + a cliff drop), Needle Sound is the **cluttered
harbor**: a structure-dense slalom over water, with props (piers, ferries,
the Wheel, the Needle) doing the verticality. Two Pacific harbor tracks in
one cup that deliberately *play* differently. The hill is short and gentle —
this is the cup opener.

## Hard section / branching / per-lap

- **Hard:** 12–24 s (the pier slalom) — tight, structure-dense lines; the
  test is precision through clutter, not wave-reading (echoes Cape Town).
- **Branching:** inside the finger-piers vs. the outer ferry lane (slalom);
  the high line over the Saucer roof vs. the threaded low line under it (low
  is faster but tighter).
- **Per-lap:** constant. The Saucer + the Rainier silhouette carry the
  freshness; no per-lap structural change (per the *per-lap variation is
  precious* principle — a constant-behavior opener).

## Palette & audio

Pacific-Northwest cool: evergreen green on the headlands, rain-slick slate
and wet concrete, Elliott Bay steel blue-green, the ferries' green-and-white,
Pike Place's red neon clock + "Public Market Center" sign warm against the
grey, Mount Rainier's snow catching pink alpenglow. Marine-layer drizzle —
telegraphed, never blinding. New `puget_drizzle` sky grade (or
`cape_town_blue` cooled as fallback). Audio: grunge revival reworked for a
racer — driving distorted guitars over an electronic low end (Sub Pop energy,
not dirge), with rain ambience + ferry horns underneath. *The Sound* — the
city that turned its weather into a sound.

## Props — unique to Needle Sound

*(Common props in [README.md](./README.md#props--common-to-all-tracks).)*

| Prop | Kind | Notes |
|---|---|---|
| Space Needle | track + decoration | The hero. Standing; tripod legs to the waterline, the saucer a low ring at launch height (the Saucer set-piece). |
| Great Wheel | track | The drowned/tilted Ferris wheel on its pier — primary launch ramp into the Saucer. |
| Drowned finger-piers | track | Alaskan Way piers half-submerged — the slalom corridor; shared `pier_NN` kit. |
| WSF ferries | track / decoration | Anchored green-and-white ferries — slalom obstacles + turn landmarks. |
| Pike Place Market | track (terrain) | Market frontage + the short Pike Hill crest; the clock + neon sign above water. |
| Mount Rainier | decoration (silhouette) | Eastern-horizon silhouette (camera-locked, not raced) — the Seattle "Table Mountain." |
| Houseboats | scatter | Lake-Union-style floating homes along the return run (`HV_Scatter*`). |
| `scatter_debris` | scatter | Floating dock wreckage, kelp, drifting boats along the pier edges (height/biome-gated). |
| `emitter_drizzle` | emitter (atlas 1) | The marine-layer drizzle veil — light, world-timed; the signature mood emitter. |
| `emitter_bay_spray` | emitter (atlas 9) | Across Elliott Bay + one at the Saucer splashdown. |

## References

- Model: [golden-gate-drowned.md](./golden-gate-drowned.md) — the cup's
  terrain template — and [cape-town-drift.md](./cape-town-drift.md) — the
  dense-structure slalom counterweight.
- New v2 concept from the Harbor-Cup rework; this doc is the spec until the
  build pass. No `track-design-specs.md` §ref yet.
