# Level Visual Quality — Research

> Research-pass deliverable, not a plan-of-record. Captures the
> starting point (what's actually in tracks today), the target ("solid
> arcade-racer look at 40 m/s, 60 fps"), and the techniques worth
> adopting on both the Blender and runtime sides. Companion to
> [v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md) — that doc
> sized the per-track *production* work; this doc sizes the *systems*
> that make a 2026-quality arcade racer look populated and alive
> without burning weeks per track.
>
> The *creative* target these systems serve — the "clean stylized toy"
> register, the built/broken/blooming material-state rule, the colour/light
> grammar, and the level-builder checklist — is now codified in
> [art-direction.md](./art-direction.md). This doc is the *systems* that
> deliver that look; that doc is the look itself.

## 1. The starting point — what tracks actually contain today

We have a mature **pipeline** but bare-bones **content**. The list
below is observed by inspecting `tools/blender/seed_track_*.py`,
`tools/blender/seed_props_library.py`, the GLBs in
`public/assets/tracks/`, and the runtime in `src/engine/render/`.

### Pipeline status — what's wired and ready to be filled

| System | State | Notes |
|---|---|---|
| Terrain shader (slope/altitude/wet-band/AO/path-worn, TSL) | ✅ live | [`src/engine/render/terrain-shader.ts`](../src/engine/render/terrain-shader.ts) — runtime per-fragment, no bake; warp + triplanar + scree band + saturation already in. |
| Water shader (Gerstner+detail cascade, foam, wakes, planar reflect, scatter) | ✅ live | [`src/engine/render/water.ts`](../src/engine/render/water.ts). Per-track wave zones. |
| Sky dome + sun + clouds + stars + horizon ring + fog | ✅ live | [`src/engine/render/sky.ts`](../src/engine/render/sky.ts) — frozen time-of-day per race, 8 colour-grade presets. |
| Cloud-shadow multiplier on terrain | ✅ live | [`src/engine/render/cloud-shadows.ts`](../src/engine/render/cloud-shadows.ts). |
| Shadow map (PCF soft, 1024², 180×180 m frustum tracking player) | ✅ live | [`src/engine/render/scene.ts`](../src/engine/render/scene.ts). |
| PMREM env-map for IBL | ✅ live | Baked once at boot; no mid-race rebake (deliberate — was a hitch source). |
| Procedural props library (rocks, palms, buoys, gates, indicators) | ✅ exists | [`tools/blender/seed_props_library.py`](../tools/blender/seed_props_library.py) — 5 collections, `scatter_source=True` flag, Asset Browser marked. |
| Landmark library (18 archetypes) | ✅ exists | [`tools/blender/seed_landmarks_library.py`](../tools/blender/seed_landmarks_library.py). |
| Particle emitter system (atlas 4×4, one InstancedMesh per cell) | ✅ live | [`src/engine/render/particle-system.ts`](../src/engine/render/particle-system.ts) — reads `kind=emitter` empties out of the GLB. |
| `EXT_mesh_gpu_instancing` round-trip → `THREE.InstancedMesh` | ✅ live | Blender export already passes `export_gpu_instances=True`. Vertex `COLOR_0` flows through. |
| Foliage sway shader hook | ⚠️ defined, **never invoked** | [`src/engine/render/foliage-sway.ts`](../src/engine/render/foliage-sway.ts) is exported but no call site applies it. |
| Bloom post-pass | ⚠️ schema only | `sky.bloom` field round-trips through the JSON; no bloom pass is actually wired in the WebGPU renderer. Per the pipeline guide: *"goes live when the post pipeline lands."* |
| Tonemapping configurability | ❌ default-only | Renderer uses Three's default tonemapping; not exposed to authors. |
| Track-side scatter (Geometry Nodes → instanced palms / rocks / debris) | ❌ never used | The transport path is built (`EXT_mesh_gpu_instancing`, `scatter_<zone>` empty convention) but **no `tracks-src/*.blend` actually attaches a scatter GN graph today**. |
| Decals (road wear, paint, posters, oil stains, graffiti) | ❌ no system | Nothing in `src/engine/render/`. |
| Trim sheets / detail textures on landmarks | ❌ no system | Landmarks use solid `mat_landmark_*` BSDFs. |
| Impostor / billboard far-LOD for distant landmarks | ❌ no system | Distant landmarks are full meshes or absent. |
| Volumetric / god rays / light shafts | ❌ no system | Sun disc only. |

### Content density — what's in the GLBs

Surveyed by grepping `emitter_NN` / `wave_zone_NN` / `landmark_*` /
`prop_*` instances in each `seed_track_*.py`:

| Track | Wave zones | Emitters | Library landmarks | Foliage / scatter |
|---|---|---|---|---|
| Mayday Bay | tutorial-low | **8** | 0 | 0 |
| South Beach Sunken | 7 | 1 | 4 facades | **16 palms (only track w/ palms)** |
| Hatteras Light | 11 | 1 | 1 lighthouse | 0 |
| Cape Town Drift | 3 | 1 | aquarium + wheel | 0 |
| The Maw | 17 | 1 | 3 arches | 0 |
| Shibuya Submerged | 6 | 1 | facade + cocoon | 0 |
| Kilauea Crown | 3 | 1 | lava-river | 0 |
| Marina Bay 7 | 3 | 1 | cranes + tanker | 0 |
| Doge's Drift | 3 | 1 | Campanile + Rialto | 0 |
| Aqualand | 5 | 1 | 0 (inline bmesh) | 0 |
| Angkor Drowned | 3 | 1 + 1 jungle | spire + 16 faces | 0 |
| Liberty Drowned | 6 | 1 | Liberty + facades | 0 |

The picture: **wave zones are well-populated** (the wave-mastery
pillar has done its job), **hero landmarks are placed** (one
postcard moment per track), but **mid-ground filler is missing** —
no foliage scatter, no rock fields, no debris piles, no signage
clutter, no jungle floor, no urban street junk. Plus emitters are
authored at "one VFX per track" density when 5–10 was the target in
the asset-pipeline plan.

That's the visual gap: tracks look like *terrain + a hero
landmark* without the middle scale of stuff that gives places
texture. JetMoto's coast had palms-and-rocks-and-tiki-torches
*everywhere*; Wave Race had buoys-and-flags-and-spectator-boats
*everywhere*. The proportional difference at race-speed read is
huge.

## 2. The target — what "solid arcade visual quality" looks like for us

Bound by the existing design rules:

- **40 m/s, 60 fps budget.** Anti-target is anything that costs us
  the framerate budget on M1 / Ryzen 5000 at 1080p. *Reads-correctly-
  at-race-speed* is the bar; nothing benefits from sub-pixel detail.
- **Arcade silhouette, not photorealism.** Bright palettes, defiant
  colours, exaggerated shapes. Pacific Rim handcrafted-toy aesthetic,
  not Forza Horizon scan-quality. See the v1 art direction in
  [`track-themes.md`](./track-themes.md): *"warm sun on cold water;
  neon at night reflected in flooded streets"*.
- **Procedural-first authoring.** Re-running a seed must remain a
  valid workflow. Any visual upgrade authored by hand has to also be
  expressible as a `seed_*.py` recipe so a future re-seed doesn't
  nuke the work.
- **Non-destructive on the Blender side.** Modifiers + GN graphs over
  baked vertex edits. Per the pipeline guide's road-conform pattern:
  *"the modifier is the source of truth, not the mesh"*.

What good arcade-racer level dressing looks like, by reference:

- **Mario Kart 8 / World** — every track has 30–80 *animated*
  background objects (waving crowds, flapping flags, moving boats,
  rotating turbines). Most are billboards or low-poly props in
  scatter clusters.
- **Wave Race 64 / Blue Storm** — boats, buoys, flags, dock-pilings,
  flotsam, beach umbrellas, distant cliff cards. Built from a small
  prop kit, repeated densely.
- **Jet Moto** — palms, rocks, tiki torches, banners, tire stacks,
  hay bales, spectator stands. A handful of prop archetypes, scattered.
- **Sonic Riders / Forza Horizon arcade mode** — heavy use of
  vertex-sway foliage, decal grass tufts, road-edge debris, sign
  posts, lamp posts, banners, sponsor signage along straights.

We are missing the **mid-ground filler band**. That's the gap to
close.

## 3. Where the work goes — by layer

Order is leverage-descending: each layer is independent enough that
you can ship one without the others, but the order below lands the
most visible upgrade per day-of-work.

---

### Layer A — Scatter foliage / rocks / debris (highest leverage)

**Why.** This is the single biggest gap: 11 of 12 tracks have *zero*
foliage. The transport (EXT_mesh_gpu_instancing) is built and
verified — 800 palms cost roughly what 1 palm costs in draw calls
and memory. The props library is built. **Nothing actually emits the
scatter graph.**

**Blender side.**

1. Author a **`HV_Scatter` Geometry Nodes group** in
   `props-library.blend` (or a new `scatter-rules.blend`) that takes:
   - a target mesh (terrain) as the surface,
   - a collection of source props (`prop_palm`, `prop_rock`, …),
   - density (per m²) / min spacing / size range / Z-up jitter,
   - slope filter (skip slopes steeper than θ),
   - altitude filter (skip below water / above tree-line),
   - distance-from-spline filter (skip on the racing surface),
   - seed (deterministic per-track).

   The output uses `Instance on Points` + `Realize Instances OFF`,
   parented under a `scatter_<zone>` Empty so the existing exporter
   emits `EXT_mesh_gpu_instancing`. The runtime already lifts these
   into `THREE.InstancedMesh` with no client-side change.

2. Add an addon operator **`King Tide → Add → Scatter Zone`** that
   drops a `scatter_<name>` Empty + a target mesh child with
   `HV_Scatter` pre-attached, defaults driven by which biome
   template is active (palms+rocks on island, palms+driftwood on
   reef, brush+rock on alpine, none on downtown, etc.).

3. Per-track `seed_track_*.py` helpers — `_drop_scatter(scene, zone,
   density=0.04, sources=("prop_palm", "prop_rock"), ...)` —
   mirroring the existing `_drop_palms` / `_drop_facades`
   helpers. Each track ends up with 1–4 scatter zones (one per
   biome chunk: "rooftop islands", "beach", "underwater shoals",
   …).

4. **Distance-from-spline mask** is essential: the racing line and
   ~6 m of shoulder on either side must read as *swept clean*, not
   as a forest. The existing path-worn bake already computes this
   distance; reuse the same KD-tree.

**Game side.**

1. **Wire `applyFoliageSway` at GLB load.** The hook in
   `src/engine/render/foliage-sway.ts` is *exported but no call site
   invokes it*. The fix is one place in `src/engine/render/glb-track.ts`:
   walk the loaded GLB, and for any mesh whose material name starts
   `mat_foliage_*`, call `applyFoliageSway(mesh.material)`. The hook
   already reads `COLOR_0.r` (sway gradient) which the props library
   already stamps on palms.

2. **Wind uniform.** Drive `updateWind(direction, strength)` from
   the same source the cloud-shadow scroll already reads, so wind
   feels coherent across cloud → sea → foliage.

3. **Frustum culling on InstancedMesh.** Three's GLTFLoader handles
   this for us, but it's worth verifying with the WebGPU path before
   shipping a 1500-palm track — the inherited bounding sphere is
   often too tight on scattered output.

4. **Far-LOD via card billboards** (deferred, Layer F). Until then,
   keep the slope/altitude/distance filters tight so we don't ship
   1500 full-mesh palms across a 1 km map.

**Expected effect.** Every track immediately reads as *populated*
rather than featureless. South Beach already shows the difference
between 16 placed palms and zero; making it 400 scattered palms is a
one-pass change after the GN group lands.

**Effort.** Medium. ~3 days for the GN group + addon operator + one
sample track conversion. Then per-track scatter setup is ~30 min in
the seed script.

---

### Layer B — Foliage sway + wind shader plumbing

Already mentioned in Layer A, called out separately because it's the
*free polish* once Layer A's content lands.

**Status.** `applyFoliageSway` is shipped but unused; vertex
`COLOR_0.r` is already stamped on palm props per the spec.

**Work.**

1. Hook `applyFoliageSway` in the GLB loader on material-name match
   (`mat_foliage_*`).
2. Drive `updateWind` once per frame from a track-wide wind
   uniform (`track.weather.windDirection`, `track.weather.windStrength`),
   round-tripped through the per-track JSON. Add a *Wind* sub-block
   to the sky preset panel.
3. Banners / flags / cloth signage get the same shader — add
   `mat_foliage_banner` to the convention. Flag-style assets in the
   landmark library (Kilauea volcanic-tribal banners, Marina Bay
   harbour flags, Shibuya neon banners) all reuse the same vertex
   gradient.

**Effort.** Low. ~0.5 day for the hook + 0.5 day for the wind
plumbing.

---

### Layer C — Light props per biome (the "kit" pass)

The props library has 5 archetypes (rock, palm, buoy, gate,
turn-indicator). That covers tropical island. The other 6 biomes have
no kit beyond their landmark library. Pick 4–6 archetypes per missing
biome and add to `props-library.blend`.

| Biome | Existing | Add |
|---|---|---|
| Tropical island (Reef Cup) | palm, rock, buoy | driftwood log, beach umbrella, kelp clump, dock piling |
| Atlantic / open sea (The Maw, Hatteras) | rock, buoy | sea-stack, navigation marker, kelp, foam tuft, gull-perch crag |
| Urban (Shibuya, Marina Bay, Liberty) | ✅ **shipped**: lamp_post, antenna_mast, vent_stack, ac_unit, signage_panel | trash can, more variants |
| Venetian (Doge's) | — | gondola, mooring post, lantern, broken paving slab, ivy patch |
| Volcanic (Kilauea) | ✅ **shipped**: basalt_boulder, ash_heap, scorched_stump | lava-tube vent |
| Industrial (Marina Bay) | ✅ **shipped**: container, oil_drum, mooring_bollard | chain, ladder |
| Jungle (Angkor) | ✅ **shipped**: fern_clump, mossy_boulder, fallen_pillar | strangler-fig root, banana palm |
| Waterpark (Aqualand) | — | beach ball, pool noodle, inflatable ring, slide piece, faded sign |

Each archetype is a 50–200-vert procedural mesh with a placeholder
material; **same authoring pattern as the existing palm**, ~30 min
to add. The art rule is *"distinctive silhouette from 40 m, fewer than
200 verts, single material slot"*.

These props are the ammunition the Layer A scatter system needs to
fill out tracks beyond the tropical biome.

**Effort.** Medium. ~3–5 days for ~40 new archetypes if hand-modelled,
~1.5 days if mostly procedural via `bmesh` like the landmark builders
are. Recommend the procedural path so the assets remain
non-destructive.

---

### Layer D — Decals (road wear, paint, posters, water staining)

**Why.** Mid-ground texture without geometry cost. A racing line that
visibly *wears* into the road, lane paint that fades from the racing
line, sponsor posters on facades, oil stains, neon-reflection puddles —
all of these read at race-pace and don't ship vertices.

**Current state.** No decal system. The existing path-worn vertex
bake is one form of decal — vertex-resolution only, locked to the
terrain mesh's tessellation.

**Recommended approach: clip-box decals via `THREE.DecalGeometry`
re-projection, OR a deferred-style screen-space decal pass on the
G-buffer.** For an arcade racer at 60 fps, `DecalGeometry` is the
simpler choice — bake the projected mesh once per decal placement,
ship as part of the GLB.

**Blender side.**

1. New `decal_NN` empty kind. Custom props: `texture` (atlas cell or
   image path), `tint`, `blend_mode` (multiply / overlay / additive),
   `decay` (per-decal age for the racing-line wear progression).
2. Author by dropping a `decal_NN` at the cursor; the addon raycasts
   onto the nearest `kind=track` mesh, projects a quad onto the
   surface with `bmesh.bisect_plane` and a per-vertex UV based on
   the decal's local axes. The result ships as a regular mesh in the
   GLB (named `decal_NN`), tagged `kind="decal"` so the runtime
   knows to render it on top (depth-test on, write off, slight
   z-offset polygon).
3. Stamp `mat_decal_*` materials with the chosen atlas cell.

**Game side.**

1. New 1024×1024 shared **decal atlas** with a small fixed legend:
   road-wear streak, lane stripe, fade-line, oil stain, blood-of-the-
   bike (kidding — water splash), graffiti panel, sponsor poster,
   crack pattern, moss patch, neon-reflection puddle. ~12 cells.
2. One shared `SpriteNodeMaterial` (or a `MeshBasicNodeMaterial`
   with the same alpha-blend setup) — keeps draw calls bundled by
   material exactly like the particle system.
3. The path-wear vertex bake already covers the *gradient* racing-
   line wear; decals layer on top for **specific, hand-placed**
   wear features (intersection scuff, corner exit smear, tire-mark
   skids near the boost pad).

**Effort.** Medium. ~3 days for the system + atlas + first track's
decal pass.

---

### Layer E — Trim sheet textures for landmarks

**Why.** Landmarks today use solid-colour `mat_landmark_*` BSDFs.
Real arcade-racer landmarks (think Shibuya skyscrapers in MK8 Tokyo
Blur) carry a *trim sheet* — a single small atlas (512×512 or
1024×1024) with strips of detail: brick course, window-grid, ledge,
moulding, sign panel, weathering streak. UVs lay sub-strips of the
landmark's geometry onto matching strips of the trim sheet. One
texture, one material, all the landmarks in a biome.

**Status.** No trim sheet system. Each landmark has a flat BSDF.

**Approach.**

1. Author one **biome trim sheet** per cup family (reef pastel,
   open sea cool, urban neon, drowned ochre) — 1024×1024, 8 strips
   per axis, ~10 KB each.
2. Re-UV the existing landmark builders in
   `seed_landmarks_library.py` to lay onto matching strips
   (`art_deco` facades onto pastel strip, NYC facades onto granite
   strip, etc.). The procedural builders are pure `bmesh` — adding
   per-face UV layout is straightforward and ~50 lines of Python
   per archetype.
3. Materials become `mat_landmark_trim_<biome>` with the trim sheet
   as base colour, plus a per-instance tint coming through
   `COLOR_0` or via a material slot override.

This is the single largest visual upgrade to **the landmarks
themselves**. It's also the single largest piece of texture
authoring on the deck. Recommend doing one biome's trim sheet
first (Shibuya, where the visual reward is highest) and
extrapolating.

**Effort.** High in texture authoring time, low in code. ~4 days for
one trim sheet + UV pass on all relevant archetypes. Pays back across
every landmark instance for that biome.

---

### Layer F — Distant-card billboards + LOD

**Why.** Once Layer A lands and we have hundreds of palms scattered,
the GPU will still be drawing them at 600 m where they're 1 px each.
A billboard / impostor pass solves this without authoring effort:

- **Near band (0–80 m):** full mesh.
- **Mid band (80–250 m):** simplified mesh (collapse fronds to
  triangle fans, drop trunk segments).
- **Far band (250 m+):** camera-facing card with a pre-rendered
  silhouette texture.

**Blender side.** A one-shot bake script:
`tools/blender/build_impostor_atlas.py` opens each `prop_*`
collection, renders 8 camera-angle silhouettes to a 256×256 atlas
cell, writes `props-impostor-atlas.png`. Same atlas pattern as the
particle system.

**Game side.** Modify the InstancedMesh path to spawn three sibling
InstancedMeshes per scatter zone (near/mid/far) and toggle per-
instance visibility by distance band. Sprite-billboard far band uses
the same shared `SpriteNodeMaterial` family the particle system
uses.

**Defer.** Not needed until Layer A is shipped and we observe an
actual frame-time hit. Three's vanilla frustum culling on
InstancedMesh covers the common case. Flag as a known-followup.

**Effort.** Medium. ~3 days when actually needed.

---

### Layer G — Atmosphere polish

These are smaller bumps that don't fit Layer A–F but each contribute.
Ordered by effort-vs-payoff.

1. **Wire bloom.** The schema is already in place
   (`sky.bloom: 0..2`); only the post-pass is missing. WebGPU
   bloom via Three's `PostProcessing` + `BloomNode` is ~30 lines
   of code in the renderer-service. Sky / sun / neon emissive (the
   buoy top-cap, Shibuya kanji, Aqualand sign, Hatteras lamp room,
   Liberty's torch flame — all already authored with emissive
   strength) will *pop* once bloom lands. Probably the single
   biggest "this looks finished" lift. **Effort: 0.5–1 day.**

2. ✅ **Tonemapping options.** `SkyConfig.toneMapping` round-trips
   through the JSON (`SKY_TONE_MAPPINGS` = neutral / aces_filmic /
   agx / reinhard / cineon); `createSkySystem` pushes the resolved
   `THREE.ToneMapping` constant onto `renderer.toneMapping` at boot.
   The `RenderPipeline` picks it up via `outputColorTransform`. Default
   stays `aces_filmic`; per-track audit pass + Blender authoring UI
   is the remaining work.

3. **Light shafts / volumetric quad sun.** A cheap fake: a
   billboard quad at the sun's position with a shader that sweeps
   alpha based on the dot of view-dir × sun-dir. Sells "sunset
   through clouds" on Big Sur / Liberty / Doge's finale. Not a
   real volumetric pass. **Effort: 1 day.**

4. **Ambient occlusion on landmark interiors.** Cycles bake one
   pass over the landmarks library — the `COLOR_0.G` channel is
   already reserved. The terrain already supports this via the
   *Bake AO + Path Wear* operator; extend the same operator to
   handle landmark meshes the next time it runs. **Effort: 0.5 day.**

5. **Distance-fog tuning.** The fog gradient runs zenith → horizon
   already, but `fogFar` defaults to 2200 m on every track. Make
   it part of the sky preset (it already round-trips schematically
   per the pipeline guide) and tune per-track — Shibuya should fog
   out the city silhouette earlier than The Maw needs to. **Effort:
   0.5 day for the tune-up across all 12 tracks.**

6. ✅ **Refraction tint under water surface.** Terrain shader's
   `withWet` branch now extends downward via a depth-driven Beer-
   Lambert cyan tint (`depthFac = clamp(depth × 0.1, 0, 1)` then
   `mix(white, cyan, depthFac)`). Submerged geometry reads as
   water-attenuated at race speed without any new texture or pass.
   Caustics pattern is the remaining work.

7. **Per-cup colour-grade pinning.** All 12 tracks already have
   their `colorGrade` slot. Audit them against the palette notes
   in [`track-themes.md`](./track-themes.md) and lock the matching
   LUTs in. **Effort: 0.5 day audit.**

8. **Crowd flat planes (Aqualand, Marina Bay).** A row of camera-
   facing quads with a single "crowd" texture, animated subtly by
   the foliage-sway shader. Sells "spectator-sport" without
   modelling people. **Effort: 1 day.**

---

### Layer H — Mid-ground "structure scatter"

Bigger than props, smaller than landmarks. Things like:

- Dock pilings, jetties, mooring posts (reef + open sea).
- Antenna masts, AC units, water tanks, rooftop signage (urban).
- Stalactites / lava tubes (Kilauea).
- Fallen columns, root cages (Angkor).
- Beached debris, half-submerged shipping containers (Marina Bay).
- Slide-pieces, lifeguard towers, pool umbrellas (Aqualand).

These could go in **either** the props library (if small enough to
scatter) **or** the landmarks library (if hand-placed). Recommend
extending the props library with ~3 "structure" prop archetypes per
biome, **without** GN modifier — pure mesh, scattered by Layer A's
graph at lower density than foliage. Three jetties per track is
better than zero.

**Effort.** Folded into Layer C — same authoring path. ~1 day per
biome for 3 structure archetypes.

---

### Layer I — Emitter coverage (use what's already shipped)

The particle system supports 16 atlas cells and an unbounded number
of emitter empties; only Mayday Bay uses more than 1 emitter (it uses
8). The asset-pipeline plan called for **3–6 emitters per track**
covering wave-pump flash, lava steam, neon glare, gull flocks, palm
sway, torch flame, oxidation shimmer, jungle motes, container rust,
tsunami spray, fog drift, ash drift, …

This is *content authoring* — no system work — so it's a one-track-at-
a-time pass. Drop emitters where the brief calls for them
([`track-themes.md`](./track-themes.md) names every track's VFX
beats). ~1 hour per track.

**Effort.** ~12 hours of authoring across all tracks.

---

## 4. Recommended sequencing

Aligned to "ship visible delta fast, foundation-first." Each phase
is independently shippable.

### Phase α — Free wins (1–2 days)

Highest payoff per hour, no new content authoring.

1. ✅ Wire `applyFoliageSway` at GLB load. — `glb-track.ts` walks
   `mat_foliage_*` materials at load (commit 990b2b7).
2. ✅ Drop in bloom post-pass and audit per-track `sky.bloom` values. —
   `src/engine/render/post-pipeline.ts` wraps `RenderPipeline` with a
   `pass(scene, camera) + bloom()` chain; `renderer-service.renderFrame()`
   routes the 4 race-mode call sites (game-loop, attract, replay,
   calibration) through the active pipeline, falling back to a direct
   render for utility renderers (track-editor, bike-viewer). South Beach
   / Cape Town / Hatteras bumped from 0.0 to 0.25–0.4; other tracks
   already had authored values.
3. Audit `colorGrade` assignments against `track-themes.md`. (~0.5 day)
4. Drop the 8-cell emitter pass per track from the asset-pipeline
   plan (each track gets its 3–6 emitters). (~1.5 days)

End state: every track *looks better* without any new geometry or
texture work. The shipped pipeline gets used to its existing capacity.

### Phase β — Scatter system + first conversion (3–4 days)

5. ✅ Author `HV_Scatter` GN group + addon operator. — `seed_props_library.py::build_scatter_group`
   + `kingtide_addon/scatter.py` (commits 990b2b7 + fe1ad51 closed
   the exporter realize-pass gap).
6. ✅ Convert South Beach from 16 hand-placed palms to a 400-palm
   scatter zone + sand-edge rock scatter; document as the
   reference track. — 3 zones, 465 palms (commit 990b2b7).
7. ✅ Roll the same pattern onto Hatteras + The Maw + Cape Town
   (existing-tropical biome). — All three carry rock scatter
   outside their racing lines (palms would float on the open-water
   layouts):
   * The Maw — 5 zones flanking the three arches, 802 rocks.
   * Hatteras Light — 4 zones outside the racetrack oval, 417 rocks.
   * Cape Town Drift — 4 zones on the harbor/Atlantic boundary, 478 rocks.

   The South Beach helpers lifted into [`scatter_lib.py`](../tools/blender/scatter_lib.py)
   so each track declares `SCATTER_ZONES` + calls `drop_scatter_zones`
   from its augment pass — per-track scatter is now ~5 lines.

End state: Reef Cup + The Maw read *populated* at race speed.
Per-track scatter for the rest takes ~30 min apiece going forward.

### Phase γ — Biome prop kits (5–6 days)

8. ✅ Add 4–6 archetype props per missing biome to the props library. —
   29 archetypes shipped across 7 biome kits (Urban / Industrial /
   Volcanic / Jungle / Venetian / Waterpark / Open Sea). See
   [`seed_props_library.py`](../tools/blender/seed_props_library.py)
   — every kit prop is a procedural `bmesh` build under 200 verts
   (except `prop_mossy_boulder` at 522v + `prop_basalt_boulder` at
   240v, both on the rework list); each has a placeholder material +
   Asset-Browser catalog entry + `scatter_source=True`.
9. ⚠️ Convert Open Sea + Continental + Drowned cup tracks with
   appropriate scatter zones using the new kits. — **Partial /
   throwaway**: test scatter on Shibuya / Kilauea / Marina Bay /
   Angkor (3 zones × 4 tracks = ~1501 new instances) verifies each
   biome kit flows through `EXT_mesh_gpu_instancing` into the
   runtime. Placement is throwaway pending the level rework.

End state: every track has 3–8 scatter zones of biome-appropriate
filler.

### Phase δ — Decals + landmark trim sheets (5–7 days)

10. ✅ Author the decal system (atlas + addon kind + runtime material). —
    `ExportedKind.DECAL` flows Blender → GLB → runtime;
    [`decal-system.ts`](../src/engine/render/decal-system.ts) walks every
    `kind=decal` mesh on load and applies the alpha-blend + polygon-offset
    + no-shadow profile, sharing one atlas texture
    (`public/assets/decals/atlas.png`, 16 procedural placeholder cells —
    rebuild with `pnpm gen:decal-atlas`). Addon ships an *Add Decal*
    operator + sub-panel with a re-cell picker
    ([`kingtide_addon/decal.py`](../tools/blender/kingtide_addon/decal.py)).
11. ⚠️ Author the first biome trim sheet (Shibuya — highest visual ROI)
    + re-UV the affected landmarks. — **First half shipped**:
    `pnpm gen:trim-sheets` builds
    `public/assets/landmarks/trim_tokyo_neon.png` (8-strip composite —
    windows / kanji / signage / weathering / brick / neon / ledge /
    base); `make_trim_sheet_material` references it via a
    `ShaderNodeTexImage`; `build_drowned_facade_trimmed_mesh` UV-maps
    a single-material slab onto the right strips. The new
    `landmark_drowned_facade_tokyo_trim` collection ships alongside
    the legacy multi-slot tokyo facade (32v vs 1624v — windows are
    painted, not modelled). Re-UV pass on the other Shibuya
    landmarks + a real artist-painted texture replacing the procedural
    placeholder is the remaining work.

End state: landmarks read as textured surfaces, not solid blocks;
hand-placed wear / paint / signage decals layer on top of the
worn-line vertex bake.

### Phase ε — Atmosphere polish (3–4 days)

Pick from Layer G's list — tonemapping, light shafts, refraction
tint, crowd planes, distance-fog tune-up. Treat as standalone polish
items that ship one at a time.

### Phase ζ — Far-LOD / impostors (deferred until frame-time evidence)

Layer F. Don't build until a track measurably drops below 60 fps on
M1.

---

## 5. Risk + anti-pattern register

- **Over-densifying scatter.** A scattered prop is still a draw on
  the shadow pass even when frustum-culled. Cap each scatter zone at
  ~500 instances by default; raise per-zone only after profiling.
  Slope + altitude + distance-from-spline filters do most of the
  work here.
- **Detail that doesn't read at 40 m/s.** Trim sheets, decals, prop
  variation should *all* be visible at 40 m and *all* be ignorable
  at 0.5 m. Avoid the temptation to chase screenshot-fidelity at
  the cost of race-speed legibility.
- **Re-bake fights.** Phase β makes scatter procedural. A
  re-running of any `seed_track_*.py` should keep the scatter zones
  intact. The pattern (and the wishlist's own rule) is: *the seed
  is the source of truth.* Hand-edits to the .blend are kept by
  authoring on top of the seeded scaffold, not by editing what the
  seed produces — same rule the landmark library already follows.
- **Foliage sway on geometry that shouldn't sway.** The hook keys
  off material name (`mat_foliage_*`). Make sure rock / building /
  facade materials don't accidentally start with `mat_foliage_*` —
  add a CI check in `pnpm gen:tracks:validate` that flags any mesh
  whose `mat_foliage_*` material has no `COLOR_0.r` gradient.
- **Bloom blowout at sunset.** ACES + bloom + emissive landmarks
  can wash the screen on `nyc_sunset` / `big_sur_golden`. Test the
  per-track sky preset against the worst-case sun angle before
  pinning the bloom value.
- **Per-track GLB size inflation.** Today's tracks are 2.5–8.5 MB.
  Adding 500 palm instances doesn't grow the GLB (the prop is
  linked, not copied) but adding a unique trim-sheet texture per
  cup does. Cap trim sheets at 1024² and reuse across the cup —
  the Shibuya sheet should also dress Marina Bay's cranes, the
  Liberty sheet should also dress Doge's palaces.

## 6. Cross-references

- [`docs/v1-asset-pipeline-plan.md`](./v1-asset-pipeline-plan.md) —
  Phase A–G production status. This doc's Phase α–ζ extend it on the
  visual-quality axis after content-fill is complete.
- [`docs/blender-pipeline-guide.md`](./blender-pipeline-guide.md) —
  current authoring workflow; the scatter / decal / trim-sheet work
  lands as additions to the existing addon panels.
- [`docs/vertex-attribute-spec.md`](./vertex-attribute-spec.md) —
  `COLOR_0` channel contract. Foliage already stamps R; rocks and
  buoys are ready to use the same R / G channels for sway / AO when
  hooked in.
- [`docs/track-themes.md`](./track-themes.md) — per-track palette
  notes; the source-of-truth audit list for Phase α colour-grade
  pinning.
- [`docs/blender-wishlist.md`](./blender-wishlist.md) — the open
  items list. Several of the visual quality knobs (terrain shader
  sliders, AO bake, road texture) are already enumerated there;
  this doc reframes them by layer rather than by author convenience.
- [`docs/design-targets.md`](./design-targets.md) — the 60-fps and
  40-m/s constraints framing everything in this doc.
