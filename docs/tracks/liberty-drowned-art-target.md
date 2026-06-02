# Liberty Drowned — Art Target (Drowned Cup visual pass) · **FINALE**

> **What this is.** A visual build-target for Liberty Drowned (Drowned Cup #3 — the
> v1 finale), from a Midjourney environment-concept pass (2026-06-01). No authored
> `.blend` yet — mood/material targets grounded in the design docs. Layout follows
> [tracks/liberty-drowned.md](./liberty-drowned.md), the *look* follows this doc.
> **Completes the v1 art-target set (all 12 tracks + sandbar).**
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#12-liberty-drowned--urban-neon--15--55--30----finale)
> (Liberty = **Urban neon**, **15 built / 55 broken / 30 blooming** — broken-heavy
> reclaim, *end-of-day finale lighting always*).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\liberty-drowned\best\`
  (`liberty_harbor_straight`, `_torch_arm`, `_crown_gates`, `_bridge_cable`,
  `_descent_finish`, `_waterline_detail`). Grids in `_montage\`, raw cells in the
  parent folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **NYC-sunset grade** + named-landmark fix):
  `<scene>; … drowned Manhattan at sunset, copper-green oxidation and NYC granite
  grey, harbor steel-blue water, warm sunset gold, end-of-day finale lighting, …
  matte gouache key art --ar 16:9 --style raw --s 250 --no island, dry land,
  pedestal, … wheels`.
- **⚠ Two MJ traps, both managed:**
  1. **Named-landmark prior** (the Statue + Brooklyn Bridge resist drowning) —
     fixed per [[reference_midjourney_concept_pipeline]]: **describe the drowned
     form, don't name it** ("colossal green-copper oxidized robed woman raising a
     torch, sunk to her waist"), and **delete the ground** (`--no island, dry land,
     pedestal, shoreline`). Worked — the harbor/bridge/copper-statue read drowned.
  2. **Wheels trap on the torch-arm** (the *worst* in the set): "ride up the arm
     and launch off for big air" pulls a hard **motocross/motorbike** prior — even
     a re-roll with `--no motorbike, motorcycle, dirt bike, wheels, jumping` kept
     the wheels (the giant-copper-fist composition came out great, the craft
     didn't). **The torch-arm pick still shows wheels** — treat it as a *composition
     + palette + framing* target; the hero craft must be modelled wheelless per
     [bike-art-direction.md](../bike-art-direction.md), or fixed in nano-banana.

## The look in one line

**End-of-day, defiant, broken-heavy.** A colossal **green-copper oxidized statue**
sunk to her waist in a **sunset-gold harbor**, her fallen torch arm a rising
causeway to the still-lit flame, the **Brooklyn Bridge** sagging into steel-blue
water, drowned Lower Manhattan behind. The last lap of every championship — it has
to *land*.

## Palette (Urban neon — NYC sunset finale)

| Role | Hex | Use |
|---|---|---|
| Copper-green | `#4E9E7E` verdigris | the Statue's oxidized surface — the hero material |
| Granite grey | `#7A7E82` | the bridge towers, drowned masonry |
| Water (cool) | `#2E6E7E` harbor steel-blue | the flooded harbor |
| Sunset gold | `#F2A03C` → `#E2542A` | the warm key — *end-of-day finale lighting, always* |
| Emissive | warm `#FFC24D` torch flame | the still-lit torch — the one privileged glow |
| Blooming | `#4E9E7E` verdigris + algae | copper verdigris-as-life, barnacle waterline |

Sky preset: **`nyc_sunset`**. *End-of-day always* — the whole finale is golden-hour
sunset on copper-green and steel-blue. Music builds in 3 tiers (lap 1→2→3); the
art should crescendo with it on the torch-arm beat.

## Material-state ratio: 15 built / 55 broken / 30 blooming

- **Built (15):** a few survivor microgrid lights in the Manhattan rooftops — the
  faint human ember.
- **Broken (55):** the dominant — the half-submerged Statue, fallen torch arm,
  Trinity spire, the yellow-cab shoal, sagging Brooklyn Bridge cables.
- **Blooming (30):** copper-green verdigris (life-as-oxidation), barnacle/algae
  waterline at her waist, harbor sea-life over the drowned bull pit.

## Per-beat build notes

### 1 — Harbor straight · `liberty_harbor_straight`  *(0–18 s)*
Open harbor pass — the drowned Lower Manhattan skyline, a thin church spire, the
yellow-cab shoal underwater, the **Brooklyn Bridge** sagging into the harbor, the
copper statue distant, sunset gold. Lock the **Manhattan + Brooklyn horizon ring**
(Empire State / Chrysler skyline) — "the finale's identity is the skyline behind it."

### 2 — The Torch Arm · `liberty_torch_arm`  *(18–35 s, the set-piece, THE postcard)*
Hero set-piece: ride **up the fallen copper-green torch arm** as a rising causeway
to the still-lit flame in the **giant clenched fist**, the harbor and her giant
green fingers framing the shot. **Build actions:**
- `ramp_torch_arm` (~80 m, ride the *top* of the fallen arm — the cut underside
  ribbon is retired) ending at the fist/flame launch lip. `emitter_torch_flame`
  (still lit), `emitter_oxidation_shimmer` on the copper.
- The plate is the **composition + palette + giant-copper-fist framing** target —
  *not* the craft: it rendered with motorbike wheels (see the trap note above). The
  hero craft is the wheelless hover-bike; light the flame as the warm focal point.

### 3 — Crown gates · `liberty_crown_gates`  *(35–52 s, the hard section)*
Fly the **big-air gap between the broken green-copper crown spikes** past her face.
`crown_spike_gates` = a clip-hazard gate corridor (the cut interior loop is
retired); miss the gap, clip a spike. The plate (cell 0) is a clean wheelless
hover-craft against the sunset — the dynamic big-air read.

### 4 — Bridge cable · `liberty_bridge_cable`  *(branch / 0–18 s shortcut)*
Ride **the top of a single taut sagging suspension-bridge cable** as a narrow
tightrope rail (the cut cable ribbon is retired) — one of v1's hardest expert
lines. `rail_bridge_cable` (one cable flagged `kind=track`); `emitter_bridge_cable_
drip`. The granite towers + sunset frame it.

### 5 — Descent finish · `liberty_descent_finish`  *(52–70 s)*
Long descent past her **submerged copper shoulder**, across the harbor to the
finish, the drowned skyline + bridge behind, the big sunset sun on the water. The
plate (cell 2) is the finale money-shot — the sun, the bridge, the craft.

### 6 — Waterline detail · `liberty_waterline_detail`
The *spec image* — **the most symbolic shoreline in the set**: the oxidized
green-copper statue meeting the harbor at her waist (the plate rendered her
giant copper foot/base + the bridge + sunset reflection — gorgeous):
1. **Barnacle + algae crust** below the line. *Blooming.*
2. **Darker verdigris tide band** at the line on the riveted copper. *Broken/blooming.*
3. **Paler salt-bleach** above; warm sunset-gold reflection on the steel-blue water.

## Build order

1. **The Statue (torso + arm + head, copper-green) + the Manhattan/Brooklyn horizon
   ring + the Brooklyn Bridge** — the three identity silhouettes; the skyline *is*
   the finale.
2. **Sunset grade** — `nyc_sunset`, copper-green + steel-blue + sunset gold,
   end-of-day always. Build the light first; it carries the emotion.
3. **The Torch Arm** (`ramp_torch_arm` + flame) — the postcard; build + light it
   first, and **model the hero craft wheelless**.
4. **Crown gates + bridge-cable rail** (beats 3, 4).
5. **The symbolic waterline** on the copper waist (the most important shoreline).
6. **Finale life** — torch flame, oxidation shimmer, harbor spray, microgrid embers,
   the 3-tier music crescendo. *Make it land.*

## References
- [liberty-drowned.md](./liberty-drowned.md) — the track (beats, props, palette).
- [bike-art-direction.md](../bike-art-direction.md) — the wheelless hover-bike (critical for the torch-arm).
- The full per-track art-target set — see [the per-track index](./README.md).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
