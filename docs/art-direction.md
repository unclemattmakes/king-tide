# Hoverbike — Art Direction v1

> The visual-language layer on top of the locked world frame. Where
> [product-plan.md](./product-plan.md) and [track-themes.md](./track-themes.md)
> set **what the world is** (drowned-coast near-future, the Circuit, the 12
> places, the per-track palettes) and [level-visual-quality-research.md](./level-visual-quality-research.md)
> + [props-production-plan.md](./props-production-plan.md) set **how assets are
> built** (vertex `COLOR_0`, node materials, scatter, decals, trim sheets), this
> doc sets **how it all looks and feels** — and hands prop/level builders a
> shared vocabulary so independent passes converge instead of drifting.
>
> **This doc is canonical for:** the stylization register, the material-state
> vocabulary, the colour/light grammar, and the builder checklists at the
> bottom.
> **It defers to:** [track-themes.md](./track-themes.md) for per-track palette
> + lore, the per-track docs in [tracks/](./tracks/README.md) for layout +
> set-piece, and the pipeline docs for the technical *how*. It changes **no**
> locked lore and **no** per-track palette — it explains the through-line that
> already connects them.

---

## The thesis (say it in one breath)

**Post-apocalyptic solarpunk, arcade-stylized.** The sea rose and took the
coasts; the people who stayed didn't mourn the ruins, they *moved in* — rooftop
gardens, jury-rigged solar, microgrids, the neon still on. The racers of the
Circuit are **intrepid explorers** who take a hoverbike to every drowned
landmark on Earth and put on a show. The world ended and life is winning anyway.

The through-line, already written into the world frame and now the law of every
asset: **warm sun on cold water; the neon's still on; life is reclaiming the
ruins; the things that survived stand next to the things that didn't.** It is a
**spectator sport during the collapse — not ruin porn.**

If a screenshot reads as bleak, grey, or mournful, it is **wrong for this game**
no matter how well-modelled it is.

---

## Pillars — the non-negotiables

These six override taste, schedule, and any single asset's "correctness."

1. **Silhouette before surface.** A prop must be nameable from its black
   cut-out at 200 m. Spend the budget on the shape that says *lighthouse /
   palm / crane / torch*, never on surface detail that dies at 40 m/s.
2. **Reads at 40 m/s, 60 fps.** Everything must be legible at race speed and
   ignorable at arm's length. Sub-pixel detail is wasted vertices. This is a
   hard perf contract (M1 / Ryzen 5000, 1080p, 8-bike field), not a vibe.
3. **Defiant & alive, never mournful.** Bright palettes, confident colour,
   things that glow because something is *powering* them. Decay is present but
   it is the backdrop the life grows out of — see the three-state rule below.
4. **Bold colour blocking, value carries the read.** Few hues per asset, high
   value contrast, clean shapes. Warm-vs-cold (sun on water, neon on ruin) does
   more work than any texture.
5. **Larger-than-life scale.** Landmarks, hazards and hero props are authored
   **2–4× past realism** so they silhouette against the sky and register at
   speed. Real dimensions are a floor, not a ceiling.
6. **Glow is a privilege.** Emissive is reserved for things that are **alive or
   powered** — neon, microgrid windows, solar-charge lines, torch flame,
   bioluminescence, lava. When only living/powered things glow, the glow itself
   becomes the game's signal for *survival*. Don't waste it on dead surfaces.

---

## The stylization register — "clean stylized toy"

The chosen register (Wind Waker × Wipeout × MK8, extending the existing
*"Pacific Rim handcrafted-toy, not Forza scan-quality"* lean). Concretely:

**Form language**
- Confident, slightly oversized, **rounded-but-faceted** masses. Read like a
  high-quality toy or a model-shop miniature, not a scan.
- Exaggerate the one feature that defines the silhouette (the lighthouse's
  taper, the crane's jib, the palm's arc) and simplify everything else.
- Chamfer/round the big edges so they catch light; let the medium edges stay
  crisp. Avoid both razor CAD edges and mushy organic blobs.

**Shading (node materials, WebGPU/TSL — never `ShaderMaterial`)**
- Flat-ish base-colour blocking with a **soft gradient** (a gentle light-to-
  shadow ramp), not full microfacet PBR. Roughness/metalness are broad strokes,
  not per-texel storytelling.
- A subtle **rim / fresnel light** to pop the silhouette off the sky and water.
- Light **ink/edge darkening** where it sharpens a read (cel-adjacent, not a
  hard outline pass). Use sparingly — bloom and rim do most of the lifting.
- **Bloom is the "finished" lift.** It's wired (`sky.bloom`); author emissive so
  it blooms. Test against the worst-case sun angle per track (ACES + bloom +
  emissive can blow out `nyc_sunset` / `big_sur_golden`).

**Texture strategy** (cheap-to-rich, in order)
1. **Vertex colour** (`COLOR_0`) — the default. Carries sway/AO/path-worn/biome
   per [vertex-attribute-spec.md](./vertex-attribute-spec.md).
2. **Small trim sheets** (≤1024², shared per cup family) for landmark surface
   variety — brick course, window grid, ledge, signage, weathering band.
3. **Decals** for the mid-band specifics — racing-line wear, paint, posters,
   moss patches, neon-reflection puddles, oil.
- **Avoid high-frequency photo textures.** They read as noise at 40 m/s and
  fight the toy register.

**Colour & emissive**
- 2–4 hues per asset, chosen for value separation. Saturated, not muddy.
- Emissive only on alive/powered things (pillar 6). Author it at a strength that
  survives bloom without smearing.

**Reference triangulation**
- *Wind Waker* — colour + silhouette confidence, the gradient-shaded toy read.
- *Wipeout / Redout* — neon clarity and a clean sense of speed.
- *Mario Kart 8 / World* — **density of animated background life** (30–80
  moving objects/track) and friendly readability.
- *Wave Race 64 / Jet Moto* — the *dressing density* target: palms-rocks-buoys-
  flags-flotsam **everywhere**, built from a small kit repeated densely.

**Anti-references (if it looks like these, stop)**
- Forza / photoscan fidelity; busy PBR microdetail.
- The Last of Us / grimdark ruin-porn; mournful desaturation; muddy brown.
- Anything that glows that isn't alive or powered.

---

## The material-state rule — built / broken / blooming

**The single most useful tool in this doc.** Every surface in the world is one
of three states, and **every scene is a deliberate ratio of the three.** The
ratio *is* the mood. Get the ratio right and the thesis sells itself; get it
wrong and you've made ruin porn or a theme park.

| State | What it is | Material read | Colour temperature | Says |
|---|---|---|---|---|
| **Built** | What people made and *kept* — maintained, salvaged, jury-rigged. Painted metal, solar panels, microgrid cable, hand-lettered signage, fresh tarps. | Clean-ish, matte, warm paint, soft sheen on glass/solar. | **Warm** | "We're still here." |
| **Broken** | What the flood took — abandoned, oxidised, salt-eaten. Verdigris copper, bleached concrete, rusted steel, cracked tile, barnacle crust. | Weathered, chalky, oxidised, streaked. | **Cool** | "This is what didn't make it." |
| **Blooming** | What life reclaimed — vines, rooftop gardens, coral on the drowned grid, mangrove, moss, kelp, bioluminescence. | Vivid organic, soft translucency on leaves/coral. | **Green / vivid** | "It's alive again." |

**How to use it:**
- When dressing *any* prop or scene, ask: *what % built / broken / blooming?*
  Then place materials and dressing to hit it.
- **All three should be visible** in most hero shots — that juxtaposition *is*
  the game. A pure-broken scene is ruin porn; a pure-blooming scene is a garden
  centre; a pure-built scene forgot the apocalypse.
- The ratio is **per-place, read it off the lore tag** — don't force a per-cup
  uniform. Worked examples:
  - **Shibuya Submerged** → built-heavy & defiant. Neon-on city, microgrids,
    "somebody's still paying the bill." Broken = the drowned crossing below;
    blooming = a little rooftop green. *Built 60 / Broken 25 / Blooming 15.*
  - **The Maw** → nature-dominant. Almost no built; ocean + gold rock + foam +
    kelp. *Built 5 / Broken 30 / Blooming 65.*
  - **Liberty Drowned** → broken-heavy with reclaim. Verdigris copper, granite,
    yellow-cab shoal; blooming = barnacle/algae waterline, harbour life; built =
    the few survivor microgrid lights. *Built 15 / Broken 55 / Blooming 30.*
  - **Angkor Drowned** → blooming-dominant. Jungle winning over sandstone,
    strangler-fig, moss; built ≈ 0. *Built 0 / Broken 35 / Blooming 65.*
  - **South Beach Sunken** → built + blooming, low broken. Pastel hotels kept
    alive, palms on the roofs, permanent spring break. *Built 45 / Broken 15 /
    Blooming 40.*

---

## The waterline rule (universal — every track is water)

Because the water pillar means **no track is dry**, the place where geometry
meets the sea is the most-repeated read in the game. Every static surface that
crosses the waterline gets the same three-mark treatment, bottom to top:

1. **New-life fringe** (below + at the line) — coral, kelp, mangrove roots,
   algae skirt. *Blooming.* Tells the player the water has been here a while.
2. **Crust / oxidation band** (at the line) — barnacles, verdigris, rust bloom,
   slime. *Broken.* The tide-mark of the drowning.
3. **Salt-bleach band** (just above) — a paler, chalkier strip where spray
   reaches. *Broken→Built transition.*

This is a `COLOR_0`/decal + vertex-colour job, not new geometry. It's what makes
a drowned building read as *drowned* rather than *standing in a puddle*, and it
ships the three-state rule for free on every shoreline.

---

## Colour & light grammar

- **Warm sun on cold water** is the master contrast. Lean into it: warm key
  light, cool water and shadow. The clash is the whole mood.
- **Per-track palettes are locked** in [track-themes.md](./track-themes.md) —
  do not override them. This doc governs *how* you apply them: bold blocking,
  value separation, emissive discipline.
- **Per-cup material families** keep cohesion: Reef pastel, Open Sea cool, Urban
  neon, Drowned ochre (trim sheets + tints shared within a cup —
  see [level-visual-quality-research.md](./level-visual-quality-research.md)
  Layer E).
- **Frozen time-of-day per race** (8 colour-grade presets, ACES tonemapping
  default). Pick the grade that pushes the contrast; finale tracks lean
  end-of-day.
- **Emissive = life signal.** Neon, microgrid windows, solar-charge glow, torch,
  lava, bioluminescent waterline. At night this is what tells the player the
  place is *inhabited*, not abandoned — the core of "defiant & alive."
- **Animated life sells "alive"** more than any texture: gull flocks, foliage
  sway, flags/banners on the sway shader, crowd flats at spectator tracks,
  rotating turbines. Budget a few moving things per scene (MK8 does 30–80).

---

## The explorer touch (light)

The Circuit racers are intrepid explorers of the drowned world — but for v1 this
is carried by **lore, lighting, and the bike/rider read**, with a *handful* of
signature dressing cues. **No dedicated expedition prop family ships in v1** —
reuse the existing kit + these motifs:

- **Planted Circuit route-flags** at set-pieces and gate beats — hand-stitched,
  wind-swayed (reuse `mat_foliage_banner`). The "we got here first" mark.
- **The odd base-camp cluster** near start grids — a tarp, a couple of crates, a
  string of work-lights (emissive = powered = alive). One per track at most.
- **Hand-painted wayfinding** — Circuit arrows/numbers as decals on ruin
  surfaces, like trail-blazes. Cheap, reads as human presence.
- **Salvage-built, personalised bikes/riders** — the bikes look field-kitted and
  individual, not showroom. This is where most of the explorer fantasy lives.
  Per-variant bike looks (+ ComfyUI concept prompts) are in
  [bike-art-direction.md](./bike-art-direction.md).

Keep it sparse. The goal is *"someone adventurous has been through here,"* not a
survival-crafting set-dress. If a track starts to look like a base-building game,
pull it back.

---

## Prop-builder checklist

For anyone making a prop (see also the per-prop definition-of-done in
[props-production-plan.md](./props-production-plan.md)):

- [ ] **Silhouette test:** nameable as a black cut-out at race distance.
- [ ] **Material state:** assign one of built / broken / blooming, or a
      deliberate ratio. Note it so level builders can mix scenes.
- [ ] **Bold value contrast**, 2–4 hues, saturated-not-muddy.
- [ ] **Emissive only if alive/powered** — and authored to survive bloom.
- [ ] **Waterline trio** if it crosses the sea line.
- [ ] **Oversize 2–4×** if it's a landmark/hero/hazard that must read at speed.
- [ ] Full `COLOR_0` contract + primitive collider + one `mat_*` family shader.
- [ ] Verified in `?viewer` **and** a headed/WebGPU browser at race pace.

**Do / Don't**

| Do | Don't |
|---|---|
| Spend budget on the silhouette | Spend it on surface microdetail |
| Block bold colour, let value carry | Reach for photo textures |
| Glow only living/powered things | Make dead metal/concrete emit |
| Show built + broken + blooming together | Make a pure-broken (ruin-porn) prop |
| Round the big edges to catch light | Ship razor CAD edges or mushy blobs |

---

## Level-builder checklist

For anyone dressing a track (see also
[track-art-pass-playbook.md](./track-art-pass-playbook.md)):

- [ ] **Hit the place's built/broken/blooming ratio** — read it off the lore
      tag; make all three visible in the hero framing.
- [ ] **Fill the mid-ground band.** The known gap is filler — scatter foliage,
      rock fields, debris, signage clutter, dock pilings. JetMoto/Wave Race
      density, not "terrain + one landmark."
- [ ] **Waterline trio on every shoreline** the player passes.
- [ ] **Keep the racing line + ~6 m shoulder swept clean** — never a forest on
      the line. The scatter mask already computes this distance.
- [ ] **Warm/cold contrast staged** — warm sun/neon against cold water/shadow.
- [ ] **A few moving things** — gulls, sway, flags, crowd flats, turbines.
- [ ] **Emissive survivor-life at night** — microgrid windows, neon, work-lights.
- [ ] **One hero set-piece carries the postcard;** dressing supports it, never
      competes. If the set-piece doesn't sell on a screenshot, fix it first.
- [ ] **Light explorer touch** — a flag, maybe a base camp; don't overdo it.
- [ ] Per-track palette + colour-grade preset match
      [track-themes.md](./track-themes.md).

---

## Anti-targets — what this art direction will *not* do

(Mirrors the [design-targets.md](./design-targets.md) anti-target discipline.)

- **No ruin porn / grimdark.** The world is defiant and alive. Decay is the
  trellis life grows on, never the point.
- **No photoreal / photoscan fidelity.** Clean stylized toy. Detail that dies at
  40 m/s is wasted.
- **No muddy desaturation or brown-grey palettes.** Bold, warm, saturated.
- **No glow on dead surfaces.** Emissive is the survival signal; spending it
  elsewhere kills the read.
- **No overriding the locked per-track palettes or lore.** This doc is *how*,
  not *what*.
- **No turning the explorer touch into a survival-craft set.** Keep it to a few
  signature cues.
- **No mid-ground left empty.** A track that's "terrain + a hero landmark" is
  unfinished, however good the landmark is.

---

## Appendix — palette families (hex)

The four shared material/trim families named above, pinned to concrete hex.
These are **starting swatches**, faithful to the locked per-track palette notes
in [track-themes.md](./track-themes.md) — sample them directly, but the
**per-track palette in the bible wins** where a track refines its grade
(Hatteras pushes Reef toward cool Atlantic grey; Liberty pins end-of-day).

Roles are consistent across families so you can sample by role, and map onto the
built/broken/blooming + warm/cold grammar: **sky/key** is the warm light,
**water** is the cool dominant, **built/broken/blooming** are the three material
states, **emissive** is the glow signal. Emissive values are *colour*, not
strength — author strength to survive bloom without smearing (pillar 6).

These feed the `mat_landmark_trim_*` / `mat_prop_*` families — one trim sheet per
family per [level-visual-quality-research.md](./level-visual-quality-research.md)
Layer E (the urban-neon exemplar, `trim_tokyo_neon.png`, is already built).

### Reef pastel — Sandbar · South Beach · Cape Town · Hatteras

| Role | Hex | State / use |
|---|---|---|
| Sky / key (warm) | `#FFB3C7` | pastel-pink sky, warm key (South Beach) |
| Water (cool) | `#36C8C0` | turquoise shallows / bright Atlantic |
| Built | `#F2E4C6` | Art-Deco cream stucco, kept-alive hotels |
| Broken | `#A7B2AC` | salt-bleached grey-green (Cape Town mtn, Hatteras) |
| Blooming | `#3DA35D` | rooftop palms, reef kelp |
| Emissive | `#6CFFC8` | neon-mint signage *(hazard accent: Cape Wheel red `#E8503A`)* |

### Open Sea cool — The Maw

| Role | Hex | State / use |
|---|---|---|
| Sky / key (warm) | `#FFD27A` | golden-hour Pacific sun, McWay light |
| Water (cool) | `#15324E` | deep navy ocean |
| Built / warm mass | `#C99A3F` | gold sea-stack rock (no human-built here) |
| Broken | `#6E6A60` | weathered cliff grey |
| Blooming | `#2C7A63` | kelp / sea-green |
| Emissive | `#5FE0C0` | foam sun-glint / bioluminescence (sparse) |

### Urban neon — Shibuya · Marina Bay 7 · Golden Gate · Liberty

| Role | Hex | State / use |
|---|---|---|
| Sky / key (warm) | `#FF7A3C` | sunset / sodium-lamp warmth |
| Water (cool) | `#2C5A66` | harbor steel blue-green |
| Built | `#5A6470` | granite / steel *(warm microgrid window: `#FFC24D`)* |
| Broken | `#4FA38C` | verdigris copper, oxidized hull |
| Blooming | `#4C9A4C` | sparse rooftop green |
| Emissive | `#FF2E88` / `#22C7F0` | hot-pink + electric-blue neon *(GG bridge silhouette: International Orange `#C0392B`)* |

### Drowned ochre — Doge's Drift · Angkor Drowned

| Role | Hex | State / use |
|---|---|---|
| Sky / key (warm) | `#E8C272` | dappled gold sunlight through canopy |
| Water (cool) | `#2E7E78` | Adriatic teal / temple pool |
| Built / warm stone | `#C2863A` | sandstone, terracotta, laterite ochre |
| Broken | `#7C8170` | mossy stone grey |
| Blooming | `#2F6B33` | jungle green, strangler-fig, waterline moss |
| Emissive | `#FF8A3D` | Murano furnace / warm window glow |

### Outliers — one-off grades, outside the four shared families

Two biomes don't share a family and carry their own grade:

- **Kilauea Crown** (volcanic): lava `#FF5A1F` *(emissive)* · black basalt
  `#1A1714` · steam white `#ECECEC` · volcanic-blue lake `#2E6F8E` · windward
  green `#3C8C44`.
- **Aqualand** (faded waterpark): sun-bleached red `#D8695B` · faded yellow
  `#E8C75E` · pool-tile blue `#3FB0D6` · algae green `#6E8F3E` · grime grey
  `#8C8A7E`.

---

## References

**Companion docs — per-domain application of this one:**

- [bike-art-direction.md](./bike-art-direction.md) — per-variant bike looks +
  ComfyUI concept prompts.
- [track-art-direction.md](./track-art-direction.md) — per-track material-state
  ratio, palette family, waterline + set-piece notes (all 13 tracks).
- [prop-art-direction.md](./prop-art-direction.md) — per-prop-family looks +
  ComfyUI prompts for the AI-lane organics.

**Source + pipeline:**

- [product-plan.md](./product-plan.md) — locked vision + pillars (silhouette,
  larger-than-life scale).
- [track-themes.md](./track-themes.md) — world frame, per-track palettes + lore
  (source of truth for colour, *not* superseded here).
- [tracks/](./tracks/README.md) — per-track layout, set-piece, prop manifests.
- [level-visual-quality-research.md](./level-visual-quality-research.md) — the
  render systems + the mid-ground-filler gap this doc's checklists target.
- [props-production-plan.md](./props-production-plan.md) — per-prop production
  + definition-of-done; the AI vs procedural lane rule.
- [track-art-pass-playbook.md](./track-art-pass-playbook.md) — dressing a
  gameplay-complete track (placement, AI-corridor clearance, re-export).
- [vertex-attribute-spec.md](./vertex-attribute-spec.md) — the `COLOR_0`
  contract the checklists assume.
- [design-targets.md](./design-targets.md) — the 40-m/s / 60-fps perf contract
  framing the "reads at speed" pillar.
</content>
</invoke>
