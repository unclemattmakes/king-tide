"""Seed ``tracks-src/template-island.blend`` — procedural volcanic-island terrain.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_island.py

This is a **one-shot scaffolder**, analogous to ``seed_bike_kit.py``
and ``seed_prop_kit.py``. It builds the .blend from scratch —
re-running nukes-and-paves. After the seed, the .blend is the source
of truth; all iteration happens in Blender via the Geometry Nodes
modifier panel and viewport empties.

### What the seed produces

A 1024×1024 m subdivided plane (~150 k verts at 384²) carrying a live
``HV_Island`` Geometry Nodes modifier. The modifier samples up to 8
**peak pairs** — a `peak_NN_base` (footprint circle) and a
`peak_NN_top` (apex sphere) — and composes a volcanic-island
heightfield: shear-tilted cones for lopsided volcanoes, optional
summit craters, continental shelves descending to a deep-water floor,
cone-masked erosion noise, plus a global low-amplitude background
noise field modulated by altitude.

Reef rings (disabled by default — ``Reef Height = 0``) are still
available in the graph for authors who want a visible fringing reef.

### Per-peak controls

Each peak uses **two empties**:

| Empty | Visual | Encoded fields |
|---|---|---|
| ``peak_NN_base`` (CIRCLE) | the island footprint at sea level | ``location.xy``: peak centre. ``scale.x``: base radius (m). |
| ``peak_NN_top``  (SPHERE) | the apex / summit | ``location`` (read via Copy Location constraint on ``peak_NN_base``): apex XY-offset + Z height. ``scale.z``: crater flag (0/1). |

Dragging ``peak_NN_base`` moves the entire island (the constraint
drags ``peak_NN_top`` along). Dragging ``peak_NN_top`` changes the
apex offset and height — sliding it sideways makes a lopsided cone.
A separate position-and-radius control plus an apex-and-height control
matches the way real volcanic morphology decouples *footprint* from
*summit*.

### Global modifier knobs (Properties → Modifier → HV_Island)

| Knob | Default | Purpose |
|---|---|---|
| Shelf Depth | -25 m | Deep-water floor depth |
| Shelf Radius | 200 m | How far offshore the shelf descends from each peak's coastline |
| Reef Inset | 20 m | Distance from coast to centre of reef ring |
| Reef Height | 0 m | Reef pulse amplitude (default off) |
| Reef Width | 25 m | Reef pulse Gaussian σ |
| Cone Erosion | 12 m | Per-cone noise amplitude (slope gulleys / outcrops). Masked by cone height — zero off the cone. |
| Erosion Scale | 0.035 | Noise frequency for cone erosion (smaller = larger features) |
| Ring Break | 20 m | World-space noise added to each peak's radial distance, jittering the cone foot and shelf rim so they're not perfect circles. 0 = clean circle, 30+ = wildly irregular outline. |
| Ring Scale | 0.015 | Frequency of the ring-break noise (smaller = larger, smoother wiggles) |
| Roughness Above | 2 m | Global background noise amplitude above water |
| Roughness Below | 1 m | Global background noise amplitude below water |
| Noise Scale | 0.008 | Global noise frequency |
| Noise Seed | 0 | Re-roll value for noise variation |
| Seafloor Billow | 10 m | Low-frequency distorted noise amplitude, gated to underwater. Reads as ridged silt rather than a flat seafloor plateau. |
| Billow Scale | 0.004 | Seafloor billow frequency (smaller = larger dunes) |
| Land Billow | 6 m | Mirror pass above the waterline. Adds hills/gulleys to cone slopes + beach plateaus. |
| Land Scale | 0.012 | Land billow frequency (smaller = larger hills) |
| Shoreline Width | 1.5 m | Underwater dead-zone (m) where the seafloor billow fades out as it nears the waterline. Tight crisp shoreline = 0.5–1; wide sandy lagoon = 5+. (Land billow now always activates at z=0 so the cone slope's texture meets the beach without a ring.) |

### Authoring loop

1. Open ``tracks-src/template-island.blend``. Default scene has 4
   peaks (1 central with crater, 2 flanking medium, 1 submerged shoal).
2. Drag ``peak_NN_base`` empties to reposition islands.
3. Drag ``peak_NN_top`` empties to retune apex height / lopsided
   offset / crater toggle.
4. Tweak modifier-panel global knobs for shelf depth, erosion, etc.
5. When the silhouette reads right, **Apply the modifier** (Object →
   Convert → Mesh), edit the AI spline / gates / starts on top, then
   export via the Hoverbike addon's *Export Track to Game* button.

### COLOR_0 stamp (per the Item 6 vertex-attribute spec)

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | 1 — AO multiplier placeholder |
| B | 0 — path-worn mask (filled later when the racing line is painted) |
| A | Biome index: 0 deep (z < -22) / 0.33 sandy seafloor (-22 ≤ z < 0) / 0.67 beach (0 ≤ z < 4) / 1.0 jungle (z ≥ 4) |
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

# Add tools/blender to path so we can import the addon for its
# water-preview helper.
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-island.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 384

# Starter peaks. Each is (idx, base.location, base_radius, top_offset_xyz, crater_flag).
# top_offset is the apex position relative to the base centre — XY is the lopsided
# offset, Z is the peak height.
PEAKS: list[tuple[str, tuple[float, float, float], float, tuple[float, float, float], float]] = [
    ("00", (   0.0,    0.0, 0.0), 240.0, (-20.0,  15.0, 140.0), 1.0),  # central, lopsided NE, crater
    ("01", (-380.0,  200.0, 0.0), 180.0, ( 30.0, -10.0,  90.0), 0.0),  # SW medium, lopsided E
    ("02", ( 320.0,  280.0, 0.0), 140.0, (  0.0,   0.0,  60.0), 0.0),  # NE small, straight
    ("03", (-100.0, -360.0, 0.0),  80.0, (  0.0,   0.0,  -1.0), 0.0),  # SW shoal, submerged
]

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

# Player starts are placed by sampling ``ai_spline_main`` at parameter
# ``START_T`` ∈ [0, 1] of arc length. The starts spawn perpendicular to
# the spline tangent at that point (so the grid faces along the racing
# line). Default 0.0 = right at the first spline anchor.
START_T = 0.0
START_GRID_SPACING_M = 4.0  # lateral distance between start_00 and start_01
START_Z = 5.0                # altitude above water

CHECKPOINTS: list[tuple[float, float, float]] = [
    (-200.0, -150.0, 5.0),
    (-280.0,  100.0, 5.0),
    (  50.0,  350.0, 5.0),
    ( 250.0,   50.0, 5.0),
]

CHECKPOINT_HALF_WIDTH = 14.0
CHECKPOINT_HEIGHT = 6.0

WATER_PREVIEW_SIZE = 800.0       # m — wider than the 1024m tile so the rim is visible
WATER_PREVIEW_SUBDIVISIONS = 120

NODE_GROUP_NAME = "HV_TemplateIsland"
PEAK_SUBGROUP_NAME = "HV_PeakProfile"


# ────────────────────────────────────────────────────────────────────
# Scene reset
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Terrain mesh
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
    for poly in mesh.polygons:
        poly.use_smooth = True

    terrain = bpy.data.objects.new("terrain", mesh)
    bpy.context.scene.collection.objects.link(terrain)
    terrain["kind"] = "track"
    return terrain


# ────────────────────────────────────────────────────────────────────
# Node-group helpers
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


# ────────────────────────────────────────────────────────────────────
# HV_PeakProfile — per-peak height contribution
# ────────────────────────────────────────────────────────────────────

def build_peak_profile_group() -> bpy.types.NodeTree:
    """Per-peak height contribution. Reads a Base empty for the footprint
    (location.xy = centre, scale.x = base radius) and a Top empty for the
    apex (location.xyz = apex world position; scale.z = crater flag).

    The cone is built using a one-iteration shear that lets the apex
    sit anywhere within the base circle — producing lopsided volcanoes
    without solving the full tilted-cone quadratic.

    Sentinel value gates unbound slots: when base.scale.x ≤ 0.01 the
    output is the sentinel (large negative) which loses the parent's
    max-combine."""
    if PEAK_SUBGROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[PEAK_SUBGROUP_NAME])
    g = bpy.data.node_groups.new(PEAK_SUBGROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Position",      "INPUT",  "NodeSocketVector")
    _new_socket(g, "Base",          "INPUT",  "NodeSocketObject")
    _new_socket(g, "Top",           "INPUT",  "NodeSocketObject")
    _new_socket(g, "Shelf Depth",   "INPUT",  "NodeSocketFloat", -25.0)
    _new_socket(g, "Shelf Radius",  "INPUT",  "NodeSocketFloat", 200.0)
    _new_socket(g, "Reef Inset",    "INPUT",  "NodeSocketFloat",  20.0)
    _new_socket(g, "Reef Height",   "INPUT",  "NodeSocketFloat",   0.0)
    _new_socket(g, "Reef Width",    "INPUT",  "NodeSocketFloat",  25.0)
    _new_socket(g, "Cone Erosion",  "INPUT",  "NodeSocketFloat",  12.0)
    _new_socket(g, "Erosion Scale", "INPUT",  "NodeSocketFloat",   0.035)
    _new_socket(g, "Noise Seed",    "INPUT",  "NodeSocketFloat",   0.0)
    _new_socket(g, "Ring Break",    "INPUT",  "NodeSocketFloat",  20.0)
    _new_socket(g, "Ring Scale",    "INPUT",  "NodeSocketFloat",   0.015)
    _new_socket(g, "Sentinel",      "INPUT",  "NodeSocketFloat", -10000.0)
    _new_socket(g, "Height",        "OUTPUT", "NodeSocketFloat")

    gi = _add_node(g, "NodeGroupInput",  -2000, 0)
    go = _add_node(g, "NodeGroupOutput",  2000, 0)

    # Vertex xy from Position
    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -1800, -200)
    g.links.new(gi.outputs["Position"], n_pos_xyz.inputs["Vector"])

    # Base info: location.xy = centre, scale.x = base radius
    n_base = _add_node(g, "GeometryNodeObjectInfo", -1800, -500, transform_space="RELATIVE")
    g.links.new(gi.outputs["Base"], n_base.inputs["Object"])
    n_base_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1600, -500)
    g.links.new(n_base.outputs["Location"], n_base_loc.inputs["Vector"])
    n_base_scl = _add_node(g, "ShaderNodeSeparateXYZ", -1600, -700)
    g.links.new(n_base.outputs["Scale"], n_base_scl.inputs["Vector"])

    # Top info: world location (apex world pos); scale.z = crater flag.
    # Top is tied to Base via a Copy Location constraint with use_offset,
    # so its world location = base.location + top.local_offset. Subtracting
    # base.xy from top.xy recovers the apex offset.
    n_top = _add_node(g, "GeometryNodeObjectInfo", -1800, -900, transform_space="RELATIVE")
    g.links.new(gi.outputs["Top"], n_top.inputs["Object"])
    n_top_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1600, -900)
    g.links.new(n_top.outputs["Location"], n_top_loc.inputs["Vector"])
    n_top_scl = _add_node(g, "ShaderNodeSeparateXYZ", -1600, -1100)
    g.links.new(n_top.outputs["Scale"], n_top_scl.inputs["Vector"])

    n_apex_dx = _add_node(g, "ShaderNodeMath", -1400, -700, operation="SUBTRACT")
    g.links.new(n_top_loc.outputs["X"], n_apex_dx.inputs[0])
    g.links.new(n_base_loc.outputs["X"], n_apex_dx.inputs[1])
    n_apex_dy = _add_node(g, "ShaderNodeMath", -1400, -850, operation="SUBTRACT")
    g.links.new(n_top_loc.outputs["Y"], n_apex_dy.inputs[0])
    g.links.new(n_base_loc.outputs["Y"], n_apex_dy.inputs[1])

    # Vertex offset from base centre.
    n_dx = _add_node(g, "ShaderNodeMath", -1400, -300, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"], n_dx.inputs[0])
    g.links.new(n_base_loc.outputs["X"], n_dx.inputs[1])
    n_dy = _add_node(g, "ShaderNodeMath", -1400, -450, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"], n_dy.inputs[0])
    g.links.new(n_base_loc.outputs["Y"], n_dy.inputs[1])

    # d_naive_raw = hypot(dx, dy)
    n_dx2 = _add_node(g, "ShaderNodeMath", -1200, -300, operation="POWER"); n_dx2.inputs[1].default_value = 2.0
    g.links.new(n_dx.outputs[0], n_dx2.inputs[0])
    n_dy2 = _add_node(g, "ShaderNodeMath", -1200, -450, operation="POWER"); n_dy2.inputs[1].default_value = 2.0
    g.links.new(n_dy.outputs[0], n_dy2.inputs[0])
    n_d_sumsq = _add_node(g, "ShaderNodeMath", -1000, -375, operation="ADD")
    g.links.new(n_dx2.outputs[0], n_d_sumsq.inputs[0])
    g.links.new(n_dy2.outputs[0], n_d_sumsq.inputs[1])
    n_d_naive_raw = _add_node(g, "ShaderNodeMath", -800, -375, operation="SQRT")
    g.links.new(n_d_sumsq.outputs[0], n_d_naive_raw.inputs[0])

    # Ring-break perturbation: world-space noise pushes the cone foot
    # and shelf rim in/out by ``Ring Break`` metres, breaking up the
    # perfect concentric circles that the radial smoothsteps would
    # otherwise produce. The same noise is added to BOTH d_naive and
    # d_sheared so the cone foot and shelf rim wiggle together.
    n_ring_noise = _add_node(g, "ShaderNodeTexNoise", -1200, -50)
    n_ring_noise.noise_dimensions = "4D"
    n_ring_noise.normalize = False
    n_ring_noise.inputs["Detail"].default_value = 2.5
    n_ring_noise.inputs["Roughness"].default_value = 0.5
    n_ring_noise.inputs["Distortion"].default_value = 0.6
    g.links.new(gi.outputs["Position"],   n_ring_noise.inputs["Vector"])
    g.links.new(gi.outputs["Ring Scale"], n_ring_noise.inputs["Scale"])
    # De-correlate the ring-break seed from cone-erosion / global noise.
    n_ring_seed = _add_node(g, "ShaderNodeMath", -1400, -50, operation="ADD")
    n_ring_seed.inputs[1].default_value = 337.0
    g.links.new(gi.outputs["Noise Seed"], n_ring_seed.inputs[0])
    g.links.new(n_ring_seed.outputs[0], n_ring_noise.inputs["W"])
    # [0,1] → [-1, +1] signed perturbation. Then × Ring Break amplitude.
    n_ring_signed = _add_node(g, "ShaderNodeMath", -1000, -50, operation="MULTIPLY_ADD")
    n_ring_signed.inputs[1].default_value =  2.0
    n_ring_signed.inputs[2].default_value = -1.0
    g.links.new(n_ring_noise.outputs["Fac"], n_ring_signed.inputs[0])
    n_ring_perturb = _add_node(g, "ShaderNodeMath", -800, -50, operation="MULTIPLY")
    g.links.new(n_ring_signed.outputs[0], n_ring_perturb.inputs[0])
    g.links.new(gi.outputs["Ring Break"], n_ring_perturb.inputs[1])

    # d_naive = d_naive_raw + ring_perturb (clamped to non-negative so a
    # large negative perturbation can't flip the sign of the distance).
    n_d_naive_pre = _add_node(g, "ShaderNodeMath", -600, -375, operation="ADD")
    g.links.new(n_d_naive_raw.outputs[0], n_d_naive_pre.inputs[0])
    g.links.new(n_ring_perturb.outputs[0], n_d_naive_pre.inputs[1])
    n_d_naive = _add_node(g, "ShaderNodeMath", -500, -375, operation="MAXIMUM")
    n_d_naive.inputs[1].default_value = 0.0
    g.links.new(n_d_naive_pre.outputs[0], n_d_naive.inputs[0])

    n_zero = _add_node(g, "ShaderNodeValue", -1400, -1300); n_zero.outputs[0].default_value = 0.0
    n_one  = _add_node(g, "ShaderNodeValue", -1400, -1400); n_one.outputs[0].default_value = 1.0

    # t_naive = smoothstep(base_radius → 0, d_naive); 1 at centre, 0 at base perimeter.
    n_mr_t = _add_node(g, "ShaderNodeMapRange", -600, -375, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d_naive.outputs[0],   n_mr_t.inputs["Value"])
    g.links.new(n_base_scl.outputs["X"], n_mr_t.inputs["From Min"])
    g.links.new(n_zero.outputs[0],      n_mr_t.inputs["From Max"])
    g.links.new(n_zero.outputs[0],      n_mr_t.inputs["To Min"])
    g.links.new(n_one.outputs[0],       n_mr_t.inputs["To Max"])

    # One-iteration shear: shift the cone centre toward the apex offset by t_naive.
    n_shift_x = _add_node(g, "ShaderNodeMath", -400, -700, operation="MULTIPLY")
    g.links.new(n_apex_dx.outputs[0], n_shift_x.inputs[0])
    g.links.new(n_mr_t.outputs["Result"], n_shift_x.inputs[1])
    n_shift_y = _add_node(g, "ShaderNodeMath", -400, -850, operation="MULTIPLY")
    g.links.new(n_apex_dy.outputs[0], n_shift_y.inputs[0])
    g.links.new(n_mr_t.outputs["Result"], n_shift_y.inputs[1])
    n_sx = _add_node(g, "ShaderNodeMath", -200, -300, operation="SUBTRACT")
    g.links.new(n_dx.outputs[0], n_sx.inputs[0])
    g.links.new(n_shift_x.outputs[0], n_sx.inputs[1])
    n_sy = _add_node(g, "ShaderNodeMath", -200, -450, operation="SUBTRACT")
    g.links.new(n_dy.outputs[0], n_sy.inputs[0])
    g.links.new(n_shift_y.outputs[0], n_sy.inputs[1])
    n_sx2 = _add_node(g, "ShaderNodeMath", 0, -300, operation="POWER"); n_sx2.inputs[1].default_value = 2.0
    g.links.new(n_sx.outputs[0], n_sx2.inputs[0])
    n_sy2 = _add_node(g, "ShaderNodeMath", 0, -450, operation="POWER"); n_sy2.inputs[1].default_value = 2.0
    g.links.new(n_sy.outputs[0], n_sy2.inputs[0])
    n_s_sumsq = _add_node(g, "ShaderNodeMath", 200, -375, operation="ADD")
    g.links.new(n_sx2.outputs[0], n_s_sumsq.inputs[0])
    g.links.new(n_sy2.outputs[0], n_s_sumsq.inputs[1])
    n_d_sheared_raw = _add_node(g, "ShaderNodeMath", 400, -375, operation="SQRT")
    g.links.new(n_s_sumsq.outputs[0], n_d_sheared_raw.inputs[0])
    # Same ring-break perturbation as d_naive, so cone foot wiggles in
    # lockstep with the shelf rim.
    n_d_sheared_pre = _add_node(g, "ShaderNodeMath", 550, -375, operation="ADD")
    g.links.new(n_d_sheared_raw.outputs[0], n_d_sheared_pre.inputs[0])
    g.links.new(n_ring_perturb.outputs[0],  n_d_sheared_pre.inputs[1])
    n_d_sheared = _add_node(g, "ShaderNodeMath", 650, -375, operation="MAXIMUM")
    n_d_sheared.inputs[1].default_value = 0.0
    g.links.new(n_d_sheared_pre.outputs[0], n_d_sheared.inputs[0])

    # CONE: peak_height * smoothstep(base_radius → 0, d_sheared)
    n_mr_cone = _add_node(g, "ShaderNodeMapRange", 600, -200, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d_sheared.outputs[0], n_mr_cone.inputs["Value"])
    g.links.new(n_base_scl.outputs["X"], n_mr_cone.inputs["From Min"])
    g.links.new(n_zero.outputs[0],     n_mr_cone.inputs["From Max"])
    g.links.new(n_zero.outputs[0],     n_mr_cone.inputs["To Min"])
    g.links.new(n_top_loc.outputs["Z"], n_mr_cone.inputs["To Max"])

    # CRATER: carve summit when top.scale.z > 0.
    n_crater_r = _add_node(g, "ShaderNodeMath", 200, -1100, operation="MULTIPLY")
    n_crater_r.inputs[1].default_value = 0.15
    g.links.new(n_base_scl.outputs["X"], n_crater_r.inputs[0])
    n_cd1 = _add_node(g, "ShaderNodeMath", 200, -1300, operation="MULTIPLY"); n_cd1.inputs[1].default_value = 0.3
    g.links.new(n_top_loc.outputs["Z"], n_cd1.inputs[0])
    n_crater_depth = _add_node(g, "ShaderNodeMath", 400, -1300, operation="MULTIPLY")
    g.links.new(n_cd1.outputs[0], n_crater_depth.inputs[0])
    g.links.new(n_top_scl.outputs["Z"], n_crater_depth.inputs[1])
    n_mr_crater = _add_node(g, "ShaderNodeMapRange", 600, -1200, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d_sheared.outputs[0],    n_mr_crater.inputs["Value"])
    g.links.new(n_zero.outputs[0],         n_mr_crater.inputs["From Min"])
    g.links.new(n_crater_r.outputs[0],     n_mr_crater.inputs["From Max"])
    g.links.new(n_crater_depth.outputs[0], n_mr_crater.inputs["To Min"])
    g.links.new(n_zero.outputs[0],         n_mr_crater.inputs["To Max"])
    n_cone_carved = _add_node(g, "ShaderNodeMath", 800, -200, operation="SUBTRACT")
    g.links.new(n_mr_cone.outputs["Result"],   n_cone_carved.inputs[0])
    g.links.new(n_mr_crater.outputs["Result"], n_cone_carved.inputs[1])

    # CONE EROSION: noise field masked by cone contribution. Strong on slopes,
    # zero off the cone.
    n_erode_noise = _add_node(g, "ShaderNodeTexNoise", 200, -1700)
    n_erode_noise.noise_dimensions = "4D"
    n_erode_noise.normalize = True
    n_erode_noise.inputs["Detail"].default_value = 6.0
    n_erode_noise.inputs["Roughness"].default_value = 0.6
    n_erode_noise.inputs["Distortion"].default_value = 0.3
    g.links.new(gi.outputs["Position"],      n_erode_noise.inputs["Vector"])
    g.links.new(gi.outputs["Erosion Scale"], n_erode_noise.inputs["Scale"])
    # Offset seed for erosion so it's de-correlated from global noise.
    n_erode_seed = _add_node(g, "ShaderNodeMath", 0, -1900, operation="ADD")
    n_erode_seed.inputs[1].default_value = 100.0
    g.links.new(gi.outputs["Noise Seed"], n_erode_seed.inputs[0])
    g.links.new(n_erode_seed.outputs[0], n_erode_noise.inputs["W"])
    n_erode_signed = _add_node(g, "ShaderNodeMath", 400, -1700, operation="MULTIPLY_ADD")
    n_erode_signed.inputs[1].default_value = 2.0
    n_erode_signed.inputs[2].default_value = -1.0
    g.links.new(n_erode_noise.outputs["Fac"], n_erode_signed.inputs[0])

    # Mask = clamp(cone_carved / max(peak_height, 1), 0, 1)
    n_safe_h = _add_node(g, "ShaderNodeMath", 200, -1500, operation="MAXIMUM")
    n_safe_h.inputs[1].default_value = 1.0
    g.links.new(n_top_loc.outputs["Z"], n_safe_h.inputs[0])
    n_mask = _add_node(g, "ShaderNodeMath", 400, -1500, operation="DIVIDE")
    g.links.new(n_cone_carved.outputs[0], n_mask.inputs[0])
    g.links.new(n_safe_h.outputs[0], n_mask.inputs[1])
    n_mask_c = _add_node(g, "ShaderNodeClamp", 600, -1500)
    n_mask_c.inputs["Min"].default_value = 0.0
    n_mask_c.inputs["Max"].default_value = 1.0
    g.links.new(n_mask.outputs[0], n_mask_c.inputs["Value"])

    n_erode_mul1 = _add_node(g, "ShaderNodeMath", 600, -1700, operation="MULTIPLY")
    g.links.new(n_erode_signed.outputs[0], n_erode_mul1.inputs[0])
    g.links.new(n_mask_c.outputs["Result"], n_erode_mul1.inputs[1])
    n_erosion = _add_node(g, "ShaderNodeMath", 800, -1700, operation="MULTIPLY")
    g.links.new(n_erode_mul1.outputs[0], n_erosion.inputs[0])
    g.links.new(gi.outputs["Cone Erosion"], n_erosion.inputs[1])
    n_cone_eroded = _add_node(g, "ShaderNodeMath", 1000, -200, operation="ADD")
    g.links.new(n_cone_carved.outputs[0], n_cone_eroded.inputs[0])
    g.links.new(n_erosion.outputs[0], n_cone_eroded.inputs[1])

    # SHELF (uses naive d, not sheared — keeps underwater plateau centred on
    # the base regardless of apex offset).
    n_shelf_outer = _add_node(g, "ShaderNodeMath", -200, -550, operation="ADD")
    g.links.new(n_base_scl.outputs["X"], n_shelf_outer.inputs[0])
    g.links.new(gi.outputs["Shelf Radius"], n_shelf_outer.inputs[1])
    n_mr_shelf = _add_node(g, "ShaderNodeMapRange", 0, -550, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d_naive.outputs[0],      n_mr_shelf.inputs["Value"])
    g.links.new(n_base_scl.outputs["X"],   n_mr_shelf.inputs["From Min"])
    g.links.new(n_shelf_outer.outputs[0],  n_mr_shelf.inputs["From Max"])
    g.links.new(n_zero.outputs[0],         n_mr_shelf.inputs["To Min"])
    g.links.new(gi.outputs["Shelf Depth"], n_mr_shelf.inputs["To Max"])

    # REEF (default Reef Height=0 keeps it invisible; available if dialed up).
    n_reef_center = _add_node(g, "ShaderNodeMath", -200, -750, operation="ADD")
    g.links.new(n_base_scl.outputs["X"], n_reef_center.inputs[0])
    g.links.new(gi.outputs["Reef Inset"], n_reef_center.inputs[1])
    n_reef_delta = _add_node(g, "ShaderNodeMath", 0, -750, operation="SUBTRACT")
    g.links.new(n_d_naive.outputs[0], n_reef_delta.inputs[0])
    g.links.new(n_reef_center.outputs[0], n_reef_delta.inputs[1])
    n_reef_abs = _add_node(g, "ShaderNodeMath", 200, -750, operation="ABSOLUTE")
    g.links.new(n_reef_delta.outputs[0], n_reef_abs.inputs[0])
    n_mr_reef = _add_node(g, "ShaderNodeMapRange", 400, -750, interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_reef_abs.outputs[0],      n_mr_reef.inputs["Value"])
    g.links.new(n_zero.outputs[0],          n_mr_reef.inputs["From Min"])
    g.links.new(gi.outputs["Reef Width"],   n_mr_reef.inputs["From Max"])
    g.links.new(gi.outputs["Reef Height"],  n_mr_reef.inputs["To Min"])
    g.links.new(n_zero.outputs[0],          n_mr_reef.inputs["To Max"])

    # profile = cone_eroded + shelf + reef
    n_h1 = _add_node(g, "ShaderNodeMath", 1200, -400, operation="ADD")
    g.links.new(n_cone_eroded.outputs[0], n_h1.inputs[0])
    g.links.new(n_mr_shelf.outputs["Result"], n_h1.inputs[1])
    n_profile = _add_node(g, "ShaderNodeMath", 1400, -500, operation="ADD")
    g.links.new(n_h1.outputs[0], n_profile.inputs[0])
    g.links.new(n_mr_reef.outputs["Result"], n_profile.inputs[1])

    # Active mask & sentinel mix
    n_active = _add_node(g, "ShaderNodeMath", 1200, -700, operation="GREATER_THAN")
    n_active.inputs[1].default_value = 0.01
    g.links.new(n_base_scl.outputs["X"], n_active.inputs[0])
    n_mix = _add_node(g, "ShaderNodeMix", 1600, -400)
    n_mix.data_type = "FLOAT"; n_mix.clamp_factor = False
    g.links.new(n_active.outputs[0],   n_mix.inputs[0])
    g.links.new(gi.outputs["Sentinel"], n_mix.inputs["A"])
    g.links.new(n_profile.outputs[0],  n_mix.inputs["B"])
    g.links.new(n_mix.outputs[0], go.inputs["Height"])

    return g


# ────────────────────────────────────────────────────────────────────
# HV_TemplateIsland — 8-peak unroll + global noise + biome stamp
# ────────────────────────────────────────────────────────────────────

def build_template_island_group(sub: bpy.types.NodeTree) -> bpy.types.NodeTree:
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Geometry", "INPUT", "NodeSocketGeometry")
    for i in range(8):
        _new_socket(g, f"Base {i}", "INPUT", "NodeSocketObject")
        _new_socket(g, f"Top {i}",  "INPUT", "NodeSocketObject")
    _new_socket(g, "Shelf Depth",     "INPUT", "NodeSocketFloat", -25.0, -200.0, 0.0)
    _new_socket(g, "Shelf Radius",    "INPUT", "NodeSocketFloat", 200.0, 0.0, 1000.0)
    _new_socket(g, "Reef Inset",      "INPUT", "NodeSocketFloat",  20.0, 0.0, 200.0)
    _new_socket(g, "Reef Height",     "INPUT", "NodeSocketFloat",   0.0, 0.0, 50.0)
    _new_socket(g, "Reef Width",      "INPUT", "NodeSocketFloat",  25.0, 1.0, 200.0)
    _new_socket(g, "Cone Erosion",    "INPUT", "NodeSocketFloat",  12.0, 0.0, 50.0)
    _new_socket(g, "Erosion Scale",   "INPUT", "NodeSocketFloat",   0.035, 0.0001, 1.0)
    _new_socket(g, "Ring Break",      "INPUT", "NodeSocketFloat",  20.0, 0.0, 200.0)
    _new_socket(g, "Ring Scale",      "INPUT", "NodeSocketFloat",   0.015, 0.0001, 1.0)
    _new_socket(g, "Roughness Above", "INPUT", "NodeSocketFloat",   2.0, 0.0, 50.0)
    _new_socket(g, "Roughness Below", "INPUT", "NodeSocketFloat",   1.0, 0.0, 20.0)
    _new_socket(g, "Noise Scale",     "INPUT", "NodeSocketFloat",   0.008, 0.0001, 1.0)
    _new_socket(g, "Noise Seed",      "INPUT", "NodeSocketFloat",   0.0, 0.0, 1000.0)
    # Billowy seafloor: low-frequency, high-distortion noise that pushes the
    # underwater floor up and down so it reads as ridged silt rather than a
    # flat plateau. Gated by a smooth underwater mask so peaks never poke
    # through the waterline. Defaults are deliberately aggressive — silt
    # trenches reach well below the nominal -25 m shelf, giving the
    # seafloor a dramatic eroded silhouette rather than a kiddie-pool floor.
    _new_socket(g, "Seafloor Billow", "INPUT", "NodeSocketFloat",  10.0, 0.0, 30.0)
    _new_socket(g, "Billow Scale",    "INPUT", "NodeSocketFloat",   0.004, 0.0001, 1.0)
    # Land billows: mirror pass above the waterline. Adds rolling-hill /
    # eroded-ridge displacement to cone slopes and beach plateaus so the
    # above-water silhouette doesn't read as a smooth ice-cream cone.
    # Symmetric (no bias) so the pass produces both hills and gulleys.
    # Gated above z=+2 m so it never reaches into the shoreline.
    _new_socket(g, "Land Billow",     "INPUT", "NodeSocketFloat",   6.0, 0.0, 30.0)
    _new_socket(g, "Land Scale",      "INPUT", "NodeSocketFloat",   0.012, 0.0001, 1.0)
    # Underwater dead-zone (m) above which the seafloor billow tapers
    # off as it approaches the waterline. Set to 0.5–1 m for a tight
    # crisp shoreline; raise to 5+ m for a wide sandy lagoon.
    # NOTE: this only governs the underwater side. The land billow now
    # always activates from z=0 so the cone slope's craggy texture
    # blends smoothly into the beach without a visible ring.
    _new_socket(g, "Shoreline Width", "INPUT", "NodeSocketFloat",   1.5, 0.0, 30.0)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",  -1600, 0)
    p_out = _add_node(g, "NodeGroupOutput",  2800, 0)
    p_pos = _add_node(g, "GeometryNodeInputPosition", -1400, -200)
    n_sentinel = _add_node(g, "ShaderNodeValue", -1400, -400)
    n_sentinel.outputs[0].default_value = -10000.0

    # 8 sub-group instances, max-cascade
    prev = None
    for i in range(8):
        inst = _add_node(g, "GeometryNodeGroup", -800, -100 - i * 200)
        inst.node_tree = sub
        g.links.new(p_pos.outputs["Position"],     inst.inputs["Position"])
        g.links.new(p_in.outputs[f"Base {i}"],     inst.inputs["Base"])
        g.links.new(p_in.outputs[f"Top {i}"],      inst.inputs["Top"])
        g.links.new(p_in.outputs["Shelf Depth"],   inst.inputs["Shelf Depth"])
        g.links.new(p_in.outputs["Shelf Radius"],  inst.inputs["Shelf Radius"])
        g.links.new(p_in.outputs["Reef Inset"],    inst.inputs["Reef Inset"])
        g.links.new(p_in.outputs["Reef Height"],   inst.inputs["Reef Height"])
        g.links.new(p_in.outputs["Reef Width"],    inst.inputs["Reef Width"])
        g.links.new(p_in.outputs["Cone Erosion"],  inst.inputs["Cone Erosion"])
        g.links.new(p_in.outputs["Erosion Scale"], inst.inputs["Erosion Scale"])
        g.links.new(p_in.outputs["Noise Seed"],    inst.inputs["Noise Seed"])
        g.links.new(p_in.outputs["Ring Break"],    inst.inputs["Ring Break"])
        g.links.new(p_in.outputs["Ring Scale"],    inst.inputs["Ring Scale"])
        g.links.new(n_sentinel.outputs[0],         inst.inputs["Sentinel"])
        if prev is None:
            prev = inst.outputs["Height"]
        else:
            n_max = _add_node(g, "ShaderNodeMath", -400, -100 - i * 200, operation="MAXIMUM")
            g.links.new(prev, n_max.inputs[0])
            g.links.new(inst.outputs["Height"], n_max.inputs[1])
            prev = n_max.outputs[0]

    # Global low-amplitude background noise (multi-octave), altitude-modulated.
    n_gnoise = _add_node(g, "ShaderNodeTexNoise", -400, -1900)
    n_gnoise.noise_dimensions = "4D"; n_gnoise.normalize = True
    n_gnoise.inputs["Detail"].default_value = 3.0
    n_gnoise.inputs["Roughness"].default_value = 0.5
    n_gnoise.inputs["Distortion"].default_value = 0.0
    g.links.new(p_pos.outputs["Position"],   n_gnoise.inputs["Vector"])
    g.links.new(p_in.outputs["Noise Scale"], n_gnoise.inputs["Scale"])
    g.links.new(p_in.outputs["Noise Seed"],  n_gnoise.inputs["W"])
    n_gsigned = _add_node(g, "ShaderNodeMath", -200, -1900, operation="MULTIPLY_ADD")
    n_gsigned.inputs[1].default_value = 2.0; n_gsigned.inputs[2].default_value = -1.0
    g.links.new(n_gnoise.outputs["Fac"], n_gsigned.inputs[0])
    n_amp = _add_node(g, "ShaderNodeMapRange", 0, -1900, interpolation_type="SMOOTHSTEP", clamp=True)
    n_amp.inputs["From Min"].default_value = -1.0
    n_amp.inputs["From Max"].default_value =  2.0
    g.links.new(prev, n_amp.inputs["Value"])
    g.links.new(p_in.outputs["Roughness Below"], n_amp.inputs["To Min"])
    g.links.new(p_in.outputs["Roughness Above"], n_amp.inputs["To Max"])
    # Same shoreline-protection trick as the land billow: split the
    # global noise's signed value into positive and negative halves and
    # fade the negative half to zero at the waterline. Without this the
    # ±~1 m global perturbation can still dig a shallow moat at the cone
    # foot even after the land billow's own dips are gone.
    n_g_pos = _add_node(g, "ShaderNodeMath", 0, -2000, operation="MAXIMUM")
    n_g_pos.inputs[1].default_value = 0.0
    g.links.new(n_gsigned.outputs[0], n_g_pos.inputs[0])
    n_g_neg = _add_node(g, "ShaderNodeMath", 0, -2100, operation="MINIMUM")
    n_g_neg.inputs[1].default_value = 0.0
    g.links.new(n_gsigned.outputs[0], n_g_neg.inputs[0])
    n_g_neg_fade = _add_node(g, "ShaderNodeMapRange", 0, -2200,
                             interpolation_type="SMOOTHSTEP", clamp=True)
    n_g_neg_fade.inputs["From Min"].default_value = 0.0
    n_g_neg_fade.inputs["From Max"].default_value = 15.0
    n_g_neg_fade.inputs["To Min"].default_value =   0.0
    n_g_neg_fade.inputs["To Max"].default_value =   1.0
    g.links.new(prev, n_g_neg_fade.inputs["Value"])
    n_g_neg_eff = _add_node(g, "ShaderNodeMath", 100, -2100, operation="MULTIPLY")
    g.links.new(n_g_neg.outputs[0], n_g_neg_eff.inputs[0])
    g.links.new(n_g_neg_fade.outputs["Result"], n_g_neg_eff.inputs[1])
    n_g_signed_eff = _add_node(g, "ShaderNodeMath", 200, -2000, operation="ADD")
    g.links.new(n_g_pos.outputs[0], n_g_signed_eff.inputs[0])
    g.links.new(n_g_neg_eff.outputs[0], n_g_signed_eff.inputs[1])
    n_perturb = _add_node(g, "ShaderNodeMath", 300, -1900, operation="MULTIPLY")
    g.links.new(n_g_signed_eff.outputs[0], n_perturb.inputs[0])
    g.links.new(n_amp.outputs["Result"], n_perturb.inputs[1])

    # Seafloor billows — low-frequency distorted noise gated to underwater.
    # ``normalize=False`` keeps the noise's natural variance instead of
    # squashing it toward 0.5. Multi-octave (Detail=4) plus moderate
    # Distortion gives the puffy / cloudy silhouette of silty dunes.
    n_billow_noise = _add_node(g, "ShaderNodeTexNoise", -400, -2400)
    n_billow_noise.noise_dimensions = "4D"
    n_billow_noise.normalize = False
    n_billow_noise.inputs["Detail"].default_value = 4.0
    n_billow_noise.inputs["Roughness"].default_value = 0.55
    n_billow_noise.inputs["Distortion"].default_value = 1.2
    g.links.new(p_pos.outputs["Position"],     n_billow_noise.inputs["Vector"])
    g.links.new(p_in.outputs["Billow Scale"],  n_billow_noise.inputs["Scale"])
    # De-correlate the billow seed from the cone-erosion + global noise seeds.
    n_billow_seed = _add_node(g, "ShaderNodeMath", -600, -2600, operation="ADD")
    n_billow_seed.inputs[1].default_value = 53.0
    g.links.new(p_in.outputs["Noise Seed"], n_billow_seed.inputs[0])
    g.links.new(n_billow_seed.outputs[0], n_billow_noise.inputs["W"])
    # Signed remap centred on 0.5 with a downward bias: map
    # [0, 1] → [-1.4, +0.6]. Without ``normalize`` the noise output can
    # poke outside [0, 1], which we *want* — the rare extremes carve
    # the dramatic silt trenches that make the seafloor read as eroded
    # rather than dialled-in.
    n_billow_signed = _add_node(g, "ShaderNodeMath", -200, -2400, operation="MULTIPLY_ADD")
    n_billow_signed.inputs[1].default_value =  2.0
    n_billow_signed.inputs[2].default_value = -1.4
    g.links.new(n_billow_noise.outputs["Fac"], n_billow_signed.inputs[0])
    # Underwater mask: full strength below z = -(Shoreline Width + 7),
    # fades out to zero at z = -Shoreline Width so the band of smooth
    # seafloor around each shoreline is author-tunable. The 7 m ramp
    # width keeps the transition visually soft (matches the land pass).
    n_sw_neg_far  = _add_node(g, "ShaderNodeMath", -800, -2200, operation="ADD")
    n_sw_neg_far.inputs[1].default_value = 7.0  # extra ramp width
    g.links.new(p_in.outputs["Shoreline Width"], n_sw_neg_far.inputs[0])
    n_sw_neg_far_neg = _add_node(g, "ShaderNodeMath", -600, -2200, operation="MULTIPLY")
    n_sw_neg_far_neg.inputs[1].default_value = -1.0
    g.links.new(n_sw_neg_far.outputs[0], n_sw_neg_far_neg.inputs[0])
    n_sw_neg_near = _add_node(g, "ShaderNodeMath", -600, -2300, operation="MULTIPLY")
    n_sw_neg_near.inputs[1].default_value = -1.0
    g.links.new(p_in.outputs["Shoreline Width"], n_sw_neg_near.inputs[0])
    n_billow_mask = _add_node(g, "ShaderNodeMapRange", 0, -2400,
                              interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_sw_neg_far_neg.outputs[0], n_billow_mask.inputs["From Min"])
    g.links.new(n_sw_neg_near.outputs[0],    n_billow_mask.inputs["From Max"])
    n_billow_mask.inputs["To Min"].default_value =    1.0
    n_billow_mask.inputs["To Max"].default_value =    0.0
    g.links.new(prev, n_billow_mask.inputs["Value"])
    n_billow_mul = _add_node(g, "ShaderNodeMath", 200, -2400, operation="MULTIPLY")
    g.links.new(n_billow_signed.outputs[0], n_billow_mul.inputs[0])
    g.links.new(n_billow_mask.outputs["Result"], n_billow_mul.inputs[1])
    n_billow = _add_node(g, "ShaderNodeMath", 400, -2400, operation="MULTIPLY")
    g.links.new(n_billow_mul.outputs[0], n_billow.inputs[0])
    g.links.new(p_in.outputs["Seafloor Billow"], n_billow.inputs[1])

    # Land billows — mirror pass above the waterline. Distorted FBM gives
    # cone slopes + beach plateaus a billowy / eroded silhouette. Centred
    # signed range so the pass adds both hills and gulleys.
    n_land_noise = _add_node(g, "ShaderNodeTexNoise", -400, -3100)
    n_land_noise.noise_dimensions = "4D"
    n_land_noise.normalize = False
    n_land_noise.inputs["Detail"].default_value = 4.0
    n_land_noise.inputs["Roughness"].default_value = 0.55
    n_land_noise.inputs["Distortion"].default_value = 1.2
    g.links.new(p_pos.outputs["Position"],   n_land_noise.inputs["Vector"])
    g.links.new(p_in.outputs["Land Scale"],  n_land_noise.inputs["Scale"])
    # De-correlate the land seed from the seafloor / global / erosion seeds.
    n_land_seed = _add_node(g, "ShaderNodeMath", -600, -3300, operation="ADD")
    n_land_seed.inputs[1].default_value = 211.0
    g.links.new(p_in.outputs["Noise Seed"], n_land_seed.inputs[0])
    g.links.new(n_land_seed.outputs[0], n_land_noise.inputs["W"])
    # Centred signed remap: [0, 1] → [-1, +1]. Symmetric so the pass adds
    # both hills and gulleys to above-water terrain. The un-normalised
    # noise can occasionally swing wider — we want the dramatic extremes.
    n_land_signed = _add_node(g, "ShaderNodeMath", -200, -3100, operation="MULTIPLY_ADD")
    n_land_signed.inputs[1].default_value =  2.0
    n_land_signed.inputs[2].default_value = -1.0
    g.links.new(n_land_noise.outputs["Fac"], n_land_signed.inputs[0])

    # Suppress negative swings near the waterline. At z=0 the cone is at
    # its foot and the bare cone profile is only gently sloped — any
    # down-swing reads as a "moat" between the cone and the shelf. We
    # fade the *negative* half of ``signed`` from 0 at the waterline to
    # full at z=25 m, keeping positives at full strength throughout. The
    # long fade range matters: the cone slope is shallowest in its
    # bottom 20 m (peak-height × smoothstep tail), so that's where any
    # residual negative contribution shows up as a visible dip.
    n_land_pos = _add_node(g, "ShaderNodeMath", 0, -3000, operation="MAXIMUM")
    n_land_pos.inputs[1].default_value = 0.0
    g.links.new(n_land_signed.outputs[0], n_land_pos.inputs[0])
    n_land_neg = _add_node(g, "ShaderNodeMath", 0, -3200, operation="MINIMUM")
    n_land_neg.inputs[1].default_value = 0.0
    g.links.new(n_land_signed.outputs[0], n_land_neg.inputs[0])
    n_land_neg_fade = _add_node(g, "ShaderNodeMapRange", 0, -3400,
                                interpolation_type="SMOOTHSTEP", clamp=True)
    n_land_neg_fade.inputs["From Min"].default_value = 0.0
    n_land_neg_fade.inputs["From Max"].default_value = 25.0
    n_land_neg_fade.inputs["To Min"].default_value =   0.0
    n_land_neg_fade.inputs["To Max"].default_value =   1.0
    g.links.new(prev, n_land_neg_fade.inputs["Value"])
    n_land_neg_eff = _add_node(g, "ShaderNodeMath", 200, -3200, operation="MULTIPLY")
    g.links.new(n_land_neg.outputs[0], n_land_neg_eff.inputs[0])
    g.links.new(n_land_neg_fade.outputs["Result"], n_land_neg_eff.inputs[1])
    n_land_signed_eff = _add_node(g, "ShaderNodeMath", 400, -3100, operation="ADD")
    g.links.new(n_land_pos.outputs[0], n_land_signed_eff.inputs[0])
    g.links.new(n_land_neg_eff.outputs[0], n_land_signed_eff.inputs[1])
    # Above-water mask: full strength above z = +3 m, fades to zero at
    # the waterline (z = 0). Keeping the lower edge fixed at the
    # waterline rather than at +Shoreline_Width lets the cone slope's
    # billow texture flow continuously down to where the shelf starts,
    # eliminating the smooth "ring" that previously formed at the
    # cone foot. ``Shoreline Width`` therefore now only governs the
    # underwater side of the no-billow band.
    n_land_mask = _add_node(g, "ShaderNodeMapRange", 0, -3100,
                            interpolation_type="SMOOTHSTEP", clamp=True)
    n_land_mask.inputs["From Min"].default_value =  0.0
    n_land_mask.inputs["From Max"].default_value =  3.0
    n_land_mask.inputs["To Min"].default_value =    0.0
    n_land_mask.inputs["To Max"].default_value =    1.0
    g.links.new(prev, n_land_mask.inputs["Value"])
    n_land_mul = _add_node(g, "ShaderNodeMath", 600, -3100, operation="MULTIPLY")
    g.links.new(n_land_signed_eff.outputs[0], n_land_mul.inputs[0])
    g.links.new(n_land_mask.outputs["Result"], n_land_mul.inputs[1])
    n_land = _add_node(g, "ShaderNodeMath", 400, -3100, operation="MULTIPLY")
    g.links.new(n_land_mul.outputs[0], n_land.inputs[0])
    g.links.new(p_in.outputs["Land Billow"], n_land.inputs[1])

    n_final = _add_node(g, "ShaderNodeMath", 600, -800, operation="ADD")
    g.links.new(prev, n_final.inputs[0])
    g.links.new(n_perturb.outputs[0], n_final.inputs[1])
    n_final2 = _add_node(g, "ShaderNodeMath", 800, -800, operation="ADD")
    g.links.new(n_final.outputs[0],   n_final2.inputs[0])
    g.links.new(n_billow.outputs[0],  n_final2.inputs[1])
    n_final3 = _add_node(g, "ShaderNodeMath", 1000, -800, operation="ADD")
    g.links.new(n_final2.outputs[0], n_final3.inputs[0])
    g.links.new(n_land.outputs[0],   n_final3.inputs[1])

    # Set Position
    n_comb = _add_node(g, "ShaderNodeCombineXYZ", 1100, -300)
    g.links.new(n_final3.outputs[0], n_comb.inputs["Z"])
    n_setpos = _add_node(g, "GeometryNodeSetPosition", 1400, 0)
    g.links.new(p_in.outputs["Geometry"], n_setpos.inputs["Geometry"])
    g.links.new(n_comb.outputs["Vector"], n_setpos.inputs["Offset"])

    # Biome stamp: 4 bands. Deep band only at z<-22, so most underwater
    # reads as sandy.
    n_pos2 = _add_node(g, "GeometryNodeInputPosition", 1600, -300)
    n_pos2_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 1800, -300)
    g.links.new(n_pos2.outputs["Position"], n_pos2_xyz.inputs["Vector"])
    def _step(z, thresh, x, y):
        n = _add_node(g, "ShaderNodeMath", x, y, operation="GREATER_THAN")
        n.inputs[1].default_value = thresh
        g.links.new(z, n.inputs[0])
        return n
    n_b1 = _step(n_pos2_xyz.outputs["Z"], -22.0, 2000, -100)
    n_b2 = _step(n_pos2_xyz.outputs["Z"],   0.0, 2000, -250)
    n_b3 = _step(n_pos2_xyz.outputs["Z"],   4.0, 2000, -400)
    n_bs1 = _add_node(g, "ShaderNodeMath", 2200, -175, operation="ADD")
    g.links.new(n_b1.outputs[0], n_bs1.inputs[0]); g.links.new(n_b2.outputs[0], n_bs1.inputs[1])
    n_bs2 = _add_node(g, "ShaderNodeMath", 2200, -325, operation="ADD")
    g.links.new(n_bs1.outputs[0], n_bs2.inputs[0]); g.links.new(n_b3.outputs[0], n_bs2.inputs[1])
    n_biome = _add_node(g, "ShaderNodeMath", 2200, -475, operation="DIVIDE")
    n_biome.inputs[1].default_value = 3.0
    g.links.new(n_bs2.outputs[0], n_biome.inputs[0])

    n_zero_p = _add_node(g, "ShaderNodeValue", 2200, -625); n_zero_p.outputs[0].default_value = 0.0
    n_one_p  = _add_node(g, "ShaderNodeValue", 2200, -775); n_one_p.outputs[0].default_value = 1.0
    n_color = _add_node(g, "FunctionNodeCombineColor", 2400, -300, mode="RGB")
    g.links.new(n_zero_p.outputs[0], n_color.inputs["Red"])
    g.links.new(n_one_p.outputs[0],  n_color.inputs["Green"])
    g.links.new(n_zero_p.outputs[0], n_color.inputs["Blue"])
    g.links.new(n_biome.outputs[0],  n_color.inputs["Alpha"])

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
    for i, (idx, _, _, _, _) in enumerate(PEAKS):
        base_name = f"peak_{idx}_base"
        top_name  = f"peak_{idx}_top"
        if base_name in bpy.data.objects:
            mod[ids[f"Base {i}"]] = bpy.data.objects[base_name]
        if top_name in bpy.data.objects:
            mod[ids[f"Top {i}"]] = bpy.data.objects[top_name]


# ────────────────────────────────────────────────────────────────────
# Scene objects
# ────────────────────────────────────────────────────────────────────

def add_peaks() -> None:
    for idx, base_loc, radius, top_local, crater in PEAKS:
        base = bpy.data.objects.new(f"peak_{idx}_base", None)
        # SPHERE display with scale.z=0 reads as a horizontal great circle
        # plus collapsed-but-visible orthogonal arcs through the centre.
        # More visually prominent than CIRCLE — matches the visibility of
        # the original single-empty peak controls. scale.z is unused by
        # the GN graph for the base (crater flag lives on the top empty).
        base.empty_display_type = "SPHERE"
        base.empty_display_size = 1.0  # SPHERE radius = scale magnitude
        base.location = base_loc
        base.scale = (radius, radius, 0.0)
        base["kind"] = "peak_base"
        bpy.context.scene.collection.objects.link(base)

        top = bpy.data.objects.new(f"peak_{idx}_top", None)
        top.empty_display_type = "SPHERE"
        top.empty_display_size = 5.0  # visible at map scale
        top.location = top_local
        top.scale = (1.0, 1.0, crater)
        top["kind"] = "peak_top"
        bpy.context.scene.collection.objects.link(top)

        # Copy Location constraint: top's world position = base + top.location.
        # Avoids the scale-inheritance issue that parenting introduces when
        # base.scale.x encodes the radius.
        con = top.constraints.new("COPY_LOCATION")
        con.target = base
        con.use_offset = True
        con.use_x = True; con.use_y = True; con.use_z = True


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


def _sample_spline_at_t(t: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """Sample the AI spline polyline at arc-length parameter t ∈ [0, 1].
    Returns ((sample_x, sample_y), (tangent_x, tangent_y)). Tangent is
    normalized."""
    anchors = AI_SPLINE_ANCHORS
    # Cyclic loop — close the polyline by appending the first anchor.
    pts = list(anchors) + [anchors[0]]
    seg_lengths = []
    for i in range(len(pts) - 1):
        dx = pts[i + 1][0] - pts[i][0]
        dy = pts[i + 1][1] - pts[i][1]
        seg_lengths.append(math.hypot(dx, dy))
    total = sum(seg_lengths)
    target = max(0.0, min(1.0, t)) * total

    accum = 0.0
    for i, seg_len in enumerate(seg_lengths):
        if accum + seg_len >= target or i == len(seg_lengths) - 1:
            f = (target - accum) / seg_len if seg_len > 0 else 0.0
            ax, ay = pts[i][0], pts[i][1]
            bx, by = pts[i + 1][0], pts[i + 1][1]
            sx = ax + f * (bx - ax)
            sy = ay + f * (by - ay)
            tx = bx - ax
            ty = by - ay
            tmag = math.hypot(tx, ty) or 1.0
            return (sx, sy), (tx / tmag, ty / tmag)
        accum += seg_len
    # Should be unreachable given the loop's i==last fallback, but keep a safe default.
    return (pts[0][0], pts[0][1]), (0.0, 1.0)


def add_player_starts() -> None:
    """Spawn player starts on the racing line. ``START_T`` picks the
    arc-length parameter (0.0 = first spline anchor). The two starts sit
    perpendicular to the tangent, ``START_GRID_SPACING_M`` apart, both
    facing along the tangent — matches a typical race-start grid."""
    (sx, sy), (tx, ty) = _sample_spline_at_t(START_T)
    # Yaw: runtime convention is yaw=0 → +Y forward, yaw=π/2 → +X.
    # forward unit = (sin(yaw), cos(yaw)); solve yaw = atan2(tx, ty).
    yaw = math.atan2(tx, ty)
    # Right vector (perpendicular to forward, in XY): (cos(yaw), -sin(yaw)) = (ty, -tx)
    rx, ry = ty, -tx
    offsets = [(-START_GRID_SPACING_M * 0.5, "-"), (+START_GRID_SPACING_M * 0.5, "+")]
    for i, (off, _label) in enumerate(offsets):
        x = sx + rx * off
        y = sy + ry * off
        obj = bpy.data.objects.new(f"start_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 6.0
        obj.location = (x, y, START_Z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "start"
        obj["index"] = i
        obj["start_t"] = float(START_T)
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
    """Slope- and altitude-aware terrain shader for the Blender preview.

    Mixes two altitude ramps — a "flat" ramp (sandy / grass / forest) and
    a "cliff" ramp (wet rock / cliff stone / volcanic) — driven by the
    surface normal's tilt. A low-frequency variation noise breaks the
    bands so neither sand nor grass reads as a flat fill. Roughness
    lifts on rocks; near the waterline the shader darkens slightly to
    suggest wet sand / wet rock.

    This material is **author-only**: the runtime ships its own terrain
    shader that reads ``COLOR_0`` from the exported .glb. The vertex-
    color stamp is still written by the GN graph, so when we wire the
    runtime shader to honour it the in-game look will match this
    preview's intent."""
    name = "mat_terrain_main"
    if name in bpy.data.materials:
        bpy.data.materials.remove(bpy.data.materials[name])
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)

    def add(kind, x, y, **kw):
        n = nt.nodes.new(kind); n.location = (x, y)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    n_out  = add("ShaderNodeOutputMaterial",  1800,    0)
    n_bsdf = add("ShaderNodeBsdfPrincipled",  1500,    0)

    # --- inputs: position + normal ------------------------------------
    n_geom = add("ShaderNodeNewGeometry",    -1600,  200)
    n_pos_xyz = add("ShaderNodeSeparateXYZ", -1400,  300)
    nt.links.new(n_geom.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_nrm_xyz = add("ShaderNodeSeparateXYZ", -1400,    0)
    nt.links.new(n_geom.outputs["Normal"], n_nrm_xyz.inputs["Vector"])

    # --- slope mask: 0 on flat tops, 1 on cliffs ----------------------
    # Normal.z drops from 1 (flat) to 0 (vertical). Smoothstep between
    # ~30° (cos ≈ 0.85) and ~55° (cos ≈ 0.57) so gentle slopes still
    # read as grass / sand.
    n_slope_mr = add("ShaderNodeMapRange",   -1200,    0,
                     interpolation_type="SMOOTHSTEP", clamp=True)
    n_slope_mr.inputs["From Min"].default_value = 0.85
    n_slope_mr.inputs["From Max"].default_value = 0.55
    n_slope_mr.inputs["To Min"].default_value =   0.0
    n_slope_mr.inputs["To Max"].default_value =   1.0
    nt.links.new(n_nrm_xyz.outputs["Z"], n_slope_mr.inputs["Value"])

    # --- altitude -> [0, 1] fac for the ramps -------------------------
    # Map z ∈ [-50, 120] → [0, 1]. The flat / cliff ramps are tuned to
    # this range; if peaks ever exceed 120 m, ramp tops just clamp.
    n_alt_mr = add("ShaderNodeMapRange",     -1200,  300, clamp=True)
    n_alt_mr.inputs["From Min"].default_value = -50.0
    n_alt_mr.inputs["From Max"].default_value = 120.0
    n_alt_mr.inputs["To Min"].default_value =     0.0
    n_alt_mr.inputs["To Max"].default_value =     1.0
    nt.links.new(n_pos_xyz.outputs["Z"], n_alt_mr.inputs["Value"])

    def _ramp(x, y, stops):
        r = add("ShaderNodeValToRGB", x, y)
        cr = r.color_ramp
        cr.interpolation = "LINEAR"
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[1])
        cr.elements[0].position = stops[0][0]
        cr.elements[0].color = stops[0][1]
        for pos, col in stops[1:]:
            e = cr.elements.new(pos)
            e.color = col
        return r

    # --- flat ramp: deep blue → sandy → wet beach → grass → forest → bare ---
    n_flat_ramp = _ramp(-800, 400, [
        (0.000, (0.03, 0.08, 0.20, 1.0)),   # abyssal blue   (z≈-50)
        (0.180, (0.22, 0.30, 0.40, 1.0)),   # blue-sand      (z≈-19)
        (0.270, (0.68, 0.66, 0.55, 1.0)),   # silty sand     (z≈-4)
        (0.300, (0.92, 0.86, 0.72, 1.0)),   # bright sand    (z= 1)
        (0.345, (0.78, 0.70, 0.50, 1.0)),   # wet beach tan  (z= 9)
        (0.430, (0.36, 0.55, 0.27, 1.0)),   # grass          (z=23)
        (0.620, (0.22, 0.40, 0.18, 1.0)),   # forest         (z=55)
        (0.820, (0.30, 0.27, 0.21, 1.0)),   # alpine stone   (z=89)
        (1.000, (0.18, 0.15, 0.13, 1.0)),   # volcanic top   (z=120)
    ])
    nt.links.new(n_alt_mr.outputs["Result"], n_flat_ramp.inputs["Fac"])

    # --- cliff ramp: cool deep → wet rock → cliff stone → volcanic ---
    n_cliff_ramp = _ramp(-800, 100, [
        (0.000, (0.07, 0.10, 0.16, 1.0)),   # dark abyssal rock
        (0.220, (0.20, 0.22, 0.24, 1.0)),   # wet rock
        (0.300, (0.34, 0.32, 0.28, 1.0)),   # sea cliff
        (0.500, (0.42, 0.39, 0.34, 1.0)),   # grey rock
        (0.750, (0.30, 0.25, 0.22, 1.0)),   # warmer rock
        (1.000, (0.16, 0.13, 0.13, 1.0)),   # volcanic
    ])
    nt.links.new(n_alt_mr.outputs["Result"], n_cliff_ramp.inputs["Fac"])

    # --- mix flat + cliff by slope ------------------------------------
    n_mix_slope = add("ShaderNodeMix", -400, 250, data_type="RGBA")
    n_mix_slope.blend_type = "MIX"
    n_mix_slope.clamp_factor = True
    nt.links.new(n_slope_mr.outputs["Result"], n_mix_slope.inputs[0])
    nt.links.new(n_flat_ramp.outputs["Color"],  n_mix_slope.inputs[6])
    nt.links.new(n_cliff_ramp.outputs["Color"], n_mix_slope.inputs[7])

    # --- variation noise: breaks ramp banding via Brightness/Contrast ---
    # Two-octave noise drives a signed brightness offset (±0.10) so neither
    # sand nor grass reads as a flat fill. Using Brightness/Contrast avoids
    # ColorRamp's 0..1 colour clamping, which would otherwise lose the
    # "brighten" half of the variation.
    n_var_noise = add("ShaderNodeTexNoise", -1200, -300)
    n_var_noise.noise_dimensions = "3D"; n_var_noise.normalize = True
    n_var_noise.inputs["Scale"].default_value = 1.2
    n_var_noise.inputs["Detail"].default_value = 6.0
    n_var_noise.inputs["Roughness"].default_value = 0.55
    nt.links.new(n_geom.outputs["Position"], n_var_noise.inputs["Vector"])
    n_var_signed = add("ShaderNodeMapRange", -900, -300, clamp=True)
    n_var_signed.inputs["From Min"].default_value =  0.0
    n_var_signed.inputs["From Max"].default_value =  1.0
    n_var_signed.inputs["To Min"].default_value =   -0.10
    n_var_signed.inputs["To Max"].default_value =    0.10
    nt.links.new(n_var_noise.outputs["Fac"], n_var_signed.inputs["Value"])
    n_color_var = add("ShaderNodeBrightContrast", -200, -100)
    nt.links.new(n_mix_slope.outputs[2],            n_color_var.inputs["Color"])
    nt.links.new(n_var_signed.outputs["Result"],    n_color_var.inputs["Bright"])

    # --- wet-band darken near waterline -------------------------------
    # Triangular |z|-mask: peaks at z=0 (shoreline) and falls to 0 at
    # |z|≥2. Pulls saturation down on damp sand / wave-washed rock
    # without bleeding into the abyssal floor (~-25 m).
    n_wet_abs = add("ShaderNodeMath",        -1400, -600, operation="ABSOLUTE")
    nt.links.new(n_pos_xyz.outputs["Z"], n_wet_abs.inputs[0])
    n_wet_mr = add("ShaderNodeMapRange",     -1200, -600,
                   interpolation_type="SMOOTHSTEP", clamp=True)
    n_wet_mr.inputs["From Min"].default_value =  0.0
    n_wet_mr.inputs["From Max"].default_value =  2.0
    n_wet_mr.inputs["To Min"].default_value =    1.0
    n_wet_mr.inputs["To Max"].default_value =    0.0
    nt.links.new(n_wet_abs.outputs[0], n_wet_mr.inputs["Value"])
    n_wet_tint = add("ShaderNodeRGB", -900, -600)
    n_wet_tint.outputs[0].default_value = (0.78, 0.78, 0.82, 1.0)
    n_wet_mix = add("ShaderNodeMix", 100, -300, data_type="RGBA")
    n_wet_mix.blend_type = "MULTIPLY"
    n_wet_mix.clamp_factor = True
    nt.links.new(n_wet_mr.outputs["Result"], n_wet_mix.inputs[0])
    nt.links.new(n_color_var.outputs["Color"], n_wet_mix.inputs[6])
    nt.links.new(n_wet_tint.outputs[0],  n_wet_mix.inputs[7])

    nt.links.new(n_wet_mix.outputs[2], n_bsdf.inputs["Base Color"])

    # --- roughness: rocks rougher than sand / grass --------------------
    n_rough_mr = add("ShaderNodeMapRange", 300, -100, clamp=True)
    n_rough_mr.inputs["From Min"].default_value = 0.0
    n_rough_mr.inputs["From Max"].default_value = 1.0
    n_rough_mr.inputs["To Min"].default_value =   0.78
    n_rough_mr.inputs["To Max"].default_value =   0.95
    nt.links.new(n_slope_mr.outputs["Result"], n_rough_mr.inputs["Value"])
    nt.links.new(n_rough_mr.outputs["Result"], n_bsdf.inputs["Roughness"])

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


def add_water_preview() -> None:
    """Run the hoverbike addon's water-preview helper so the seeded scene
    opens with a visible water surface. Pure preview — lives in the
    addon's render-disabled collection and never reaches GLB export.

    Loads the addon from the disk path (``tools/blender/hoverbike_addon.py``)
    via ``importlib.util.spec_from_file_location`` rather than ``import
    hoverbike_addon``, because Blender's installed-addons directory may
    contain an older registered copy that gets picked up first and would
    otherwise produce a vertically-oriented water plane (pre Item 5 fix)."""
    import importlib.util
    addon_file = os.path.join(SCRIPT_DIR, "hoverbike_addon.py")
    if not os.path.exists(addon_file):
        print(f"[seed-template-island] WARNING: {addon_file} not found; skipping water preview")
        return
    spec = importlib.util.spec_from_file_location("hoverbike_addon_disk", addon_file)
    if spec is None or spec.loader is None:
        print(f"[seed-template-island] WARNING: could not load spec for {addon_file}; skipping water preview")
        return
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)

    summary = addon._rebuild_water_preview(
        bpy.context.scene,
        size=WATER_PREVIEW_SIZE,
        subdivisions=WATER_PREVIEW_SUBDIVISIONS,
        time=0.0,
    )
    print(f"[seed-template-island] water preview: {summary['vert_count']} verts centered on {summary['centered_on']}")


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

    bpy.context.view_layer.update()
    add_water_preview()
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
