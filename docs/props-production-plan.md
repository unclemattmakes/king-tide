# Props production plan — from placeholders to ship quality

How we take the game's props and landmarks from the current procedural
*placeholders* to ship-quality assets, using a **hybrid procedural-first +
AI-accelerated** approach. The *what/why* of per-track content lives in
[track-themes.md](track-themes.md) + [track-design-specs.md](track-design-specs.md);
the v1 landmark/VFX plan lives in [v1-asset-pipeline-plan.md](v1-asset-pipeline-plan.md).
This doc is the *prop-art production strategy* layer — how each asset gets
made, conditioned, and shipped without breaking the instancing contract.

> **Before building any prop, read [art-direction.md](art-direction.md)** — the
> "clean stylized toy" register, the built/broken/blooming material-state rule,
> the waterline rule, and the prop-builder checklist define *how a prop should
> look*. This doc defines how it gets *made and shipped*. For the **per-family
> look + copy-paste ComfyUI concept prompts** (the AI-lane concept phase this
> plan routes to), see [prop-art-direction.md](prop-art-direction.md).

## Where we are

Every prop and landmark in the game today is a **procedural placeholder**:

- `tools/blender/lib/prop_kit.blend` — five primitives (two barriers, a
  lamppost, a crate, a pylon) appended by [build_prop.py](../tools/blender/build_prop.py).
- `tracks-src/props-library.blend` — five Geometry-Nodes collections
  (`prop_rock`, `prop_palm`, `prop_buoy`, `prop_gate`, `prop_turn_indicator`)
  scattered via `EXT_mesh_gpu_instancing` ([seed_props_library.py](../tools/blender/seed_props_library.py)).
- Hero landmarks — inline `bmesh` in `seed_track_*.py` (e.g. the Statue of
  Liberty silhouette is 121 verts / 156 faces) or the parametric archetypes
  planned in [v1-asset-pipeline-plan.md](v1-asset-pipeline-plan.md) Phase B.

The **plumbing is solid and shipped** — instancing, the `COLOR_0` vertex
contract, the `kind` registry, primitive colliders, the foliage-sway hook.
What's missing is the *art*: the silhouettes are block-outs. Closing that gap
is this plan.

## The three prop lanes (where props/landmarks enter the pipeline)

| Lane | For | Mechanism | Source of truth |
|---|---|---|---|
| **Placeable prop** | Single editor-droppable decor | `specs/props/<id>.json` → `kitPart` in `prop_kit.blend` → `build_prop.py` → GLB | spec + kit `.blend` |
| **Scattered prop** | Foliage/rocks/buoys at volume | GN collection in `props-library.blend` → `HV_Scatter` / `HV_BiomePalette` / `HV_StrokeScatter` → `EXT_mesh_gpu_instancing` | `props-library.blend` |
| **Hero landmark** | The one postcard set-piece per track | parametric collection in `landmarks-library.blend`, or inline `bmesh` in `seed_track_*.py` | seed script + `.blend` |
| **External CC0 pack** | Free third-party props that already fit the toy register | download → `fbx_to_glb_batch.py` (if FBX-only) → `condition_ai_batch.py` → `public/assets/props/cc0/` | conditioned GLB + `specs/props/cc0/<source>.json` |

Batch production **by archetype family, not by track** — one rock family
serves The Maw, Hatteras, Angkor, and Liberty. See the archetype list below.

## The constraint that shapes everything

Raw generated meshes **do not drop into this engine.** Every shippable asset
must carry:

- `COLOR_0 = (sway, AO, path-worn/phase, biome)` per [vertex-attribute-spec.md](vertex-attribute-spec.md).
- A `kind` registered in **both** [hoverbike_kinds.py](../tools/blender/hoverbike_kinds.py)
  and [asset-kinds.ts](../src/engine/asset-kinds.ts) (CI enforces parity).
- A primitive collider (box / sphere / cylinder / capsule) — scattered
  instances are render-only.
- The authoring frame: Blender **Z-up, `-Y` forward** (the yup glTF exporter
  rotates it; matches [build_prop.py](../tools/blender/build_prop.py)).
- A material in the **one-shader-per-family** convention (`mat_prop_*`,
  `mat_foliage_*`, `mat_landmark_*`).

AI generators emit dense, un-instanced, arbitrary-topology triangle soup with
none of that. **Generation is minutes; conditioning a mesh to ship here is the
hour.** That conditioning pass is the real cost — and the reason this plan is
procedural-first, not generate-everything.

Two design rules from [v1-asset-pipeline-plan.md](v1-asset-pipeline-plan.md)
reinforce it:

> **Cap fidelity at "reads correctly at 40 m/s, 60 fps."**
> **Silhouette before surface.**

A clean procedural silhouette beats a high-poly AI sculpt that fights the
instancing budget. AI-gen is a **targeted accelerator for organic + hero
pieces**, not a bulk replacement.

## Tooling assessment

### "AI props" means two different things

1. **AI-*authored* procedural props** — Claude writing `bpy`/Geometry-Nodes
   code, screenshot-iterating via the Blender MCP. **Works today**, fully
   on-pipeline. This is the right tool for all hard-surface + scatter props.
2. **Generative text/image-to-3D meshes** (Rodin / Hunyuan3D / TRELLIS /
   Meshy / Tripo) — **not** available in the currently-connected MCP. Needs a
   one-time tooling add.

### The connected MCP vs. the generative one

The session's Blender MCP is **`blender_mcp`** (projects.blender.org) — a
code-execution + introspection + screenshot bridge. **No generative AI, no
asset libraries.** Verified live: Blender 5.1.0, `hoverbike_addon` loaded.

To get generation, add **[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)**
alongside it — bundles Hyper3D Rodin (text/image→3D), PolyHaven (CC0
textures/HDRIs/models), and Sketchfab import. One-time install when Phase 2
starts.

### Tuned free stack (target machine: Nitro V16, RTX 5050, 8 GB dedicated VRAM)

| Need | Tool | Notes |
|---|---|---|
| Hard-surface + scatter bulk | **Claude + `bpy`/GN** | Native to pipeline; free |
| Fast in-Blender spikes | **Hyper3D Rodin** via ahujasid MCP | Cloud, free trial key (limited gens/day) |
| Local volume generation | **Hunyuan3D** (shape model) | ~6 GB shape gen → fits 8 GB VRAM |
| Clean quad retopo overflow | **Meshy / Tripo** free web tiers | Commercial rights granted |
| Occasional top-quality hero | **TRELLIS 2** — *cloud only* | Wants ~16–24 GB; don't self-host on 8 GB |
| Materials / HDRIs | **PolyHaven / ambientCG** (CC0) | Feeds `mat_*` families; `build_trim_sheets.py` |

All free at the starting tiers; licensing is clean for a commercial ship.

## The conditioning pass

The leverage investment. A `tools/blender/condition_ai_mesh.py` helper that
turns any imported generated mesh into a pipeline-legal asset in one call:

1. Import GLB/OBJ from the generator.
2. **Decimate / retopo** to the race-pace budget (or use Tripo's quad output).
3. **Recenter origin, orient to `-Y` forward / Z-up, apply scale.**
4. **Strip** the generator's material; assign the `mat_*` family shader.
5. **Stamp `COLOR_0`** (terrain defaults for static, linear sway for foliage).
6. **Wrap** in `prop_root` + primitive `collider_body`.
7. **Register** any new `kind` in both registry files.
8. Drop into `prop_kit.blend` (placeable), `props-library.blend` (scatter GN
   collection), or `landmarks-library.blend` (hero); author the spec.
9. Export via `build_prop` / the addon; verify in `?viewer=<id>` and at race
   pace in a **headed/WebGPU** browser (not headless).

Build this before generating at volume — without it, every AI asset is a
manual slog.

## AI-gen subject suitability — the lane-sorting rule

**Learned from the first real generations (2026-05-30). This is the
single most important filter on what to point the AI lane at.**

Image-to-3D (Hunyuan3D, and the family generally) reconstructs a shape
from a single view. It is excellent at **compact, solid, closed forms**
and poor at **thin, spindly, or spanning forms** — the latter fragment
into disconnected clumps and floating specks (the model can't infer a
coherent thin structure from one view).

| Verdict | Forms | Examples (our archetypes) |
|---|---|---|
| ✅ **AI lane** | Compact / solid / closed | rocks, boulders, idols + carved heads (Bayon), anchors, chests, urns, debris, crates, barrels, mooring bollards, statues, chunky sea-life (turtle, shark), the bike body |
| ❌ **Keep procedural** | Thin / spindly / spanning | coral *fans*, kelp, branching foliage, arches, towers, bridges, cables, gates, lattice masts, lamp posts |

**Evidence:** the AEGIS V bike body and a barrel conditioned cleanly; a
*branching* coral and a sea arch both fragmented into clumpy/floaty
messes. (The sea-stacks were authored procedurally — correct in
hindsight: a clean columnar primitive beats a fragmented AI guess.)

**Practical consequences:**

1. When routing a level's prop list, send compact/solid archetypes to the
   AI lane and flag thin/spanning ones for the procedural lane — don't
   waste GPU time on subjects that will fragment.
2. Prompt *toward* solidity even within a category: "massive solid brain
   coral **boulder**, rounded" reads far better than "branching coral."
3. Decimation: the conditioner reduces **iteratively** (≤10× per pass,
   per the 2×0.1-Decimate finding) rather than one aggressive collapse —
   gentle passes preserve the silhouette.

## Plan of attack — phased

### Phase 0 — Unblock the toolchain (½–1 day, highest leverage)
- Blender + MCP online (✅ verified: 5.1.0, addon loaded).
- Add ahujasid/blender-mcp for Rodin/PolyHaven/Sketchfab (deferred until
  first organic generation).
- Write `condition_ai_mesh.py` + a golden-path template `.blend`.

### Phase 1 — Procedural bulk, Claude-authored (~60–70% of archetypes)
Hard-surface + scatter that GN/bmesh already nails. Most of this overlaps the
**existing** landmark archetypes already planned in
[v1-asset-pipeline-plan.md](v1-asset-pipeline-plan.md) Phase B —
`tower_cylinder_spiral`, `arch_ruin`, `drowned_facade`, `glass_tank_broken`,
`mechanical_rig`, `carved_face_block`, `lava_river_strip` — plus the placeable
+ scatter decor (containers, cranes, barriers, crates, lampposts, signage
flats, hotel/facade plinths, wave-pool walls). Drive via the MCP live-loop or
committed `seed_*.py` for CI reproducibility.

### Phase 2 — AI-gen accelerated organics + hero (~25%)
What procedural can't make read well: sculpted rock/sea-stack/coral family,
kelp, strangler-fig roots, the great-white shark, Bayon carved-face *detail*,
and the Statue of Liberty hero sculpt. Generate → condition → instance.
**The loop is now automated**: `make-level-props <level>` routes a track's
props to the AI lane and drives the GPU phases; run it per level and review
at the two gates. Routing is validated across all 13 tracks (≈11 AI props,
the rest flagged procedural).

### Phase 3 — CC0 fill + materials (~10%)
PolyHaven HDRIs/textures into the `mat_*` families; ambientCG / Kenney /
Quaternius filler; existing `build_trim_sheets.py` / `build_decal_atlas.py` /
`build_sprite_atlas.py`.

### Week-1 de-risking pilot — ✅ loop proven
Proved the loop on the **rock family**: The Maw's `sea_boulder` ran the full
`make-level-props` chain (SDXL concept → Hunyuan mesh → ~2000-tri conditioned
prop with `COLOR_0` + box collider → `hv_locked` library asset). The loop is
smooth — Phase 2 can scale level by level. Conditioning was *not* painful
once two export bugs were fixed (single-`COLOR_0` export; generator
color-layer strip — see [ai-prop-pipeline.md](ai-prop-pipeline.md)).

## Master archetype list

Deduplicated across the 12 v1 tracks (+ the emerging Golden Gate Drowned).
Tiered by production method; each maps to a lane above.

### (A) Hard-surface / architectural → **procedural** (Phase 1)
- Towers: lighthouse cylinder (Hatteras), stepped spire (Angkor), Campanile
  (Doge's), skyscraper grid (Shibuya, Liberty, Golden Gate) → `tower_cylinder_spiral`,
  `drowned_facade`.
- Arches / tunnels: Maw arches ×3, Rialto, aquarium shell (Cape Town) →
  `arch_ruin`, `glass_tank_broken`.
- Industrial: gantry cranes ×5 (Marina Bay), supertanker hull, Brooklyn Bridge
  towers + cables, seaplane (South Beach) → `mechanical_rig` + bespoke.
- Water-feature structures: wave-pool basin + walls, half-pipe slide, lazy
  river (Aqualand); lava-waterfall ridge (Kilauea) → `lava_river_strip`.
- Decorative: hotel rooftop plinths (South Beach), container stacks (Marina
  Bay, Cape Town), St. Mark's domes (Doge's), lifeguard tower (Aqualand).

### (B) Organic / natural → **AI-gen + condition** (Phase 2)
- Rock family: sea stacks (Maw), shoal rocks (Hatteras, Liberty), mossy temple
  rubble (Angkor), coral/debris (South Beach, Cape Town). **← pilot target.**
- Foliage: palms (6+ tracks), strangler-fig root arches (Angkor), jungle
  tree-line.
- Sea life / sculptural: great-white shark (Cape Town), underwater statues
  (Liberty), kelp (Golden Gate).
- Hero sculpts: **Statue of Liberty** (finale postcard), Bayon carved faces.

### (C) Small scatter decor → **procedural + CC0 fill** (Phase 1/3)
- Signage flats (Art Deco fascia, Shibuya neon), buoys, lounge chairs,
  driftwood, mooring posts, rusted hardware.
- Debris / hazards: corroded containers, glass shards, yellow cabs (Liberty
  shoal), broken furniture.
- Glow props: Murano furnaces (Doge's), microgrid survivor lights (Golden
  Gate, Liberty windows), torch flame, neon glare → pair with the emitter
  system (`kind="emitter"`).

## Definition of done — per prop

A prop is "done" when it:

1. Reads at 40 m/s / 60 fps (silhouette first), at its intended scatter density.
2. Carries the full `COLOR_0` contract + a primitive collider.
3. Uses a `mat_*` family material (one shader per family).
4. Exports clean (`EXT_mesh_gpu_instancing` for scatter; `lint`/`gen` pass).
5. Any new `kind` is registered in both registry files.
6. Verified in `?viewer` and in a headed/WebGPU browser, on at least one track.

## References

- [v1-asset-pipeline-plan.md](v1-asset-pipeline-plan.md) — landmark/VFX plan,
  the seven hard-surface archetypes (Phase B here).
- [level-design-playbook.md](level-design-playbook.md) — the pass-by-pass track
  build (supersedes the archived track-build-playbook).
- [blender-pipeline-guide.md](blender-pipeline-guide.md) — scatter, biome
  palette, strokes, object-kind reference.
- [asset-pipeline-guide.md](asset-pipeline-guide.md) — spec → GLB round-trip.
- [vertex-attribute-spec.md](vertex-attribute-spec.md) — the `COLOR_0` contract.
- [track-themes.md](track-themes.md) / [track-design-specs.md](track-design-specs.md)
  — per-track content + numeric specs.
