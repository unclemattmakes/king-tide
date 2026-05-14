"""Seed ``tracks-src/template-dunes.blend`` — procedural desert-dune terrain.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_dunes.py

Compresses-altitude desert biome: rolling sand drifts (±15 m), a single
basin oasis (configurable depth + radius via a draggable empty), and a
sun-baked sandy palette. The hoverbike's water-on-impact effects fire
only inside the oasis basin; the rest of the map is dry desert. Players
race long, soft, swooping lines — the terrain rewards momentum rather
than precise braking.

### Why dunes (and not just "small island")

The island template's silhouette is dominated by tall lopsided volcanoes
rising out of open water. The dunes silhouette is the opposite — almost
no relief from above, a low-amplitude undulating sandscape with a single
visible water hole. Above-water terrain dominates; water is a point
feature, not a sea.

### Global modifier knobs (Properties → Modifier → HV_Dunes)

| Knob | Default | Purpose |
|---|---|---|
| Base Z | 20 m | Average sand-plane altitude. Tuned so dune troughs stay above the waterline (z=0); only the oasis basin shows water. |
| Large Dune | 10 m | Amplitude of the primary FBM dune layer (slow, broad drifts). |
| Large Scale | 0.006 | Frequency of the primary dune layer. Smaller = bigger dunes. |
| Mid Dune | 3.5 m | Mid-scale ridge amplitude. Adds drift-on-drift detail. |
| Mid Scale | 0.018 | Mid-scale ridge frequency. |
| Ripple | 0.5 m | Fine sand-ripple amplitude. Pure cosmetic; doesn't affect driving. |
| Ripple Scale | 0.12 | Ripple frequency (very tight). |
| Oasis Center | empty | Drag this empty to move the oasis basin. |
| Oasis Radius | 120 m | Inner radius of the basin (full depth). |
| Oasis Rim | 180 m | Outer radius of the basin (terrain returns to nominal). |
| Oasis Depth | -28 m | Floor depth relative to Base Z. Basin floor ends up at z ≈ -8 with defaults (8 m of water in the oasis). |
| Noise Seed | 0 | Re-roll for variation. |

### Authoring loop

1. Open ``tracks-src/template-dunes.blend``. The default scene has the
   basin centred at the origin (drag ``oasis_center`` to relocate it).
2. Tweak modifier knobs for dune scale / oasis size.
3. When the silhouette reads right, **Apply the modifier**, edit the AI
   spline / gates / starts on top, then export via the Hoverbike addon's
   *Export Track to Game*.

### COLOR_0 stamp

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | baked AO (default 1) |
| B | baked path-worn (default 0) |
| A | Biome index: 0.2 (oasis floor, z < -5) / 0.6 (mid-tone sand, -5 ≤ z < 2) / 1.0 (light sand, z ≥ 2) |
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
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-dunes.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 320  # slightly lower than island — dunes are smoother

# Oasis empty drives the basin location. Defaults centre it at origin
# so the bike's spawn line (south end) faces it.
OASIS_CENTER_DEFAULT = (0.0, 0.0, 0.0)

# Starter AI spline: a wide ring that loops around the oasis perimeter
# (≈ 250 m radius from centre) so the racing line skims the water.
# Z=22 sits just above the nominal dune surface (base 20 + ripple).
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -260.0, 22.0),
    ( 200.0, -180.0, 22.0),
    ( 290.0,    0.0, 22.0),
    ( 200.0,  180.0, 22.0),
    (   0.0,  260.0, 22.0),
    (-200.0,  180.0, 22.0),
    (-290.0,    0.0, 22.0),
    (-200.0, -180.0, 22.0),
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
START_Z = 22.0

CHECKPOINTS: list[tuple[float, float, float]] = [
    ( 280.0, -100.0, 22.0),
    ( 100.0,  280.0, 22.0),
    (-280.0,  100.0, 22.0),
    (-100.0, -280.0, 22.0),
]
CHECKPOINT_HALF_WIDTH = 16.0
CHECKPOINT_HEIGHT = 6.0

WATER_PREVIEW_SIZE = 360.0  # only the oasis is wet — tighter than island
WATER_PREVIEW_SUBDIVISIONS = 80

NODE_GROUP_NAME = "HV_TemplateDunes"


# ────────────────────────────────────────────────────────────────────
# Scene reset
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Terrain mesh — same 1024 m subdivided plane as island.
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

    # Pre-create the per-vertex attributes that the GN graph samples for
    # COLOR_0.G (AO) and COLOR_0.B (path-worn) — same convention as island.
    ao = mesh.attributes.new(name="baked_ao", type="FLOAT", domain="POINT")
    for i in range(len(ao.data)):
        ao.data[i].value = 1.0
    path = mesh.attributes.new(name="baked_path", type="FLOAT", domain="POINT")
    for i in range(len(path.data)):
        path.data[i].value = 0.0
    anchor = mesh.color_attributes.new(name="COLOR_0", type="FLOAT_COLOR", domain="POINT")
    for i in range(len(anchor.data)):
        anchor.data[i].color = (1.0, 1.0, 1.0, 1.0)
    mesh.color_attributes.active_color = anchor
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("COLOR_0")
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
# HV_TemplateDunes — pure-noise dune heightfield + oasis depression
# ────────────────────────────────────────────────────────────────────

def build_template_dunes_group() -> bpy.types.NodeTree:
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Geometry",     "INPUT", "NodeSocketGeometry")
    _new_socket(g, "Base Z",       "INPUT", "NodeSocketFloat",  20.0, -50.0,  100.0)
    _new_socket(g, "Large Dune",   "INPUT", "NodeSocketFloat",  10.0,   0.0,   60.0)
    _new_socket(g, "Large Scale",  "INPUT", "NodeSocketFloat",   0.006, 0.0001, 1.0)
    _new_socket(g, "Mid Dune",     "INPUT", "NodeSocketFloat",   3.5,   0.0,   30.0)
    _new_socket(g, "Mid Scale",    "INPUT", "NodeSocketFloat",   0.018, 0.0001, 1.0)
    _new_socket(g, "Ripple",       "INPUT", "NodeSocketFloat",   0.5,   0.0,    5.0)
    _new_socket(g, "Ripple Scale", "INPUT", "NodeSocketFloat",   0.12,  0.0001, 1.0)
    _new_socket(g, "Oasis Center", "INPUT", "NodeSocketObject")
    _new_socket(g, "Oasis Radius", "INPUT", "NodeSocketFloat", 120.0,   0.0, 1000.0)
    _new_socket(g, "Oasis Rim",    "INPUT", "NodeSocketFloat", 180.0,   0.0, 1000.0)
    _new_socket(g, "Oasis Depth",  "INPUT", "NodeSocketFloat", -28.0, -100.0,   0.0)
    _new_socket(g, "Noise Seed",   "INPUT", "NodeSocketFloat",   0.0,   0.0, 1000.0)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",   -1600,    0)
    p_out = _add_node(g, "NodeGroupOutput",   2800,    0)
    p_pos = _add_node(g, "GeometryNodeInputPosition", -1400, -200)

    # ── Large dune noise ───────────────────────────────────────────
    # NOTE: normalize=True on every layer. Unnormalized TexNoise output
    # is heavily skewed below 0.5, which gave the previous tuning a
    # ~-19 m mean bias (most dunes sat underwater). Normalizing clamps
    # to [0, 1] so the symmetric [0,1] → [-1,+1] remap below produces a
    # zero-mean dune amplitude as advertised.
    n_large = _add_node(g, "ShaderNodeTexNoise", -1200,   200)
    n_large.noise_dimensions = "4D"
    n_large.normalize = True
    n_large.inputs["Detail"].default_value = 4.0
    n_large.inputs["Roughness"].default_value = 0.55
    n_large.inputs["Distortion"].default_value = 0.4
    g.links.new(p_pos.outputs["Position"],   n_large.inputs["Vector"])
    g.links.new(p_in.outputs["Large Scale"], n_large.inputs["Scale"])
    g.links.new(p_in.outputs["Noise Seed"],  n_large.inputs["W"])
    # Signed remap: [0, 1] → [-1, +1]
    n_large_signed = _add_node(g, "ShaderNodeMath", -1000, 200, operation="MULTIPLY_ADD")
    n_large_signed.inputs[1].default_value =  2.0
    n_large_signed.inputs[2].default_value = -1.0
    g.links.new(n_large.outputs["Fac"], n_large_signed.inputs[0])
    n_large_amp = _add_node(g, "ShaderNodeMath", -800, 200, operation="MULTIPLY")
    g.links.new(n_large_signed.outputs[0],   n_large_amp.inputs[0])
    g.links.new(p_in.outputs["Large Dune"],  n_large_amp.inputs[1])

    # ── Mid dune noise ──────────────────────────────────────────────
    n_mid = _add_node(g, "ShaderNodeTexNoise", -1200, -200)
    n_mid.noise_dimensions = "4D"
    n_mid.normalize = True
    n_mid.inputs["Detail"].default_value = 4.0
    n_mid.inputs["Roughness"].default_value = 0.5
    n_mid.inputs["Distortion"].default_value = 0.3
    g.links.new(p_pos.outputs["Position"], n_mid.inputs["Vector"])
    g.links.new(p_in.outputs["Mid Scale"], n_mid.inputs["Scale"])
    # Seed-offset the mid noise so it doesn't correlate with large dunes.
    n_mid_seed = _add_node(g, "ShaderNodeMath", -1400, -300, operation="ADD")
    n_mid_seed.inputs[1].default_value = 137.0
    g.links.new(p_in.outputs["Noise Seed"], n_mid_seed.inputs[0])
    g.links.new(n_mid_seed.outputs[0], n_mid.inputs["W"])
    n_mid_signed = _add_node(g, "ShaderNodeMath", -1000, -200, operation="MULTIPLY_ADD")
    n_mid_signed.inputs[1].default_value =  2.0
    n_mid_signed.inputs[2].default_value = -1.0
    g.links.new(n_mid.outputs["Fac"], n_mid_signed.inputs[0])
    n_mid_amp = _add_node(g, "ShaderNodeMath", -800, -200, operation="MULTIPLY")
    g.links.new(n_mid_signed.outputs[0],  n_mid_amp.inputs[0])
    g.links.new(p_in.outputs["Mid Dune"], n_mid_amp.inputs[1])

    # ── Fine ripple noise ───────────────────────────────────────────
    n_rip = _add_node(g, "ShaderNodeTexNoise", -1200, -600)
    n_rip.noise_dimensions = "4D"
    n_rip.normalize = True
    n_rip.inputs["Detail"].default_value = 2.0
    n_rip.inputs["Roughness"].default_value = 0.4
    n_rip.inputs["Distortion"].default_value = 0.0
    g.links.new(p_pos.outputs["Position"],    n_rip.inputs["Vector"])
    g.links.new(p_in.outputs["Ripple Scale"], n_rip.inputs["Scale"])
    n_rip_seed = _add_node(g, "ShaderNodeMath", -1400, -700, operation="ADD")
    n_rip_seed.inputs[1].default_value = 271.0
    g.links.new(p_in.outputs["Noise Seed"], n_rip_seed.inputs[0])
    g.links.new(n_rip_seed.outputs[0], n_rip.inputs["W"])
    n_rip_signed = _add_node(g, "ShaderNodeMath", -1000, -600, operation="MULTIPLY_ADD")
    n_rip_signed.inputs[1].default_value =  2.0
    n_rip_signed.inputs[2].default_value = -1.0
    g.links.new(n_rip.outputs["Fac"], n_rip_signed.inputs[0])
    n_rip_amp = _add_node(g, "ShaderNodeMath", -800, -600, operation="MULTIPLY")
    g.links.new(n_rip_signed.outputs[0], n_rip_amp.inputs[0])
    g.links.new(p_in.outputs["Ripple"],  n_rip_amp.inputs[1])

    # ── Oasis depression ────────────────────────────────────────────
    # Read oasis_center.location → compute horizontal distance from vertex.
    n_oasis = _add_node(g, "GeometryNodeObjectInfo", -1400, -1100, transform_space="RELATIVE")
    g.links.new(p_in.outputs["Oasis Center"], n_oasis.inputs["Object"])
    n_oasis_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -1100)
    g.links.new(n_oasis.outputs["Location"], n_oasis_loc.inputs["Vector"])
    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -900)
    g.links.new(p_pos.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_dx = _add_node(g, "ShaderNodeMath", -1000, -900, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"],  n_dx.inputs[0])
    g.links.new(n_oasis_loc.outputs["X"], n_dx.inputs[1])
    n_dy = _add_node(g, "ShaderNodeMath", -1000, -1050, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"],  n_dy.inputs[0])
    g.links.new(n_oasis_loc.outputs["Y"], n_dy.inputs[1])
    n_dx2 = _add_node(g, "ShaderNodeMath", -800, -900, operation="POWER")
    n_dx2.inputs[1].default_value = 2.0
    g.links.new(n_dx.outputs[0], n_dx2.inputs[0])
    n_dy2 = _add_node(g, "ShaderNodeMath", -800, -1050, operation="POWER")
    n_dy2.inputs[1].default_value = 2.0
    g.links.new(n_dy.outputs[0], n_dy2.inputs[0])
    n_d_sum = _add_node(g, "ShaderNodeMath", -600, -1000, operation="ADD")
    g.links.new(n_dx2.outputs[0], n_d_sum.inputs[0])
    g.links.new(n_dy2.outputs[0], n_d_sum.inputs[1])
    n_d = _add_node(g, "ShaderNodeMath", -400, -1000, operation="SQRT")
    g.links.new(n_d_sum.outputs[0], n_d.inputs[0])

    # Map distance → depression amount:
    #   d ≤ radius        → full depth
    #   radius < d < rim  → smoothstep back up to 0
    #   d ≥ rim           → 0
    n_basin = _add_node(g, "ShaderNodeMapRange", -200, -1000,
                        interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d.outputs[0],               n_basin.inputs["Value"])
    g.links.new(p_in.outputs["Oasis Radius"], n_basin.inputs["From Min"])
    g.links.new(p_in.outputs["Oasis Rim"],    n_basin.inputs["From Max"])
    g.links.new(p_in.outputs["Oasis Depth"],  n_basin.inputs["To Min"])
    n_basin.inputs["To Max"].default_value = 0.0

    # ── Sum it all up ───────────────────────────────────────────────
    n_sum1 = _add_node(g, "ShaderNodeMath", -200, 200, operation="ADD")
    g.links.new(p_in.outputs["Base Z"],    n_sum1.inputs[0])
    g.links.new(n_large_amp.outputs[0],   n_sum1.inputs[1])
    n_sum2 = _add_node(g, "ShaderNodeMath", 0, 100, operation="ADD")
    g.links.new(n_sum1.outputs[0],   n_sum2.inputs[0])
    g.links.new(n_mid_amp.outputs[0], n_sum2.inputs[1])
    n_sum3 = _add_node(g, "ShaderNodeMath", 200, 0, operation="ADD")
    g.links.new(n_sum2.outputs[0],   n_sum3.inputs[0])
    g.links.new(n_rip_amp.outputs[0], n_sum3.inputs[1])
    n_sum4 = _add_node(g, "ShaderNodeMath", 400, -200, operation="ADD")
    g.links.new(n_sum3.outputs[0],          n_sum4.inputs[0])
    g.links.new(n_basin.outputs["Result"], n_sum4.inputs[1])

    # ── Set Position ────────────────────────────────────────────────
    n_comb = _add_node(g, "ShaderNodeCombineXYZ", 700, -200)
    g.links.new(n_sum4.outputs[0], n_comb.inputs["Z"])
    n_setpos = _add_node(g, "GeometryNodeSetPosition", 1000, 0)
    g.links.new(p_in.outputs["Geometry"], n_setpos.inputs["Geometry"])
    g.links.new(n_comb.outputs["Vector"], n_setpos.inputs["Offset"])

    # ── Biome stamp (sand bands) ────────────────────────────────────
    # 0.2: deep oasis (z < -3)   — wet basin floor
    # 0.6: shore band (-3 .. 5)  — damp sand fringe
    # 1.0: bright sand (z ≥ 5)   — sun-blasted dune crests
    n_pos2 = _add_node(g, "GeometryNodeInputPosition", 1200, -300)
    n_pos2_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 1400, -300)
    g.links.new(n_pos2.outputs["Position"], n_pos2_xyz.inputs["Vector"])
    n_b1 = _add_node(g, "ShaderNodeMath", 1600, -200, operation="GREATER_THAN")
    n_b1.inputs[1].default_value = -3.0
    g.links.new(n_pos2_xyz.outputs["Z"], n_b1.inputs[0])
    n_b2 = _add_node(g, "ShaderNodeMath", 1600, -350, operation="GREATER_THAN")
    n_b2.inputs[1].default_value = 5.0
    g.links.new(n_pos2_xyz.outputs["Z"], n_b2.inputs[0])
    # Output: 0.2 + 0.4*b1 + 0.4*b2
    n_b1m = _add_node(g, "ShaderNodeMath", 1800, -200, operation="MULTIPLY")
    n_b1m.inputs[1].default_value = 0.4
    g.links.new(n_b1.outputs[0], n_b1m.inputs[0])
    n_b2m = _add_node(g, "ShaderNodeMath", 1800, -350, operation="MULTIPLY")
    n_b2m.inputs[1].default_value = 0.4
    g.links.new(n_b2.outputs[0], n_b2m.inputs[0])
    n_biome_sum = _add_node(g, "ShaderNodeMath", 2000, -250, operation="ADD")
    g.links.new(n_b1m.outputs[0], n_biome_sum.inputs[0])
    g.links.new(n_b2m.outputs[0], n_biome_sum.inputs[1])
    n_biome = _add_node(g, "ShaderNodeMath", 2200, -250, operation="ADD")
    n_biome.inputs[1].default_value = 0.2
    g.links.new(n_biome_sum.outputs[0], n_biome.inputs[0])

    n_zero_p = _add_node(g, "ShaderNodeValue", 2200, -625)
    n_zero_p.outputs[0].default_value = 0.0
    n_ao_attr = _add_node(g, "GeometryNodeInputNamedAttribute", 2200, -775, data_type="FLOAT")
    n_ao_attr.inputs["Name"].default_value = "baked_ao"
    n_path_attr = _add_node(g, "GeometryNodeInputNamedAttribute", 2200, -925, data_type="FLOAT")
    n_path_attr.inputs["Name"].default_value = "baked_path"
    n_color = _add_node(g, "FunctionNodeCombineColor", 2400, -300, mode="RGB")
    g.links.new(n_zero_p.outputs[0],            n_color.inputs["Red"])
    g.links.new(n_ao_attr.outputs["Attribute"], n_color.inputs["Green"])
    g.links.new(n_path_attr.outputs["Attribute"], n_color.inputs["Blue"])
    g.links.new(n_biome.outputs[0],             n_color.inputs["Alpha"])

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
    mod = terrain.modifiers.new("HV_Dunes", "NODES")
    mod.node_group = ng
    return mod


def bind_oasis_input(mod: bpy.types.Modifier, ng: bpy.types.NodeTree) -> None:
    ids = {}
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) == "SOCKET" and getattr(item, "in_out", None) == "INPUT":
            ids[item.name] = item.identifier
    oasis = bpy.data.objects.get("oasis_center")
    if oasis is not None:
        mod[ids["Oasis Center"]] = oasis


# ────────────────────────────────────────────────────────────────────
# Scene objects
# ────────────────────────────────────────────────────────────────────

def add_oasis_empty() -> None:
    obj = bpy.data.objects.new("oasis_center", None)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 30.0
    obj.location = OASIS_CENTER_DEFAULT
    obj["kind"] = "oasis_center"
    bpy.context.scene.collection.objects.link(obj)


def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, 0.0)
    # Water volume size — covers the oasis basin (~360m diameter is plenty).
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.4   # calmer than coastal — desert oasis
    obj["wave_freq"] = 0.6
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


def _sample_spline_at_t(t: float):
    anchors = AI_SPLINE_ANCHORS
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
    return (pts[0][0], pts[0][1]), (0.0, 1.0)


def add_player_starts() -> None:
    (sx, sy), (tx, ty) = _sample_spline_at_t(START_T)
    yaw = math.atan2(tx, ty)
    rx, ry = ty, -tx
    for i, off in enumerate([-START_GRID_SPACING_M * 0.5, +START_GRID_SPACING_M * 0.5]):
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
    light_data.energy = 5.5  # harsh desert sun
    light_data.color = (1.0, 0.95, 0.86)
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.4, 0.2, 0.0)  # higher in the sky than tropical
    bpy.context.scene.collection.objects.link(obj)


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Sand-tone shader. Slope drives a subtle darken on dune faces (so the
    silhouette reads from above); altitude bands sand → wet sand → oasis
    floor. Variation noise breaks the bands. No cliff stratum — this biome
    is pure soft drifts."""
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

    # COLOR_0 anchor (same trick as island — keeps glTF's color-export
    # heuristic engaged so the GN-stamped attribute ships in the .glb).
    n_color0 = add("ShaderNodeAttribute", -1600, 500)
    n_color0.attribute_name = "COLOR_0"
    nt.links.new(n_color0.outputs["Color"], n_bsdf.inputs["Emission Color"])
    n_bsdf.inputs["Emission Strength"].default_value = 0.0

    n_geom = add("ShaderNodeNewGeometry", -1600,  200)
    n_pos_xyz = add("ShaderNodeSeparateXYZ", -1400,  300)
    nt.links.new(n_geom.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_nrm_xyz = add("ShaderNodeSeparateXYZ", -1400,    0)
    nt.links.new(n_geom.outputs["Normal"], n_nrm_xyz.inputs["Vector"])

    # Slope mask — gentle: most desert is shallow. 0.95→0.75 ≈ 18°→40°.
    n_slope = add("ShaderNodeMapRange", -1200, 0,
                  interpolation_type="SMOOTHSTEP", clamp=True)
    n_slope.inputs["From Min"].default_value = 0.95
    n_slope.inputs["From Max"].default_value = 0.75
    n_slope.inputs["To Min"].default_value =   0.0
    n_slope.inputs["To Max"].default_value =   1.0
    nt.links.new(n_nrm_xyz.outputs["Z"], n_slope.inputs["Value"])

    # Altitude → ramp: z ∈ [-10, 35] → [0, 1] (oasis floor → dune crest)
    n_alt = add("ShaderNodeMapRange", -1200, 300, clamp=True)
    n_alt.inputs["From Min"].default_value = -10.0
    n_alt.inputs["From Max"].default_value =  35.0
    n_alt.inputs["To Min"].default_value =     0.0
    n_alt.inputs["To Max"].default_value =     1.0
    nt.links.new(n_pos_xyz.outputs["Z"], n_alt.inputs["Value"])

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

    # Flat ramp: oasis floor (silty mud) → wet sand → dry sand → highlights.
    n_flat_ramp = _ramp(-800, 400, [
        (0.000, (0.18, 0.20, 0.22, 1.0)),   # oasis floor (z=-25) — dark silt
        (0.290, (0.32, 0.30, 0.25, 1.0)),   # shallow oasis (z=-6)
        (0.385, (0.74, 0.65, 0.45, 1.0)),   # wet sand rim (z=0)
        (0.460, (0.90, 0.78, 0.52, 1.0)),   # damp sand (z=5)
        (0.620, (0.95, 0.85, 0.60, 1.0)),   # bright dune (z=15)
        (1.000, (1.00, 0.93, 0.75, 1.0)),   # sun-blasted crest (z=40)
    ])
    nt.links.new(n_alt.outputs["Result"], n_flat_ramp.inputs["Fac"])

    # Steep face — slightly darker / cooler (sand shadow on lee slopes).
    n_steep_ramp = _ramp(-800, 100, [
        (0.000, (0.16, 0.16, 0.18, 1.0)),   # wet oasis cliff
        (0.290, (0.38, 0.32, 0.24, 1.0)),
        (0.385, (0.62, 0.50, 0.34, 1.0)),
        (0.620, (0.75, 0.62, 0.42, 1.0)),
        (1.000, (0.82, 0.70, 0.50, 1.0)),
    ])
    nt.links.new(n_alt.outputs["Result"], n_steep_ramp.inputs["Fac"])

    n_mix = add("ShaderNodeMix", -400, 250, data_type="RGBA")
    n_mix.blend_type = "MIX"
    n_mix.clamp_factor = True
    nt.links.new(n_slope.outputs["Result"], n_mix.inputs[0])
    nt.links.new(n_flat_ramp.outputs["Color"],  n_mix.inputs[6])
    nt.links.new(n_steep_ramp.outputs["Color"], n_mix.inputs[7])

    # Variation noise — breaks the ramp banding on the dune crests.
    n_var_noise = add("ShaderNodeTexNoise", -1200, -300)
    n_var_noise.noise_dimensions = "3D"; n_var_noise.normalize = True
    n_var_noise.inputs["Scale"].default_value = 1.8
    n_var_noise.inputs["Detail"].default_value = 4.0
    n_var_noise.inputs["Roughness"].default_value = 0.5
    nt.links.new(n_geom.outputs["Position"], n_var_noise.inputs["Vector"])
    n_var_signed = add("ShaderNodeMapRange", -900, -300, clamp=True)
    n_var_signed.inputs["From Min"].default_value =  0.0
    n_var_signed.inputs["From Max"].default_value =  1.0
    n_var_signed.inputs["To Min"].default_value =   -0.06
    n_var_signed.inputs["To Max"].default_value =    0.06
    nt.links.new(n_var_noise.outputs["Fac"], n_var_signed.inputs["Value"])
    n_color_var = add("ShaderNodeBrightContrast", -200, -100)
    nt.links.new(n_mix.outputs[2],               n_color_var.inputs["Color"])
    nt.links.new(n_var_signed.outputs["Result"], n_color_var.inputs["Bright"])

    nt.links.new(n_color_var.outputs["Color"], n_bsdf.inputs["Base Color"])

    # Roughness — sand is rough everywhere; oasis floor wetter (lower).
    n_rough = add("ShaderNodeMapRange", 300, -100, clamp=True)
    n_rough.inputs["From Min"].default_value = 0.0
    n_rough.inputs["From Max"].default_value = 1.0
    n_rough.inputs["To Min"].default_value =   0.55  # wet floor
    n_rough.inputs["To Max"].default_value =   0.92  # dry crest
    nt.links.new(n_alt.outputs["Result"], n_rough.inputs["Value"])
    nt.links.new(n_rough.outputs["Result"], n_bsdf.inputs["Roughness"])

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
    col_oasis    = ensure("Oasis")
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
        elif obj.name == "oasis_center":
            move(obj, col_oasis)
        elif obj.name == "water_volume_main":
            move(obj, col_water)
        elif obj.name in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif obj.name.startswith(("start_", "cp_", "pickup_")):
            move(obj, col_gameplay)


def _load_addon_module():
    import importlib.util
    addon_file = os.path.join(SCRIPT_DIR, "hoverbike_addon.py")
    if not os.path.exists(addon_file):
        print(f"[seed-template-dunes] WARNING: {addon_file} not found; skipping previews")
        return None
    spec = importlib.util.spec_from_file_location("hoverbike_addon_disk", addon_file)
    if spec is None or spec.loader is None:
        print(f"[seed-template-dunes] WARNING: could not load spec for {addon_file}; skipping previews")
        return None
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    return addon


def add_previews() -> None:
    addon = _load_addon_module()
    if addon is None:
        return
    scene = bpy.context.scene

    summary = addon._rebuild_water_preview(
        scene,
        size=WATER_PREVIEW_SIZE,
        subdivisions=WATER_PREVIEW_SUBDIVISIONS,
        time=0.0,
    )
    print(f"[seed-template-dunes] water preview: {summary['vert_count']} verts centered on {summary['centered_on']}")

    n_gates = addon._rebuild_gate_preview(
        scene,
        spacing=60.0,
        half_width=14.0,
        height=6.0,
    )
    print(f"[seed-template-dunes] gate preview: {n_gates} gates at 60.0m spacing")

    racer_summary = addon._rebuild_racer_preview(scene)
    print(
        "[seed-template-dunes] racer preview: "
        f"1 player + {racer_summary['ai_count']} AI bikes "
        f"({racer_summary['grid_source']})"
    )

    turn_summary = addon._rebuild_turn_indicators(
        scene,
        kappa_threshold=0.02,
        min_spacing_m=20.0,
    )
    print(f"[seed-template-dunes] turn indicators: {turn_summary['peak_count']} chevrons")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-dunes] writing {OUTPUT_PATH}")
    reset_scene()
    terrain = build_terrain_mesh()
    ng = build_template_dunes_group()
    mod = attach_modifier(terrain, ng)
    add_oasis_empty()
    bind_oasis_input(mod, ng)
    add_water_volume()
    add_ai_spline()
    add_player_starts()
    add_checkpoints()
    add_sun()
    build_terrain_material(terrain)
    organize_collections()

    bpy.context.view_layer.update()
    add_previews()
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-template-dunes] done")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"[seed-template-dunes] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
