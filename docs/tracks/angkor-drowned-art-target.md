# Angkor Drowned — Art Target (Drowned Cup visual pass)

> **What this is.** A visual build-target for Angkor Drowned (Drowned Cup #2 —
> atmosphere + vertical temple-stair climb), from a Midjourney environment-concept
> pass (2026-06-01). No authored `.blend` yet — mood/material targets grounded in
> the design docs. Layout follows [tracks/angkor-drowned.md](./angkor-drowned.md),
> the *look* follows this doc.
>
> Downstream of [art-direction.md](../art-direction.md) and
> [track-art-direction.md](../track-art-direction.md#11-angkor-drowned--drowned-ochre--0--35--65)
> (Angkor = **Drowned ochre**, **0 built / 35 broken / 65 blooming** — jungle
> winning over sandstone, blooming-dominant, no human-built).

## Source material

- **Concept plates (curated best-of, 6 beats):**
  `C:\project-content\hoverbike\concept-art\midjourney\angkor-drowned\best\`
  (`angkor_bayon_faces`, `_ta_prohm_roots`, `_inner_court`, `_stair_climb`,
  `_descent_finish`, `_waterline_detail`). Grids in `_montage\`, raw cells in the
  parent folder, `CONTACT_SHEET.png` + `best\_BEST_STRIP.png`.
- **MJ prompt lane** (house lane, **jungle-temple grade**):
  `<scene>; … drowned Angkor, mossy grey-gold sandstone and golden laterite, deep
  jungle greens reclaiming the ruins, dappled sunlight through canopy, calm teal
  flood water, bold colour blocking and clean stylized forms, Wind Waker meets
  Wipeout colour confidence, matte gouache key art, ancient and alive --ar 16:9
  --style raw --s 250 --no … wheels`. (The hover-craft rendered clean here — no
  wheels trap; the temple/water context didn't pull a motorbike prior.)

## The look in one line

**Jungle winning over sandstone.** Mossy grey-gold temple stone half-sunk in calm
teal flood water, **giant serene Bayon faces** watching, strangler-fig roots and
deep jungle greens reclaiming the ruins, **dappled sunlight through the canopy**.
"The flood is just the latest thing it'll outlast."

## Palette (Drowned ochre — jungle temple)

| Role | Hex | Use |
|---|---|---|
| Sandstone (broken) | `#C8A86A` golden + `#8A8478` mossy grey | the temple stone — Bayon faces, galleries, the spire |
| Jungle green | `#3E6B2E` deep + `#7CA84E` canopy | the dominant — vines, moss, strangler-figs, canopy |
| Water (cool) | `#2E8C82` calm teal | the flood; lotus-dotted, reflective, calm |
| Laterite | `#A6522B` ochre | warm brick accents |
| Dappled light | warm `#F0D89A` shafts | **sun-through-canopy haze — 50% of the visual identity** |
| Mossy waterline | `#4E7A3E` | the moss band on the wet sandstone, everywhere |

Sky preset: **`angkor_jungle`** (new preset). The **dappled sunlight shafts**
(`emitter_jungle_motes`, 3+ locations) are *half the identity* — light the temple
in warm canopy-broken shafts.

## Material-state ratio: 0 built / 35 broken / 65 blooming

- **Built (0):** none living — only the ancient temple stone, which reads as
  *broken* (abandoned), not built.
- **Broken (35):** mossy grey temple stone, the monumental staircases, fallen
  pillars, laterite brick.
- **Blooming (65):** the dominant — deep jungle greens, strangler-fig roots, moss
  everywhere, monkeys, dappled canopy light. Nature reclaiming.

## Per-beat build notes

### 1 — Bayon faces · `angkor_bayon_faces`  *(0–14 s, the set-piece)*
Hero set-piece: race past the **giant serene four-faced Bayon towers** rising from
the calm teal flood, jungle reclaiming the upper levels. **Build actions:**
- Build the 4 Bayon face-towers (4 faces each = 16 faces passed on the straight);
  carve the faces to **read as serene silhouettes at speed**, warm sandstone gold
  under green canopy shafts. The plate (cell 2) is the read — a giant face dominant
  + craft skimming. `emitter_birds_startle` lap-1 burst from the faces.

### 2 — Ta Prohm roots · `angkor_ta_prohm_roots`  *(14–28 s, the chicane)*
Weave through massive **strangler-fig roots** arching across the flooded court as a
tight chicane, golden sandstone wrapped in pale roots + moss. Build the 5 arched-root
meshes spanning the path; the hidden **root-tunnel shortcut** (`tunnel_curve_main`,
radius 3.5, one-shot-kill walls) is the high-risk expert line.

### 3 — Inner court · `angkor_inner_court`  *(28–40 s, the breather)*
A calm flooded inner courtyard with a central **lotus pond**, mossy golden-sandstone
galleries, jungle spilling over the walls, dappled light. The visual breather —
glassy reflective teal, lotus, calm. The plate (cell 0) is the mood target.

### 4 — Stair climb · `angkor_stair_climb`  *(40–55 s, the hard section)*
Ride **up the steep monumental staircase of the four-sided stepped-pyramid spire**
as a ramp, jungle canopy intermittently occluding the climb. **Build actions:**
- The central spire (~75 m, stepped pyramid) + `ramp_temple_stairs` (the rideable
  steep stairs) — the stepped-pyramid geometry *is* the verticality (the cut
  corkscrew is retired). Canopy occlusion is the skill challenge; the plate (cell 2)
  is the read — craft climbing the spire stairs.

### 5 — Descent finish · `angkor_descent_finish`  *(55–62 s, finish)*
Glide down the broad **outer staircase** back toward the Bayon approach + finish
straight, mossy galleries + jungle, calm teal water below. `road_curve_main` descent
slab to the finish.

### 6 — Waterline detail · `angkor_waterline_detail`
The *spec image* — the mossy temple waterline on golden sandstone:
1. **Algae + water-plants** below the line. *Blooming.*
2. **Vivid mossy-green tide band** on the carved sandstone at the line. *Broken/blooming.*
3. **Strangler-fig roots + lichen** above; dappled sunlight on the wet carved stone.

## Build order

1. **Bayon face-towers + the stepped-pyramid spire + the jungle horizon ring** —
   the identity silhouettes (faces + spire + tree-line).
2. **Dappled-light shafts** (`emitter_jungle_motes`) + the calm teal water grade —
   half the identity; build the light first.
3. **The stair climb** (`ramp_temple_stairs`) + the Bayon set-piece.
4. **Ta Prohm roots** chicane + the root-tunnel shortcut.
5. **Mossy waterline** on every submerged wall (the signature).
6. **Jungle life** — birds startle (lap 1), monkeys, temple dust, canopy motes.

## References
- [angkor-drowned.md](./angkor-drowned.md) — the track (beats, props, palette).
- Sister passes across the Reef / Open Sea / Continental / Drowned cups — see [the per-track index](./README.md).
- [art-direction.md](../art-direction.md) — register, material-state rule, waterline trio.
