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

## The six tools

| Group | Type | Apply to | What it makes |
|-------|------|----------|---------------|
| `HV_SeaStack` | generator | single-vertex / empty mesh | Chunky golden faceted rock **stack** — flared base, irregular lumpy silhouette, strata ledges, voronoi facets, blunted tip. Knobs incl. `Taper`, `Tip` (tip bluntness), `Lumpiness`, `Facets`. Optional **boulder-cluster** pass (toggle, default on) re-skins the spire as scattered `HV_Rock` chunks fused into one mesh. |
| `HV_Dock` | curve-driven | a path **curve** | **Irregular planks** (jittered length/yaw/tilt/height) decking + **weathered pylons** in two edge rows dropping below the deck. |
| `HV_Palm` | generator | single-vertex / empty mesh | **"Drunken" palm** — leaning/wobbling trunk, a fountain of pinnate **green fronds** up top and **brown dead fronds** drooping into a skirt. |
| `HV_Ramp` | curve-driven | a path **curve** | Corrugated **sheet-metal panels** shingled along the curve, following its slope, with Pitch/Bank/Rise control — ramps over a curvy sandbar. |
| `HV_SeaArch` | generator | single-vertex / empty mesh | Parametric eroded **rock sea-arch**; Span/Height/Thickness/Leg-Spread/Lean/Seed give endless variants. Same optional **boulder-cluster** pass as the stack (toggle, default on). |
| `HV_Rock` | generator | single-vertex / empty mesh | Boolean-carved faceted **boulder** — a lumpy ico-sphere whittled by a swarm of randomly-tilted cutting planes into crystal-like facets. Knobs incl. `Cut Spacing` (facet count), `Cut Depth`, `Depth Jitter`, `Tilt`. |

### Rock faceting — two recipes
**Stacks & arches** displace per **voronoi cell** (each cell pushes out as a unit)
to build chunky stepped facets.

**Boulders** (`HV_Rock`) take the crystal-generator route instead (after Entagma's
procedural-crystal tree, minus its internal planes + glass shading): a lumpy
ico-sphere is whittled by a swarm of big, randomly-tilted cutter planes — **one
exact Mesh Boolean per cut, looped in a Repeat Zone**, because booleans are
unreliable when many cutters intersect at once. A sphere base (not a box) is
deliberate: it has no corners for the cuts to pile up on, so the stone facets
without eroding to a sliver. The cut depth is jittered *outward only* for the same
reason — irregular, rocky planes that can never collapse the rock. (An edge-chip
boolean stage existed but was cut — the chips read too small; see git history.)

All three (stacks, arches, boulders) finish with a **Planar Decimate** modifier
(`Dissolve`, ~6–12° angle limit) that collapses each facet's interior into a flat
n-gon — the crisp planar read. The build script adds that decimate automatically
to the demo objects; when you place one yourself, add a Planar Decimate after the
Geometry Nodes modifier (and keep flat shading).

### Boulder-cluster sea stacks & arches
`HV_SeaStack` and `HV_SeaArch` carry a **`Boulder Cluster`** toggle (default **on**):
instead of shipping the smooth voronoi spire/arch, the tool scatters carved
`HV_Rock` boulders over that base mesh and **boolean-UNIONs** them (boulders + base)
into one watertight, faceted rock mass — no interpenetrating instances. The boulder
source is the `HV_Rock` group itself (so the chunks match the standalone rock tool);
`Boulder Size` and `Boulder Density` tune chunk scale and count (spacing =
Size / Density). Cost is one rock carve + one exact union per object, so keep the
density modest on big spans. Because the union references `HV_Rock`, `build_all`
builds the rock group **first** (and `_rock_cluster` builds it on demand if you
regenerate a stack/arch alone). The shared helper is `_rock_cluster()`.

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
