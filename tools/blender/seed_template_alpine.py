"""Seed ``tracks-src/template-alpine.blend`` — procedural alpine-valley terrain.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_alpine.py

Two long parallel ridges flanking a river-canyon valley floor. Each
ridge is defined by **two empties** at its endpoints — drag them in
the viewport to reshape the mountain range:

| Empty | Field | Encoded value |
|---|---|---|
| ``ridge_NN_a`` (CONE) | ``location.xy`` | Endpoint A in world XY. |
|                       | ``location.z``  | Ridge crest height at endpoint A (m). |
|                       | ``scale.x``     | Ridge half-width (perpendicular to the line, m). |
| ``ridge_NN_b`` (CONE) | ``location.xyz`` | Endpoint B (xy + crest height). |

Each vertex inside the ridge's flat-top band (perpendicular distance ≤
``ridge.scale.x``) sits at the linearly-interpolated crest altitude
along the segment AB. Inside the cliff band (extra ``Cliff Width`` m
beyond the half-width) the height smoothsteps down to the
``Valley Floor`` scalar. Outside both bands the vertex sits at the
valley floor + a low-amplitude bed-rock noise.

The default scene has two ridges flanking a central E-W valley at
y=0; the racing line runs along the valley floor.

### Global modifier knobs (Properties → Modifier → HV_Alpine)

| Knob | Default | Purpose |
|---|---|---|
| Valley Floor | -5 m | Mean valley-floor altitude. Below water (z=0) ⇒ visible river. |
| Cliff Width | 15 m | Smoothstep band between ridge crest and valley floor. |
| Crest Noise | 4 m | Random ripple amplitude stamped on ridge crests (snowy crags). |
| Crest Scale | 0.025 | Crest noise frequency. |
| Valley Noise | 1.0 m | Random ripple amplitude on the valley bed. |
| Valley Scale | 0.04 | Valley noise frequency. |
| Noise Seed | 0 | Re-roll for noise variation. |

### COLOR_0 stamp

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | baked AO (default 1) |
| B | baked path-worn (default 0) |
| A | Biome index: 0.0 (river z < -1) / 0.33 (valley grass 0..15) / 0.67 (cliff rock 15..70) / 1.0 (snow z ≥ 70) |
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-alpine.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 384

# Starter ridges. Each entry: (idx, A_xyz, B_xyz, half_width).
# A.z / B.z are the crest heights at each endpoint (linearly
# interpolated along the segment). half_width = ridge.scale.x.
# Defaults: 2 active ridges (N + S) flanking a central E-W valley,
# 2 inert slots for future tuning.
RIDGES: list[tuple[str, tuple[float, float, float], tuple[float, float, float], float]] = [
    ("00", (-350.0, +150.0,  75.0), (+350.0, +150.0, 105.0), 80.0),  # N ridge
    ("01", (-350.0, -150.0, 105.0), (+350.0, -150.0,  75.0), 80.0),  # S ridge
    ("02", (   0.0,    0.0,   0.0), (   0.0,    0.0,   0.0),  0.0),  # inert
    ("03", (   0.0,    0.0,   0.0), (   0.0,    0.0,   0.0),  0.0),  # inert
]

# Starter racing line: an elongated oval inside the valley. North leg
# at y=+30 (close to but not touching the N cliff), south leg at y=-30,
# tight U-turns at x=±440 (past the ridge ends at x=±350). The
# snap-spline pass clamps z to the river surface.
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (-400.0, +30.0, -2.0),  # north straight start
    ( -50.0, +30.0, -2.0),
    ( +400.0, +30.0, -2.0),  # east end of north straight
    ( +450.0,   0.0, -2.0),  # east U-turn apex
    ( +400.0, -30.0, -2.0),  # start of south straight
    (   0.0, -30.0, -2.0),
    ( -400.0, -30.0, -2.0),  # west end of south straight
    ( -450.0,   0.0, -2.0),  # west U-turn apex
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
START_Z = -2.0

CHECKPOINTS: list[tuple[float, float, float]] = [
    ( +400.0, +30.0, -2.0),
    ( +400.0, -30.0, -2.0),
    ( -400.0, -30.0, -2.0),
    ( -400.0, +30.0, -2.0),
]
CHECKPOINT_HALF_WIDTH = 18.0
CHECKPOINT_HEIGHT = 8.0

WATER_PREVIEW_SIZE = 900.0
WATER_PREVIEW_SUBDIVISIONS = 160

NODE_GROUP_NAME = "HV_TemplateAlpine"
RIDGE_SUBGROUP_NAME = "HV_RidgeProfile"


# ────────────────────────────────────────────────────────────────────
# Scene reset + terrain mesh (same shape as other templates)
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


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
# HV_RidgeProfile — per-ridge linear-line height contribution
# ────────────────────────────────────────────────────────────────────

def build_ridge_profile_group() -> bpy.types.NodeTree:
    """Per-ridge height contribution. Reads two endpoint empties
    (Ridge A, Ridge B). Computes the perpendicular distance from the
    vertex's XY to the line segment AB, plus the parameter t along AB
    (clamped to [0, 1]). Lerps the ridge crest height between A.z and
    B.z by t. Smoothsteps from crest to ``Valley Floor`` across the
    cliff band beyond the ridge half-width (= A.scale.x).

    Output equals Valley Floor for vertices outside the cliff band —
    so the parent's MAX cascade picks up the floor cleanly when the
    vertex isn't under any ridge.
    Inactive slots (A.scale.x ≤ 0.01) emit the sentinel."""
    if RIDGE_SUBGROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[RIDGE_SUBGROUP_NAME])
    g = bpy.data.node_groups.new(RIDGE_SUBGROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Position",     "INPUT", "NodeSocketVector")
    _new_socket(g, "Ridge A",      "INPUT", "NodeSocketObject")
    _new_socket(g, "Ridge B",      "INPUT", "NodeSocketObject")
    _new_socket(g, "Cliff Width",  "INPUT", "NodeSocketFloat", 15.0)
    _new_socket(g, "Crest Noise",  "INPUT", "NodeSocketFloat",  4.0)
    _new_socket(g, "Crest Scale",  "INPUT", "NodeSocketFloat",  0.025)
    _new_socket(g, "Noise Seed",   "INPUT", "NodeSocketFloat",  0.0)
    _new_socket(g, "Valley Floor", "INPUT", "NodeSocketFloat", -5.0)
    _new_socket(g, "Sentinel",     "INPUT", "NodeSocketFloat", -10000.0)
    _new_socket(g, "Height",       "OUTPUT", "NodeSocketFloat")

    gi = _add_node(g, "NodeGroupInput",  -1800, 0)
    go = _add_node(g, "NodeGroupOutput",  1800, 0)

    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -1600, -200)
    g.links.new(gi.outputs["Position"], n_pos_xyz.inputs["Vector"])

    # Ridge A info
    n_a_info = _add_node(g, "GeometryNodeObjectInfo", -1600, -500, transform_space="RELATIVE")
    g.links.new(gi.outputs["Ridge A"], n_a_info.inputs["Object"])
    n_a_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1400, -500)
    g.links.new(n_a_info.outputs["Location"], n_a_loc.inputs["Vector"])
    n_a_scl = _add_node(g, "ShaderNodeSeparateXYZ", -1400, -700)
    g.links.new(n_a_info.outputs["Scale"], n_a_scl.inputs["Vector"])

    # Ridge B info
    n_b_info = _add_node(g, "GeometryNodeObjectInfo", -1600, -900, transform_space="RELATIVE")
    g.links.new(gi.outputs["Ridge B"], n_b_info.inputs["Object"])
    n_b_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1400, -900)
    g.links.new(n_b_info.outputs["Location"], n_b_loc.inputs["Vector"])

    # AB vector (in XY)
    n_abx = _add_node(g, "ShaderNodeMath", -1200, -500, operation="SUBTRACT")
    g.links.new(n_b_loc.outputs["X"], n_abx.inputs[0])
    g.links.new(n_a_loc.outputs["X"], n_abx.inputs[1])
    n_aby = _add_node(g, "ShaderNodeMath", -1200, -650, operation="SUBTRACT")
    g.links.new(n_b_loc.outputs["Y"], n_aby.inputs[0])
    g.links.new(n_a_loc.outputs["Y"], n_aby.inputs[1])

    # |AB|^2 (avoid division by zero with MAX(.,1e-6))
    n_abx2 = _add_node(g, "ShaderNodeMath", -1000, -500, operation="POWER")
    n_abx2.inputs[1].default_value = 2.0
    g.links.new(n_abx.outputs[0], n_abx2.inputs[0])
    n_aby2 = _add_node(g, "ShaderNodeMath", -1000, -650, operation="POWER")
    n_aby2.inputs[1].default_value = 2.0
    g.links.new(n_aby.outputs[0], n_aby2.inputs[0])
    n_absq_raw = _add_node(g, "ShaderNodeMath", -800, -575, operation="ADD")
    g.links.new(n_abx2.outputs[0], n_absq_raw.inputs[0])
    g.links.new(n_aby2.outputs[0], n_absq_raw.inputs[1])
    n_absq = _add_node(g, "ShaderNodeMath", -600, -575, operation="MAXIMUM")
    n_absq.inputs[1].default_value = 1.0e-6
    g.links.new(n_absq_raw.outputs[0], n_absq.inputs[0])

    # AP = P - A (in XY)
    n_apx = _add_node(g, "ShaderNodeMath", -1200, -200, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"], n_apx.inputs[0])
    g.links.new(n_a_loc.outputs["X"],   n_apx.inputs[1])
    n_apy = _add_node(g, "ShaderNodeMath", -1200, -350, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"], n_apy.inputs[0])
    g.links.new(n_a_loc.outputs["Y"],   n_apy.inputs[1])

    # AP · AB
    n_apx_abx = _add_node(g, "ShaderNodeMath", -1000, -200, operation="MULTIPLY")
    g.links.new(n_apx.outputs[0], n_apx_abx.inputs[0])
    g.links.new(n_abx.outputs[0], n_apx_abx.inputs[1])
    n_apy_aby = _add_node(g, "ShaderNodeMath", -1000, -350, operation="MULTIPLY")
    g.links.new(n_apy.outputs[0], n_apy_aby.inputs[0])
    g.links.new(n_aby.outputs[0], n_apy_aby.inputs[1])
    n_dot = _add_node(g, "ShaderNodeMath", -800, -275, operation="ADD")
    g.links.new(n_apx_abx.outputs[0], n_dot.inputs[0])
    g.links.new(n_apy_aby.outputs[0], n_dot.inputs[1])

    # t = clamp(dot / |AB|^2, 0, 1)
    n_t_unclamped = _add_node(g, "ShaderNodeMath", -600, -275, operation="DIVIDE")
    g.links.new(n_dot.outputs[0],   n_t_unclamped.inputs[0])
    g.links.new(n_absq.outputs[0],  n_t_unclamped.inputs[1])
    n_t = _add_node(g, "ShaderNodeClamp", -400, -275)
    n_t.inputs["Min"].default_value = 0.0
    n_t.inputs["Max"].default_value = 1.0
    g.links.new(n_t_unclamped.outputs[0], n_t.inputs["Value"])

    # closest_x = A.x + t * AB.x, closest_y = A.y + t * AB.y
    n_tx = _add_node(g, "ShaderNodeMath", -200, -200, operation="MULTIPLY")
    g.links.new(n_t.outputs["Result"], n_tx.inputs[0])
    g.links.new(n_abx.outputs[0],      n_tx.inputs[1])
    n_ty = _add_node(g, "ShaderNodeMath", -200, -350, operation="MULTIPLY")
    g.links.new(n_t.outputs["Result"], n_ty.inputs[0])
    g.links.new(n_aby.outputs[0],      n_ty.inputs[1])
    n_cx = _add_node(g, "ShaderNodeMath", 0, -200, operation="ADD")
    g.links.new(n_a_loc.outputs["X"], n_cx.inputs[0])
    g.links.new(n_tx.outputs[0],      n_cx.inputs[1])
    n_cy = _add_node(g, "ShaderNodeMath", 0, -350, operation="ADD")
    g.links.new(n_a_loc.outputs["Y"], n_cy.inputs[0])
    g.links.new(n_ty.outputs[0],      n_cy.inputs[1])

    # d_perp = |P - closest|
    n_dpx = _add_node(g, "ShaderNodeMath", 200, -200, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"], n_dpx.inputs[0])
    g.links.new(n_cx.outputs[0],        n_dpx.inputs[1])
    n_dpy = _add_node(g, "ShaderNodeMath", 200, -350, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"], n_dpy.inputs[0])
    g.links.new(n_cy.outputs[0],        n_dpy.inputs[1])
    n_dpx2 = _add_node(g, "ShaderNodeMath", 400, -200, operation="POWER")
    n_dpx2.inputs[1].default_value = 2.0
    g.links.new(n_dpx.outputs[0], n_dpx2.inputs[0])
    n_dpy2 = _add_node(g, "ShaderNodeMath", 400, -350, operation="POWER")
    n_dpy2.inputs[1].default_value = 2.0
    g.links.new(n_dpy.outputs[0], n_dpy2.inputs[0])
    n_d_sum = _add_node(g, "ShaderNodeMath", 600, -275, operation="ADD")
    g.links.new(n_dpx2.outputs[0], n_d_sum.inputs[0])
    g.links.new(n_dpy2.outputs[0], n_d_sum.inputs[1])
    n_d = _add_node(g, "ShaderNodeMath", 800, -275, operation="SQRT")
    g.links.new(n_d_sum.outputs[0], n_d.inputs[0])

    # Falloff: 1 inside half_width (= A.scale.x), 0 outside (half + cliff)
    n_outer = _add_node(g, "ShaderNodeMath", 600, -500, operation="ADD")
    g.links.new(n_a_scl.outputs["X"],     n_outer.inputs[0])
    g.links.new(gi.outputs["Cliff Width"], n_outer.inputs[1])
    n_falloff = _add_node(g, "ShaderNodeMapRange", 800, -500,
                          interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d.outputs[0],          n_falloff.inputs["Value"])
    g.links.new(n_a_scl.outputs["X"],    n_falloff.inputs["From Min"])
    g.links.new(n_outer.outputs[0],      n_falloff.inputs["From Max"])
    n_falloff.inputs["To Min"].default_value = 1.0
    n_falloff.inputs["To Max"].default_value = 0.0

    # Crest height at this t (lerp of A.z, B.z)
    n_dh = _add_node(g, "ShaderNodeMath", -400, -550, operation="SUBTRACT")
    g.links.new(n_b_loc.outputs["Z"], n_dh.inputs[0])
    g.links.new(n_a_loc.outputs["Z"], n_dh.inputs[1])
    n_dh_t = _add_node(g, "ShaderNodeMath", -200, -550, operation="MULTIPLY")
    g.links.new(n_t.outputs["Result"], n_dh_t.inputs[0])
    g.links.new(n_dh.outputs[0],       n_dh_t.inputs[1])
    n_crest = _add_node(g, "ShaderNodeMath", 0, -550, operation="ADD")
    g.links.new(n_a_loc.outputs["Z"], n_crest.inputs[0])
    g.links.new(n_dh_t.outputs[0],    n_crest.inputs[1])

    # Crest noise — adds craggy ripple to the ridge top. Per-ridge seed
    # = noise_seed + A.location.x (de-correlates ridges).
    n_crest_noise = _add_node(g, "ShaderNodeTexNoise", 0, -800)
    n_crest_noise.noise_dimensions = "4D"
    n_crest_noise.normalize = True
    n_crest_noise.inputs["Detail"].default_value = 3.0
    n_crest_noise.inputs["Roughness"].default_value = 0.5
    n_crest_noise.inputs["Distortion"].default_value = 0.3
    g.links.new(gi.outputs["Position"],     n_crest_noise.inputs["Vector"])
    g.links.new(gi.outputs["Crest Scale"],  n_crest_noise.inputs["Scale"])
    n_crest_seed = _add_node(g, "ShaderNodeMath", -200, -900, operation="ADD")
    g.links.new(gi.outputs["Noise Seed"], n_crest_seed.inputs[0])
    g.links.new(n_a_loc.outputs["X"],     n_crest_seed.inputs[1])
    g.links.new(n_crest_seed.outputs[0],  n_crest_noise.inputs["W"])
    n_crest_signed = _add_node(g, "ShaderNodeMath", 200, -800, operation="MULTIPLY_ADD")
    n_crest_signed.inputs[1].default_value =  2.0
    n_crest_signed.inputs[2].default_value = -1.0
    g.links.new(n_crest_noise.outputs["Fac"], n_crest_signed.inputs[0])
    n_crest_amp = _add_node(g, "ShaderNodeMath", 400, -800, operation="MULTIPLY")
    g.links.new(n_crest_signed.outputs[0], n_crest_amp.inputs[0])
    g.links.new(gi.outputs["Crest Noise"], n_crest_amp.inputs[1])
    # Gate noise by falloff so it only affects vertices on or near the ridge.
    n_crest_masked = _add_node(g, "ShaderNodeMath", 600, -800, operation="MULTIPLY")
    g.links.new(n_crest_amp.outputs[0],       n_crest_masked.inputs[0])
    g.links.new(n_falloff.outputs["Result"], n_crest_masked.inputs[1])

    # height = lerp(valley_floor, crest + crest_noise * falloff, falloff)
    #        = valley_floor + falloff * (crest - valley_floor) + crest_noise * falloff
    n_diff = _add_node(g, "ShaderNodeMath", 200, -550, operation="SUBTRACT")
    g.links.new(n_crest.outputs[0],         n_diff.inputs[0])
    g.links.new(gi.outputs["Valley Floor"], n_diff.inputs[1])
    n_lerp_part = _add_node(g, "ShaderNodeMath", 400, -550, operation="MULTIPLY")
    g.links.new(n_falloff.outputs["Result"], n_lerp_part.inputs[0])
    g.links.new(n_diff.outputs[0],            n_lerp_part.inputs[1])
    n_lerp_total = _add_node(g, "ShaderNodeMath", 600, -550, operation="ADD")
    g.links.new(gi.outputs["Valley Floor"], n_lerp_total.inputs[0])
    g.links.new(n_lerp_part.outputs[0],     n_lerp_total.inputs[1])
    n_height = _add_node(g, "ShaderNodeMath", 800, -550, operation="ADD")
    g.links.new(n_lerp_total.outputs[0],   n_height.inputs[0])
    g.links.new(n_crest_masked.outputs[0], n_height.inputs[1])

    # Active gate: scale.x > 0.01
    n_active = _add_node(g, "ShaderNodeMath", 1000, -800, operation="GREATER_THAN")
    n_active.inputs[1].default_value = 0.01
    g.links.new(n_a_scl.outputs["X"], n_active.inputs[0])
    n_mix = _add_node(g, "ShaderNodeMix", 1200, -550)
    n_mix.data_type = "FLOAT"
    n_mix.clamp_factor = False
    g.links.new(n_active.outputs[0],    n_mix.inputs[0])
    g.links.new(gi.outputs["Sentinel"], n_mix.inputs["A"])
    g.links.new(n_height.outputs[0],    n_mix.inputs["B"])
    g.links.new(n_mix.outputs[0], go.inputs["Height"])

    return g


# ────────────────────────────────────────────────────────────────────
# HV_TemplateAlpine — 4-ridge unroll + valley-floor noise + biome stamp
# ────────────────────────────────────────────────────────────────────

def build_template_alpine_group(sub: bpy.types.NodeTree) -> bpy.types.NodeTree:
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")
    # Required so the group is selectable in the GN modifier dropdown.
    # HV_RidgeProfile (the inner sub-group) stays is_modifier=False —
    # it's never attached directly. See seed_template_island.py for the
    # full rationale.
    g.is_modifier = True

    _new_socket(g, "Geometry", "INPUT", "NodeSocketGeometry")
    for i in range(4):
        _new_socket(g, f"Ridge {i}A", "INPUT", "NodeSocketObject")
        _new_socket(g, f"Ridge {i}B", "INPUT", "NodeSocketObject")
    _new_socket(g, "Valley Floor", "INPUT", "NodeSocketFloat", -5.0, -50.0,  20.0)
    _new_socket(g, "Cliff Width",  "INPUT", "NodeSocketFloat", 15.0,  0.5, 200.0)
    _new_socket(g, "Crest Noise",  "INPUT", "NodeSocketFloat",  4.0,  0.0,  30.0)
    _new_socket(g, "Crest Scale",  "INPUT", "NodeSocketFloat",  0.025, 0.0001, 1.0)
    _new_socket(g, "Valley Noise", "INPUT", "NodeSocketFloat",  1.0,  0.0,  10.0)
    _new_socket(g, "Valley Scale", "INPUT", "NodeSocketFloat",  0.04, 0.0001, 1.0)
    _new_socket(g, "Noise Seed",   "INPUT", "NodeSocketFloat",  0.0,  0.0, 1000.0)
    # Additive offset mode. When True the Z displacement is clamped to
    # max(0, raw_z) before being applied as Offset, so the sub-group
    # only RAISES the input geometry. Default True. See
    # seed_template_island.py for the same socket on HV_TemplateIsland —
    # the HV_TemplateTerrain wrapper relies on this for stacking.
    _new_socket(g, "Additive",     "INPUT", "NodeSocketBool", True)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",  -1600, 0)
    p_out = _add_node(g, "NodeGroupOutput",  2800, 0)
    p_pos = _add_node(g, "GeometryNodeInputPosition", -1400, -200)
    n_sentinel = _add_node(g, "ShaderNodeValue", -1400, -400)
    n_sentinel.outputs[0].default_value = -10000.0

    # 4 sub-group instances, max-cascade
    prev = None
    for i in range(4):
        inst = _add_node(g, "GeometryNodeGroup", -800, -100 - i * 300)
        inst.node_tree = sub
        g.links.new(p_pos.outputs["Position"], inst.inputs["Position"])
        g.links.new(p_in.outputs[f"Ridge {i}A"], inst.inputs["Ridge A"])
        g.links.new(p_in.outputs[f"Ridge {i}B"], inst.inputs["Ridge B"])
        g.links.new(p_in.outputs["Cliff Width"], inst.inputs["Cliff Width"])
        g.links.new(p_in.outputs["Crest Noise"], inst.inputs["Crest Noise"])
        g.links.new(p_in.outputs["Crest Scale"], inst.inputs["Crest Scale"])
        g.links.new(p_in.outputs["Noise Seed"],  inst.inputs["Noise Seed"])
        g.links.new(p_in.outputs["Valley Floor"], inst.inputs["Valley Floor"])
        g.links.new(n_sentinel.outputs[0],       inst.inputs["Sentinel"])
        if prev is None:
            prev = inst.outputs["Height"]
        else:
            n_max = _add_node(g, "ShaderNodeMath", -400, -100 - i * 300, operation="MAXIMUM")
            g.links.new(prev, n_max.inputs[0])
            g.links.new(inst.outputs["Height"], n_max.inputs[1])
            prev = n_max.outputs[0]

    # Valley-floor noise (bed-rock ripple), gated below z=10 so cliffs
    # and crests aren't perturbed.
    n_valley_noise = _add_node(g, "ShaderNodeTexNoise", -400, -1700)
    n_valley_noise.noise_dimensions = "4D"
    n_valley_noise.normalize = True
    n_valley_noise.inputs["Detail"].default_value = 3.0
    n_valley_noise.inputs["Roughness"].default_value = 0.5
    n_valley_noise.inputs["Distortion"].default_value = 0.4
    g.links.new(p_pos.outputs["Position"],   n_valley_noise.inputs["Vector"])
    g.links.new(p_in.outputs["Valley Scale"], n_valley_noise.inputs["Scale"])
    n_valley_seed = _add_node(g, "ShaderNodeMath", -600, -1800, operation="ADD")
    n_valley_seed.inputs[1].default_value = 79.0
    g.links.new(p_in.outputs["Noise Seed"], n_valley_seed.inputs[0])
    g.links.new(n_valley_seed.outputs[0], n_valley_noise.inputs["W"])
    n_valley_signed = _add_node(g, "ShaderNodeMath", -200, -1700, operation="MULTIPLY_ADD")
    n_valley_signed.inputs[1].default_value =  2.0
    n_valley_signed.inputs[2].default_value = -1.0
    g.links.new(n_valley_noise.outputs["Fac"], n_valley_signed.inputs[0])
    n_valley_amp = _add_node(g, "ShaderNodeMath", 0, -1700, operation="MULTIPLY")
    g.links.new(n_valley_signed.outputs[0], n_valley_amp.inputs[0])
    g.links.new(p_in.outputs["Valley Noise"], n_valley_amp.inputs[1])

    # Mask: 1 below z=8, 0 above z=20.
    n_valley_mask = _add_node(g, "ShaderNodeMapRange", -200, -1900,
                              interpolation_type="SMOOTHSTEP", clamp=True)
    n_valley_mask.inputs["From Min"].default_value =  8.0
    n_valley_mask.inputs["From Max"].default_value = 20.0
    n_valley_mask.inputs["To Min"].default_value =    1.0
    n_valley_mask.inputs["To Max"].default_value =    0.0
    g.links.new(prev, n_valley_mask.inputs["Value"])
    n_valley_gated = _add_node(g, "ShaderNodeMath", 200, -1700, operation="MULTIPLY")
    g.links.new(n_valley_amp.outputs[0],         n_valley_gated.inputs[0])
    g.links.new(n_valley_mask.outputs["Result"], n_valley_gated.inputs[1])

    n_final = _add_node(g, "ShaderNodeMath", 600, -800, operation="ADD")
    g.links.new(prev,                       n_final.inputs[0])
    g.links.new(n_valley_gated.outputs[0], n_final.inputs[1])

    # Additive clamp + switch. See seed_template_island.py for the
    # rationale — Additive=True clamps Z to max(0, z) so this sub-group
    # only raises the input geometry (suitable for stacking under
    # HV_TemplateTerrain). Additive=False preserves the raw signed Z
    # (the valley floor reaches its native -5 m river bed).
    n_add_clamp = _add_node(g, "ShaderNodeMath", 750, -500, operation="MAXIMUM")
    n_add_clamp.name = "HV_Additive_Clamp"
    n_add_clamp.label = "HV_Additive_Clamp"
    n_add_clamp.inputs[1].default_value = 0.0
    g.links.new(n_final.outputs[0], n_add_clamp.inputs[0])
    n_add_sw = _add_node(g, "GeometryNodeSwitch", 850, -400, input_type="FLOAT")
    n_add_sw.name = "HV_Additive_Switch"
    n_add_sw.label = "HV_Additive_Switch"
    g.links.new(p_in.outputs["Additive"], n_add_sw.inputs[0])
    g.links.new(n_final.outputs[0],       n_add_sw.inputs[1])
    g.links.new(n_add_clamp.outputs[0],   n_add_sw.inputs[2])

    # Set Position
    n_comb = _add_node(g, "ShaderNodeCombineXYZ", 900, -400)
    g.links.new(n_add_sw.outputs[0], n_comb.inputs["Z"])
    n_setpos = _add_node(g, "GeometryNodeSetPosition", 1200, 0)
    g.links.new(p_in.outputs["Geometry"], n_setpos.inputs["Geometry"])
    g.links.new(n_comb.outputs["Vector"], n_setpos.inputs["Offset"])

    # Biome stamp:
    # z < -1   → 0.0   (river bed / underwater)
    # -1 .. 15 → 0.33  (valley grass)
    # 15 .. 70 → 0.67  (cliff rock)
    # z ≥ 70   → 1.0   (snow line)
    n_pos2 = _add_node(g, "GeometryNodeInputPosition", 1400, -300)
    n_pos2_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 1600, -300)
    g.links.new(n_pos2.outputs["Position"], n_pos2_xyz.inputs["Vector"])

    def _step(z, thresh, x, y):
        n = _add_node(g, "ShaderNodeMath", x, y, operation="GREATER_THAN")
        n.inputs[1].default_value = thresh
        g.links.new(z, n.inputs[0])
        return n

    n_b1 = _step(n_pos2_xyz.outputs["Z"], -1.0, 1800, -100)
    n_b2 = _step(n_pos2_xyz.outputs["Z"], 15.0, 1800, -250)
    n_b3 = _step(n_pos2_xyz.outputs["Z"], 70.0, 1800, -400)
    n_bs1 = _add_node(g, "ShaderNodeMath", 2000, -175, operation="ADD")
    g.links.new(n_b1.outputs[0], n_bs1.inputs[0]); g.links.new(n_b2.outputs[0], n_bs1.inputs[1])
    n_bs2 = _add_node(g, "ShaderNodeMath", 2000, -325, operation="ADD")
    g.links.new(n_bs1.outputs[0], n_bs2.inputs[0]); g.links.new(n_b3.outputs[0], n_bs2.inputs[1])
    n_biome = _add_node(g, "ShaderNodeMath", 2200, -475, operation="DIVIDE")
    n_biome.inputs[1].default_value = 3.0
    g.links.new(n_bs2.outputs[0], n_biome.inputs[0])

    n_zero_p = _add_node(g, "ShaderNodeValue", 2200, -625)
    n_zero_p.outputs[0].default_value = 0.0
    n_ao_attr = _add_node(g, "GeometryNodeInputNamedAttribute", 2200, -775, data_type="FLOAT")
    n_ao_attr.inputs["Name"].default_value = "baked_ao"
    n_path_attr = _add_node(g, "GeometryNodeInputNamedAttribute", 2200, -925, data_type="FLOAT")
    n_path_attr.inputs["Name"].default_value = "baked_path"
    n_color = _add_node(g, "FunctionNodeCombineColor", 2400, -300, mode="RGB")
    g.links.new(n_zero_p.outputs[0],              n_color.inputs["Red"])
    g.links.new(n_ao_attr.outputs["Attribute"],   n_color.inputs["Green"])
    g.links.new(n_path_attr.outputs["Attribute"], n_color.inputs["Blue"])
    g.links.new(n_biome.outputs[0],               n_color.inputs["Alpha"])

    n_store = _add_node(g, "GeometryNodeStoreNamedAttribute", 2600, 0,
                        data_type="FLOAT_COLOR", domain="POINT")
    n_store.inputs["Name"].default_value = "COLOR_0"
    g.links.new(n_setpos.outputs["Geometry"], n_store.inputs["Geometry"])
    g.links.new(n_color.outputs["Color"], n_store.inputs["Value"])
    g.links.new(n_store.outputs["Geometry"], p_out.inputs["Geometry"])

    return g


# ────────────────────────────────────────────────────────────────────
# Modifier + scene objects
# ────────────────────────────────────────────────────────────────────

def attach_modifier(terrain: bpy.types.Object, ng: bpy.types.NodeTree) -> bpy.types.Modifier:
    for m in list(terrain.modifiers):
        if m.type == "NODES":
            terrain.modifiers.remove(m)
    mod = terrain.modifiers.new("HV_Alpine", "NODES")
    mod.node_group = ng
    return mod


def bind_ridge_inputs(mod: bpy.types.Modifier, ng: bpy.types.NodeTree) -> None:
    ids = {}
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) == "SOCKET" and getattr(item, "in_out", None) == "INPUT":
            ids[item.name] = item.identifier
    for i, (idx, _, _, _) in enumerate(RIDGES):
        a = bpy.data.objects.get(f"ridge_{idx}_a")
        b = bpy.data.objects.get(f"ridge_{idx}_b")
        if a is not None:
            mod[ids[f"Ridge {i}A"]] = a
        if b is not None:
            mod[ids[f"Ridge {i}B"]] = b


def add_ridge_empties() -> None:
    for idx, a_loc, b_loc, half_w in RIDGES:
        a = bpy.data.objects.new(f"ridge_{idx}_a", None)
        a.empty_display_type = "CONE"  # visually points along +Z so users can see endpoint
        a.empty_display_size = 8.0
        a.location = a_loc
        a.scale = (half_w, half_w, 1.0)
        a["kind"] = "ridge_a"
        bpy.context.scene.collection.objects.link(a)

        b = bpy.data.objects.new(f"ridge_{idx}_b", None)
        b.empty_display_type = "CONE"
        b.empty_display_size = 8.0
        b.location = b_loc
        b.scale = (half_w, half_w, 1.0)
        b["kind"] = "ridge_b"
        bpy.context.scene.collection.objects.link(b)


def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, 0.0)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.5  # mountain river — quick but not stormy
    obj["wave_freq"] = 0.7
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
    seg_lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
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
    light_data.energy = 4.0
    light_data.color = (0.96, 0.98, 1.0)  # cold mountain sun
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.7, 0.4, 0.0)
    bpy.context.scene.collection.objects.link(obj)


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Alpine palette: river-grey valley floor → green valley walls →
    grey-blue cliff rock → bright snow caps."""
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

    n_color0 = add("ShaderNodeAttribute", -1600, 500)
    n_color0.attribute_name = "COLOR_0"
    nt.links.new(n_color0.outputs["Color"], n_bsdf.inputs["Emission Color"])
    n_bsdf.inputs["Emission Strength"].default_value = 0.0

    n_geom = add("ShaderNodeNewGeometry", -1600,  200)
    n_pos_xyz = add("ShaderNodeSeparateXYZ", -1400,  300)
    nt.links.new(n_geom.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_nrm_xyz = add("ShaderNodeSeparateXYZ", -1400,    0)
    nt.links.new(n_geom.outputs["Normal"], n_nrm_xyz.inputs["Vector"])

    n_slope = add("ShaderNodeMapRange", -1200, 0,
                  interpolation_type="SMOOTHSTEP", clamp=True)
    n_slope.inputs["From Min"].default_value = 0.85
    n_slope.inputs["From Max"].default_value = 0.40
    n_slope.inputs["To Min"].default_value =   0.0
    n_slope.inputs["To Max"].default_value =   1.0
    nt.links.new(n_nrm_xyz.outputs["Z"], n_slope.inputs["Value"])

    # Altitude → ramp: z ∈ [-8, 115] → [0, 1]
    n_alt = add("ShaderNodeMapRange", -1200, 300, clamp=True)
    n_alt.inputs["From Min"].default_value = -8.0
    n_alt.inputs["From Max"].default_value = 115.0
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

    # Flat ramp: silty riverbed → grass → forest → bare rock → snow.
    n_flat_ramp = _ramp(-800, 400, [
        (0.000, (0.22, 0.26, 0.30, 1.0)),  # silty riverbed (z=-8)
        (0.057, (0.34, 0.40, 0.36, 1.0)),  # riverbank (z=-1)
        (0.130, (0.32, 0.50, 0.28, 1.0)),  # valley grass (z=8)
        (0.220, (0.24, 0.40, 0.22, 1.0)),  # forest band (z=20)
        (0.420, (0.40, 0.40, 0.42, 1.0)),  # mid rock (z=44)
        (0.625, (0.62, 0.62, 0.66, 1.0)),  # high rock (z=70)
        (0.700, (0.85, 0.88, 0.92, 1.0)),  # snow start (z=78)
        (1.000, (0.98, 0.99, 1.00, 1.0)),  # snow cap (z=115)
    ])
    nt.links.new(n_alt.outputs["Result"], n_flat_ramp.inputs["Fac"])

    # Cliff ramp: darker, blue-grey rock palette.
    n_cliff_ramp = _ramp(-800, 100, [
        (0.000, (0.16, 0.18, 0.20, 1.0)),
        (0.130, (0.24, 0.28, 0.28, 1.0)),
        (0.420, (0.30, 0.32, 0.36, 1.0)),
        (0.625, (0.42, 0.44, 0.50, 1.0)),
        (0.700, (0.60, 0.62, 0.66, 1.0)),
        (1.000, (0.86, 0.88, 0.92, 1.0)),  # snow on steep faces too
    ])
    nt.links.new(n_alt.outputs["Result"], n_cliff_ramp.inputs["Fac"])

    n_mix = add("ShaderNodeMix", -400, 250, data_type="RGBA")
    n_mix.blend_type = "MIX"
    n_mix.clamp_factor = True
    nt.links.new(n_slope.outputs["Result"], n_mix.inputs[0])
    nt.links.new(n_flat_ramp.outputs["Color"],  n_mix.inputs[6])
    nt.links.new(n_cliff_ramp.outputs["Color"], n_mix.inputs[7])

    # Variation noise — breaks up grass and snow.
    n_var_noise = add("ShaderNodeTexNoise", -1200, -300)
    n_var_noise.noise_dimensions = "3D"; n_var_noise.normalize = True
    n_var_noise.inputs["Scale"].default_value = 1.0
    n_var_noise.inputs["Detail"].default_value = 6.0
    n_var_noise.inputs["Roughness"].default_value = 0.55
    nt.links.new(n_geom.outputs["Position"], n_var_noise.inputs["Vector"])
    n_var_signed = add("ShaderNodeMapRange", -900, -300, clamp=True)
    n_var_signed.inputs["From Min"].default_value =  0.0
    n_var_signed.inputs["From Max"].default_value =  1.0
    n_var_signed.inputs["To Min"].default_value =   -0.08
    n_var_signed.inputs["To Max"].default_value =    0.08
    nt.links.new(n_var_noise.outputs["Fac"], n_var_signed.inputs["Value"])
    n_color_var = add("ShaderNodeBrightContrast", -200, -100)
    nt.links.new(n_mix.outputs[2],               n_color_var.inputs["Color"])
    nt.links.new(n_var_signed.outputs["Result"], n_color_var.inputs["Bright"])

    nt.links.new(n_color_var.outputs["Color"], n_bsdf.inputs["Base Color"])

    # Roughness: snow softer, rock rougher.
    n_rough = add("ShaderNodeMapRange", 300, -100, clamp=True)
    n_rough.inputs["From Min"].default_value = 0.0
    n_rough.inputs["From Max"].default_value = 1.0
    n_rough.inputs["To Min"].default_value =   0.70
    n_rough.inputs["To Max"].default_value =   0.92
    nt.links.new(n_slope.outputs["Result"], n_rough.inputs["Value"])
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
    col_ridges   = ensure("Ridges")
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
        elif obj.name.startswith("ridge_"):
            move(obj, col_ridges)
        elif obj.name == "water_volume_main":
            move(obj, col_water)
        elif obj.name in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif obj.name.startswith(("start_", "cp_", "pickup_")):
            move(obj, col_gameplay)


def _load_addon_module():
    """Load the in-repo Hoverbike addon package by file path so the seed
    sees the working-tree version even when the installed-addons copy
    lags. Post-2026-05 the addon is a package (``hoverbike_addon/`` with
    submodules); ``submodule_search_locations`` makes the package's
    internal ``from . import water, ...`` lines resolve under the disk
    alias."""
    import importlib.util
    import sys
    pkg_dir = os.path.join(SCRIPT_DIR, "hoverbike_addon")
    init_file = os.path.join(pkg_dir, "__init__.py")
    if not os.path.exists(init_file):
        print(f"[seed-template-alpine] WARNING: {init_file} not found; skipping previews")
        return None
    spec = importlib.util.spec_from_file_location(
        "hoverbike_addon_disk",
        init_file,
        submodule_search_locations=[pkg_dir],
    )
    if spec is None or spec.loader is None:
        print(f"[seed-template-alpine] WARNING: could not load spec for {init_file}; skipping previews")
        return None
    addon = importlib.util.module_from_spec(spec)
    sys.modules["hoverbike_addon_disk"] = addon
    spec.loader.exec_module(addon)
    return addon


def add_previews() -> None:
    addon = _load_addon_module()
    if addon is None:
        return
    scene = bpy.context.scene
    summary = addon._rebuild_water_preview(
        scene, size=WATER_PREVIEW_SIZE, subdivisions=WATER_PREVIEW_SUBDIVISIONS, time=0.0,
    )
    print(f"[seed-template-alpine] water preview: {summary['vert_count']} verts centered on {summary['centered_on']}")
    n_gates = addon._rebuild_gate_preview(scene, spacing=60.0, half_width=14.0, height=6.0)
    print(f"[seed-template-alpine] gate preview: {n_gates} gates at 60.0m spacing")
    racer_summary = addon._rebuild_racer_preview(scene)
    print(
        "[seed-template-alpine] racer preview: "
        f"1 player + {racer_summary['ai_count']} AI bikes ({racer_summary['grid_source']})"
    )
    turn_summary = addon._rebuild_turn_indicators(scene, kappa_threshold=0.02, min_spacing_m=20.0)
    print(f"[seed-template-alpine] turn indicators: {turn_summary['peak_count']} chevrons")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-alpine] writing {OUTPUT_PATH}")
    reset_scene()
    terrain = build_terrain_mesh()
    sub = build_ridge_profile_group()
    ng = build_template_alpine_group(sub)
    mod = attach_modifier(terrain, ng)
    add_ridge_empties()
    bind_ridge_inputs(mod, ng)
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
    print(f"[seed-template-alpine] done")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-template-alpine] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
