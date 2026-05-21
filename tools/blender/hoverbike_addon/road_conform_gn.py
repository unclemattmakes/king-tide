"""Non-destructive road→terrain conform via Geometry Nodes.

The classic flow in ``road.py`` (``HOVERBIKE_OT_build_road``) carves
the terrain mesh's vertex data directly to flatten a strip around the
road curve. That bakes the result and makes every subsequent edit
cumulative — re-running with a slightly different curve doesn't
recover the original terrain. This module is the live alternative:

* :func:`build_road_conform_node_group` constructs a Geometry Nodes
  node tree (``HV_RoadConform``) that takes the terrain geometry plus
  a road curve object as inputs, then emits a Z-displaced terrain
  whose surface dips/rises to meet the curve inside a configurable
  band. Pure node evaluation — no vertex mutation. Stack it *above*
  whatever else is generating the terrain (``HV_Island``, heightmap,
  hand sculpt) and the conform is the last thing that runs before the
  mesh is rendered.

* :class:`HOVERBIKE_OT_attach_road_conform` adds (or refreshes) that
  modifier on the active terrain and wires ``road_curve_main`` into
  the modifier's curve input socket.

* :class:`HOVERBIKE_OT_snap_curve_to_terrain` is the one-shot seeder.
  Project each control point of the road curve straight down onto the
  terrain so its authored Z starts somewhere reasonable. After that,
  edit either side freely — the curve owns its Z, the terrain follows
  through the GN modifier.

Trade-offs vs. the destructive ``HOVERBIKE_OT_build_road`` carve:

* **What works**: single-nearest-point conform with smoothstep blend,
  global lift, clearance cap (terrain can never rise above the road
  surface), and **banking-aware target** — the conform target is
  tilted around the road tangent by the curve's per-control-point
  ``tilt`` angle (radians), scaled by the modifier's *Bank Strength*
  slider. High-side terrain sits up with the banked outer curb,
  low-side dips with the inner curb. Authors set tilt per CP in
  Blender's N-panel → Curve → Tilt. Works on any ``kind=track`` mesh
  — heightmap, hand-sculpt, or procedural-island GN output — because
  it sits on top of the stack.
* **What's punted to a later pass**: curvature-driven *auto-bank*
  (the destructive flow derives per-sample bank from curvature and
  adds CP tilt on top — the live flow reads CP tilt only, so authors
  who want auto-bank for live preview must edit tilts manually),
  per-CP float/conform-weight, and the "always push down lowest
  segment" multi-segment rule for overlapping roads / overpasses.
  Authors who need any of those features can apply the modifier and
  then run the destructive ``Build Road`` for final bake fidelity.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

NODE_GROUP_NAME = "HV_RoadConform"
MODIFIER_NAME = "HV_RoadConform"

# Name of the proxy mesh object that hosts the HV_RoadConform modifier.
# We can't put the modifier on the source terrain directly: the curve →
# modifier dependency would propagate up the stack and force any
# upstream modifiers (HV_Island in particular) to re-evaluate on every
# curve edit — measured 920 ms per edit on a 148k-vert procedural
# island vs ~0.5 ms with the proxy decoupling. The proxy reads the
# source terrain via Object Info, which Blender's depsgraph treats
# as a separate cached dependency.
PROXY_OBJECT_NAME = "terrain_conformed"
PROXY_MESH_NAME = "terrain_conformed_mesh"

# Default GN-modifier socket values. The modifier panel exposes these
# as live sliders once the modifier is attached, so authors tune from
# Properties → Modifiers rather than scene-wide props.
DEFAULT_INNER_RADIUS = 13.0  # full conform inside this XY distance
DEFAULT_BLEND_RADIUS = 8.0   # smoothstep blend band past the inner edge
DEFAULT_LIFT = 0.05          # vertical offset matching road mesh lift
DEFAULT_CLEARANCE = 0.20     # terrain stays this far below road surface
DEFAULT_STRENGTH = 1.0       # master multiplier (0 disables)
DEFAULT_RESAMPLE = 512       # dense curve sample count for Proximity
DEFAULT_BANK_STRENGTH = 1.0  # multiplier on per-CP curve tilt (0 = flat)


# ────────────────────────────────────────────────────────────────────
# Node-graph builder helpers (mirror seed_template_island.py style)
# ────────────────────────────────────────────────────────────────────


def _new_socket(group, name, in_out, stype, default=None, mn=None, mx=None):
    s = group.interface.new_socket(name, in_out=in_out, socket_type=stype)
    if default is not None:
        s.default_value = default
    if mn is not None:
        s.min_value = mn
    if mx is not None:
        s.max_value = mx
    return s


def _add_node(group, kind, x, y, **kw):
    n = group.nodes.new(kind)
    n.location = (x, y)
    for k, v in kw.items():
        setattr(n, k, v)
    return n


# ────────────────────────────────────────────────────────────────────
# HV_RoadConform — the live road→terrain GN graph
# ────────────────────────────────────────────────────────────────────


def build_road_conform_node_group() -> bpy.types.NodeTree:
    """Construct (or rebuild) the ``HV_RoadConform`` Geometry Nodes
    tree. Idempotent — wipes any prior node group of the same name so
    re-running picks up code changes without leaving orphan trees.

    Graph topology (left to right):

        Inputs ─┬─► Object Info(Road Curve) ──► Resample Curve ──┐
                │                                                  ▼
                │                                       Geometry Proximity
                │                                                  │
                ▼                                                  ▼
        Vertex Position  ──────────────► XY distance  +  Nearest XYZ
                                                  │            │
                                                  ▼            ▼
                                          smoothstep blend  target_z
                                                       \\    /
                                                        Set Position (Z only)
                                                              │
                                                              ▼
                                                          Output

    Math mirrors the inner loop of ``road._conform_terrain_to_road``:
    inside ``Inner Radius``: blend = 1; inside ``Inner + Blend`` band:
    smoothstep falloff; outside: untouched. A clearance cap keeps the
    blended terrain Z from ever exceeding ``target_z + lift - clearance``,
    interpolated outward through the band the same way the destructive
    path does it — see ``road.py`` lines 1048–1061 for the rationale.
    """
    if NODE_GROUP_NAME in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[NODE_GROUP_NAME])
    g = bpy.data.node_groups.new(NODE_GROUP_NAME, "GeometryNodeTree")

    _new_socket(g, "Geometry",      "INPUT",  "NodeSocketGeometry")
    # Source Terrain is the terrain we conform — read via Object Info
    # rather than the modifier's own input geometry. This decouples
    # the conform from the terrain's modifier stack: with the conform
    # sitting on a SEPARATE proxy object and reading the source
    # terrain through this socket, a curve edit re-evaluates only the
    # proxy's HV_RoadConform (~20 ms) and Blender's depsgraph caches
    # the source terrain's evaluation (HV_Island procedural, ~900 ms)
    # since the curve is no longer in HV_Island's dependency chain.
    # Putting the modifier on the terrain stack directly creates that
    # transitive dependency and forces HV_Island to re-run on every
    # curve edit — measured 920 ms per edit vs 0.4 ms with the proxy.
    _new_socket(g, "Source Terrain", "INPUT", "NodeSocketObject")
    _new_socket(g, "Road Curve",    "INPUT",  "NodeSocketObject")
    _new_socket(g, "Inner Radius",  "INPUT",  "NodeSocketFloat",
                DEFAULT_INNER_RADIUS, 0.1, 200.0)
    _new_socket(g, "Blend Radius",  "INPUT",  "NodeSocketFloat",
                DEFAULT_BLEND_RADIUS, 0.0, 200.0)
    _new_socket(g, "Lift",          "INPUT",  "NodeSocketFloat",
                DEFAULT_LIFT, -10.0, 10.0)
    _new_socket(g, "Clearance",     "INPUT",  "NodeSocketFloat",
                DEFAULT_CLEARANCE, 0.0, 5.0)
    _new_socket(g, "Strength",      "INPUT",  "NodeSocketFloat",
                DEFAULT_STRENGTH, 0.0, 1.0)
    _new_socket(g, "Bank Strength", "INPUT",  "NodeSocketFloat",
                DEFAULT_BANK_STRENGTH, 0.0, 4.0)
    _new_socket(g, "Resample Count", "INPUT", "NodeSocketInt",
                DEFAULT_RESAMPLE, 16, 8192)
    _new_socket(g, "Geometry",      "OUTPUT", "NodeSocketGeometry")

    p_in  = _add_node(g, "NodeGroupInput",   -1800, 0)
    p_out = _add_node(g, "NodeGroupOutput",   2400, 0)

    # ── Pull the road curve into the modifier's local space ─────────
    # transform_space="RELATIVE" brings the curve into the active
    # object's (= terrain's) local space, so comparing against the
    # terrain vertex Position below works without an extra inverse-
    # transform on either side. Resample to dense points so Geometry
    # Proximity has plenty of candidate positions to lock onto.
    n_obj = _add_node(g, "GeometryNodeObjectInfo", -1500, 200,
                      transform_space="RELATIVE")
    g.links.new(p_in.outputs["Road Curve"], n_obj.inputs["Object"])

    # Resample Curve in Blender 5.1 takes its mode from an input
    # socket (NodeSocketMenu, default "Count"), not a node property.
    # We rely on the "Count" default so the modifier's Resample Count
    # input feeds directly into the node's Count socket.
    n_resample = _add_node(g, "GeometryNodeResampleCurve", -1200, 300)
    g.links.new(n_obj.outputs["Geometry"], n_resample.inputs["Curve"])
    g.links.new(p_in.outputs["Resample Count"], n_resample.inputs["Count"])

    # ── Capture per-point tangent + tilt + original Z ───────────────
    # Used by the banking + Z-target passes below. We capture three
    # attributes BEFORE flattening the curve to Z=0:
    #
    #   * Tangent — the road's heading at each resampled point. Drives
    #     the LEFT-perpendicular projection for lateral offset.
    #   * Tilt — per-CP roll in radians. Drives the bank lift.
    #   * Curve Z — the original curve altitude at each point. We
    #     can't read this off the Proximity output once we flatten
    #     the curve to Z=0, so we capture it as a separate attribute
    #     and dereference it via Sample Index at the nearest vertex.
    #
    # **Why we flatten the curve before Proximity** (verified bug on
    # steep terrain, fixed 2026-05-20): GeometryNodeProximity returns
    # the *3D* perpendicular foot from the sample position onto the
    # nearest edge. On a curve segment that climbs steeply (a road up
    # a volcano), the 3D foot's XY drifts away from the vertex's XY
    # — the perpendicular slides up/down the slope. We then compute
    # XY distance from vert.xy to foot.xy and use it for the inner /
    # outer band selection, but a vertex directly above the road in
    # XY can land 5–10 m laterally in the 3D projection and get
    # excluded from the conform band entirely. Flattening the curve
    # to Z=0 first means the 3D foot's XY equals the true 2D
    # perpendicular projection regardless of how steep the original
    # curve was, so the band check sees XY distance correctly.
    n_tan_in = _add_node(g, "GeometryNodeInputTangent", -1100, 500)
    n_tilt_in = _add_node(g, "GeometryNodeInputCurveTilt", -1100, 380)
    n_curve_pos = _add_node(g, "GeometryNodeInputPosition", -1100, 260)
    n_curve_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -950, 260)
    g.links.new(n_curve_pos.outputs["Position"], n_curve_pos_xyz.inputs["Vector"])

    n_cap = _add_node(g, "GeometryNodeCaptureAttribute", -800, 300,
                      domain="POINT")
    # capture_items.new takes socket-type names ("VECTOR", "FLOAT")
    # — different enum space than Sample Index's data_type below
    # which uses attribute-type names ("FLOAT_VECTOR", "FLOAT").
    n_cap.capture_items.new("VECTOR", "Tangent")
    n_cap.capture_items.new("FLOAT", "Tilt")
    n_cap.capture_items.new("FLOAT", "Curve Z")
    g.links.new(n_resample.outputs["Curve"], n_cap.inputs["Geometry"])
    g.links.new(n_tan_in.outputs["Tangent"], n_cap.inputs["Tangent"])
    g.links.new(n_tilt_in.outputs["Tilt"], n_cap.inputs["Tilt"])
    g.links.new(n_curve_pos_xyz.outputs["Z"], n_cap.inputs["Curve Z"])

    # ── Flatten the captured curve to Z=0 ───────────────────────────
    # Set Position with Offset=(0, 0, -Position.Z) zeros every point's
    # Z while preserving XY. Wired via separate XYZ → combine because
    # SetPosition's Position input expects a vector and we only want
    # to override Z. Captured attributes (Tangent, Tilt, Curve Z) ride
    # through Set Position untouched — they live on POINT domain.
    n_flat_combine = _add_node(g, "ShaderNodeCombineXYZ", -600, 200)
    g.links.new(n_curve_pos_xyz.outputs["X"], n_flat_combine.inputs["X"])
    g.links.new(n_curve_pos_xyz.outputs["Y"], n_flat_combine.inputs["Y"])
    # n_flat_combine.inputs["Z"] defaults to 0 — exactly what we want.
    n_flatten = _add_node(g, "GeometryNodeSetPosition", -400, 300)
    g.links.new(n_cap.outputs["Geometry"], n_flatten.inputs["Geometry"])
    g.links.new(n_flat_combine.outputs[0], n_flatten.inputs["Position"])

    # ── Convert flattened curve → mesh of straight edges ────────────
    # GeometryNodeProximity with target_element="POINTS" silently
    # returns (0,0,0) on curve-as-curve geometry. The fix is to
    # convert to a mesh polyline first (Curve to Mesh without a
    # profile = one mesh vert per resampled curve point, one edge
    # per segment) then use target_element="EDGES" — that projects
    # each terrain vertex perpendicularly onto the nearest segment.
    n_c2m = _add_node(g, "GeometryNodeCurveToMesh", -200, 300)
    g.links.new(n_flatten.outputs["Geometry"], n_c2m.inputs["Curve"])

    # ── Nearest point on the curve for each terrain vertex ──────────
    # Proximity returns the nearest-edge projection in relative space
    # plus the straight 3D distance. We compute XY distance ourselves
    # below because the conform band shouldn't widen on tall hills
    # just because the curve is higher than the local terrain.
    #
    # Blender 5.1 socket names: the geometry input is "Geometry" (not
    # "Target", which was the 3.x name), and the query point socket
    # is "Sample Position" (not "Source Position").
    n_pos = _add_node(g, "GeometryNodeInputPosition", -1500, -100)
    n_prox = _add_node(g, "GeometryNodeProximity", -600, 0,
                       target_element="EDGES")
    g.links.new(n_c2m.outputs["Mesh"], n_prox.inputs["Geometry"])
    g.links.new(n_pos.outputs["Position"], n_prox.inputs["Sample Position"])

    # ── Pull tangent + tilt at the nearest mesh vertex ──────────────
    # Sample Nearest with domain=POINT finds the index of the nearest
    # MESH VERTEX (not edge — separate from Proximity above). Sample
    # Index then dereferences the captured Tangent + Tilt attributes
    # at that index. Stepwise per resampled vertex: tangent / tilt
    # change discontinuously every ~SIZE/Resample metres. At the
    # default 512 samples on a typical 600 m track that's ~1.2 m
    # spacing — well below visible bank-discontinuity threshold.
    n_nearest_idx = _add_node(g, "GeometryNodeSampleNearest", -400, -350,
                              domain="POINT")
    g.links.new(n_c2m.outputs["Mesh"], n_nearest_idx.inputs["Geometry"])
    g.links.new(n_pos.outputs["Position"], n_nearest_idx.inputs["Sample Position"])

    n_sample_tan = _add_node(g, "GeometryNodeSampleIndex", -200, -300,
                             data_type="FLOAT_VECTOR", domain="POINT")
    g.links.new(n_c2m.outputs["Mesh"], n_sample_tan.inputs["Geometry"])
    g.links.new(n_cap.outputs["Tangent"], n_sample_tan.inputs["Value"])
    g.links.new(n_nearest_idx.outputs["Index"], n_sample_tan.inputs["Index"])

    n_sample_tilt = _add_node(g, "GeometryNodeSampleIndex", -200, -500,
                              data_type="FLOAT", domain="POINT")
    g.links.new(n_c2m.outputs["Mesh"], n_sample_tilt.inputs["Geometry"])
    g.links.new(n_cap.outputs["Tilt"], n_sample_tilt.inputs["Value"])
    g.links.new(n_nearest_idx.outputs["Index"], n_sample_tilt.inputs["Index"])

    # ── Recover the original curve Z (we flattened the geometry) ────
    # The flattened-curve mesh has every vert at Z=0, so Proximity's
    # nearest-position output gives Z=0 too. We pull the original Z
    # value from the Curve Z attribute we captured pre-flatten,
    # indexed by the nearest vertex. This is the source-of-truth Z
    # the conform target needs to land on.
    n_sample_curve_z = _add_node(g, "GeometryNodeSampleIndex", -200, -700,
                                 data_type="FLOAT", domain="POINT")
    g.links.new(n_c2m.outputs["Mesh"], n_sample_curve_z.inputs["Geometry"])
    g.links.new(n_cap.outputs["Curve Z"], n_sample_curve_z.inputs["Value"])
    g.links.new(n_nearest_idx.outputs["Index"], n_sample_curve_z.inputs["Index"])

    # Split the nearest position and the vertex position so we can
    # work on Z separately from XY.
    n_pos_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -700, -150)
    g.links.new(n_pos.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_near_xyz = _add_node(g, "ShaderNodeSeparateXYZ", -700, 100)
    g.links.new(n_prox.outputs["Position"], n_near_xyz.inputs["Vector"])

    # ── XY-only distance to the nearest curve point ─────────────────
    n_dx = _add_node(g, "ShaderNodeMath", -500, 250, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["X"], n_dx.inputs[0])
    g.links.new(n_near_xyz.outputs["X"], n_dx.inputs[1])
    n_dy = _add_node(g, "ShaderNodeMath", -500, 100, operation="SUBTRACT")
    g.links.new(n_pos_xyz.outputs["Y"], n_dy.inputs[0])
    g.links.new(n_near_xyz.outputs["Y"], n_dy.inputs[1])
    n_dx_sq = _add_node(g, "ShaderNodeMath", -300, 250, operation="MULTIPLY")
    g.links.new(n_dx.outputs[0], n_dx_sq.inputs[0])
    g.links.new(n_dx.outputs[0], n_dx_sq.inputs[1])
    n_dy_sq = _add_node(g, "ShaderNodeMath", -300, 100, operation="MULTIPLY")
    g.links.new(n_dy.outputs[0], n_dy_sq.inputs[0])
    g.links.new(n_dy.outputs[0], n_dy_sq.inputs[1])
    n_d_sq = _add_node(g, "ShaderNodeMath", -100, 200, operation="ADD")
    g.links.new(n_dx_sq.outputs[0], n_d_sq.inputs[0])
    g.links.new(n_dy_sq.outputs[0], n_d_sq.inputs[1])
    n_d = _add_node(g, "ShaderNodeMath", 100, 200, operation="SQRT")
    g.links.new(n_d_sq.outputs[0], n_d.inputs[0])

    # ── Inner / outer band edges (Inner Radius + Blend Radius) ──────
    n_outer = _add_node(g, "ShaderNodeMath", -100, 400, operation="ADD")
    g.links.new(p_in.outputs["Inner Radius"], n_outer.inputs[0])
    g.links.new(p_in.outputs["Blend Radius"], n_outer.inputs[1])

    # ── Smoothstep blend across (inner → outer) ─────────────────────
    # Map Range with SMOOTHSTEP interpolation handles the band falloff
    # in one node. Clamp on so anything inside the inner radius lands
    # at 1.0 and anything past the outer at 0.0.
    n_blend = _add_node(g, "ShaderNodeMapRange", 300, 300,
                        interpolation_type="SMOOTHSTEP", clamp=True)
    g.links.new(n_d.outputs[0], n_blend.inputs["Value"])
    g.links.new(p_in.outputs["Inner Radius"], n_blend.inputs["From Min"])
    g.links.new(n_outer.outputs[0], n_blend.inputs["From Max"])
    n_blend.inputs["To Min"].default_value = 1.0
    n_blend.inputs["To Max"].default_value = 0.0

    n_blend_scaled = _add_node(g, "ShaderNodeMath", 500, 300,
                               operation="MULTIPLY")
    g.links.new(n_blend.outputs["Result"], n_blend_scaled.inputs[0])
    g.links.new(p_in.outputs["Strength"], n_blend_scaled.inputs[1])

    # ── Banking: tilt the target around the road tangent ────────────
    # Mirror of road._conform_terrain_to_road (lines 967-992): at the
    # nearest point, compute the LEFT-perpendicular unit vector in XY
    # from the curve tangent, project the terrain vert's XY offset
    # onto it (signed lateral), clip to the inner band so the bank
    # doesn't keep extrapolating into the smoothstep zone, then
    # bank_lift = -lat_clipped * tilt * bank_strength.
    #
    # Tangent.xy is normalised in XY so the perpendicular is unit-
    # length even when the road is sloped (tangent.z ≠ 0). Without
    # this, a road climbing a steep hill would have a perpendicular
    # short in XY and the bank would under-tilt.
    n_tan_xyz = _add_node(g, "ShaderNodeSeparateXYZ", 0, -350)
    g.links.new(n_sample_tan.outputs["Value"], n_tan_xyz.inputs["Vector"])
    n_tan_x_sq = _add_node(g, "ShaderNodeMath", 200, -300, operation="MULTIPLY")
    g.links.new(n_tan_xyz.outputs["X"], n_tan_x_sq.inputs[0])
    g.links.new(n_tan_xyz.outputs["X"], n_tan_x_sq.inputs[1])
    n_tan_y_sq = _add_node(g, "ShaderNodeMath", 200, -400, operation="MULTIPLY")
    g.links.new(n_tan_xyz.outputs["Y"], n_tan_y_sq.inputs[0])
    g.links.new(n_tan_xyz.outputs["Y"], n_tan_y_sq.inputs[1])
    n_tan_xy_sumsq = _add_node(g, "ShaderNodeMath", 400, -350, operation="ADD")
    g.links.new(n_tan_x_sq.outputs[0], n_tan_xy_sumsq.inputs[0])
    g.links.new(n_tan_y_sq.outputs[0], n_tan_xy_sumsq.inputs[1])
    n_tan_xy_len = _add_node(g, "ShaderNodeMath", 600, -350, operation="SQRT")
    g.links.new(n_tan_xy_sumsq.outputs[0], n_tan_xy_len.inputs[0])
    # Floor at a tiny epsilon so a perfectly vertical tangent (degenerate
    # for a road but possible in a contrived test) doesn't divide by zero.
    n_tan_xy_safe = _add_node(g, "ShaderNodeMath", 800, -350, operation="MAXIMUM")
    g.links.new(n_tan_xy_len.outputs[0], n_tan_xy_safe.inputs[0])
    n_tan_xy_safe.inputs[1].default_value = 1e-4

    # LEFT perpendicular in XY: (-tan_y/|t|, tan_x/|t|).
    n_perp_x_raw = _add_node(g, "ShaderNodeMath", 400, -500, operation="MULTIPLY")
    g.links.new(n_tan_xyz.outputs["Y"], n_perp_x_raw.inputs[0])
    n_perp_x_raw.inputs[1].default_value = -1.0
    n_perp_x = _add_node(g, "ShaderNodeMath", 1000, -450, operation="DIVIDE")
    g.links.new(n_perp_x_raw.outputs[0], n_perp_x.inputs[0])
    g.links.new(n_tan_xy_safe.outputs[0], n_perp_x.inputs[1])
    n_perp_y = _add_node(g, "ShaderNodeMath", 1000, -550, operation="DIVIDE")
    g.links.new(n_tan_xyz.outputs["X"], n_perp_y.inputs[0])
    g.links.new(n_tan_xy_safe.outputs[0], n_perp_y.inputs[1])

    # Signed lateral offset: dot((vert - near).xy, perp.xy). Reuses
    # the n_dx / n_dy nodes from the XY-distance computation above
    # so we don't recompute the deltas.
    n_lat_x = _add_node(g, "ShaderNodeMath", 1200, -400, operation="MULTIPLY")
    g.links.new(n_dx.outputs[0], n_lat_x.inputs[0])
    g.links.new(n_perp_x.outputs[0], n_lat_x.inputs[1])
    n_lat_y = _add_node(g, "ShaderNodeMath", 1200, -550, operation="MULTIPLY")
    g.links.new(n_dy.outputs[0], n_lat_y.inputs[0])
    g.links.new(n_perp_y.outputs[0], n_lat_y.inputs[1])
    n_lat_signed = _add_node(g, "ShaderNodeMath", 1400, -450, operation="ADD")
    g.links.new(n_lat_x.outputs[0], n_lat_signed.inputs[0])
    g.links.new(n_lat_y.outputs[0], n_lat_signed.inputs[1])

    # Clip lateral to ±Inner Radius so the bank only applies inside
    # the road footprint — past inner the smoothstep handles the
    # transition and we don't want a 12 m blend band extrapolating
    # bank to wildly tilt distant terrain.
    n_inner_neg = _add_node(g, "ShaderNodeMath", 1400, -650, operation="MULTIPLY")
    g.links.new(p_in.outputs["Inner Radius"], n_inner_neg.inputs[0])
    n_inner_neg.inputs[1].default_value = -1.0
    n_lat_clip_lo = _add_node(g, "ShaderNodeMath", 1600, -550, operation="MAXIMUM")
    g.links.new(n_lat_signed.outputs[0], n_lat_clip_lo.inputs[0])
    g.links.new(n_inner_neg.outputs[0], n_lat_clip_lo.inputs[1])
    n_lat_clipped = _add_node(g, "ShaderNodeMath", 1800, -550, operation="MINIMUM")
    g.links.new(n_lat_clip_lo.outputs[0], n_lat_clipped.inputs[0])
    g.links.new(p_in.outputs["Inner Radius"], n_lat_clipped.inputs[1])

    # bank_lift = -lat_clipped × tilt × bank_strength
    n_bank_a = _add_node(g, "ShaderNodeMath", 2000, -500, operation="MULTIPLY")
    g.links.new(n_lat_clipped.outputs[0], n_bank_a.inputs[0])
    g.links.new(n_sample_tilt.outputs["Value"], n_bank_a.inputs[1])
    n_bank_b = _add_node(g, "ShaderNodeMath", 2200, -500, operation="MULTIPLY")
    g.links.new(n_bank_a.outputs[0], n_bank_b.inputs[0])
    g.links.new(p_in.outputs["Bank Strength"], n_bank_b.inputs[1])
    n_bank_lift = _add_node(g, "ShaderNodeMath", 2400, -500, operation="MULTIPLY")
    g.links.new(n_bank_b.outputs[0], n_bank_lift.inputs[0])
    n_bank_lift.inputs[1].default_value = -1.0

    # ── Target Z = curve Z + Lift + bank_lift ───────────────────────
    # Pull curve Z from the captured attribute, NOT from the nearest
    # position's Z — we flattened the curve to Z=0 before Proximity,
    # so `n_near_xyz.outputs["Z"]` is always 0. The captured "Curve
    # Z" attribute carries the original altitude per resampled point;
    # Sample Index at the nearest mesh vertex gives the right value.
    n_target_centerline = _add_node(g, "ShaderNodeMath", 100, -100, operation="ADD")
    g.links.new(n_sample_curve_z.outputs["Value"], n_target_centerline.inputs[0])
    g.links.new(p_in.outputs["Lift"], n_target_centerline.inputs[1])
    n_target_z = _add_node(g, "ShaderNodeMath", 300, -100, operation="ADD")
    g.links.new(n_target_centerline.outputs[0], n_target_z.inputs[0])
    g.links.new(n_bank_lift.outputs[0], n_target_z.inputs[1])

    # ── Blended Z: mix(vertex.z, target_z, blend) ───────────────────
    # ShaderNodeMix has two sockets named "Factor" (a FloatFactor at
    # index 0 for FLOAT/COLOR/VECTOR data, a VectorFactor at index 1
    # for non-uniform vector mixing). Address by index so we wire the
    # float-factor side unambiguously. A=2, B=3, Result=0 for FLOAT.
    n_mix_z = _add_node(g, "ShaderNodeMix", 700, 0, data_type="FLOAT")
    g.links.new(n_blend_scaled.outputs[0], n_mix_z.inputs[0])  # Factor (float)
    g.links.new(n_pos_xyz.outputs["Z"], n_mix_z.inputs[2])     # A
    g.links.new(n_target_z.outputs[0], n_mix_z.inputs[3])      # B

    # ── Clearance cap ───────────────────────────────────────────────
    # max_allowed = (target_z - clearance) + clearance * (1 - blend)
    #             = target_z - clearance * blend
    # At blend=1 (inside inner): cap = target_z - clearance.
    # At blend=0 (outside band):  cap = target_z (no effective cap; we
    #   gate the whole displacement off via Set Position selection
    #   below, so this branch never bites outside the band).
    #
    # Matches the interpolated cap in road._conform_terrain_to_road
    # (lines 1048-1061), but flattened: there the cap interpolates
    # between (road_top - clearance) and road_top across the band;
    # we collapse that to target_z - clearance * blend since
    # road_top = target_z + 0 here (Lift is already folded into
    # target_z above and the cap is measured against the *blended*
    # surface, not road_top).
    n_clear_eff = _add_node(g, "ShaderNodeMath", 700, -200,
                            operation="MULTIPLY")
    g.links.new(p_in.outputs["Clearance"], n_clear_eff.inputs[0])
    g.links.new(n_blend_scaled.outputs[0], n_clear_eff.inputs[1])
    n_cap = _add_node(g, "ShaderNodeMath", 900, -150,
                      operation="SUBTRACT")
    g.links.new(n_target_z.outputs[0], n_cap.inputs[0])
    g.links.new(n_clear_eff.outputs[0], n_cap.inputs[1])
    n_capped_z = _add_node(g, "ShaderNodeMath", 1100, -50,
                           operation="MINIMUM")
    g.links.new(n_mix_z.outputs[0], n_capped_z.inputs[0])
    g.links.new(n_cap.outputs[0], n_capped_z.inputs[1])

    # ── Final position: keep XY, swap in capped Z ───────────────────
    n_new_pos = _add_node(g, "ShaderNodeCombineXYZ", 1300, 0)
    g.links.new(n_pos_xyz.outputs["X"], n_new_pos.inputs["X"])
    g.links.new(n_pos_xyz.outputs["Y"], n_new_pos.inputs["Y"])
    g.links.new(n_capped_z.outputs[0], n_new_pos.inputs["Z"])

    # ── Selection: only displace verts inside the outer band ────────
    # Without this, the Minimum cap above would clamp every vert in
    # the scene to (target_z - 0) = target_z (Clearance * blend = 0
    # outside the band). Set Position respects Selection per-vertex,
    # so verts outside the band keep their original position.
    n_select = _add_node(g, "ShaderNodeMath", 1100, 450,
                         operation="LESS_THAN")
    g.links.new(n_d.outputs[0], n_select.inputs[0])
    g.links.new(n_outer.outputs[0], n_select.inputs[1])

    # ── Read the source terrain via Object Info (decoupled) ─────────
    # The modifier's own input geometry is ignored — we read the
    # terrain via Object Info on the Source Terrain socket so a curve
    # edit doesn't transitively dirty HV_Island. transform_space=
    # "RELATIVE" brings the source terrain into the proxy object's
    # local space, matching the same space the Input Position node
    # below operates in.
    n_terrain_in = _add_node(g, "GeometryNodeObjectInfo", 1300, 200,
                             transform_space="RELATIVE")
    g.links.new(p_in.outputs["Source Terrain"], n_terrain_in.inputs["Object"])

    # ── Apply the displacement ──────────────────────────────────────
    n_set_pos = _add_node(g, "GeometryNodeSetPosition", 1700, 0)
    g.links.new(n_terrain_in.outputs["Geometry"], n_set_pos.inputs["Geometry"])
    g.links.new(n_select.outputs[0], n_set_pos.inputs["Selection"])
    g.links.new(n_new_pos.outputs[0], n_set_pos.inputs["Position"])

    g.links.new(n_set_pos.outputs["Geometry"], p_out.inputs["Geometry"])

    return g


# ────────────────────────────────────────────────────────────────────
# Modifier wiring
# ────────────────────────────────────────────────────────────────────


def _socket_id(ng: bpy.types.NodeTree, name: str) -> str | None:
    """Look up a node-group socket's stable identifier by display
    name. The modifier accesses input sockets by identifier
    (``modifier[id] = value``), not by display name — that's the
    Blender 3.6+ API."""
    for item in ng.interface.items_tree:
        if (
            getattr(item, "item_type", None) == "SOCKET"
            and getattr(item, "in_out", None) == "INPUT"
            and item.name == name
        ):
            return item.identifier
    return None


def find_source_terrain() -> bpy.types.Object | None:
    """Find the terrain mesh that HV_RoadConform conforms (or should
    conform on first attach). Aware of the two scene states:

      * **Pre-attach** (no conform yet): the source terrain is a
        visible kind="track" mesh. Pick the largest one, excluding
        road_main and the proxy itself.
      * **Post-attach**: the source was tagged kind="terrain_source"
        when the modifier was attached. That tag wins over the
        general kind="track" lookup so we always find the same
        object on subsequent operations.

    The legacy ``_largest_terrain_mesh`` helper doesn't know about
    the proxy/source pattern and would happily return the 1-vertex
    proxy or the road_main mesh, neither of which is the conform
    source."""
    # Explicit tag wins — set by attach_road_conform_modifier.
    for o in bpy.data.objects:
        if o.type == "MESH" and o.get("kind") == "terrain_source":
            return o
    # Pre-attach fallback: largest visible kind=track that isn't the
    # road or the proxy itself.
    from .road import ROAD_OBJECT_NAME
    excluded = {ROAD_OBJECT_NAME, PROXY_OBJECT_NAME}
    largest = None
    largest_size = -1.0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        if o.get("kind") != "track":
            continue
        if o.name in excluded:
            continue
        if o.hide_get() or o.hide_viewport:
            continue
        bb = o.bound_box
        dx = bb[6][0] - bb[0][0]
        dy = bb[6][1] - bb[0][1]
        dz = bb[6][2] - bb[0][2]
        size = (dx * dx + dy * dy + dz * dz) ** 0.5
        if size > largest_size:
            largest = o
            largest_size = size
    return largest


def _ensure_proxy_object(source_terrain: bpy.types.Object) -> bpy.types.Object:
    """Return the ``terrain_conformed`` proxy object that hosts the
    HV_RoadConform modifier, creating it on first call. The proxy:

      * Has a 1-vertex placeholder mesh — the GN graph replaces its
        geometry entirely via Object Info on Source Terrain, so the
        host mesh's content is irrelevant.
      * Is tagged ``kind="track"`` so it's the collidable surface the
        runtime + export pipeline see. The source terrain has its
        ``kind`` cleared to ``"terrain_source"`` so it isn't double-
        exported.
      * Sits at world origin (the proxy is in source-terrain-local
        space because we use ``transform_space="RELATIVE"`` on the
        Object Info node inside the GN graph; the proxy's world
        transform is identity so screen positions match the source).
      * Is hidden in the source terrain's collection alongside it,
        so re-running attach can find it cleanly.

    Source terrain is hidden from the viewport (NOT deleted) — the
    author still needs it in the Outliner to edit HV_Island sliders,
    sculpt, etc. Its edits flow into the proxy live via depsgraph.
    """
    proxy = bpy.data.objects.get(PROXY_OBJECT_NAME)
    if proxy is None:
        if PROXY_MESH_NAME in bpy.data.meshes:
            bpy.data.meshes.remove(bpy.data.meshes[PROXY_MESH_NAME])
        proxy_mesh = bpy.data.meshes.new(PROXY_MESH_NAME)
        # Single vertex — Set Position in the GN graph reads from
        # Object Info(Source Terrain), so this host mesh's geometry
        # is unused. The vertex is just here so the mesh is non-empty
        # (Blender warns on empty geometry).
        proxy_mesh.from_pydata([(0.0, 0.0, 0.0)], [], [])
        proxy_mesh.update()
        proxy = bpy.data.objects.new(PROXY_OBJECT_NAME, proxy_mesh)
        # Link into the same collection as the source terrain so the
        # author finds the two together.
        target_collection = bpy.context.scene.collection
        for coll in source_terrain.users_collection:
            target_collection = coll
            break
        target_collection.objects.link(proxy)
    # Idempotent kind assignment — writing this on every call would
    # tag the object as dirty in the depsgraph every time, which is
    # one of the writes that fed the rebuild feedback loop.
    if proxy.get("kind") != "track":
        proxy["kind"] = "track"
    return proxy


def attach_road_conform_modifier(
    terrain: bpy.types.Object,
    curve_obj: bpy.types.Object,
    *,
    defaults: dict | None = None,
) -> tuple[bpy.types.Modifier, bool]:
    """Wire up the live conform via a decoupled proxy:

      1. Ensure a ``terrain_conformed`` proxy object exists in the
         same collection as ``terrain``.
      2. Add (or refresh) the ``HV_RoadConform`` modifier on the
         proxy, with Source Terrain = ``terrain`` and Road Curve =
         ``curve_obj``.
      3. Hide the source terrain in the viewport + clear its
         ``kind="track"`` tag (so runtime export picks up only the
         conformed proxy, not the un-conformed source).

    Returns ``(modifier, was_freshly_created)``. The ``defaults``
    dict, when provided, supplies seed values for the modifier's
    socket inputs (by display name) — applied ONLY on fresh creation.
    Pre-existing modifiers preserve their socket values across
    re-runs so that the user's edits in the modifier panel persist;
    auto-rebuilds that fire from curve / scene-prop edits must not
    silently revert those.

    Idempotent: re-running with the same terrain refreshes the proxy
    bindings without re-creating it; re-running with a different
    terrain re-wires the proxy to the new source. Removing the
    modifier or the proxy un-hides the source terrain (handled by a
    sibling helper / depsgraph cleanup — out of scope here)."""
    ng = bpy.data.node_groups.get(NODE_GROUP_NAME)
    # Rebuild the node group if the cached version is from an older
    # addon revision (= missing the Source Terrain socket added when
    # the proxy decoupling landed). Easier than trying to patch the
    # interface in-place.
    if ng is None or _socket_id(ng, "Source Terrain") is None:
        ng = build_road_conform_node_group()

    # Migration: the previous architecture put HV_RoadConform on the
    # source terrain's modifier stack. That created the curve→HV_Island
    # dependency we're trying to avoid. If we see one of those legacy
    # modifiers, strip it — the new proxy will replace its function.
    legacy = terrain.modifiers.get(MODIFIER_NAME)
    if legacy is not None:
        terrain.modifiers.remove(legacy)

    proxy = _ensure_proxy_object(terrain)

    existing = None
    for m in proxy.modifiers:
        if m.type == "NODES" and m.name == MODIFIER_NAME:
            existing = m
            break
    is_fresh = existing is None
    if is_fresh:
        mod = proxy.modifiers.new(MODIFIER_NAME, "NODES")
    else:
        mod = existing
    # Same idempotency guard: assigning node_group to the same value
    # still fires a depsgraph update in some Blender versions, which
    # contributed to the rebuild-loop UI flicker.
    if mod.node_group is not ng:
        mod.node_group = ng

    # Object inputs (Source Terrain + Road Curve) — write ONLY when
    # the value would actually change. Unconditional writes here
    # caused a vicious feedback loop: setting mod[curve_id] = curve_obj
    # fired a depsgraph update with the curve in its update-list,
    # which the depsgraph handler interpreted as a curve edit and
    # scheduled another road rebuild, which called attach again, etc.
    # Each iteration redrew the UI every ~0.2 s (the debounce
    # interval), making modifier sliders un-clickable.
    source_id = _socket_id(ng, "Source Terrain")
    if source_id and mod[source_id] is not terrain:
        mod[source_id] = terrain
    curve_id = _socket_id(ng, "Road Curve")
    if curve_id and mod[curve_id] is not curve_obj:
        mod[curve_id] = curve_obj

    # Tuning sockets (Inner Radius, Lift, etc) get DEFAULTS only on
    # fresh creation. On subsequent re-attaches the modifier's existing
    # values are preserved — otherwise every depsgraph-triggered
    # rebuild would silently revert whatever the user just typed in
    # the modifier panel. The user's slider edits in Properties →
    # Modifiers → HV_RoadConform persist forever (until they remove
    # the modifier or click an explicit *Sync from Scene Props*).
    if is_fresh and defaults:
        for name, value in defaults.items():
            sid = _socket_id(ng, name)
            if sid is not None:
                mod[sid] = value

    # Hide the source terrain from the viewport and demote its kind
    # so the runtime/export pipeline picks up only the conformed
    # proxy. Guard each write — see the Source Terrain note above for
    # why unconditional writes cause a depsgraph rebuild loop.
    if terrain.name != PROXY_OBJECT_NAME:
        if not terrain.hide_viewport:
            terrain.hide_viewport = True
        if not terrain.hide_render:
            terrain.hide_render = True
        if terrain.get("kind") == "track":
            terrain["kind"] = "terrain_source"

    return mod, is_fresh


# ────────────────────────────────────────────────────────────────────
# Snap-curve helper — projects curve control points down to terrain
# ────────────────────────────────────────────────────────────────────


def _ray_down_to_terrain(
    terrain: bpy.types.Object,
    x: float,
    y: float,
    *,
    start_z: float = 500.0,
    end_z: float = -500.0,
) -> float | None:
    """Raycast straight down at (``x``, ``y``) onto the terrain mesh
    in world space. Returns the hit Z, or ``None`` if the ray misses
    (off the terrain plane edges).

    Cheaper than building a BVHTree because we can use Blender's
    ``Object.ray_cast`` which already keeps its own evaluated BVH
    around. The terrain matrix is applied automatically inside the
    method's local-space conversion."""
    mw = terrain.matrix_world
    mw_inv = mw.inverted_safe()
    # Convert the world-space ray endpoints into terrain-local space —
    # ray_cast expects local-space inputs and returns a local-space
    # hit. Going through world is the only way to be sure the start
    # is above the terrain regardless of how the user posed it.
    local_start = mw_inv @ mathutils.Vector((x, y, start_z))
    local_end = mw_inv @ mathutils.Vector((x, y, end_z))
    direction = (local_end - local_start)
    length = direction.length
    if length < 1e-6:
        return None
    direction.normalize()
    hit, location_local, _normal, _idx = terrain.ray_cast(
        local_start, direction, distance=length
    )
    if not hit:
        return None
    world_hit = mw @ location_local
    return float(world_hit.z)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_attach_road_conform(Operator):
    """Add (or refresh) the live ``HV_RoadConform`` Geometry Nodes
    modifier on the active terrain mesh. Wires ``road_curve_main``
    (falling back to ``ai_spline_main``) into the modifier's Road
    Curve socket. Pure GN — no vertex mutation — so editing the curve
    or the modifier sliders re-shapes the terrain live and reverts
    cleanly when the modifier is disabled or removed.

    Stack it on top of any procedural terrain modifier (``HV_Island``,
    heightmap, hand sculpt). Tune width / blend / lift directly in
    Properties → Modifiers → HV_RoadConform.

    For per-CP banking, float/conform weights, or the high-fidelity
    multi-segment "always push down" rule, fall back to the legacy
    ``Build Road`` operator — it's still the export-time bake path."""

    bl_idname = "hoverbike.attach_road_conform"
    bl_label = "Attach Road Conform (live)"
    bl_description = (
        "Add the live HV_RoadConform Geometry Nodes modifier on the active "
        "terrain — non-destructive, edit the curve to re-shape the terrain "
        "in real time. Pairs with Snap Curve to seed sane Z values."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from .road import _resolve_road_curve

        curve_obj = _resolve_road_curve()
        if curve_obj is None:
            self.report(
                {"ERROR"},
                "No road curve found — click *Add Road Curve* (or author "
                "an ai_spline_main) before attaching the conform modifier.",
            )
            return {"CANCELLED"}

        # Use the proxy-aware source-terrain lookup so re-attaches
        # find the same source object even after the first attach
        # has hidden it + retagged its kind to "terrain_source".
        terrain = find_source_terrain()
        if terrain is None:
            self.report(
                {"ERROR"},
                "No terrain mesh found. Select a kind=track mesh first, or "
                "set kind='track' on the terrain you want the road to follow.",
            )
            return {"CANCELLED"}

        mod, is_fresh = attach_road_conform_modifier(terrain, curve_obj)
        verb = "Attached" if is_fresh else "Refreshed"
        self.report(
            {"INFO"},
            f"{verb} {mod.name} on {mod.id_data.name} → source {terrain.name}, curve {curve_obj.name}. "
            "Tune width / blend / lift in Properties → Modifiers.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_snap_curve_to_terrain(Operator):
    """Project every control point of the road curve straight down
    onto the terrain so each point's Z lands on the terrain surface
    (plus the configured Lift). Does *not* modify the terrain — it's
    a one-shot seeding pass for the curve.

    Run this once after sculpting the terrain (or after a big curve
    XY edit) so the GN conform modifier has a sensible target Z to
    blend toward. After the snap, edit the curve handles freely in
    edit mode and the terrain follows through the live modifier.

    Per-point Float mode (``weight_softbody > 0.5``) is respected —
    floating points keep their authored Z so bridges and ramps still
    work."""

    bl_idname = "hoverbike.snap_curve_to_terrain"
    bl_label = "Snap Curve to Terrain"
    bl_description = (
        "Raycast each road-curve control point down onto the terrain to "
        "seed sensible Z values for the live GN conform modifier"
    )
    bl_options = {"REGISTER", "UNDO"}

    lift: FloatProperty(  # type: ignore[valid-type]
        name="Lift (m)",
        description=(
            "Optional vertical offset added to each snapped point. Default "
            "is 0 — the curve sits exactly on the terrain surface and the "
            "HV_RoadConform modifier / road mesh build add their own lift "
            "on top. Setting this non-zero stacks an extra offset onto "
            "every conform target, which is rarely what you want."
        ),
        default=0.0,
        min=-10.0,
        max=10.0,
    )

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh
        from .road import _resolve_road_curve

        curve_obj = _resolve_road_curve()
        if curve_obj is None:
            self.report({"ERROR"}, "No road curve found to snap.")
            return {"CANCELLED"}

        terrain = context.active_object
        if terrain is None or terrain.type != "MESH" or terrain.get("kind") != "track":
            terrain = _largest_terrain_mesh()
        if terrain is None:
            self.report({"ERROR"}, "No terrain mesh found to raycast onto.")
            return {"CANCELLED"}

        lift = float(self.lift)

        # Curve control points live in the curve object's local space.
        # Raycasting needs world XY, so we convert through curve.matrix_world,
        # then convert the resulting world-Z hit back into curve-local-Z
        # before writing it back to the control point.
        curve_mw = curve_obj.matrix_world
        curve_mw_inv = curve_mw.inverted_safe()

        snapped = 0
        skipped_float = 0
        missed = 0
        for spline in curve_obj.data.splines:
            if spline.type == "BEZIER":
                pts = spline.bezier_points
            else:
                pts = spline.points
            for pt in pts:
                # Float-mode points (weight_softbody > 0.5) keep their
                # authored Z — same convention as the destructive
                # conform in road._sample_road_path. The curve's Z is
                # the bridge/ramp height the author intended.
                if getattr(pt, "weight_softbody", 0.0) > 0.5:
                    skipped_float += 1
                    continue
                if spline.type == "BEZIER":
                    local_co = pt.co.copy()
                else:
                    # NURBS points are 4D (x, y, z, w) — slice off w.
                    local_co = mathutils.Vector(pt.co[:3])
                world_co = curve_mw @ local_co
                hit_z = _ray_down_to_terrain(terrain, world_co.x, world_co.y)
                if hit_z is None:
                    missed += 1
                    continue
                new_world = mathutils.Vector((world_co.x, world_co.y, hit_z + lift))
                new_local = curve_mw_inv @ new_world
                if spline.type == "BEZIER":
                    # Move the control point AND the two handles by
                    # the same delta so the handle relationship stays
                    # intact — otherwise the spline kinks at every
                    # snapped point.
                    delta_z = new_local.z - pt.co.z
                    pt.co.z = new_local.z
                    pt.handle_left.z += delta_z
                    pt.handle_right.z += delta_z
                else:
                    pt.co = (new_local.x, new_local.y, new_local.z, pt.co[3])
                snapped += 1

        # Curves don't get a me.update() — Blender re-evaluates on access —
        # but invalidating the depsgraph here makes the redo panel feel
        # snappy when the user tweaks Lift after the snap.
        curve_obj.data.update_tag()

        msg = f"Snapped {snapped} point(s) on {curve_obj.name} to {terrain.name}"
        if skipped_float:
            msg += f" ({skipped_float} float-mode pts skipped)"
        if missed:
            msg += f" — {missed} ray miss(es) off the terrain"
        self.report({"INFO"}, msg)
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_attach_road_conform,
    HOVERBIKE_OT_snap_curve_to_terrain,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
