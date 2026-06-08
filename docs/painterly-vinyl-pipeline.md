# Hoverbike — Painterly-Vinyl Pipeline

> How we **achieve** the painterly-vinyl look ([art-direction.md](./art-direction.md) v2)
> in the engine, and how we **ingest** meshes at any readiness state — shape-only
> → fully textured — and bring them all to that look.
>
> **Canonical for:** the runtime "vinyl" material treatment, the multi-point
> asset-intake funnel, and the build plan that connects them.
> **Defers to:** [art-direction.md](./art-direction.md) for *what the look is*
> (the register, the two ditches, the material-state + waterline rules);
> [props-production-plan.md](./props-production-plan.md) +
> [asset-pipeline-guide.md](./asset-pipeline-guide.md) for the existing
> conditioner mechanics; [vertex-attribute-spec.md](./vertex-attribute-spec.md)
> for the `COLOR_0` contract.
>
> Status: **design locked, implementation starting** (2026-06-05). File/line refs
> are pointers and will drift — grep the symbol, not the line.

---

## The core principle — impose the look once, at runtime

The painterly-vinyl read (clean cast forms + hand-painted surfaces, no outlines,
soft rim, world-space waterline, bloom) does **not** have to be baked into every
asset. The decisive move is to **separate two layers that are currently
conflated:**

- **Intake** decides a mesh's *form* and its *albedo* (flat tint, atlas, or
  hand-painted texture). Meshes arrive at any readiness.
- **Runtime** imposes the *look* — one shared TSL material every prop wears,
  which adds the rim, the matte finish, the procedural weathering, the waterline
  bands, and bloom-ready emissive **on top of whatever albedo arrived.**

Today the runtime layer is **missing for props.** Track meshes run four
material-swap passes in `loadGlbTrackVisuals` (`glb-track.ts`); props are
instanced with their **raw GLB material, by reference, untouched**
(`props-mesh.ts` `createPropsMesh`). So a prop reads as whatever the conditioner
baked, with no unifying treatment.

Push the signature into one shared runtime material and the look becomes
**intake-independent**: a track dressed entirely from clean Quaternius shapes
still reads painterly-vinyl, and so does a hero prop wearing an AI-painted skin —
because they share the same rim, the same waterline, the same finish. The terrain
shader already proves the pattern (world-space waterline + value-noise weathering
on a `MeshStandardNodeMaterial`); we **generalize it to props.**

---

## Layer 1 — the runtime "vinyl" material (the look lives here)

A new module `src/engine/render/painterly-vinyl-material.ts` exporting
`buildVinylMaterial(srcMaterial, opts)`, modeled on the existing GLB→node
conversion helper `toSwayNodeMaterial` (`foliage-sway.ts`).

**What it does** — returns a `MeshStandardNodeMaterial` that:

1. **Wraps the source albedo** — samples `srcMaterial.map` if present (textured
   intake), else uses `srcMaterial.color` (flat-tint intake). Copies the standard
   props (`map/normalMap/roughness/metalness/color/emissive`) the way
   `toSwayNodeMaterial` already does (`COPIED_STANDARD_PROPS`).
2. **Soft rim / fresnel** — lift the idiom already shipping in `clouds.ts`:
   `rim = pow(1 - saturate(dot(normalWorld, viewDir)), k)`, mixed toward a warm
   rim tint. Pops the silhouette off sky and water; no outline.
3. **Matte-satin finish** — roughness high, metalness 0 (vinyl, not glossy
   plastic).
4. **Procedural painterly weathering** — a subtle domain-warped value-noise wash
   + the built/broken/blooming tint, copied from the terrain idiom
   (`terrain-shader.ts`). The material *storytelling* layer; makes a flat-tint
   mesh read as painted with no texture work.
5. **World-space waterline trio** — calls the **shared helper** (below) so a prop
   gets salt-bleach / barnacle / algae wherever it meets the sea, no per-prop
   baking (the waterline rule in [art-direction.md](./art-direction.md)).
6. **Bloom-ready emissive** — preserve/author emissive to cross the bloom
   threshold (already wired in `post-pipeline.ts`).
7. **Idempotent** — mark with `Symbol.for('hv_vinyl')` like `NODE_SWAYED`, so
   shared materials convert once.

**The shared waterline helper.** Factor the world-space waterline block out of
`terrain-shader.ts` into `src/engine/render/waterline.ts` exporting
`applyWaterlineBands(baseColorNode, worldY, waterLevel, strength, palette)`.
Terrain and the vinyl material both import it — one art-tuned implementation, two
callers. Highest-value reuse in the plan.

**Attach points** (two swap sites, mirroring the existing pattern):

- **Props** — convert each prop's material in `createPropsMesh` (`props-mesh.ts`)
  before instancing. Materials are shared by reference across instances, so we
  convert **once per asset**, not per placement — nearly free. Animated props
  (`animated-props.ts`) share the material cache and inherit it for free.
- **Buildings / set-pieces** — a new `applyVinylMaterialToScene(scene, opts)`
  traversal in `loadGlbTrackVisuals` (`glb-track.ts`), after the lava pass,
  converting every still-stock mesh (skip `kind` terrain/decal/emitter/horizon).
  `waterLevel` threads from the track JSON like `terrainShader` already does.

---

## Layer 2 — multi-point intake (form + albedo)

The conditioner (`condition_ai_mesh.py` `condition_object`) already does most of
this; the work is **readiness auto-detection** plus two missing routes.

| Mesh arrives as… | Route (conditioner) | Albedo it carries | Dial position |
|---|---|---|---|
| **Shape-only** (Hunyuan, raw scan) | strip → flat **family tint** (`_assign_family_material`) | one hex tone | clean-vinyl end |
| **Shape-only, hero** | strip → **hand-painted texture** (AI / Blender strokes) → bake to `map` | brushwork | SoT end |
| **Flat-colour slots** (toon-shooter, ships, fish) | `keep_material` (`_preserve_material`) | per-slot colour | clean-vinyl end |
| **Atlas** (pirate, cyberpunk) | `keep_material` | flat palette atlas | clean-vinyl end |
| **2K PBR** (downtown-city, stylized-nature) | **budget-downsize** (≤512, drop ORM) → keep or flatten | rich texture | mid; tame first |
| **Rigged** (animated fish) | `ship_animated_prop.py` | flat colour | clean-vinyl end |

All routes stamp the `COLOR_0` contract (neutral for keep_material; family
default for strip) and normalize scale (`_rescale_to_height`, game ≈ 3× real).

**Readiness maps onto the dial.** Flat-tint and Quaternius-atlas assets land at
the *clean-vinyl* end; AI/hand-painted textures land at the *SoT brushwork* end —
and the **runtime vinyl material keeps them coherent**. Dressing a track from
clean Quaternius shapes today already yields a unified painterly-vinyl read;
repainting a prop's albedo pushes it toward SoT.

**Intake gaps to close** (from the audit):

- **No readiness auto-detection.** `keep_material` is a hand-set binary flag,
  unreachable from the AI orchestrator (`make_level_props.py` `cmd_condition`
  never sets it). Detection helpers exist (`_material_has_image`,
  `_preserve_material`'s source diagnosis). → Add an auto-router that inspects the
  mesh and selects strip-tint / keep_material / budget-downsize.
- **No texture-budget pass** for the 2K PBR packs (downsize ≤512, drop non-base
  maps). → New `tools/blender` (or node) step; otherwise they blow the prop GLB
  budget.
- **No painterly-texture lane** for shape-only hero props. → The Blender
  hand-painted-stroke tools are the asset-time generator here (below).

---

## Procedural vs. hand-painted — what each buys

- **Procedural (in the shared vinyl material)** gives: rim, matte finish,
  weathering *washes*, built/broken/blooming tinting, and the **waterline trio** —
  uniform, free, on any albedo. ~80% of the read. It does **not** give literal
  brushstrokes (value-noise is mottling, not paint).
- **A hand-painted *texture* (the `map`)** gives the literal **brushwork** — the
  SoT skin. Sources: Quaternius's own atlas (flat-toy, clean end), or an
  AI/Blender-stroke-painted texture for shape-only and hero props (SoT end).

**The new Blender hand-painted-stroke tools slot in here** — the asset-time
painterly-`map` generator for shape-only and hero props, producing the texture
the runtime vinyl material then finishes. Procedural is the baseline;
hand-painted texture is the hero upgrade.

---

## What exists vs. what we build

| Look element | Status | Where |
|---|---|---|
| Bloom on emissives | **exists, wired** | `post-pipeline.ts` (threshold 0.85) |
| World-space waterline trio | **exists — terrain only** | `terrain-shader.ts` → factor into `waterline.ts` |
| Value-noise weathering | **exists — terrain only** | `terrain-shader.ts` → reuse in vinyl material |
| GLB→node-material copy helper | **exists** | `toSwayNodeMaterial` (`foliage-sway.ts`) |
| Rim / fresnel idiom | **exists — clouds/water only** | `clouds.ts` → reuse on opaque |
| No outlines | **correct by default** | Sobel pass exists but off (`post-pipeline.ts`) |
| `keep_material` intake | **exists — hand-authored only** | `condition_ai_mesh.py` |
| 63 Quaternius props conditioned | **exists, loadable** | `?track=prop-showcase` |
| **Unified vinyl material on props** | **MISSING — core build** | new `painterly-vinyl-material.ts` |
| Toon/gradient ramp | missing (infra exists) | `makeRampTexture` (`terrain-shader.ts`) |
| Scene-wide colour grade | missing (grade is dome-only) | `post-pipeline.ts` final node |
| Readiness auto-router | missing | `condition_ai_mesh.py` |
| Texture-budget pass | missing | new `tools/blender` step |

---

## Build plan (phased)

> **Progress (2026-06-05).** P0 helper landed as `waterline.ts`; the **terrain
> refactor onto it is deferred** — the prototype shouldn't risk the working
> terrain shader, so that's a later no-visual-change cleanup. P1 first cut
> landed: `buildVinylMaterial` (rim + matte + procedural weathering; waterline
> wired but default-off) converted in `createPropsMesh` via a per-source-material
> cache. Typechecks; compiles to WGSL and runs on WebGPU with zero errors.
> Procedural **brush streaks** then landed — triplanar directional value-noise +
> `bumpMap` relief, tunable in the prop viewer (brush / stroke-size / rim /
> weathering dials). Reads as soft directional brushwork (not camo), but stays
> *soft* — noise can't give deliberate tapered strokes.
>
> **Bolder strokes — landed (2026-06-06, the B+C pass).** The shared brush sheet
> (`tools/blender/build_brush_texture.py`, `pnpm gen:brush-texture`) is now real
> **bristle strokes** — a loaded tapered body + jittered bristle scratches that
> dry-brush out toward the end, on an arced spine, composited by toroidal
> scatter-add (seamless by construction, no blur-crop). It packs **three stroke
> SCALES into R/G/B** (coarse/medium/fine); `buildVinylMaterial` samples one texel
> triplanar and blends the channels by **prop size** (big props lean coarse,
> small lean fine — `brushScaleWeights`). Weights sum to 1 so brush 0 stays a
> no-op, and a grayscale sheet / the 1×1 fallback degrade to the old single-field
> behaviour for free. Verified on real WebGPU in `?propviewer` (chest): bristle
> brushwork + impasto relief, zero shader errors.
>
> **Real oil strokes — shipped (2026-06-06).** The procedural bristles are now the
> *fallback*; the shipped sheet composites **real scanned oil strokes** harvested
> from the Blender Studio **Brushstroke Tools** add-on (`pnpm gen:brush-stamps` →
> `harvest_brush_stamps.py` slices its `oil_paint-*.exr` brush-style maps into
> single-stroke stamps under `tools/blender/brush_stamps/`). Counts are LOW + large
> + high-contrast so each scanned stroke reads as a distinct mark — dense packs to
> mush, sparse goes smooth; tuned to the middle. Default `brush` is **0.5** (signed
> off on the chest). Stamps are gitignored + derived: shipping requires
> **attribution** on the in-game credits page — the brush assets are **CC BY 4.0**
> (Blender Studio / Project Gold). Only the flat stroke *textures* are used — the
> addon's stroke *geometry* is render-only and never ships.
> **TODO — Kuwahara** photo-mode post toggle (opt-in; perf/speed-read caveats).
> Otherwise aesthetic tuning is a prop-viewer dial-in.
>
> **Extended to bikes + riders + engine trails — landed (2026-06-07).** The vinyl
> brush now also rides the **bikes** (`createBikeRenderSystem` →
> `applyVinylMaterialToScene` per non-ghost bike, after the livery/exhaust tint —
> emissive glow + per-bike recolor preserved, ghosts excluded; `BIKE_BRUSH`) and the
> **rider mannequin** (`rider-mannequin.ts`, skinned-mesh safe; `RIDER_BRUSH`). New
> **brush-stroke engine ribbon trails** (`engine-trail.ts`) stream off each bike's
> authored thruster sockets (`fx_thruster_l/_r`, resolved from the bike-loader's
> `socketLocals`) — camera-facing quad-strips whose length = speed × `TRAIL_SECONDS`
> (a time window: gentle stub when slow, long streak at speed; width + alpha also
> ramp with speed). Adapted from the retired `trail-render.ts`. **Swim fixed:** the
> world-space triplanar brush *swam* on these MOVING surfaces (correct for static
> terrain/buildings, wrong for bikes/riders). `buildVinylMaterial` now takes a
> `brushObjectSpace` opt (defaulting to world) that samples the brush + weathering
> at `positionLocal × objectScale` / `normalLocal`, so the strokes are painted in
> the mesh's own frame and ride along with it. `applyVinylMaterialToScene` threads
> it through (plus `objectScale` from the mesh's world scale); bikes + riders pass
> `brushObjectSpace: true`. Bikes also pass `edgeWear` (`BIKE_EDGE_WEAR`), which
> bakes per-vertex convexity (`stampConvexityColor0`) — edge wear is a baked vertex
> attribute, so it never swam in the first place.

### Authoring & verifying the brush sheet (the repeatable loop)

The shared sheet is a **built asset** — gitignored, served from R2 (see
[asset-storage.md](./asset-storage.md)), with a neutral 1×1 fallback so a fresh
clone never breaks. To change the strokes:

1. **Source the strokes** — `pnpm gen:brush-stamps` re-harvests real oil strokes
   from the add-on (needs it installed), or hand-paint stamps into
   `tools/blender/brush_stamps/`. Then tune counts/sizes in `CHANNELS`
   (`build_brush_texture.py`): few + large + high-contrast reads as distinct
   strokes; many small ones blend to mush.
2. **Regenerate:** `pnpm gen:brush-texture` (deterministic, ~3 s, no Blender/GPU).
3. **Verify IN-ENGINE, not in texture space.** Open `?propviewer=cc0/chest` in a
   real-WebGPU browser, push the `brush` dial up (~0.7) and zoom in. **The
   contrast-stretched texture preview is NOT a reliable proxy** — spaced dabs
   blur together there but resolve as *dots* once tiled small in-engine (and the
   normal/relief turns each dot into a shaded pit). The 2026-06-06 dots bug was
   exactly this: strokes must be **continuous lines** (dense overlapping centres),
   with dry-brush as a smooth along-stroke ripple/fade, never per-dab dropout.
4. **Ship it:** the new `public/assets/textures/brush_strokes.png` only exists
   locally until pushed — `pnpm assets:push` (or, from an un-hydrated worktree,
   `rclone copy` just that one file to avoid junction/`audio` noise).

### Live look-tuning: the in-engine Brush tuner

The brush *sheet* above sets the stroke **shapes**; the brush **look** (how big
the strokes read, where they land, how strong) is live-tunable in-engine — no
reload. Open the dev palette (**Ctrl/⌘K → "brush"**, or the dock rail's *Tuners*
group; dev builds only) for the **Brush strokes** panel. Terrain and
rocks/props/buildings are **independent** dial sets — terrain stroke values never
force the same onto a dock or building. The dials are shader uniforms driven
through [brush-tuning-service.ts](../src/engine/render/brush-tuning-service.ts), so
dragging re-paints with no recompile (default values render identical to the baked
look — a no-op refactor at defaults).

The busy "straw/speckle" on big terrain + rocks isn't the sheet — it's that big
surfaces get clamped to a SMALL stroke that tiles many times. Fix: let big things
use bigger strokes + gate to curvature so flats stay clean (*dense small = straw;
few big = deliberate brushwork*):

| Surface | Dial | Default | Direction → first-pass |
|---|---|---|---|
| **Terrain** | stroke size | 4 m | bigger/sparser → **10** (the #1 straw lever) |
| | curvature gate | 0.4 | flats stay clean → **0.7** (0 = uniform, 1 = slopes/ridges only) |
| | strength | 0.75 | gentler → **0.5** |
| **Rocks/props** | size cap | 6 m | more strokes (not giant) on big forms → **12** |
| | stroke size (frac) | 0.12 | lower = bigger strokes |
| | strength | 0.7 | gentler → **0.5** |

**Copy** emits the terrain `terrainShader` block to paste into
`public/tracks/<id>.json`; the rock values map to `VinylSceneOptions`
(`glb-track.ts`) / `buildVinylMaterial` defaults (`BRUSH_PROP_SIZE_CAP`). The
sheet's own stroke *counts* are NOT tunable here — that's the regen loop above.

**P0 — shared waterline helper.** Extract the world-space waterline block from
`terrain-shader.ts` into `waterline.ts`; refactor terrain to call it (no visual
change — regression-check via `gen:track-shots`).

**P1 — runtime vinyl material (the prototype).** `buildVinylMaterial`
(albedo-wrap + rim + matte + procedural weathering + waterline) wired into
`createPropsMesh`. **Validate in `?track=prop-showcase`** on the 63 conditioned
Quaternius props (headed WebGPU). Highest-signal first step — clean shapes become
painterly-vinyl on real assets; tune the dials here.

**P2 — buildings / set-pieces.** `applyVinylMaterialToScene` pass in
`glb-track.ts`; validate on a dressed track.

**P3 — gradient/toon ramp + opts.** Optional ramp (built on `makeRampTexture`) +
per-call dials (rim strength, weathering amount, ramp on/off) so the dial is
tunable per asset/track.

**P4 — intake auto-router + texture-budget pass.** Readiness detection in the
conditioner; the ≤512 downsize step; expose `keep_material` to the AI
orchestrator.

**P5 — hand-painted texture lane (hero props).** Wire the Blender stroke tools as
the asset-time painterly-`map` generator; optional reef-pastel palette retarget
for off-palette packs.

---

## Open decisions / dials to tune (adjust as we go)

- **Weathering strength + rim intensity** — how far procedural goes before it
  reads busy (painterly ≠ busy).
- **Ramp on/off** — does a toon ramp help the vinyl read, or do rim + matte
  suffice? Decide by eye in P1/P3.
- **Scene-wide grade** — add a final grade node later, or keep grade dome-only?
- **Lean on Quaternius-as-is vs. repaint** — the clean end is shippable now;
  repaint is the hero upgrade.

---

## File map

Runtime (`src/engine/render` + `src/game/assets`): `glb-track.ts`,
`terrain-shader.ts`, `props-mesh.ts`, `animated-props.ts`, `foliage-sway.ts`,
`clouds.ts`, `post-pipeline.ts`, `prop-loader.ts`; new `painterly-vinyl-material.ts`
+ `waterline.ts`. Schema: `src/game/tracks/types.ts`.
Intake: `tools/blender/condition_ai_mesh.py` + `condition_ai_batch.py`,
`tools/make_level_props.py`, `specs/props/cc0/quaternius.json`.
Assets: `public/assets/props/cc0/*.glb` (63 conditioned), external store
`C:\project-content\hoverbike\external\quaternius\` (11 packs, 720 source models).
Validation harness: `?track=prop-showcase`.

## References

- [art-direction.md](./art-direction.md) — the look (canonical).
- [props-production-plan.md](./props-production-plan.md) — conditioner + DoD.
- [asset-pipeline-guide.md](./asset-pipeline-guide.md) — asset pipeline.
- [vertex-attribute-spec.md](./vertex-attribute-spec.md) — `COLOR_0` contract.
- [ai-prop-pipeline.md](./ai-prop-pipeline.md) — AI + CC0 intake lanes.
