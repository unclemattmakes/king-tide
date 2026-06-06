# Geometry-Nodes prop toolkit

Reusable, parametric **Geometry Nodes tools** for dressing levels — distinct from
the placeholder props in `seed_props_library.py`. Each is a node group you drop
onto an object and tune with exposed knobs; they regenerate deterministically.

- **Source of truth:** [`tools/blender/build_geonode_props.py`](../tools/blender/build_geonode_props.py)
  (in-repo, reproducible).
- **Asset library:** `<content-root>/tracks-src/geonode-toolkit/geonode_toolkit.blend`
  (Drive, out of git). The six groups are asset-marked under the
  **Hoverbike ▸ GeoNode Toolkit** catalog, so they show in the Asset Browser of
  any level `.blend` that scans the content root.

## The seven tools

| Group | Type | Apply to | What it makes |
|-------|------|----------|---------------|
| `HV_SeaStack` | generator | single-vertex / empty mesh | **Cluster of faceted crystal spires** fused into one golden rock mass. A tapered, blunt-tipped **cube** column gets a **voronoi position-offset** (angular flat planes), is **instanced** over a tight scatter cluster (centre spire tallest, edge spires shorter, leaned outward), then **voxel-remeshed** (Mesh to Volume → Volume to Mesh) into one watertight stack. Knobs: `Spires`, `Cluster Radius`, `Col Radius`, `Taper`/`Tip`, `Warp`/`Facet`/`Voronoi Scale`, `Height Var`, `Lean`, `Voxel Size`. |
| `HV_Dock` | curve-driven | a path **curve** | **Irregular planks** (jittered length/yaw/tilt/height) decking + **weathered pylons** in two edge rows dropping below the deck. |
| `HV_Palm` | generator | single-vertex / empty mesh | **"Drunken" palm** — leaning/wobbling trunk, a fountain of pinnate **green fronds** up top and **brown dead fronds** drooping into a skirt. |
| `HV_Ramp` | curve-driven | a path **curve** | Corrugated **sheet-metal panels** shingled along the curve, following its slope, with Pitch/Bank/Rise control — ramps over a curvy sandbar. |
| `HV_SeaArch` | generator | single-vertex / empty mesh | Parametric eroded **rock sea-arch**; Span/Height/Thickness/Leg-Spread/Lean/Seed give endless variants. Optional **boulder-cluster** pass (toggle, default off) re-skins it as scattered `HV_Rock` chunks fused into one mesh. |
| `HV_Rock` | generator | single-vertex / empty mesh | Boolean-carved faceted **boulder** — a lumpy ico-sphere whittled by a swarm of randomly-tilted cutting planes into crystal-like facets. Knobs incl. `Cut Spacing` (facet count), `Cut Depth`, `Depth Jitter`, `Tilt`. |
| `HV_Cloud` | generator | single-vertex / empty mesh | **Stylized cumulus cloud.** A flattened, lumpy ellipsoid dome is scattered on its **upper** surface with deformed icosphere "puffs" (centre/crown puffs biggest via `Top Bias`), fused by a **voxel remesh** (Mesh to Volume → Volume to Mesh) into one soft watertight blob, billow-noised for cauliflower waviness, then **flat-base-compressed** to a flattened-but-lumpy cumulus base (the underside players see from below — *not* a razor-flat disc), lifted to ~z=0. Smooth-shaded. Knobs: `Size`, `Height`, `Puffs`, `Puff Size`/`Puff Var`, `Top Bias`, `Billow`/`Billow Scale`, `Lumpiness`, `Flat Base`, `Voxel Size`, `Seed`. |

### Rock faceting — three recipes
**Sea stacks** (`HV_SeaStack`) follow the **procedural-crystal flow**: a tapered
cube column is voronoi position-offset into angular flat planes, instanced over a
tight scatter cluster, then **voxel-remeshed** (Mesh to Volume → Volume to Mesh)
into one watertight spire cluster. Voxel Size is the cost throttle and is floored
against Height so a tall stack can't ask for a pathological voxel grid.

**Arches** (`HV_SeaArch`) displace a swept mesh per **voronoi cell** (each cell
pushes out as a unit) to build chunky stepped facets.

**Boulders** (`HV_Rock`) take the crystal-generator route instead (after Entagma's
procedural-crystal tree, minus its internal planes + glass shading): a lumpy
ico-sphere is whittled by a swarm of big, randomly-tilted cutter planes — **one
exact Mesh Boolean per cut, looped in a Repeat Zone**, because booleans are
unreliable when many cutters intersect at once. A sphere base (not a box) is
deliberate: it has no corners for the cuts to pile up on, so the stone facets
without eroding to a sliver. The cut depth is jittered *outward only* for the same
reason — irregular, rocky planes that can never collapse the rock. (An edge-chip
boolean stage existed but was cut — the chips read too small; see git history.)

Each tool finishes with its own modifier stack. The build script adds these to the
demo objects automatically (the Smooth by Angle ones via the `_smooth_by_angle()`
helper, which links Blender's bundled essentials group); replicate the matching
stack when you place one yourself.

- **Boulders** (`HV_Rock`): a **Planar Decimate** (`Dissolve`, ~6°) collapses each
  facet's interior into a flat n-gon — the crisp planar read (keep flat shading).
- **Sea stacks** (`HV_SeaStack`): *no* planar dissolve — the dense voxel-remesh
  shell gets **two Collapse Decimates** (~0.25 then ~0.5) to thin it to a light
  low-poly mesh, then **Smooth by Angle** (20°) softens the broad faces while the
  spire ridges stay sharp.
- **Arches** (`HV_SeaArch`): a **Planar Dissolve** (~11°) first crisps the voronoi
  facets, *then* **two Collapse Decimates** (0.5 then 0.3333) and **Smooth by
  Angle** (30°) — the same family as the stacks, but keeping the dissolve.
- **Clouds** (`HV_Cloud`): *no* dissolve — a single **Collapse Decimate** (~0.1,
  aggressive) thins the smooth voxel shell to a very light ~0.8 k-tri cloud, then
  **Smooth by Angle** (60°) keeps the whole soft form smooth (clouds read soft,
  never faceted — the even remesh + smooth normals hide the low count).

### Boulder-cluster sea arches
`HV_SeaArch` carries a **`Boulder Cluster`** toggle (default **off** — the smooth
voronoi arch reads cleaner; flip it on to opt in): instead of shipping the smooth
voronoi arch, the tool scatters carved `HV_Rock` boulders over the arch mesh and
**boolean-UNIONs** them (boulders + base) into one watertight, faceted rock mass —
no interpenetrating instances. The boulder source is the
`HV_Rock` group itself (so the chunks match the standalone rock tool); `Boulder
Size` and `Boulder Density` tune chunk scale and count (spacing = Size / Density).
Cost is one rock carve + one exact union, so keep the density modest on big spans.
Because the union references `HV_Rock`, `build_all` builds the rock group **first**
(and `_rock_cluster` builds it on demand if you regenerate the arch alone). The
shared helper is `_rock_cluster()`. (The sea **stack** used to carry this toggle
too; it now uses the procedural-crystal flow above instead.)

### Cloud — voxel-puff cumulus
`HV_Cloud` is the Houdini cumulus recipe (fill a base shape with spheres → VDB
from particles → billow noise → mesh → decimate) on Blender nodes, reusing the
sea-stack's **Mesh to Volume → Volume to Mesh** fuse: a flattened, lumpy ellipsoid
dome is scattered on its **upper** surface with deformed icosphere puffs (`Top
Bias` makes the crown puffs biggest), the whole mass is voxel-remeshed into one
soft watertight blob, and a **flat-base pass compresses** (not collapses) the
rounded underbelly into a flattened-but-lumpy cumulus base — the underside is the
view players get from below, so it keeps its lumps and the even remesh topology
rather than the razor-flat triangle-fan disc a hard clamp gives — lifted to ~z=0.
Smooth-shaded —
clouds read soft, not faceted. `Size` is the footprint width, `Height` the rise;
the demos are humilis (flat), mediocris (default) and a towering congestus.

Two non-obvious choices, both learned the hard way:
- **Billow before the remesh, not after.** Offsetting the fused-but-creased
  surface along its own normals *after* Volume to Mesh tore tall, top-heavy clouds
  into disconnected shards at the crown. Doing the billow Set Position on the
  *pre-remesh* joined mesh lets the voxel remesh re-weld it into a clean manifold —
  shards become impossible; sub-voxel crust is washed out (which a soft cloud wants
  anyway).
- **Voxel floored against Height as well as Size.** A fixed voxel size gives a
  *tall* cloud far more voxels than a flat one, so the towering variant exploded in
  polys and the collapse decimate faceted the over-dense shell. Flooring on
  `max(Size·0.012, Height·0.038)` auto-coarsens tall clouds, keeping the remesh
  evenly smooth and the budget bounded — with the ~0.1 Collapse Decimate the three
  demos land at ~0.8 k tris each, and stay smooth because the remesh is even.

In-game a placed cloud rides the shared prop **painterly-vinyl** material (soft rim
+ matte) for free, and its world-space waterline never triggers up in the sky, so
it stays clean. This is a *mesh* cloud prop (placeable, fly-past massing),
complementary to the engine's existing sky shading (`clouds.ts`).

### Generators vs curve-driven
- **Generators** ignore input geometry — apply to any object (a single-vertex mesh
  is cleanest) and dial the knobs. `Seed` reshuffles the rock/foliage.
- **Curve-driven** (`HV_Dock`, `HV_Ramp`) read the object's curve as the path.
  Draw a curve, add the modifier. `HV_Ramp` sets the curve normal to Z-up so panels
  don't twist; it follows the curve's 3-D slope, and `Pitch`/`Bank`/`Rise` tilt the
  panels further.

## Conventions honoured
- Each group is `is_modifier` and writes **`COLOR_0`** (FLOAT_COLOR, POINT) so
  realised geometry satisfies the runtime vertex-attribute contract
  (`docs/vertex-attribute-spec.md`). `HV_Palm` writes an R = height-sway gradient so
  the foliage shader sways the crown.
- Materials follow `mat_<family>_<id>` (`mat_prop_sea_stack`, `mat_prop_dock_plank`,
  `mat_foliage_palm_frond`/`_dead`/`_trunk`, `mat_prop_ramp_metal`,
  `mat_prop_sea_arch`). Colours are placeholders — runtime shaders restyle.

## Gotcha: Curve to Mesh ignores curve radius in Blender 5.1

In Blender 5.1 the **Curve to Mesh** node no longer scales the swept profile by
the curve's `radius` attribute — it sizes the profile by the node's **`Scale`**
input (default `1.0`). A `Set Curve Radius` upstream is silently a no-op for the
mesh size. Every curve-swept tool here therefore feeds the radius into `Scale`
via an `Input Radius` node (`_radius_to_scale()` helper). If you add a new
`GeometryNodeCurveToMesh` that should respect an authored radius, wire
`Input Radius → Curve to Mesh ▸ Scale` or your profile will be stuck at unit
size. (This bug was making every spire/arch/trunk/frond the wrong thickness.)

**Related:** Blender 5.1's **Curve to Points** `Rotation` output orients the
instance's **+Z along the tangent** (not +X). Instancing a flat panel with it
stands the panel on edge. `HV_Ramp` therefore builds orientation explicitly —
`Align Euler to Vector` (X→tangent, follows slope) then a second align rolling
+Z to world-up — so panels lie flat by default. `Pitch`/`Bank` are offsets from
that flat resting pose; no per-point curve tilt needed.

## Regenerate / iterate
```python
import importlib.util, sys
p = r"tools/blender/build_geonode_props.py"  # absolute path
spec = importlib.util.spec_from_file_location("bgp", p)
mod = importlib.util.module_from_spec(spec); sys.modules["bgp"] = mod
spec.loader.exec_module(mod)
mod.build_all()                 # all six + demo objects in a "GeoNode Toolkit" collection
mod.build_all(which=["palm"])   # just one tool
```
Editing the build script and re-running is idempotent (groups/demo objects are
purged and rebuilt by name).

## Not yet wired
These are **authoring tools**, not finished prop GLBs. For a standalone prop export
they'd still need a `prop_<id>_root` empty + primitive collider per the prop-export
contract (`tools/blender/build_prop.py`); placed inside a track, the track export
handles realisation + `kind` tagging. Per-tool asset previews and a settings-menu
toggle are follow-ups.
