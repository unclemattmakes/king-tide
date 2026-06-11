# Mexico City — Concept-Art Pass (per-beat shot sheet)

> **What this is.** The runnable per-beat concept prompts for Mexico City
> (Reef Cup #1 — drowned Mexico City). Paste-ready for Midjourney, built from
> the project recipe ([art-direction.md § Concept-art recipe](../art-direction.md#concept-art-recipe-v2-lock))
> and the track look ([mexico-city-art-target.md](./mexico-city-art-target.md)).
> Beats follow [mexico-city.md](./mexico-city.md).
>
> *(Prompts authored on a remote session with no image generator. **The pass
> has since been run — ✅ 2026-06-07 ([#321](https://github.com/occ-matt/hoverbike/issues/321)).**
> All 7 beats rendered on the lane below, carrying the painterly-vinyl `--sref`
> canonical frame and the `--no` ban list; curated to
> `concept-art/midjourney/mexico-city/best/`. Curated picks (best cell per
> beat): hero_aerial `0`, calzada_run `0`, zocalo_lagoon `2`, el_angel `2`,
> chapultepec_finish `3`, waterline_detail `3`, volcano_horizon `0`. Next: drive
> the bespoke-prop sculpts from [mexico-city-prop-manifest.md](./mexico-city-prop-manifest.md).)*

## How to read this

- **Mood plates (beats below) are wide cinematic key art.** Per the recipe,
  wide framings drift to flat 2D illustration — that's **fine for mood +
  asset-mining**, *not* the render target. The render look is locked on the
  **single-prop turnarounds** in the prop manifest, not on these scenes.
- All beats share the **style block** + **flags** below; only the
  `<concrete scene>` swaps. Always carry the `--sref` style-lock and the
  `--no` ban list.

### Shared style block + flags (prepend / append every beat)

```
<concrete scene>; painterly cinematic concept art, retro-future post-apocalyptic
solarpunk drowned-world hover-bike racing game, warm rosa-mexicano-pink and
marigold sunset over a calm teal high-altitude lake, gold and verdigris accents,
bold colour blocking and clean stylized forms, Wind Waker meets Wipeout colour
confidence, matte gouache key art, defiant and alive not mournful
--ar 16:9 --style raw --s 250
--sref <concept-art/midjourney/style-v2-sot-tf2/ref_style_canonical.png URL>
--no cute, vinyl toy, chibi, smooth plastic, glossy, infantile, busy detail,
text, watermark, wheels
```

> Palette anchors (from the art-target): sky `#E4007C`→`#FF8C1A`, water `#2E9E8F`,
> built stucco `#E8C9A0` + rosa/cobalt/ochre, broken basalt `#6E6A66`, blooming
> jacaranda `#8A6FD1` / chinampa `#3DA35D`, emissive gold `#FFD23D`.

## Beats

### 1 — Hero aerial · `mexico_city_hero_aerial`
The postcard; get water + sky grade right here first.
> `<concrete scene>` = **aerial postcard of a drowned Mexico City: a teal lake
> threaded by raised stone Aztec causeways, the tall gold Ángel de la
> Independencia column catching low sun dead-centre, colourful Xochimilco
> trajinera boats fanned across the water, the half-sunk cathedral and a stepped
> pyramid off to one side, twin volcanoes — one smoking — on the horizon**

### 2 — Calzada causeway run · `mexico_city_calzada_run`  *(0–10 s)*
The built heart; where to spend prop density.
> `<concrete scene>` = **low racing view down a raised Aztec stone causeway over
> a calm teal lake, painted colonial facades (rosa, cobalt, ochre) and purple
> jacaranda trees lining it, papel-picado banners strung overhead, warm
> string-lights, water reflecting the sunset**

### 3 — Zócalo lagoon · `mexico_city_zocalo_lagoon`  *(10–20 s, weave)*
> `<concrete scene>` = **the half-sunk Catedral Metropolitana leaning over a
> teal lagoon beside the re-emerging stepped Templo Mayor pyramid with carved
> stone serpent heads, colourful trajinera boats and floating marigold petals,
> gilded altarpiece glints catching the light**

### 4 — El Ángel · `mexico_city_el_angel`  *(28–36 s, the set-piece)*
The hero; build + light first after water/sky.
> `<concrete scene>` = **hero shot: a collapsed double-decker concrete freeway
> deck fallen across a flooded avenue as a launch ramp, a hover-bike airborne
> off the broken lip soaring past the towering gold Ángel de la Independencia
> winged-victory statue, Popocatépetl volcano smoking behind, the teal lake and
> trajineras spread far below**
>
> *(Bike beat — carries the wheels-trap mitigation: the hover-craft "magic
> phrase" (`"jet-ski"-adjacent … hovers on a cushion of anti-grav repulsion`),
> air-gap language, hover/glide verbs instead of "launch/jump," and an extended
> `--no wheels, tires, motorbike, motorcycle, dirt bike`. In the 2026-06-07 run
> this rendered all 4 cells wheel-free.)*

### 5 — Chapultepec finish · `mexico_city_chapultepec_finish`  *(36–45 s, turn)*
> `<concrete scene>` = **a sweeping bank through a drowned park of flooded
> ahuehuete cypress groves, a castle silhouette on a green hill as the finish
> landmark, distant twin volcanoes and skyline silhouette mirrored in the calm
> teal water**

### 6 — Waterline detail · `mexico_city_waterline_detail`
The spec image for the waterline trio (closer to a material study).
> `<concrete scene>` = **instructional close-up: a painted colonial facade and a
> basalt causeway edge meeting clear teal alkaline lake water, the waterline
> trio visible — bright reed/lily fringe, a mineral verdigris crust band, a pale
> chalky salt-bleach band above — submerged rubble and chinampa reeds below the
> surface**

### (bonus) Twin-volcano horizon · `mexico_city_volcano_horizon`
Mood reference for the bespoke `horizon_ring` silhouette.
> `<concrete scene>` = **wide silhouette study of Popocatépetl and Iztaccíhuatl
> (the smoking volcano + the sleeping-woman ridge) on the horizon at sunset
> beyond a calm teal lake, the high ground that watched the city drown**

## Next

1. Run the lane, curate a best-of (6 beats + horizon) to the external store.
2. Mine the plates for **bespoke sculpts** → [mexico-city-prop-manifest.md](./mexico-city-prop-manifest.md)
   (the prop manifest carries the render-locked single-prop ComfyUI/MJ prompts).
3. Build the `.blend` the current way (empty scene → the **South Beach track
   shape carried in `public/tracks/mexico-city.json`** → blockin terrain +
   landmarks → dressing). See [track-design-specs.md §2.1](../track-design-specs.md).

## References
- [mexico-city-art-target.md](./mexico-city-art-target.md) — the look spec.
- [mexico-city.md](./mexico-city.md) — the track (beats, props).
- [art-direction.md](../art-direction.md#concept-art-recipe-v2-lock) — the recipe.
