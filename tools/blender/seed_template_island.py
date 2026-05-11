"""Seed ``tracks-src/template-island.blend`` — procedural volcanic-island terrain.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_island.py

This is a **one-shot scaffolder**, analogous to ``seed_bike_kit.py`` and
``seed_prop_kit.py``. It builds the .blend from scratch — re-running
nukes-and-paves. After the seed, the .blend is the source of truth;
all iteration happens in Blender via the Geometry Nodes modifier panel
and viewport empties.

### What the seed produces

A single 1024×1024 m tile of subdivided plane (~150 k verts at 384²)
carrying a live ``HV_Island`` Geometry Nodes modifier. The modifier
samples up to 8 ``peak_NN`` empties in the scene and composes a
volcanic-island heightfield: cone-shaped peaks with optional crater
caves, smoothstep continental shelves descending to a deep-water
floor, reef pulses fringing each peak base, and multi-octave noise
modulated by altitude (rougher above water, gentler below).

### Authoring loop

1. Open ``tracks-src/template-island.blend``. Default scene has 4
   peaks (1 central with crater, 2 flanking medium, 1 submerged
   shoal) yielding a St. Lucia-style silhouette.
2. **Move peak empties** in the viewport to relocate islands. The
   terrain reshapes live.
3. **Tweak per-peak custom properties** (encoded in each empty's
   transform):
     - ``location.xy`` → peak center in world XY
     - ``location.z``  → peak height (m)
     - ``scale.x``     → base radius (m)
     - ``scale.z``     → crater flag (0=off, 1=on)
4. **Tweak global knobs** in the modifier panel (Properties >
   Modifier > HV_Island):
     - Shelf Depth / Shelf Radius — deep-water floor and how far
       offshore the shelf descends
     - Reef Inset / Reef Height / Reef Width — fringing reef ring
     - Roughness Above / Roughness Below — noise amplitude on land vs
       below water
     - Noise Scale / Noise Seed — feature size and variation
5. When the silhouette reads right, **Apply the modifier** (bakes to
   static mesh), edit the AI spline / gates / starts on top, and
   export via the Hoverbike addon's *Export Track to Game* button.

### Encoding choices

* ``peak_NN`` empties pack four parameters into their transform:
  ``location.xy`` (centre), ``location.z`` (height), ``scale.x``
  (base radius), ``scale.z`` (crater flag). Both author-friendly
  (drag the empty up = taller peak; widen X = broader base) and GN-
  friendly (Object Info gives location + scale directly).
* Up to **8 peak slots** by design — the GN graph unrolls 8 instances
  of the ``HV_PeakProfile`` sub-group and max-combines them. Unbound
  slots contribute a -10 000 sentinel that loses every max comparison,
  so empty slots are free.
* ``COLOR_0`` per-vertex attribute is stamped per the Item 6 spec
  (``docs/vertex-attribute-spec.md``):
     - R = 0 (sway — terrain doesn't sway)
     - G = 1 (AO multiplier placeholder — real AO bake is GUI work)
     - B = 0 (path-worn — filled later when the author paints the
              racing line)
     - A = biome index (0 deep / 0.33 shallow / 0.67 beach / 1.0 jungle)
"""

from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-island.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0  # metres; matches `test-custom-track.blend`'s Landscape extent
SUBDIV = 384        # → 385² verts ≈ 148k, ~2.7m cell spacing; tractable trimesh

# Starter peaks (St. Lucia-style: one big stratovolcano + two flanking + one
# submerged shoal). Each tuple is (name, (x, y, height_m), (base_radius_m,
# base_radius_m, crater_flag_0_or_1)). Editable directly in Blender post-seed.
PEAKS: list[tuple[str, tuple[float, float, float], tuple[float, float, float]]] = [
    ("peak_00", (   0.0,    0.0, 140.0), (240.0, 240.0, 1.0)),
    ("peak_01", (-380.0,  200.0,  90.0), (180.0, 180.0, 0.0)),
    ("peak_02", ( 320.0,  280.0,  60.0), (140.0, 140.0, 0.0)),
    ("peak_03", (-100.0, -360.0,  -1.0), ( 80.0,  80.0, 0.0)),
]

# AI racing line — weaves over water between islands, sea-level (z=5m).
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -300.0, 5.0),
    (-200.0, -200.0, 5.0),
    (-300.0,    0.0, 5.0),
    (-200.0,  250.0, 5.0),
    (   0.0,  350.0, 5.0),
    ( 200.0,  300.0, 5.0),
    ( 300.0,  100.0, 5.0),
    ( 200.0, -150.0, 5.0),
]

STARTS: list[tuple[tuple[float, float, float], float]] = [
    ((-30.0, -330.0, 5.0), 0.0),
    (( 30.0, -330.0, 5.0), 0.0),
]

CHECKPOINTS: list[tuple[float, float, float]] = [
    (-200.0, -150.0, 5.0),
    (-280.0,  100.0, 5.0),
    (  50.0,  350.0, 5.0),
    ( 250.0,   50.0, 5.0),
]

CHECKPOINT_HALF_WIDTH = 14.0
CHECKPOINT_HEIGHT = 6.0

NODE_GROUP_NAME = "HV_TemplateIsland"
PEAK_SUBGROUP_NAME = "HV_PeakProfile"


# ────────────────────────────────────────────────────────────────────
# Scene reset
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Terrain mesh (subdivided plane)
# ────────────────────────────────────────────────────────────────────

def build_terrain_mesh() -> bpy.types.Object:
    mesh = bpy.data.meshes.new("terrain_mesh")
    bm = bmesh.new()
    half = TILE_SIZE * 0.5
    v00 = bm.verts.new((-half, -half, 0))
    v10 = bm.verts.new(( half, -half, 0))
    v11 = bm.verts.new(( half,  half, 0))
    v01 = bm.verts.new((-half,  half, 0))
    bm.faces.new([v00, v10, v11, v01])
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=SUBDIV - 1, use_grid_fill=True)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    # Smooth shading so the GN-modified terrain reads cleanly.
    for poly in mesh.polygons:
        poly.use_smooth = True

    terrain = bpy.data.objects.new("terrain", mesh)
    bpy.context.scene.collection.objects.link(terrain)
    terrain["kind"] = "track"  # export_track.py reads this for trimesh collider
    return terrain


# ────────────────────────────────────────────────────────────────────
# HV_PeakProfile — sub-node-group, per-peak height contribution
# ────────────────────────────────────────────────────────────────────

def _new_socket(group, name, in_out, stype, default=None, mn=None, mx=None):
    s = group.interface.new_socket(name, in_out=in_out, socket_type=stype)
    if default is not None: s.default_value = default
    if mn is not None: s.min_value = mn
    if mx is not None: s.max_value = mx
    return s


def _add_node(group, kind, x, y, **kw):
    n = group.nodes.new(kind)
    n.location = (x, y)
    for k, v in kw.items():
        setattr(n, k, v)
    return n


def build_peak_profile_group() -> bpy.types.NodeTree:
    """One peak's contribution to the height field. Cone + crater + shelf +
    reef, gated by an active-mask so unbound slots contribute a sentinel
    that always loses the parent's max-combine."""
    if PEAK_SUBGROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[PEAK_SUBGROUP_NAME])
    g = bpy.data.node_groups.new(PEAK_SUBGROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Position",     "INPUT",  "NodeSocketVector")
    _new_socket(g, "Peak",         "INPUT",  "NodeSocketObject")
    _new_socket(g, "Shelf Depth",  "INPUT",  "NodeSocketFloat", -25.0)
    _new_socket(g, "Shelf Radius", "INPUT",  "NodeSocketFloat", 200.0)
    _new_socket(g, "Reef Inset",   "INPUT",  "NodeSocketFloat",  20.0)
    _new_socket(g, "Reef Height",  "INPUT",  "NodeSocketFloat",  12.0)
    _new_socket(g, "Reef Width",   "INPUT",  "NodeSocketFloat",  25.0)
    _new_socket(g, "Sentinel",     "INPUT",  "NodeSocketFloat", -10000.0)
    _new_socket(g, "Height",       "OUTPUT", "NodeSocketFloat")

    n_in  = _add_node(g, "NodeGroupInput",  -1600, 0)
    n_out = _add_node(g, "NodeGroupOutput",  1400, 0)

    # Current vertex xy from Position input.
    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -1400, -200)
    g.links.new(n_in.outputs["Position"], n_pos_xyz.inputs["Vector"])

    # Peak transform → location.xy + height (in z), base_radius (in scale.x), crater (in scale.z).
    n_obj = _add_node(g, "GeometryNodeObjectInfo", -1400, -500, transform_space="RELATIVE")
    g.links.new(n_in.outputs["Peak"], n_obj.inputs["Object"])
    n_peak_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -500)
    g.links.new(n_obj.outputs["Location"], n_peak_loc.inputs["Vector"])
    n_peak_scl = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -700)
    g.links.new(n_obj.outputs["Scale"], n_peak_scl.inputs["Vector"])

    # dist = hypot(pos.xy - peak.xy)
    n_dx = _add_node(g, "ShaderNodeMath", -1000, -300, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"], n_dx.inputs[0])
    g.links.new(n_peak_loc.outputs["X"], n_dx.inputs[1])
    n_dy = _add_node(g, "ShaderNodeMath", -1000, -450, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"], n_dy.inputs[0])
    g.links.new(n_peak_loc.outputs["Y"], n_dy.inputs[1])
    n_dx2 = _add_node(g, "ShaderNodeMath", -800, -300, operation="POWER"); n_dx2.inputs[1].default_value = 2.0
    g.links.new(n_dx.outputs[0], n_dx2.inputs[0])
    n_dy2 = _add_node(g, "ShaderNodeMath", -800, -450, operation="POWER"); n_dy2.inputs[1].default_value = 2.0
    g.links.new(n_dy.outputs[0], n_dy2.inputs[0])
    n_sumsq = _add_node(g, "ShaderNodeMath", -600, -375, operation="ADD")
    g.links.new(n_dx2.outputs[0], n_sumsq.inputs[0])
    g.links.new(n_dy2.outputs[0], n_sumsq.inputs[1])
    n_dist = _add_node(g, "ShaderNodeMath", -400, -375, operation="SQRT")
    g.links.new(n_sumsq.outputs[0], n_dist.inputs[0])

    n_zero = _add_node(g, "ShaderNodeValue", -1000, -900); n_zero.outputs[0].default_value = 0.0

    # CONE: peak.height * smoothstep(peak_radius -> 0, dist)
    n_mr_cone = _add_node(g, "ShaderNodeMapRange", -100, -200, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_dist.outputs[0],        n_mr_cone.inputs["Value"])
    g.links.new(n_peak_scl.outputs["X"],  n_mr_cone.inputs["From Min"])  # peak_radius
    g.links.new(n_zero.outputs[0],        n_mr_cone.inputs["From Max"])
    g.links.new(n_zero.outputs[0],        n_mr_cone.inputs["To Min"])
    g.links.new(n_peak_loc.outputs["Z"],  n_mr_cone.inputs["To Max"])   # peak_height

    # CRATER carve: subtract an inverted cone at the summit when scale.z>0.
    n_crater_r = _add_node(g, "ShaderNodeMath", -100, -1100, operation="MULTIPLY")
    n_crater_r.inputs[1].default_value = 0.15  # crater takes up 15% of peak radius
    g.links.new(n_peak_scl.outputs["X"], n_crater_r.inputs[0])
    n_cd1 = _add_node(g, "ShaderNodeMath", -100, -1300, operation="MULTIPLY")
    n_cd1.inputs[1].default_value = 0.3  # 30% of peak height dropped at summit
    g.links.new(n_peak_loc.outputs["Z"], n_cd1.inputs[0])
    n_crater_depth = _add_node(g, "ShaderNodeMath", 100, -1300, operation="MULTIPLY")
    g.links.new(n_cd1.outputs[0], n_crater_depth.inputs[0])
    g.links.new(n_peak_scl.outputs["Z"], n_crater_depth.inputs[1])  # crater flag (0/1)
    n_mr_crater = _add_node(g, "ShaderNodeMapRange", 300, -1200, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_dist.outputs[0],         n_mr_crater.inputs["Value"])
    g.links.new(n_zero.outputs[0],         n_mr_crater.inputs["From Min"])
    g.links.new(n_crater_r.outputs[0],     n_mr_crater.inputs["From Max"])
    g.links.new(n_crater_depth.outputs[0], n_mr_crater.inputs["To Min"])
    g.links.new(n_zero.outputs[0],         n_mr_crater.inputs["To Max"])
    n_cone_carved = _add_node(g, "ShaderNodeMath", 500, -200, operation="SUBTRACT")
    g.links.new(n_mr_cone.outputs["Result"],   n_cone_carved.inputs[0])
    g.links.new(n_mr_crater.outputs["Result"], n_cone_carved.inputs[1])

    # SHELF: smoothstep ramp from 0 at coast (dist=peak_radius) down to
    # Shelf Depth at dist=peak_radius+Shelf Radius; clamped beyond.
    n_shelf_outer = _add_node(g, "ShaderNodeMath", -200, -500, operation="ADD")
    g.links.new(n_peak_scl.outputs["X"],  n_shelf_outer.inputs[0])
    g.links.new(n_in.outputs["Shelf Radius"], n_shelf_outer.inputs[1])
    n_mr_shelf = _add_node(g, "ShaderNodeMapRange", 0, -500, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_dist.outputs[0],          n_mr_shelf.inputs["Value"])
    g.links.new(n_peak_scl.outputs["X"],    n_mr_shelf.inputs["From Min"])
    g.links.new(n_shelf_outer.outputs[0],   n_mr_shelf.inputs["From Max"])
    g.links.new(n_zero.outputs[0],          n_mr_shelf.inputs["To Min"])
    g.links.new(n_in.outputs["Shelf Depth"], n_mr_shelf.inputs["To Max"])

    # REEF: positive pulse centred at peak_radius + Reef Inset,
    # smoothstep falloff over Reef Width to either side.
    n_reef_center = _add_node(g, "ShaderNodeMath", -200, -800, operation="ADD")
    g.links.new(n_peak_scl.outputs["X"], n_reef_center.inputs[0])
    g.links.new(n_in.outputs["Reef Inset"], n_reef_center.inputs[1])
    n_reef_delta = _add_node(g, "ShaderNodeMath", 0, -800, operation="SUBTRACT")
    g.links.new(n_dist.outputs[0], n_reef_delta.inputs[0])
    g.links.new(n_reef_center.outputs[0], n_reef_delta.inputs[1])
    n_reef_abs = _add_node(g, "ShaderNodeMath", 200, -800, operation="ABSOLUTE")
    g.links.new(n_reef_delta.outputs[0], n_reef_abs.inputs[0])
    n_mr_reef = _add_node(g, "ShaderNodeMapRange", 400, -800, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_reef_abs.outputs[0],        n_mr_reef.inputs["Value"])
    g.links.new(n_zero.outputs[0],            n_mr_reef.inputs["From Min"])
    g.links.new(n_in.outputs["Reef Width"],   n_mr_reef.inputs["From Max"])
    g.links.new(n_in.outputs["Reef Height"],  n_mr_reef.inputs["To Min"])
    g.links.new(n_zero.outputs[0],            n_mr_reef.inputs["To Max"])

    # profile = cone_carved + shelf + reef
    n_h1 = _add_node(g, "ShaderNodeMath", 700, -400, operation="ADD")
    g.links.new(n_cone_carved.outputs[0],     n_h1.inputs[0])
    g.links.new(n_mr_shelf.outputs["Result"], n_h1.inputs[1])
    n_profile = _add_node(g, "ShaderNodeMath", 900, -500, operation="ADD")
    g.links.new(n_h1.outputs[0], n_profile.inputs[0])
    g.links.new(n_mr_reef.outputs["Result"], n_profile.inputs[1])

    # ACTIVE mask: peak.base_radius > 0.01 means this slot is bound.
    n_mask = _add_node(g, "ShaderNodeMath", 700, -700, operation="GREATER_THAN")
    n_mask.inputs[1].default_value = 0.01
    g.links.new(n_peak_scl.outputs["X"], n_mask.inputs[0])

    # height = mix(sentinel, profile, mask)
    n_mix = _add_node(g, "ShaderNodeMix", 1100, -400)
    n_mix.data_type = "FLOAT"
    n_mix.clamp_factor = False
    g.links.new(n_mask.outputs[0],     n_mix.inputs[0])      # Factor (Float)
    g.links.new(n_in.outputs["Sentinel"], n_mix.inputs["A"])
    g.links.new(n_profile.outputs[0],  n_mix.inputs["B"])
    g.links.new(n_mix.outputs[0], n_out.inputs["Height"])

    return g


# ────────────────────────────────────────────────────────────────────
# HV_TemplateIsland — parent group, 8-peak unroll + roughness + biome
# ────────────────────────────────────────────────────────────────────

def build_template_island_group(sub: bpy.types.NodeTree) -> bpy.types.NodeTree:
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Geometry", "INPUT", "NodeSocketGeometry")
    for i in range(8):
        _new_socket(g, f"Peak {i}", "INPUT", "NodeSocketObject")
    _new_socket(g, "Shelf Depth",     "INPUT", "NodeSocketFloat", -25.0, -200.0, 0.0)
    _new_socket(g, "Shelf Radius",    "INPUT", "NodeSocketFloat", 200.0, 0.0, 1000.0)
    _new_socket(g, "Reef Inset",      "INPUT", "NodeSocketFloat",  20.0, 0.0, 200.0)
    _new_socket(g, "Reef Height",     "INPUT", "NodeSocketFloat",  12.0, 0.0, 50.0)
    _new_socket(g, "Reef Width",      "INPUT", "NodeSocketFloat",  25.0, 1.0, 200.0)
    _new_socket(g, "Roughness Above", "INPUT", "NodeSocketFloat",   6.0, 0.0, 50.0)
    _new_socket(g, "Roughness Below", "INPUT", "NodeSocketFloat",   1.5, 0.0, 20.0)
    _new_socket(g, "Noise Scale",     "INPUT", "NodeSocketFloat",   0.01, 0.0001, 1.0)
    _new_socket(g, "Noise Seed",      "INPUT", "NodeSocketFloat",   0.0, 0.0, 1000.0)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",  -1600, 0)
    p_out = _add_node(g, "NodeGroupOutput",  2800, 0)
    p_pos = _add_node(g, "GeometryNodeInputPosition", -1400, -200)

    n_sentinel = _add_node(g, "ShaderNodeValue", -1400, -400)
    n_sentinel.outputs[0].default_value = -10000.0

    # Instantiate the sub-group 8 times and max-cascade their outputs.
    prev = None
    for i in range(8):
        inst = _add_node(g, "GeometryNodeGroup", -800, -100 - i * 200)
        inst.node_tree = sub
        g.links.new(p_pos.outputs["Position"],          inst.inputs["Position"])
        g.links.new(p_in.outputs[f"Peak {i}"],          inst.inputs["Peak"])
        g.links.new(p_in.outputs["Shelf Depth"],        inst.inputs["Shelf Depth"])
        g.links.new(p_in.outputs["Shelf Radius"],       inst.inputs["Shelf Radius"])
        g.links.new(p_in.outputs["Reef Inset"],         inst.inputs["Reef Inset"])
        g.links.new(p_in.outputs["Reef Height"],        inst.inputs["Reef Height"])
        g.links.new(p_in.outputs["Reef Width"],         inst.inputs["Reef Width"])
        g.links.new(n_sentinel.outputs[0],              inst.inputs["Sentinel"])
        if prev is None:
            prev = inst.outputs["Height"]
        else:
            n_max = _add_node(g, "ShaderNodeMath", -400, -100 - i * 200, operation="MAXIMUM")
            g.links.new(prev, n_max.inputs[0])
            g.links.new(inst.outputs["Height"], n_max.inputs[1])
            prev = n_max.outputs[0]

    # Roughness — single multi-octave noise field, altitude-modulated amplitude.
    n_noise = _add_node(g, "ShaderNodeTexNoise", -400, -1900)
    n_noise.noise_dimensions = "4D"
    n_noise.normalize = True
    n_noise.inputs["Detail"].default_value = 4.0
    n_noise.inputs["Roughness"].default_value = 0.55
    n_noise.inputs["Distortion"].default_value = 0.0
    g.links.new(p_pos.outputs["Position"],   n_noise.inputs["Vector"])
    g.links.new(p_in.outputs["Noise Scale"], n_noise.inputs["Scale"])
    g.links.new(p_in.outputs["Noise Seed"],  n_noise.inputs["W"])

    n_signed = _add_node(g, "ShaderNodeMath", -200, -1900, operation="MULTIPLY_ADD")
    n_signed.inputs[1].default_value = 2.0
    n_signed.inputs[2].default_value = -1.0
    g.links.new(n_noise.outputs["Fac"], n_signed.inputs[0])

    n_amp = _add_node(g, "ShaderNodeMapRange", 0, -1900, interpolation_type="SMOOTHSTEP", clamp=True)
    n_amp.inputs["From Min"].default_value = -1.0
    n_amp.inputs["From Max"].default_value = 2.0
    g.links.new(prev, n_amp.inputs["Value"])
    g.links.new(p_in.outputs["Roughness Below"], n_amp.inputs["To Min"])
    g.links.new(p_in.outputs["Roughness Above"], n_amp.inputs["To Max"])

    n_perturb = _add_node(g, "ShaderNodeMath", 200, -1900, operation="MULTIPLY")
    g.links.new(n_signed.outputs[0], n_perturb.inputs[0])
    g.links.new(n_amp.outputs["Result"], n_perturb.inputs[1])

    # final_height = max_profile + perturb
    n_final_h = _add_node(g, "ShaderNodeMath", 600, -800, operation="ADD")
    g.links.new(prev, n_final_h.inputs[0])
    g.links.new(n_perturb.outputs[0], n_final_h.inputs[1])

    # Set Position: offset Z by final_height.
    n_combine = _add_node(g, "ShaderNodeCombineXYZ", 1100, -300)
    g.links.new(n_final_h.outputs[0], n_combine.inputs["Z"])
    n_setpos = _add_node(g, "GeometryNodeSetPosition", 1400, 0)
    g.links.new(p_in.outputs["Geometry"], n_setpos.inputs["Geometry"])
    g.links.new(n_combine.outputs["Vector"], n_setpos.inputs["Offset"])

    # ── Biome stamp into COLOR_0 ───────────────────────────────────
    # Read Position AGAIN after SetPosition — gets the modified Z.
    n_pos2 = _add_node(g, "GeometryNodeInputPosition", 1600, -300)
    n_pos2_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 1800, -300)
    g.links.new(n_pos2.outputs["Position"], n_pos2_xyz.inputs["Vector"])

    def _step(z_socket, threshold, x, y):
        n = _add_node(g, "ShaderNodeMath", x, y, operation="GREATER_THAN")
        n.inputs[1].default_value = threshold
        g.links.new(z_socket, n.inputs[0])
        return n

    n_b1 = _step(n_pos2_xyz.outputs["Z"], -3.0, 2000, -100)
    n_b2 = _step(n_pos2_xyz.outputs["Z"],  0.0, 2000, -250)
    n_b3 = _step(n_pos2_xyz.outputs["Z"],  4.0, 2000, -400)
    n_bsum1 = _add_node(g, "ShaderNodeMath", 2200, -175, operation="ADD")
    g.links.new(n_b1.outputs[0], n_bsum1.inputs[0])
    g.links.new(n_b2.outputs[0], n_bsum1.inputs[1])
    n_bsum2 = _add_node(g, "ShaderNodeMath", 2200, -325, operation="ADD")
    g.links.new(n_bsum1.outputs[0], n_bsum2.inputs[0])
    g.links.new(n_b3.outputs[0], n_bsum2.inputs[1])
    n_biome = _add_node(g, "ShaderNodeMath", 2200, -475, operation="DIVIDE")
    n_biome.inputs[1].default_value = 3.0
    g.links.new(n_bsum2.outputs[0], n_biome.inputs[0])

    n_zero_p = _add_node(g, "ShaderNodeValue", 2200, -625); n_zero_p.outputs[0].default_value = 0.0
    n_one_p  = _add_node(g, "ShaderNodeValue", 2200, -775); n_one_p.outputs[0].default_value = 1.0
    n_color = _add_node(g, "FunctionNodeCombineColor", 2400, -300, mode="RGB")
    g.links.new(n_zero_p.outputs[0], n_color.inputs["Red"])    # sway
    g.links.new(n_one_p.outputs[0],  n_color.inputs["Green"])  # AO placeholder
    g.links.new(n_zero_p.outputs[0], n_color.inputs["Blue"])   # path-worn (filled later)
    g.links.new(n_biome.outputs[0],  n_color.inputs["Alpha"])  # biome 0..1

    n_store = _add_node(g, "GeometryNodeStoreNamedAttribute", 2600, 0,
                        data_type="FLOAT_COLOR", domain="POINT")
    n_store.inputs["Name"].default_value = "COLOR_0"
    g.links.new(n_setpos.outputs["Geometry"], n_store.inputs["Geometry"])
    g.links.new(n_color.outputs["Color"], n_store.inputs["Value"])
    g.links.new(n_store.outputs["Geometry"], p_out.inputs["Geometry"])

    return g


# ────────────────────────────────────────────────────────────────────
# Modifier wiring
# ────────────────────────────────────────────────────────────────────

def attach_modifier(terrain: bpy.types.Object, ng: bpy.types.NodeTree) -> bpy.types.Modifier:
    for m in list(terrain.modifiers):
        if m.type == "NODES":
            terrain.modifiers.remove(m)
    mod = terrain.modifiers.new("HV_Island", "NODES")
    mod.node_group = ng
    return mod


def bind_peak_inputs(mod: bpy.types.Modifier, ng: bpy.types.NodeTree) -> None:
    ids = {}
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) == "SOCKET" and getattr(item, "in_out", None) == "INPUT":
            ids[item.name] = item.identifier
    for i, (name, _, _) in enumerate(PEAKS):
        if name in bpy.data.objects:
            mod[ids[f"Peak {i}"]] = bpy.data.objects[name]


# ────────────────────────────────────────────────────────────────────
# Scene objects
# ────────────────────────────────────────────────────────────────────

def add_peaks() -> None:
    for name, loc, scl in PEAKS:
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 1.0
        obj.location = loc
        obj.scale = scl
        obj["kind"] = "peak"
        bpy.context.scene.collection.objects.link(obj)


def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, 0.0)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 1.0
    obj["wave_freq"] = 0.4
    bpy.context.scene.collection.objects.link(obj)


def add_ai_spline() -> None:
    curve = bpy.data.curves.new("ai_spline_main", type="CURVE")
    curve.dimensions = "3D"
    sp = curve.splines.new(type="NURBS")
    sp.points.add(len(AI_SPLINE_ANCHORS) - 1)
    for i, p in enumerate(AI_SPLINE_ANCHORS):
        sp.points[i].co = (p[0], p[1], p[2], 1.0)
    sp.use_endpoint_u = True
    sp.use_cyclic_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    bpy.context.scene.collection.objects.link(obj)


def add_player_starts() -> None:
    for i, (loc, yaw) in enumerate(STARTS):
        obj = bpy.data.objects.new(f"start_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.location = loc
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "start"
        obj["index"] = i
        bpy.context.scene.collection.objects.link(obj)


def add_checkpoints() -> None:
    for i, loc in enumerate(CHECKPOINTS):
        obj = bpy.data.objects.new(f"cp_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.location = loc
        obj["kind"] = "checkpoint"
        obj["index"] = i
        obj["half_width"] = CHECKPOINT_HALF_WIDTH
        obj["height"] = CHECKPOINT_HEIGHT
        bpy.context.scene.collection.objects.link(obj)


def add_sun() -> None:
    light_data = bpy.data.lights.new("sun", type="SUN")
    light_data.energy = 4.0
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.6, 0.3, 0.0)
    bpy.context.scene.collection.objects.link(obj)


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Vertex-color-driven biome ramp. Placeholder — author wires a real
    material in Blender later."""
    name = "mat_terrain_main"
    if name in bpy.data.materials:
        bpy.data.materials.remove(bpy.data.materials[name])
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    n_out = nt.nodes.new("ShaderNodeOutputMaterial"); n_out.location = (400, 0)
    n_bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled"); n_bsdf.location = (200, 0)
    n_attr = nt.nodes.new("ShaderNodeAttribute"); n_attr.location = (-400, 0)
    n_attr.attribute_name = "COLOR_0"
    n_ramp = nt.nodes.new("ShaderNodeValToRGB"); n_ramp.location = (-200, 0)
    nt.links.new(n_attr.outputs["Alpha"], n_ramp.inputs["Fac"])
    cr = n_ramp.color_ramp
    cr.interpolation = "LINEAR"
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[1])
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.05, 0.15, 0.35, 1.0)   # deep
    e1 = cr.elements.new(0.333); e1.color = (0.15, 0.55, 0.65, 1.0)  # shallow
    e2 = cr.elements.new(0.667); e2.color = (0.75, 0.70, 0.45, 1.0)  # beach
    e3 = cr.elements.new(1.0);   e3.color = (0.20, 0.45, 0.25, 1.0)  # jungle
    nt.links.new(n_ramp.outputs["Color"], n_bsdf.inputs["Base Color"])
    n_bsdf.inputs["Roughness"].default_value = 0.85
    n_bsdf.inputs["Metallic"].default_value = 0.0
    nt.links.new(n_bsdf.outputs["BSDF"], n_out.inputs["Surface"])
    if terrain.data.materials:
        terrain.data.materials[0] = mat
    else:
        terrain.data.materials.append(mat)


def organize_collections() -> None:
    scene = bpy.context.scene
    root = scene.collection

    def ensure(name):
        if name in bpy.data.collections:
            return bpy.data.collections[name]
        c = bpy.data.collections.new(name)
        root.children.link(c)
        return c

    col_terrain  = ensure("Terrain")
    col_peaks    = ensure("Peaks")
    col_water    = ensure("Water")
    col_spline   = ensure("Spline")
    col_gameplay = ensure("Gameplay")

    def move(obj, coll):
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        coll.objects.link(obj)

    for obj in list(scene.objects):
        if obj.name == "terrain":
            move(obj, col_terrain)
        elif obj.name.startswith("peak_"):
            move(obj, col_peaks)
        elif obj.name == "water_volume_main":
            move(obj, col_water)
        elif obj.name in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif obj.name.startswith(("start_", "cp_", "pickup_")):
            move(obj, col_gameplay)


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-island] writing {OUTPUT_PATH}")

    reset_scene()
    terrain = build_terrain_mesh()

    sub = build_peak_profile_group()
    ng = build_template_island_group(sub)

    mod = attach_modifier(terrain, ng)
    add_peaks()
    bind_peak_inputs(mod, ng)

    add_water_volume()
    add_ai_spline()
    add_player_starts()
    add_checkpoints()
    add_sun()
    build_terrain_material(terrain)
    organize_collections()

    # Force depsgraph evaluation so the modifier evaluates before save —
    # gives a cleaner viewport state when the file is reopened.
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-template-island] done")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"[seed-template-island] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
