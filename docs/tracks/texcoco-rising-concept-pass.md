# Texcoco Rising — Concept-Art Pass (per-beat shot sheet)

> **What this is.** The runnable per-beat concept prompts for Texcoco Rising
> (Reef Cup #1 — drowned Mexico City). Paste-ready for Midjourney, built from
> the project recipe ([art-direction.md § Concept-art recipe](../art-direction.md#concept-art-recipe-v2-lock))
> and the track look ([texcoco-rising-art-target.md](./texcoco-rising-art-target.md)).
> Beats follow [texcoco-rising.md](./texcoco-rising.md).
>
> *(Authored on a remote session with no image generator — this is the
> direction + prompts, not the rendered plates. Run the lane, curate a
> best-of to `concept-art/midjourney/texcoco-rising/best/`, then drive the
> bespoke-prop sculpts from [texcoco-rising-prop-manifest.md](./texcoco-rising-prop-manifest.md).)*

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

### 1 — Hero aerial · `texcoco_hero_aerial`
The postcard; get water + sky grade right here first.
> `<concrete scene>` = **aerial postcard of a drowned Mexico City: a teal lake
> threaded by raised stone Aztec causeways, the tall gold Ángel de la
> Independencia column catching low sun dead-centre, colourful Xochimilco
> trajinera boats fanned across the water, the half-sunk cathedral and a stepped
> pyramid off to one side, twin volcanoes — one smoking — on the horizon**

### 2 — Calzada causeway run · `texcoco_calzada_run`  *(0–10 s)*
The built heart; where to spend prop density.
> `<concrete scene>` = **low racing view down a raised Aztec stone causeway over
> a calm teal lake, painted colonial facades (rosa, cobalt, ochre) and purple
> jacaranda trees lining it, papel-picado banners strung overhead, warm
> string-lights, water reflecting the sunset**

### 3 — Zócalo lagoon · `texcoco_zocalo_lagoon`  *(10–20 s, weave)*
> `<concrete scene>` = **the half-sunk Catedral Metropolitana leaning over a
> teal lagoon beside the re-emerging stepped Templo Mayor pyramid with carved
> stone serpent heads, colourful trajinera boats and floating marigold petals,
> gilded altarpiece glints catching the light**

### 4 — El Ángel · `texcoco_el_angel`  *(28–36 s, the set-piece)*
The hero; build + light first after water/sky.
> `<concrete scene>` = **hero shot: a collapsed double-decker concrete freeway
> deck fallen across a flooded avenue as a launch ramp, a hover-bike airborne
> off the broken lip soaring past the towering gold Ángel de la Independencia
> winged-victory statue, Popocatépetl volcano smoking behind, the teal lake and
> trajineras spread far below**

### 5 — Chapultepec finish · `texcoco_chapultepec_finish`  *(36–45 s, turn)*
> `<concrete scene>` = **a sweeping bank through a drowned park of flooded
> ahuehuete cypress groves, a castle silhouette on a green hill as the finish
> landmark, distant twin volcanoes and skyline silhouette mirrored in the calm
> teal water**

### 6 — Waterline detail · `texcoco_waterline_detail`
The spec image for the waterline trio (closer to a material study).
> `<concrete scene>` = **instructional close-up: a painted colonial facade and a
> basalt causeway edge meeting clear teal alkaline lake water, the waterline
> trio visible — bright reed/lily fringe, a mineral verdigris crust band, a pale
> chalky salt-bleach band above — submerged rubble and chinampa reeds below the
> surface**

### (bonus) Twin-volcano horizon · `texcoco_volcano_horizon`
Mood reference for the bespoke `horizon_ring` silhouette.
> `<concrete scene>` = **wide silhouette study of Popocatépetl and Iztaccíhuatl
> (the smoking volcano + the sleeping-woman ridge) on the horizon at sunset
> beyond a calm teal lake, the high ground that watched the city drown**

## Next

1. Run the lane, curate a best-of (6 beats + horizon) to the external store.
2. Mine the plates for **bespoke sculpts** → [texcoco-rising-prop-manifest.md](./texcoco-rising-prop-manifest.md)
   (the prop manifest carries the render-locked single-prop ComfyUI/MJ prompts).
3. Build the `.blend` the current way (empty scene → the **South Beach track
   shape carried in `public/tracks/texcoco-rising.json`** → blockin terrain +
   landmarks → dressing). See [track-design-specs.md §2.1](../track-design-specs.md).

## References
- [texcoco-rising-art-target.md](./texcoco-rising-art-target.md) — the look spec.
- [texcoco-rising.md](./texcoco-rising.md) — the track (beats, props).
- [art-direction.md](../art-direction.md#concept-art-recipe-v2-lock) — the recipe.
