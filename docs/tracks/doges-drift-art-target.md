# Doge's Drift — Art Target (Continental Cup visual pass)

> **What this is.** A visual build-target for Doge's Drift (Continental Cup #2,
> elegant Venetian spectacle), from a Midjourney environment-concept pass
> (2026-06-01). No authored `.blend` yet — mood/material targets grounded in the
> design docs. Layout follows [tracks/doges-drift.md](./doges-drift.md), the *look*
> follows this doc.
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#7-doges-drift--drowned-ochre--35--35--30)
> (Doge's = **Drowned ochre**, **35 built / 35 broken / 30 blooming** — the most
> *balanced* track, all three states in tension). Shares the `venice_warm` sky with
> the [Sandbar](./sandbar-art-target.md) grade.

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\doges-drift\best\`
  (`doges_hero_palace`, `_rialto_tunnel`, `_murano_furnaces`, `_campanile_fall`,
  `_descent_finish`, `_waterline_detail`). Grids in `_montage\`, raw cells in the
  parent folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **Venice-warm grade**):
  `<scene>; … drowned Venice, warm ochre and terracotta stone, mossy-green
  waterline, Adriatic teal water, gold Byzantine domes and warm furnace-orange
  glow, bold colour blocking and clean stylized forms, Wind Waker meets Wipeout
  colour confidence, matte gouache key art, elegant and alive not mournful --ar
  16:9 --style raw --s 250 --no … wheels`.
- **⚠ Wheels trap (strong here):** "Venetian canal + racing" pulls a hard
  *motorbike* prior — 3 of 4 Rialto cells grew wheels; the Campanile beat grew a
  *biplane* on 2 of 4. The picks are the clean ones; on any re-roll keep the
  hover-craft phrase + `--no wheels, tires` and prefer the sleek-pod cells.

## The look in one line

**Elegant, warm, balanced.** Ochre and terracotta stone rising from glassy
**Adriatic-teal** water, **gold Byzantine domes** catching the light, the signature
**mossy-green acqua-alta waterline** everywhere, warm **furnace-orange** glow from
the Murano kilns. Venice was already half-flooded; the rest just took longer.

## Palette (Drowned ochre)

| Role | Hex | Use |
|---|---|---|
| Stone (built/broken) | `#C8772E` ochre + `#A6452B` terracotta | palazzi facades, brick, the toppled Campanile |
| Water (cool) | `#1E8C82` Adriatic teal | the canals-turned-ocean; glassy, reflective |
| Gold accent | `#E2B84B` | the Byzantine basilica domes — the warm hero accent |
| Mossy waterline | `#5E7C3E` | the signature acqua-alta tide-mark, *everywhere* |
| Furnace glow | `#FF8A2A` | the Murano kilns + rising embers — warm human persistence |
| Blooming | `#5E7C3E` | moss, ivy on facades, Adriatic sea-life |

Sky preset: **`venice_warm`** (tint `#ffe0c8`); warm daylight. This track *lives at
its waterline* — the mossy-green band is the identity.

## Material-state ratio: 35 built / 35 broken / 30 blooming

The most balanced track — built (alive), broken (flooded), blooming (mossy) all in
tension.

- **Built (35):** the palazzi facades, St. Mark's domes, the **Murano furnaces
  still burning** — warm, the human-persistence note.
- **Broken (35):** the half-submerged Doge's Palace, the toppled Campanile, the
  partially-collapsed Rialto arch.
- **Blooming (30):** mossy green at every waterline, ivy on facades, Adriatic
  sea-life in the canals-turned-ocean.

## Per-beat build notes

### 1 — Hero palace · `doges_hero_palace`
Establishing: the half-submerged ornate Gothic doge's-palace colonnade rising from
teal water, lion-column tops poking out, the toppled Campanile + gold domes beyond.
Lock the **palace-colonnade silhouette + the gold-dome cluster + the Dolomites
horizon ring**; mossy-green at the waterline.

### 2 — Rialto tunnel · `doges_rialto_tunnel`  *(12–22 s, the clearance section)*
A hover-craft ducking through the low arch of the partially-collapsed Rialto bridge
as a tight tunnel just above the water. Build `tunnel_curve_main` (radius 4, ~6 m
clearance, walls collide); mossy-green on the warm ochre brick. *Pick is the clean
wheelless cell — keep the craft a sleek hover-pod, not a motorbike.*

### 3 — Murano furnaces · `doges_murano_furnaces`  *(22–34 s, the calm stretch)*
Past warm Murano glassblower-furnace rooftops still burning, glowing furnace-orange
light + rising embers reflected in teal water. Build the 3 furnace rooftops
(`emitter_murano_furnace_*` rising embers); the warm glow is the hero accent in an
otherwise cool-teal frame — the brief calm before the Campanile.

### 4 — Campanile Fall · `doges_campanile_fall`  *(34–48 s, the set-piece)*
Hero set-piece: ride **up the fallen brick shaft** of the toppled bell-tower as a
ramp and launch off the belfry stub, the **golden domes spread below**, the bronze
bell swinging at the launch lip. **Build actions:**
- Build `ramp_campanile_fall` (~20° incline, the fallen brick shaft) + the belfry
  stub as the launch lip; the **swinging bell** is the timing hazard (glTF anim).
- The plate (cell 0) is the money shot — *domes below, craft airborne over them,
  bell-tower + bell at the lip.* `emitter_bell_ripple` on each swing apex.

### 5 — Descent finish · `doges_descent_finish`  *(48–60 s, finish straight)*
A long descending glide down the Grand-Canal-turned-ocean past the gold domes and
the palace facade to the finish, a craft racing the teal water. The basilica dome
cluster + ochre facades frame the finishing straight.

### 6 — Waterline detail · `doges_waterline_detail`
The *signature spec image* — Venice's mossy-green acqua-alta waterline on warm
ochre marble (a palace colonnade base in teal water):
1. **Green algae + seaweed skirt** below the line. *Blooming.*
2. **Mossy-green tide-stain band** at the line on the marble — *the Venice
   signature.* *Broken/blooming.*
3. **Salt-bleach band** just above, a little ivy. Reflections + caustics in the teal.

## Build order

1. **Palace colonnade + gold-dome cluster + toppled Campanile silhouette** — the
   three identity shapes.
2. **Water + sky grade** — `venice_warm`, glassy Adriatic teal, the mossy-green
   waterline everywhere (the identity).
3. **The Campanile Fall** (beat 4) — the ramp + belfry launch + swinging bell.
4. **Rialto tunnel** (beat 2) + Murano furnace glow (beat 3).
5. **Mossy-green waterline trio** on every facade + column.
6. **Warm life** — furnace embers, bell ripples, ivy, Adriatic sea-life.

## References
- [doges-drift.md](./doges-drift.md) — the track (beats, props, palette).
- Sister passes: [marina-bay-7](./marina-bay-7-art-target.md) · [the-maw](./the-maw-art-target.md) · [shibuya](./shibuya-submerged-art-target.md) · Reef ([south-beach](./south-beach-sunken-art-target.md) · [cape-town](./cape-town-drift-art-target.md) · [hatteras](./hatteras-light-art-target.md) · [sandbar](./sandbar-art-target.md)).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
