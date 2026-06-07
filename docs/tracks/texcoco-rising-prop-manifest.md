# Texcoco Rising — Bespoke Prop Manifest

> The **bespoke** props Texcoco Rising (drowned Mexico City) needs that the
> shared library doesn't already cover — derived from the design beats
> ([texcoco-rising.md](./texcoco-rising.md)) and the concept pass
> ([texcoco-rising-concept-pass.md](./texcoco-rising-concept-pass.md)), applying
> [prop-art-direction.md](../prop-art-direction.md) (lane rule, material-state,
> waterline trio, "glow is a privilege") and the track's **50 built / 20 broken
> / 30 blooming** ratio ([track-art-direction.md](../track-art-direction.md#1-texcoco-rising--reef-rosa--50--20--30)).
>
> *(Common props — `scatter_rocks`, `emitter_explosion`, AI line, checkpoints,
> start grid, water surface, etc. — are in the
> [common list](./README.md#props--common-to-all-tracks) and are out of scope
> here.)*

## Lane rule (which props get a ComfyUI sculpt prompt)

Per [prop-art-direction.md](../prop-art-direction.md#the-lane-rule-decides-whether-theres-even-a-prompt):
**AI lane** (image-to-3D — compact/solid/closed forms) gets a copy-paste prompt;
**procedural lane** (thin/spanning/architectural — towers, facades, decks,
cables, foliage) is authored via `bmesh`/Geometry-Nodes with **no prompt**. Hero
landmarks often **split**: solid sculpt (AI) + thin/architectural part
(procedural).

## Shared ComfyUI blocks (AI-lane only)

Prepend **Style**, append the per-prop **Subject**, carry the **Negative**
([source](../prop-art-direction.md#shared-comfyui-blocks-ai-lane-only)):

**Style:**
```
game prop concept art, single isolated object, stylized 3D, "clean stylized
toy" look, bold flat color blocking, strong readable silhouette, soft cel
shading with a gentle light-to-shadow gradient, subtle rim light, confident
slightly-oversized rounded-but-faceted form, matte stylized surface, post-
apocalyptic solarpunk drowned-world, 3/4 view, centered, neutral studio
background, clean even lighting, Wind Waker x Wipeout
```
**Negative:**
```
photorealistic, photoscan, realistic PBR, heavy rust, grimdark, gritty, muddy
desaturated, brown, busy surface detail, noise, text, watermark, logo,
signature, multiple objects, scene, background clutter, lowres, blurry, thin
spindly fragments, floating disconnected parts, holes
```

---

## A. Hero / set-piece

### A1 — Ángel de la Independencia *(split: column procedural + Victory sculpt AI)*
- **Kind:** `decoration` (no collision — landmark). **Beat:** 4 / hero aerial.
- **Lane — column shaft:** **procedural** (tall thin column → `bmesh`/GN). Fluted
  stone column + plinth; verdigris waterline band; **oversize 2–3×** for the
  postcard read.
- **Lane — winged Victory:** **AI** (compact solid sculpt) atop the column.
- **Material-state:** built/gilt — **emissive gold `#FFD23D`** authored to
  survive bloom (the one true glow on the track besides string-lights/gilt).
- **ComfyUI Subject (Victory only):**
  ```
  a golden winged Victory statue, classical female figure holding up a laurel
  wreath and a broken chain, wings spread, one solid cast bronze-gilt sculpt on
  a small round plinth, confident rounded forms, gilded gold surface with a thin
  green verdigris band at the base, oversized hero landmark
  ```

### A2 — Collapsed Segundo Piso freeway deck *(the El Ángel ramp)*
- **Kind:** `track` (the launch surface). **Beat:** 4.
- **Lane:** **procedural** (a spanning roadway deck → `bmesh`/GN). Tilted
  double-decker concrete deck fallen across the avenue: **tilted deck = run-up,
  broken rebar lip = takeoff**. Single clean entry/exit, readable takeoff lip.
- **Material-state:** broken — cracked concrete, exposed rebar, a salt/mineral
  band at the waterline. Keep it a *budget* (this is most of the track's 20%
  broken). No grimdark.

### A3 — Templo Mayor pyramid *(steps procedural + serpent heads AI)*
- **Kind:** `track` (skimmed past). **Beat:** 3.
- **Lane — stepped mass:** **procedural** (stacked stepped geometry).
- **Lane — carved serpent heads (Coatepantli):** **AI** (compact blocky sculpts)
  placed along the base.
- **Material-state:** built + blooming — basalt + painted-stucco panels, moss /
  chinampa-green creep at the waterline.
- **ComfyUI Subject (serpent head only):**
  ```
  a carved Aztec stone serpent head, Coatepantli temple guardian, solid blocky
  basalt sculpt with bold fangs and a curled snout, painted ochre-and-turquoise
  accents, a thin green moss band at the base, one isolated object
  ```

---

## B. Landmark / silhouette

### B1 — Catedral Metropolitana *(half-sunk, tilted)*
- **Kind:** `track` (lower mass, bike passes/skims) **+ `decoration`** (towers).
  **Beat:** 3.
- **Lane:** **procedural** (facade + twin towers → `bmesh`/GN). Authored leaning;
  gilded altarpiece glints as small **emissive** accents inside the doorway.
- **Material-state:** built — warm sandstone/stucco, verdigris dome, salt-bleach
  band above the waterline.

### B2 — Chapultepec Castle silhouette *(finish landmark)*
- **Kind:** `decoration` / distant. **Beat:** 5.
- **Lane:** **procedural** (architectural silhouette). Castle on its green hill;
  reads at distance — silhouette over surface.

### B3 — Popocatépetl + Iztaccíhuatl horizon ring
- **Kind:** bespoke **`horizon_ring`** (the distant silhouette, not a prop).
  **Beat:** all / horizon.
- **Lane:** **procedural / bespoke mesh** — twin-volcano profile (one with a
  thin smoke plume; the smoke is an **emitter**, not geometry). **The track's
  distant identity — lock early** (see [track-themes.md](../track-themes.md)
  implementation note: distant silhouettes do the heavy lifting).

---

## C. Dressing

### C1 — Trajinera boat *(hull AI + canopy arch procedural)*
- **Kind:** `decoration` (fanned across the lagoon; a raft-line of them is the
  Zócalo shortcut). **Beats:** 1, 3.
- **Lane — hull:** **AI** (compact solid punt). **Lane — name-arch canopy:**
  **procedural** (thin spanning arch — fragments in image-to-3D).
- **Material-state:** built/blooming — riot of saturated colour (bold blues,
  pinks, yellows, greens); marigold + flower dressing. Authored in **2–3 colour
  variants** for the fan.
- **ComfyUI Subject (hull only):**
  ```
  a colourful Mexican Xochimilco trajinera party boat hull, flat-bottomed wooden
  punt, solid closed body painted in bold blocks of blue, pink and yellow, a
  rounded prow, low benches, one isolated solid object, no canopy
  ```

### C2 — Drowned colonial facades *(Centro Histórico)*
- **Kind:** `decoration` (line the causeways). **Beat:** 2.
- **Lane:** **procedural** (facades → `bmesh`/GN). A small **kit** of 3–4 painted
  colonial fronts (rosa/cobalt/ochre), wrought-iron balconies, warm
  **string-light** emissives. Salt-bleach waterline band. Reuse via instancing.

### C3 — Aztec causeway (calzada) modules
- **Kind:** `track` (the loop's spine — the only "land"). **All beats.**
- **Lane:** **procedural** (raised stone roadway → `bmesh`/GN, `mat_track_road`).
  ~12 m wide, lifted just above the lake; modular straight + corner pieces.
  Reed/lily fringe at the waterline.

### C4 — Papel-picado banner strings
- **Kind:** `decoration`. **Beats:** 2, 3.
- **Lane:** **procedural** (thin spanning cables/banners → GN). Strung between
  facades/poles; bright cut-paper colour. Pairs with the `emitter_papel_picado`
  VFX below.

### C5 — `scatter_jacaranda` (jacaranda + ahuehuete cypress)
- **Kind:** `scatter`. **All beats** (causeway edges).
- **Lane:** **procedural** (branching foliage → GN scatter). Replaces the
  tropical `scatter_palms` on this track. Purple jacaranda + grey-green ahuehuete;
  blooming note.

---

## D. VFX (atlas emitters — texture work, not meshes)

| Emitter | Atlas cell | Notes |
|---|---|---|
| `emitter_papel_picado` | 6 (leaf/paper) | Drifting cut-paper banner colour over the Zócalo. |
| `emitter_jacaranda_fall` | 6 (leaf) | Purple petal drift under the jacaranda clusters. |
| `emitter_volcano_smoke` | (smoke) | Thin plume off Popocatépetl on the horizon ring. |
| `emitter_lake_birds` | 5 (gull re-skin) | Ambient inland-lake waterbirds. |

---

## Build order (cheapest-impact-first)

1. **Horizon ring** (B3) + **water/sky grade** — the distant identity + the read
   everything sits on.
2. **El Ángel** (A1) + **collapsed freeway deck** (A2) — the hero; the screenshot
   the track is judged on.
3. **Causeway modules** (C3) + **colonial facade kit** (C2) — the drivable spine
   and the built density (spend it on beat 2).
4. **Catedral + Templo Mayor** (B1, A3) — the Zócalo weave.
5. **Trajineras** (C1) + **papel-picado** (C4) + **jacaranda scatter** (C5) — the
   colour-and-party dressing.
6. **VFX emitters** (D) + **waterline trio** decal pass on every passed shore.

## References
- [texcoco-rising.md](./texcoco-rising.md) · [texcoco-rising-art-target.md](./texcoco-rising-art-target.md) · [texcoco-rising-concept-pass.md](./texcoco-rising-concept-pass.md)
- [prop-art-direction.md](../prop-art-direction.md) — lane rule, ComfyUI blocks, family looks.
- [props-production-plan.md](../props-production-plan.md) — production lanes + per-prop definition-of-done.
- [painterly-vinyl-pipeline.md](../painterly-vinyl-pipeline.md) — mesh-intake (shape-only → textured).
