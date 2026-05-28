"""Seed ``tracks-src/template-mesa.blend`` — procedural mesa-canyon terrain.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_mesa.py

Tiered flat-topped plateaus on a deep canyon floor. Each ``mesa_NN``
empty is the parametric driver for one plateau:

| Empty | Field | Encoded value |
|---|---|---|
| ``mesa_NN`` (SPHERE) | ``location.xy`` | Plateau centre in world XY. |
|                     | ``location.z``  | Plateau top altitude (m). |
|                     | ``scale.x``     | Plateau radius (m). |

The HV_Mesa graph evaluates each mesa as a smooth-step disk that ramps
from the canyon floor (z = ``Canyon Floor``) up to ``location.z`` across
a band ``Cliff Width`` metres wide centred at the plateau radius. The
graph composes up to 6 mesas via MAX cascade — overlapping mesas form
terraced plateau complexes. The racing surface = the canyon floor +
whichever mesa tops the racing line crosses.

Water (the canyon river) sits at z = 0 by default; the canyon floor at
z = -8 m so the central trough always has a thin meander of water.

### Global modifier knobs (Properties → Modifier → HV_Mesa)

| Knob | Default | Purpose |
|---|---|---|
| Canyon Floor | -8 m | Mean canyon-floor altitude (mostly below water). |
| Cliff Width | 8 m | Cliff smoothstep band — narrow = steep, wide = ramp-like. |
| Floor Noise | 1.5 m | Random ripple amplitude on the canyon floor + mesa tops. |
| Floor Scale | 0.04 | Noise frequency. |
| Mesa Top Noise | 1.0 m | Independent noise band stamped on each mesa plateau (cosmetic, breaks up perfectly-flat tops). |
| Noise Seed | 0 | Re-roll for noise variation. |

### COLOR_0 stamp

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | baked AO (default 1) |
| B | baked path-worn (default 0) |
| A | Biome index: 0.0 (water z < -2) / 0.33 (canyon floor -2..8) / 0.67 (cliff face 8..50) / 1.0 (mesa top z ≥ 50) |
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-mesa.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 384  # mesas need crisp edges; matching island's resolution helps

# Starter mesas. Each: (idx, world_location_xyz, radius)
# location.z is the mesa-top altitude. Six mesa-pair slots match the
# GN-graph capacity.
MESAS: list[tuple[str, tuple[float, float, float], float]] = [
    ("00", (-280.0,  250.0,  70.0), 180.0),  # NW big plateau
    ("01", ( 280.0, -200.0,  60.0), 200.0),  # SE big plateau
    ("02", ( 300.0,  220.0,  40.0), 120.0),  # NE mid plateau
    ("03", (-280.0, -220.0,  40.0), 120.0),  # SW mid plateau
    ("04", (   0.0,    0.0, 110.0),  70.0),  # central high spire
    ("05", (   0.0,    0.0,   0.0),   0.0),  # unused slot (sentinel)
]

# Starter racing line: a long figure-8 around the central spire, dipping
# down into the canyon between mesas. Z values are nominal — the
# snap-spline-to-terrain pass refines them.
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -340.0,  -2.0),  # south canyon floor (start)
    ( 200.0, -300.0,  -2.0),  # SE turn-in
    ( 350.0, -100.0,  -2.0),  # E canyon between mesas
    ( 250.0,  100.0,  -2.0),  # NE approach to plateau
    (   0.0,  340.0,  -2.0),  # N canyon
    (-250.0,  100.0,  -2.0),  # NW
    (-350.0, -100.0,  -2.0),  # W canyon
    (-200.0, -300.0,  -2.0),  # SW turn
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
START_Z = -2.0

CHECKPOINTS: list[tuple[float, float, float]] = [
    ( 350.0, -100.0,  -2.0),
    (   0.0,  340.0,  -2.0),
    (-350.0, -100.0,  -2.0),
    (-200.0, -300.0,  -2.0),
]
CHECKPOINT_HALF_WIDTH = 16.0
CHECKPOINT_HEIGHT = 8.0

WATER_PREVIEW_SIZE = 700.0
WATER_PREVIEW_SUBDIVISIONS = 120

NODE_GROUP_NAME = "HV_TemplateMesa"
MESA_SUBGROUP_NAME = "HV_MesaProfile"


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
# Node-group helpers (same pattern as island/dunes)
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
# HV_MesaProfile — per-mesa flat-topped contribution
# ────────────────────────────────────────────────────────────────────

def build_mesa_profile_group() -> bpy.types.NodeTree:
    """Per-mesa height contribution. Reads a single Mesa empty:
    ``location.xy`` = centre, ``location.z`` = top altitude, ``scale.x``
    = plateau radius. The plateau is a flat disk of radius ``scale.x``
    ramping down to 0 over ``Cliff Width`` metres.

    Sentinel gates unbound slots: when ``scale.x ≤ 0.01`` the output is
    the sentinel (large negative) so the parent's MAX cascade drops it."""
    if MESA_SUBGROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[MESA_SUBGROUP_NAME])
    g = bpy.data.node_groups.new(MESA_SUBGROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Position",       "INPUT", "NodeSocketVector")
    _new_socket(g, "Mesa",           "INPUT", "NodeSocketObject")
    _new_socket(g, "Cliff Width",    "INPUT", "NodeSocketFloat", 8.0)
    _new_socket(g, "Top Noise",      "INPUT", "NodeSocketFloat", 1.0)
    _new_socket(g, "Noise Seed",     "INPUT", "NodeSocketFloat", 0.0)
    _new_socket(g, "Canyon Floor",   "INPUT", "NodeSocketFloat", -8.0)
    _new_socket(g, "Sentinel",       "INPUT", "NodeSocketFloat", -10000.0)
    _new_socket(g, "Height",         "OUTPUT", "NodeSocketFloat")

    gi = _add_node(g, "NodeGroupInput",  -1600, 0)
    go = _add_node(g, "NodeGroupOutput",  1600, 0)

    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -1400, -200)
    g.links.new(gi.outputs["Position"], n_pos_xyz.inputs["Vector"])

    n_mesa = _add_node(g, "GeometryNodeObjectInfo", -1400, -500, transform_space="RELATIVE")
    g.links.new(gi.outputs["Mesa"], n_mesa.inputs["Object"])
    n_mesa_loc = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -500)
    g.links.new(n_mesa.outputs["Location"], n_mesa_loc.inputs["Vector"])
    n_mesa_scl = _add_node(g, "ShaderNodeSeparateXYZ", -1200, -700)
    g.links.new(n_mesa.outputs["Scale"], n_mesa_scl.inputs["Vector"])

    # Horizontal distance from mesa centre to vertex.
    n_dx = _add_node(g, "ShaderNodeMath", -1000, -300, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"],  n_dx.inputs[0])
    g.links.new(n_mesa_loc.outputs["X"], n_dx.inputs[1])
    n_dy = _add_node(g, "ShaderNodeMath", -1000, -450, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"],  n_dy.inputs[0])
    g.links.new(n_mesa_loc.outputs["Y"], n_dy.inputs[1])
    n_dx2 = _add_node(g, "ShaderNodeMath", -800, -300, operation="POWER")
    n_dx2.inputs[1].default_value = 2.0
    g.links.new(n_dx.outputs[0], n_dx2.inputs[0])
    n_dy2 = _add_node(g, "ShaderNodeMath", -800, -450, operation="POWER")
    n_dy2.inputs[1].default_value = 2.0
    g.links.new(n_dy.outputs[0], n_dy2.inputs[0])
    n_dsum = _add_node(g, "ShaderNodeMath", -600, -375, operation="ADD")
    g.links.new(n_dx2.outputs[0], n_dsum.inputs[0])
    g.links.new(n_dy2.outputs[0], n_dsum.inputs[1])
    n_d = _add_node(g, "ShaderNodeMath", -400, -375, operation="SQRT")
    g.links.new(n_dsum.outputs[0], n_d.inputs[0])

    # Plateau falloff: 1 inside radius, 0 outside (radius + cliff_width),
    # smoothstep in between.
    n_outer = _add_node(g, "ShaderNodeMath", -400, -550, operation="ADD")
    g.links.new(n_mesa_scl.outputs["X"], n_outer.inputs[0])
    g.links.new(gi.outputs["Cliff Width"], n_outer.inputs[1])
    n_falloff = _add_node(g, "ShaderNodeMapRange", -200, -400,
                          interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d.outputs[0],          n_falloff.inputs["Value"])
    g.links.new(n_mesa_scl.outputs["X"], n_falloff.inputs["From Min"])
    g.links.new(n_outer.outputs[0],      n_falloff.inputs["From Max"])
    n_falloff.inputs["To Min"].default_value = 1.0
    n_falloff.inputs["To Max"].default_value = 0.0

    # Plateau-top cosmetic noise — mildly perturbs the flat top so it
    # doesn't read as a perfectly machined surface. Gated by the same
    # falloff (1 inside, fading to 0 at cliff edge) so the noise only
    # appears on the plateau itself, not in the cliff.
    n_top_noise = _add_node(g, "ShaderNodeTexNoise", -800, -800)
    n_top_noise.noise_dimensions = "4D"
    n_top_noise.normalize = True
    n_top_noise.inputs["Detail"].default_value = 2.0
    n_top_noise.inputs["Roughness"].default_value = 0.4
    n_top_noise.inputs["Distortion"].default_value = 0.0
    n_top_noise.inputs["Scale"].default_value = 0.06  # ~17m wavelength on top
    g.links.new(gi.outputs["Position"],   n_top_noise.inputs["Vector"])
    # De-correlate per mesa by hashing the seed against mesa.location.x.
    n_top_seed_sum = _add_node(g, "ShaderNodeMath", -1000, -1000, operation="ADD")
    g.links.new(gi.outputs["Noise Seed"], n_top_seed_sum.inputs[0])
    g.links.new(n_mesa_loc.outputs["X"],  n_top_seed_sum.inputs[1])
    g.links.new(n_top_seed_sum.outputs[0], n_top_noise.inputs["W"])
    n_top_signed = _add_node(g, "ShaderNodeMath", -600, -800, operation="MULTIPLY_ADD")
    n_top_signed.inputs[1].default_value =  2.0
    n_top_signed.inputs[2].default_value = -1.0
    g.links.new(n_top_noise.outputs["Fac"], n_top_signed.inputs[0])
    n_top_perturb = _add_node(g, "ShaderNodeMath", -400, -800, operation="MULTIPLY")
    g.links.new(n_top_signed.outputs[0], n_top_perturb.inputs[0])
    g.links.new(gi.outputs["Top Noise"], n_top_perturb.inputs[1])
    # Gate by falloff so noise only applies on the plateau.
    n_top_masked = _add_node(g, "ShaderNodeMath", -200, -800, operation="MULTIPLY")
    g.links.new(n_top_perturb.outputs[0], n_top_masked.inputs[0])
    g.links.new(n_falloff.outputs["Result"], n_top_masked.inputs[1])

    # Plateau height contribution = lerp(canyon_floor, mesa.z, falloff) +
    # top_noise * falloff. Outside the cliff band (falloff=0) the
    # contribution equals the canyon floor — so the MAX cascade in the
    # parent picks up the floor cleanly for vertices in open canyon.
    # Inside the plateau (falloff=1) the contribution equals mesa.z + noise.
    n_diff = _add_node(g, "ShaderNodeMath", -200, -550, operation="SUBTRACT")
    g.links.new(n_mesa_loc.outputs["Z"],   n_diff.inputs[0])
    g.links.new(gi.outputs["Canyon Floor"], n_diff.inputs[1])
    n_lerp_part = _add_node(g, "ShaderNodeMath", 0, -550, operation="MULTIPLY")
    g.links.new(n_falloff.outputs["Result"], n_lerp_part.inputs[0])
    g.links.new(n_diff.outputs[0],            n_lerp_part.inputs[1])
    n_lerp_total = _add_node(g, "ShaderNodeMath", 200, -550, operation="ADD")
    g.links.new(gi.outputs["Canyon Floor"], n_lerp_total.inputs[0])
    g.links.new(n_lerp_part.outputs[0],     n_lerp_total.inputs[1])
    n_height = _add_node(g, "ShaderNodeMath", 400, -500, operation="ADD")
    g.links.new(n_lerp_total.outputs[0], n_height.inputs[0])
    g.links.new(n_top_masked.outputs[0], n_height.inputs[1])

    # Sentinel gating: when scale.x ≤ 0.01 the mesa is inert.
    n_active = _add_node(g, "ShaderNodeMath", 400, -700, operation="GREATER_THAN")
    n_active.inputs[1].default_value = 0.01
    g.links.new(n_mesa_scl.outputs["X"], n_active.inputs[0])
    n_mix = _add_node(g, "ShaderNodeMix", 800, -500)
    n_mix.data_type = "FLOAT"
    n_mix.clamp_factor = False
    g.links.new(n_active.outputs[0],    n_mix.inputs[0])
    g.links.new(gi.outputs["Sentinel"], n_mix.inputs["A"])
    g.links.new(n_height.outputs[0],    n_mix.inputs["B"])
    g.links.new(n_mix.outputs[0], go.inputs["Height"])

    return g


# ────────────────────────────────────────────────────────────────────
# HV_TemplateMesa — 6-mesa unroll + canyon-floor noise + biome stamp
# ────────────────────────────────────────────────────────────────────

def build_template_mesa_group(sub: bpy.types.NodeTree) -> bpy.types.NodeTree:
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")
    # Required so the group is selectable in the GN modifier dropdown.
    # HV_MesaProfile (the inner sub-group) stays is_modifier=False —
    # it's never attached directly. See seed_template_island.py for the
    # full rationale.
    g.is_modifier = True

    _new_socket(g, "Geometry", "INPUT", "NodeSocketGeometry")
    for i in range(6):
        _new_socket(g, f"Mesa {i}", "INPUT", "NodeSocketObject")
    _new_socket(g, "Canyon Floor", "INPUT", "NodeSocketFloat",  -8.0, -50.0,  20.0)
    _new_socket(g, "Cliff Width",  "INPUT", "NodeSocketFloat",   8.0,   0.5, 200.0)
    _new_socket(g, "Floor Noise",  "INPUT", "NodeSocketFloat",   1.5,   0.0,  20.0)
    _new_socket(g, "Floor Scale",  "INPUT", "NodeSocketFloat",   0.04,  0.0001, 1.0)
    _new_socket(g, "Mesa Top Noise", "INPUT", "NodeSocketFloat", 1.0,   0.0,  10.0)
    _new_socket(g, "Noise Seed",   "INPUT", "NodeSocketFloat",   0.0,   0.0, 1000.0)
    # Additive offset mode. When True the Z displacement is clamped to
    # max(0, raw_z) before being applied as Offset, so this sub-group
    # only RAISES the input geometry — required for clean stacking under
    # HV_TemplateTerrain. Default True. Flip Additive=False to recover
    # the destructive behaviour (the canyon floor reaches its -8 m
    # default and water shows through the central trough).
    _new_socket(g, "Additive",     "INPUT", "NodeSocketBool", True)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",  -1600, 0)
    p_out = _add_node(g, "NodeGroupOutput",  2800, 0)
    p_pos = _add_node(g, "GeometryNodeInputPosition", -1400, -200)
    n_sentinel = _add_node(g, "ShaderNodeValue", -1400, -400)
    n_sentinel.outputs[0].default_value = -10000.0

    # 6 sub-group instances, max-cascade.
    prev = None
    for i in range(6):
        inst = _add_node(g, "GeometryNodeGroup", -800, -100 - i * 250)
        inst.node_tree = sub
        g.links.new(p_pos.outputs["Position"],     inst.inputs["Position"])
        g.links.new(p_in.outputs[f"Mesa {i}"],     inst.inputs["Mesa"])
        g.links.new(p_in.outputs["Cliff Width"],   inst.inputs["Cliff Width"])
        g.links.new(p_in.outputs["Mesa Top Noise"], inst.inputs["Top Noise"])
        g.links.new(p_in.outputs["Noise Seed"],    inst.inputs["Noise Seed"])
        g.links.new(p_in.outputs["Canyon Floor"],  inst.inputs["Canyon Floor"])
        g.links.new(n_sentinel.outputs[0],         inst.inputs["Sentinel"])
        if prev is None:
            prev = inst.outputs["Height"]
        else:
            n_max = _add_node(g, "ShaderNodeMath", -400, -100 - i * 250, operation="MAXIMUM")
            g.links.new(prev, n_max.inputs[0])
            g.links.new(inst.outputs["Height"], n_max.inputs[1])
            prev = n_max.outputs[0]

    # Canyon-floor noise (small rocky ripples) — applied to the floor
    # itself, gated to below the lowest mesa contribution. For simplicity
    # the floor noise is just added unconditionally — mesas dominate via
    # max-cascade so the floor texture below them gets clipped naturally.
    n_floor_noise = _add_node(g, "ShaderNodeTexNoise", -400, -1800)
    n_floor_noise.noise_dimensions = "4D"
    n_floor_noise.normalize = True
    n_floor_noise.inputs["Detail"].default_value = 4.0
    n_floor_noise.inputs["Roughness"].default_value = 0.55
    n_floor_noise.inputs["Distortion"].default_value = 0.6
    g.links.new(p_pos.outputs["Position"],   n_floor_noise.inputs["Vector"])
    g.links.new(p_in.outputs["Floor Scale"], n_floor_noise.inputs["Scale"])
    n_floor_seed = _add_node(g, "ShaderNodeMath", -600, -1900, operation="ADD")
    n_floor_seed.inputs[1].default_value = 53.0
    g.links.new(p_in.outputs["Noise Seed"], n_floor_seed.inputs[0])
    g.links.new(n_floor_seed.outputs[0], n_floor_noise.inputs["W"])
    n_floor_signed = _add_node(g, "ShaderNodeMath", -200, -1800, operation="MULTIPLY_ADD")
    n_floor_signed.inputs[1].default_value =  2.0
    n_floor_signed.inputs[2].default_value = -1.0
    g.links.new(n_floor_noise.outputs["Fac"], n_floor_signed.inputs[0])
    n_floor_amp = _add_node(g, "ShaderNodeMath", 0, -1800, operation="MULTIPLY")
    g.links.new(n_floor_signed.outputs[0], n_floor_amp.inputs[0])
    g.links.new(p_in.outputs["Floor Noise"], n_floor_amp.inputs[1])

    # Gate the floor noise so it only adds ripple to the canyon floor
    # (z ≈ Canyon Floor). On mesa tops the sub-group's own top noise
    # dominates and we don't want extra wobble there. Mask = 1 below
    # z=0, fading to 0 by z=15.
    n_floor_mask = _add_node(g, "ShaderNodeMapRange", -200, -1900,
                             interpolation_type="SMOOTHSTEP", clamp=True)
    n_floor_mask.inputs["From Min"].default_value =  0.0
    n_floor_mask.inputs["From Max"].default_value = 15.0
    n_floor_mask.inputs["To Min"].default_value =    1.0
    n_floor_mask.inputs["To Max"].default_value =    0.0
    g.links.new(prev, n_floor_mask.inputs["Value"])
    n_floor_amp_gated = _add_node(g, "ShaderNodeMath", 200, -1800, operation="MULTIPLY")
    g.links.new(n_floor_amp.outputs[0],        n_floor_amp_gated.inputs[0])
    g.links.new(n_floor_mask.outputs["Result"], n_floor_amp_gated.inputs[1])

    # Final = mesa_max (already includes canyon_floor for outside-cliff)
    # + gated floor noise. No second MAX needed.
    n_final = _add_node(g, "ShaderNodeMath", 600, -800, operation="ADD")
    g.links.new(prev,                          n_final.inputs[0])
    g.links.new(n_floor_amp_gated.outputs[0], n_final.inputs[1])

    # Additive clamp + switch. See seed_template_island.py. Additive=True
    # clamps the Z to max(0, z) so this sub-group only raises the input
    # geometry (used by HV_TemplateTerrain). Additive=False preserves
    # the signed Z (canyon floor reaches its native -8 m).
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

    # Set Position.
    n_comb = _add_node(g, "ShaderNodeCombineXYZ", 900, -400)
    g.links.new(n_add_sw.outputs[0], n_comb.inputs["Z"])
    n_setpos = _add_node(g, "GeometryNodeSetPosition", 1200, 0)
    g.links.new(p_in.outputs["Geometry"],  n_setpos.inputs["Geometry"])
    g.links.new(n_comb.outputs["Vector"], n_setpos.inputs["Offset"])

    # Biome stamp:
    #   z < -2     → 0.0 (deep canyon, river)
    #   -2 .. 8    → 0.33 (canyon floor)
    #   8 .. 50    → 0.67 (cliff face)
    #   z ≥ 50     → 1.0 (mesa top)
    n_pos2 = _add_node(g, "GeometryNodeInputPosition", 1400, -300)
    n_pos2_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 1600, -300)
    g.links.new(n_pos2.outputs["Position"], n_pos2_xyz.inputs["Vector"])

    def _step(z, thresh, x, y):
        n = _add_node(g, "ShaderNodeMath", x, y, operation="GREATER_THAN")
        n.inputs[1].default_value = thresh
        g.links.new(z, n.inputs[0])
        return n

    n_b1 = _step(n_pos2_xyz.outputs["Z"], -2.0, 1800, -100)
    n_b2 = _step(n_pos2_xyz.outputs["Z"],  8.0, 1800, -250)
    n_b3 = _step(n_pos2_xyz.outputs["Z"], 50.0, 1800, -400)
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
# Modifier wiring + scene objects
# ────────────────────────────────────────────────────────────────────

def attach_modifier(terrain: bpy.types.Object, ng: bpy.types.NodeTree) -> bpy.types.Modifier:
    for m in list(terrain.modifiers):
        if m.type == "NODES":
            terrain.modifiers.remove(m)
    mod = terrain.modifiers.new("HV_Mesa", "NODES")
    mod.node_group = ng
    return mod


def bind_mesa_inputs(mod: bpy.types.Modifier, ng: bpy.types.NodeTree) -> None:
    ids = {}
    for item in ng.interface.items_tree:
        if getattr(item, "item_type", None) == "SOCKET" and getattr(item, "in_out", None) == "INPUT":
            ids[item.name] = item.identifier
    for i, (idx, _, _) in enumerate(MESAS):
        name = f"mesa_{idx}"
        if name in bpy.data.objects:
            mod[ids[f"Mesa {i}"]] = bpy.data.objects[name]


def add_mesa_empties() -> None:
    for idx, loc, radius in MESAS:
        obj = bpy.data.objects.new(f"mesa_{idx}", None)
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 1.0  # SPHERE radius = scale magnitude
        obj.location = loc
        obj.scale = (radius, radius, 1.0)
        obj["kind"] = "mesa"
        bpy.context.scene.collection.objects.link(obj)


def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, 0.0)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.3  # canyon river is small + calm
    obj["wave_freq"] = 0.5
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
    light_data.energy = 4.5
    light_data.color = (1.0, 0.92, 0.80)  # canyon warmth
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.5, 0.3, 0.0)
    bpy.context.scene.collection.objects.link(obj)


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Red-rock canyon shader: rust / sandstone palette banded by altitude;
    cliffs darker than tops. The deep canyon floor reads as cool grey-green
    (silty riverbed) so the central river meander is legible from above.
    """
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

    # Slope mask — wide range so even gentle cliffs read as rock-banded.
    n_slope = add("ShaderNodeMapRange", -1200, 0,
                  interpolation_type="SMOOTHSTEP", clamp=True)
    n_slope.inputs["From Min"].default_value = 0.90
    n_slope.inputs["From Max"].default_value = 0.45
    n_slope.inputs["To Min"].default_value =   0.0
    n_slope.inputs["To Max"].default_value =   1.0
    nt.links.new(n_nrm_xyz.outputs["Z"], n_slope.inputs["Value"])

    # Altitude → ramp: z ∈ [-10, 115] → [0, 1]
    n_alt = add("ShaderNodeMapRange", -1200, 300, clamp=True)
    n_alt.inputs["From Min"].default_value = -10.0
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

    # Flat ramp: silty riverbed → canyon floor sand → red rock → mesa top.
    n_flat_ramp = _ramp(-800, 400, [
        (0.000, (0.25, 0.27, 0.24, 1.0)),  # silty riverbed (z=-10)
        (0.080, (0.55, 0.46, 0.32, 1.0)),  # river sand (z=0)
        (0.144, (0.70, 0.45, 0.30, 1.0)),  # canyon floor (z=8)
        (0.320, (0.78, 0.42, 0.28, 1.0)),  # red rock band (z=30)
        (0.480, (0.84, 0.48, 0.32, 1.0)),  # mid mesa rust (z=50)
        (0.720, (0.86, 0.60, 0.42, 1.0)),  # sandstone (z=80)
        (1.000, (0.78, 0.72, 0.58, 1.0)),  # mesa top khaki (z=115)
    ])
    nt.links.new(n_alt.outputs["Result"], n_flat_ramp.inputs["Fac"])

    # Cliff ramp: darker rust strata, cool shadows.
    n_cliff_ramp = _ramp(-800, 100, [
        (0.000, (0.18, 0.18, 0.20, 1.0)),  # deep cliff shadow
        (0.080, (0.30, 0.24, 0.22, 1.0)),
        (0.320, (0.52, 0.28, 0.22, 1.0)),  # red cliff
        (0.480, (0.62, 0.34, 0.24, 1.0)),
        (0.720, (0.66, 0.42, 0.28, 1.0)),
        (1.000, (0.58, 0.46, 0.36, 1.0)),
    ])
    nt.links.new(n_alt.outputs["Result"], n_cliff_ramp.inputs["Fac"])

    n_mix = add("ShaderNodeMix", -400, 250, data_type="RGBA")
    n_mix.blend_type = "MIX"
    n_mix.clamp_factor = True
    nt.links.new(n_slope.outputs["Result"], n_mix.inputs[0])
    nt.links.new(n_flat_ramp.outputs["Color"],  n_mix.inputs[6])
    nt.links.new(n_cliff_ramp.outputs["Color"], n_mix.inputs[7])

    # Variation noise — broad strokes on the flat tops so the plateau
    # surface doesn't read as a single colour.
    n_var_noise = add("ShaderNodeTexNoise", -1200, -300)
    n_var_noise.noise_dimensions = "3D"; n_var_noise.normalize = True
    n_var_noise.inputs["Scale"].default_value = 1.2
    n_var_noise.inputs["Detail"].default_value = 5.0
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

    # Roughness — rocks rougher than river silt.
    n_rough = add("ShaderNodeMapRange", 300, -100, clamp=True)
    n_rough.inputs["From Min"].default_value = 0.0
    n_rough.inputs["From Max"].default_value = 1.0
    n_rough.inputs["To Min"].default_value =   0.78
    n_rough.inputs["To Max"].default_value =   0.95
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
    col_mesas    = ensure("Mesas")
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
        elif obj.name.startswith("mesa_"):
            move(obj, col_mesas)
        elif obj.name == "water_volume_main":
            move(obj, col_water)
        elif obj.name in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif obj.name.startswith(("start_", "cp_", "pickup_")):
            move(obj, col_gameplay)


def _load_addon_module():
    """Load the in-repo Hoverbike addon package by file path. See the
    twin in ``track_build_lib.py`` for the post-2026-05 package layout
    rationale."""
    import importlib.util
    import sys
    pkg_dir = os.path.join(SCRIPT_DIR, "hoverbike_addon")
    init_file = os.path.join(pkg_dir, "__init__.py")
    if not os.path.exists(init_file):
        print(f"[seed-template-mesa] WARNING: {init_file} not found; skipping previews")
        return None
    spec = importlib.util.spec_from_file_location(
        "hoverbike_addon_disk",
        init_file,
        submodule_search_locations=[pkg_dir],
    )
    if spec is None or spec.loader is None:
        print(f"[seed-template-mesa] WARNING: could not load spec for {init_file}; skipping previews")
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
    print(f"[seed-template-mesa] water preview: {summary['vert_count']} verts centered on {summary['centered_on']}")
    n_gates = addon._rebuild_gate_preview(scene, spacing=60.0, half_width=14.0, height=6.0)
    print(f"[seed-template-mesa] gate preview: {n_gates} gates at 60.0m spacing")
    racer_summary = addon._rebuild_racer_preview(scene)
    print(
        "[seed-template-mesa] racer preview: "
        f"1 player + {racer_summary['ai_count']} AI bikes ({racer_summary['grid_source']})"
    )
    turn_summary = addon._rebuild_turn_indicators(scene, kappa_threshold=0.02, min_spacing_m=20.0)
    print(f"[seed-template-mesa] turn indicators: {turn_summary['peak_count']} chevrons")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-mesa] writing {OUTPUT_PATH}")
    reset_scene()
    terrain = build_terrain_mesh()
    sub = build_mesa_profile_group()
    ng = build_template_mesa_group(sub)
    mod = attach_modifier(terrain, ng)
    add_mesa_empties()
    bind_mesa_inputs(mod, ng)
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
    print(f"[seed-template-mesa] done")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-template-mesa] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
