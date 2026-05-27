"""Seed ``tracks-src/props-library.blend`` — Asset-Browser-marked library
of procedural track props (Item 3 from docs/blender-wishlist.md, with
biome kits added per docs/level-visual-quality-research.md Layer C / γ).

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_props_library.py

This is a one-shot scaffolder, analogous to ``seed_template_island.py``
and ``seed_bike_kit.py``. Nuke-and-paves on every run; the .blend is
the source of truth for hand-tuned tweaks afterwards.

### What the seed produces

Five **collections**, each marked as a Blender Asset under the
``Hoverbike/Track Props`` catalogue:

| Collection | Catalogue sub-tree | Base geometry | Procedural knobs |
|---|---|---|---|
| ``prop_rock``           | Rocks      | Distorted icosphere, FBM noise displacement | size, jaggedness, seed |
| ``prop_palm``           | Palms      | Tapered trunk + radial fronds               | height, frond count, droop |
| ``prop_buoy``           | Buoys      | Pylon + skirt + emissive top cap            | radius, height, light tint |
| ``prop_gate``           | Gates      | Two posts + crossbar at gizmo dimensions    | half-width, height, post radius |
| ``prop_turn_indicator`` | Indicators | Flat chevron mesh                           | size |

Each prop:

- Has a Geometry Nodes modifier on a single-vertex base mesh, so the
  asset's shape is purely a function of the modifier's input sockets.
  Authors retune via Properties → Modifier panel.
- Carries ``COLOR_0`` per [docs/vertex-attribute-spec.md](../../docs/vertex-attribute-spec.md):
  - **Foliage / animated** props (palm) store linear sway gradient in R.
  - **Static** props (rock, buoy, gate, indicator) store terrain defaults
    (R=1, G=1, B=0, A=0). Scatter graphs overwrite B with per-instance
    random phase via ``Store Named Attribute``.
- Uses placeholder materials whose name follows the runtime convention
  (``mat_foliage_palm`` opts the palm into the sway shader at load; the
  rest stay static).
- Sits inside a top-level Empty named ``prop_<id>`` so Item 4's scatter
  graph can use the collection as a ``Collection Info → Instance on
  Points`` source without any reparenting.

### Aesthetic polish — deferred to GUI follow-up

Per the wishlist's "scaffold + hand off" guidance, this seed ships
*functional* placeholder geometry with sensible knobs. Real PBR
materials, sculpted rock silhouettes, palm-leaf textures, and per-prop
preview-thumbnail composition are all left for in-Blender iteration.
The .blend is the source of truth from that point forward — re-running
the seed nukes hand-edits.

### Asset Browser catalogue

A ``blender_assets.cats.txt`` file is written alongside the .blend in
``tracks-src/``. Blender picks it up automatically when the user adds
that folder as an asset library (Edit → Preferences → File Paths →
Asset Libraries → Add → tracks-src/). One Hoverbike library, five
sub-categories.
"""

from __future__ import annotations

import math
import os
import sys
import uuid

import bmesh
import bpy
from mathutils import Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.blender.vertex_attrs import (  # noqa: E402
    DEFAULT_TERRAIN,
    set_color_attr,
    set_constant,
    set_linear_sway_z,
)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")
CATALOG_PATH = os.path.join(REPO_ROOT, "tracks-src", "blender_assets.cats.txt")

CATALOG_ROOT = "Hoverbike/Track Props"

# Catalogue UUIDs are deterministic so re-running the seed produces a
# stable catalogue file. The Asset Browser keys on the UUID, not the
# path, so stability lets authors save user-side catalog selections.
CATALOG_UUIDS = {
    "Hoverbike":                       "11111111-1111-4111-8111-000000000001",
    "Hoverbike/Track Props":           "11111111-1111-4111-8111-000000000002",
    "Hoverbike/Track Props/Rocks":     "11111111-1111-4111-8111-000000000010",
    "Hoverbike/Track Props/Palms":     "11111111-1111-4111-8111-000000000011",
    "Hoverbike/Track Props/Buoys":     "11111111-1111-4111-8111-000000000012",
    "Hoverbike/Track Props/Logs":      "11111111-1111-4111-8111-000000000027",
    "Hoverbike/Track Props/Gates":     "11111111-1111-4111-8111-000000000013",
    "Hoverbike/Track Props/Indicators":"11111111-1111-4111-8111-000000000014",
    # Phase γ biome kits — keep UUIDs stable so Asset-Browser
    # bookmarks survive re-runs.
    "Hoverbike/Track Props/Urban":     "11111111-1111-4111-8111-000000000020",
    "Hoverbike/Track Props/Industrial":"11111111-1111-4111-8111-000000000021",
    "Hoverbike/Track Props/Volcanic":  "11111111-1111-4111-8111-000000000022",
    "Hoverbike/Track Props/Jungle":    "11111111-1111-4111-8111-000000000023",
    # Final biome kits (Phase γ #8 follow-up — closes the remaining biome
    # gaps from `docs/level-visual-quality-research.md` Layer C / Phase γ).
    "Hoverbike/Track Props/Venetian":  "11111111-1111-4111-8111-000000000024",
    "Hoverbike/Track Props/Waterpark": "11111111-1111-4111-8111-000000000025",
    "Hoverbike/Track Props/Open Sea":  "11111111-1111-4111-8111-000000000026",
}


# ────────────────────────────────────────────────────────────────────
# Catalogue file — shared with seed_landmarks_library via the merge
# helper. Re-seeding props preserves landmark UUIDs (and vice-versa);
# see ``blender_assets_catalog.merge_catalog_file`` for the contract.
# ────────────────────────────────────────────────────────────────────

def write_catalog_file() -> None:
    """Merge prop-library catalogue rows into the shared
    ``tracks-src/blender_assets.cats.txt``."""
    from tools.blender.blender_assets_catalog import merge_catalog_file

    merge_catalog_file(CATALOG_PATH, CATALOG_UUIDS)


# ────────────────────────────────────────────────────────────────────
# Scene reset
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Node-group helpers (verbatim style from seed_template_island.py)
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
# Materials — placeholder Principled BSDFs with runtime-convention names
# ────────────────────────────────────────────────────────────────────

def _hex(c, gamma=2.2):
    s = c.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** gamma, g ** gamma, b ** gamma, 1.0)


def make_material(name: str, base_color_hex: str, roughness: float = 0.7, emission_hex: str | None = None, emission_strength: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = _hex(base_color_hex)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if emission_hex and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = _hex(emission_hex)
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


# ────────────────────────────────────────────────────────────────────
# Rock — noise-displaced icosphere
# ────────────────────────────────────────────────────────────────────

ROCK_GROUP = "HV_Prop_Rock"


def build_rock_group() -> bpy.types.NodeTree:
    """Take an input geometry (icosphere), displace each vertex along
    its normal by FBM noise sampled in world space, scale by Size."""
    if ROCK_GROUP in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[ROCK_GROUP])
    g = bpy.data.node_groups.new(ROCK_GROUP, "GeometryNodeTree")

    _new_socket(g, "Geometry",    "INPUT",  "NodeSocketGeometry")
    _new_socket(g, "Size",        "INPUT",  "NodeSocketFloat",  1.5)
    _new_socket(g, "Jaggedness",  "INPUT",  "NodeSocketFloat",  0.35, mn=0.0, mx=1.0)
    _new_socket(g, "Noise Scale", "INPUT",  "NodeSocketFloat",  1.4)
    _new_socket(g, "Seed",        "INPUT",  "NodeSocketFloat",  0.0)
    _new_socket(g, "Geometry",    "OUTPUT", "NodeSocketGeometry")

    gi = _add_node(g, "NodeGroupInput",  -1400, 0)
    go = _add_node(g, "NodeGroupOutput",  1200, 0)

    # Capture position before any scaling so the noise is stable as we
    # change Size — otherwise scaling the input would change the noise
    # sample point.
    pos = _add_node(g, "GeometryNodeInputPosition", -1100, -300)
    nrm = _add_node(g, "GeometryNodeInputNormal",   -1100, -500)

    # Noise vector → push each vert along its normal by N(x).
    # 4D noise so Seed perturbs the field.
    noise = _add_node(g, "ShaderNodeTexNoise", -900, -300)
    noise.noise_dimensions = "4D"
    noise.normalize = False
    noise.inputs["Detail"].default_value = 4.0
    noise.inputs["Roughness"].default_value = 0.55
    noise.inputs["Distortion"].default_value = 0.3
    g.links.new(pos.outputs["Position"], noise.inputs["Vector"])
    g.links.new(gi.outputs["Noise Scale"], noise.inputs["Scale"])
    g.links.new(gi.outputs["Seed"], noise.inputs["W"])

    # noise.Fac is [0,1]; map to signed [-1,1] then × Jaggedness × Size
    signed = _add_node(g, "ShaderNodeMath", -700, -300, operation="MULTIPLY_ADD")
    signed.inputs[1].default_value = 2.0
    signed.inputs[2].default_value = -1.0
    g.links.new(noise.outputs["Fac"], signed.inputs[0])

    amp = _add_node(g, "ShaderNodeMath", -500, -300, operation="MULTIPLY")
    g.links.new(signed.outputs[0], amp.inputs[0])
    g.links.new(gi.outputs["Jaggedness"], amp.inputs[1])

    # Displacement vector = normal * amp * Size
    displace_scale = _add_node(g, "ShaderNodeMath", -300, -300, operation="MULTIPLY")
    g.links.new(amp.outputs[0], displace_scale.inputs[0])
    g.links.new(gi.outputs["Size"], displace_scale.inputs[1])

    displace_vec = _add_node(g, "ShaderNodeVectorMath", -100, -400, operation="SCALE")
    g.links.new(nrm.outputs["Normal"], displace_vec.inputs[0])
    g.links.new(displace_scale.outputs[0], displace_vec.inputs["Scale"])

    # Apply Size first, then displacement.
    scale_set = _add_node(g, "GeometryNodeSetPosition", -600, 100)
    g.links.new(gi.outputs["Geometry"], scale_set.inputs["Geometry"])
    scale_vec = _add_node(g, "ShaderNodeVectorMath", -900, 100, operation="SCALE")
    g.links.new(pos.outputs["Position"], scale_vec.inputs[0])
    g.links.new(gi.outputs["Size"], scale_vec.inputs["Scale"])
    g.links.new(scale_vec.outputs[0], scale_set.inputs["Position"])

    set_pos = _add_node(g, "GeometryNodeSetPosition", 100, 100)
    g.links.new(scale_set.outputs["Geometry"], set_pos.inputs["Geometry"])
    g.links.new(displace_vec.outputs[0], set_pos.inputs["Offset"])

    # Recompute normals for smoother shading after displacement.
    shade_smooth = _add_node(g, "GeometryNodeSetShadeSmooth", 400, 100, domain="FACE")
    g.links.new(set_pos.outputs["Geometry"], shade_smooth.inputs["Geometry"])
    shade_smooth.inputs["Shade Smooth"].default_value = True

    g.links.new(shade_smooth.outputs["Geometry"], go.inputs["Geometry"])
    return g


def build_rock_mesh(name: str) -> bpy.types.Mesh:
    """Icosphere base mesh with terrain-default COLOR_0."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ────────────────────────────────────────────────────────────────────
# Palm — trunk cylinder + radial fronds, sway in R channel
# ────────────────────────────────────────────────────────────────────

PALM_GROUP = "HV_Prop_Palm"


def build_palm_mesh(name: str, *, height: float = 4.5, frond_count: int = 7, frond_length: float = 2.4, frond_droop: float = 0.7) -> bpy.types.Mesh:
    """Hand-built palm geometry: tapered trunk + radial fronds. We do
    this in bmesh (not GN) because the COLOR_0 sway gradient is
    authored per-vertex by Python — the GN store-attribute path would
    work too but bmesh is simpler for a small mesh and matches Item 6's
    ``set_linear_sway_z`` helper directly.

    The GN modifier on top of this mesh exposes height/frond_count
    knobs via simple transform-warps so the asset still feels live in
    the modifier panel."""
    bm = bmesh.new()

    # Trunk — tapered cylinder.
    trunk_segs = 8
    trunk_rings = 6
    trunk_radius_base = 0.18
    trunk_radius_top = 0.10
    ring_verts: list[list[bmesh.types.BMVert]] = []
    for ri in range(trunk_rings + 1):
        t = ri / trunk_rings
        z = t * height
        # Subtle organic bend
        bend_x = 0.05 * math.sin(t * math.pi) * height * 0.1
        r = trunk_radius_base * (1.0 - t) + trunk_radius_top * t
        ring = []
        for si in range(trunk_segs):
            ang = (si / trunk_segs) * math.tau
            x = math.cos(ang) * r + bend_x
            y = math.sin(ang) * r
            ring.append(bm.verts.new((x, y, z)))
        ring_verts.append(ring)
    for ri in range(trunk_rings):
        cur = ring_verts[ri]
        nxt = ring_verts[ri + 1]
        for si in range(trunk_segs):
            sn = (si + 1) % trunk_segs
            bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
    # Cap the base
    bm.faces.new(ring_verts[0][::-1])

    # Fronds — flat strips emerging from the trunk top, drooping outward.
    top_x = 0.05 * math.sin(math.pi) * height * 0.1  # bend_x at t=1
    crown_origin = Vector((top_x, 0.0, height))
    frond_segs = 6  # segments along the length, gives drooping curve
    frond_half_width_base = 0.04
    frond_half_width_mid = 0.18
    frond_half_width_tip = 0.02

    for fi in range(frond_count):
        ang = (fi / frond_count) * math.tau + 0.13 * fi  # slight randomization
        dir_xy = Vector((math.cos(ang), math.sin(ang), 0.0))
        # Build a quad strip along the frond's length with width that pulses.
        left_verts = []
        right_verts = []
        for si in range(frond_segs + 1):
            t = si / frond_segs
            # Arc shape: rises slightly then droops with gravity.
            arc_z = math.sin(t * math.pi) * (frond_length * 0.25) - (t * t) * frond_length * frond_droop
            radial = t * frond_length
            centre = crown_origin + dir_xy * radial + Vector((0.0, 0.0, arc_z))
            # Width tapers: small at base, fatter in the middle, tiny at the tip.
            if t < 0.2:
                w = frond_half_width_base + (frond_half_width_mid - frond_half_width_base) * (t / 0.2)
            elif t < 0.7:
                w = frond_half_width_mid
            else:
                w = frond_half_width_mid + (frond_half_width_tip - frond_half_width_mid) * ((t - 0.7) / 0.3)
            perp = Vector((-dir_xy.y, dir_xy.x, 0.0)) * w
            left_verts.append(bm.verts.new(centre + perp))
            right_verts.append(bm.verts.new(centre - perp))
        for si in range(frond_segs):
            bm.faces.new([left_verts[si], left_verts[si + 1], right_verts[si + 1], right_verts[si]])

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()

    # Smooth shading on fronds + trunk
    for p in me.polygons:
        p.use_smooth = True

    # Sway gradient: linear in Z from trunk base (0) to leaf tip (1).
    set_linear_sway_z(me, z_min=0.0, z_max=height * 1.2, ao=1.0)
    return me


def build_palm_group() -> bpy.types.NodeTree:
    """Pass-through GN group with a Scale socket so authors can resize
    the palm via the modifier panel without re-baking. The GN-side
    knobs intentionally don't regenerate fronds — for shape changes,
    re-run the seed (and accept that overrides nuke). Scale is the one
    knob that's safely live."""
    if PALM_GROUP in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[PALM_GROUP])
    g = bpy.data.node_groups.new(PALM_GROUP, "GeometryNodeTree")

    _new_socket(g, "Geometry", "INPUT",  "NodeSocketGeometry")
    _new_socket(g, "Scale",    "INPUT",  "NodeSocketFloat", 1.0, mn=0.1, mx=10.0)
    _new_socket(g, "Geometry", "OUTPUT", "NodeSocketGeometry")

    gi = _add_node(g, "NodeGroupInput",  -800, 0)
    go = _add_node(g, "NodeGroupOutput",  600, 0)

    pos = _add_node(g, "GeometryNodeInputPosition", -600, -200)
    scale_vec = _add_node(g, "ShaderNodeVectorMath", -400, -100, operation="SCALE")
    g.links.new(pos.outputs["Position"], scale_vec.inputs[0])
    g.links.new(gi.outputs["Scale"], scale_vec.inputs["Scale"])

    set_pos = _add_node(g, "GeometryNodeSetPosition", -100, 0)
    g.links.new(gi.outputs["Geometry"], set_pos.inputs["Geometry"])
    g.links.new(scale_vec.outputs[0], set_pos.inputs["Position"])

    g.links.new(set_pos.outputs["Geometry"], go.inputs["Geometry"])
    return g


# ────────────────────────────────────────────────────────────────────
# Buoy — pylon + skirt + emissive top
# ────────────────────────────────────────────────────────────────────

def build_buoy_mesh(name: str, *, radius: float = 0.6, height: float = 1.5) -> bpy.types.Mesh:
    """Pylon-style buoy. Mesh layout (Z up):
       z=-0.2: skirt/keel ring (wider than the body) so it floats visually
       z=0   : waterline ring
       z=h-0.2: shoulder ring
       z=h   : top cap (smaller, emissive)
    """
    bm = bmesh.new()
    segs = 16

    def ring(r: float, z: float):
        return [bm.verts.new((math.cos(s / segs * math.tau) * r,
                               math.sin(s / segs * math.tau) * r,
                               z)) for s in range(segs)]

    r_keel = radius * 1.2
    r_body = radius
    r_shoulder = radius * 0.85
    r_top = radius * 0.35

    keel = ring(r_keel, -0.25)
    water = ring(r_body, 0.0)
    shoulder = ring(r_shoulder, height - 0.25)
    top = ring(r_top, height)

    def quad_strip(a, b):
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new([a[i], a[j], b[j], b[i]])

    quad_strip(keel, water)
    quad_strip(water, shoulder)
    quad_strip(shoulder, top)

    # Bottom: invert keel ring as a fan
    bm.faces.new(keel[::-1])
    # Top cap (the "light")
    top_cap = bm.faces.new(top)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True

    # Tag the top-cap loops by emissive multiplier in A. We mark every
    # vert whose z is within ε of the top ring height — the topmost
    # ring of verts gets A=1, everything else A=0. R,G,B keep terrain
    # defaults so the static shader sees no sway/phase.
    def value_for(i, co):
        is_top = abs(co[2] - height) < 1e-3
        return (1.0, 1.0, 0.0, 1.0 if is_top else 0.0)
    set_color_attr(me, value_for)

    # Assign material index 1 to the top cap polygon (created last);
    # everything else stays at index 0.
    me.polygons[-1].material_index = 1

    return me


# ────────────────────────────────────────────────────────────────────
# Drift log — horizontal cylinder that wave-rides like a buoy
# ────────────────────────────────────────────────────────────────────


def build_log_mesh(name: str, *, length: float = 2.4, radius: float = 0.30) -> bpy.types.Mesh:
    """Drift-log mesh — horizontal cylinder lying along +X. Pairs with
    the runtime ``wave_rider_archetype = "log"`` tuning (longer tilt
    period, smaller floatOffsetY than the buoy). The cylinder runs
    along +X so the runtime's yaw drift reads as the log rolling about
    its long axis when authored at yaw=0.

    A subtle taper at each end + a faint mid-band sit the silhouette
    apart from the pylon-style buoy at race speed."""
    bm = bmesh.new()
    segs = 12
    half = length / 2

    def ring(x: float, r: float) -> list[bmesh.types.BMVert]:
        return [
            bm.verts.new((x,
                          math.cos(s / segs * math.tau) * r,
                          math.sin(s / segs * math.tau) * r))
            for s in range(segs)
        ]

    # Ring stack along +X — slight taper at both ends so the log reads
    # organic and not as a perfect cylinder.
    left_cap = ring(-half,          radius * 0.78)
    left     = ring(-half * 0.85,   radius)
    mid_l    = ring(-half * 0.30,   radius * 1.04)
    mid_r    = ring( half * 0.30,   radius * 1.04)
    right    = ring( half * 0.85,   radius)
    right_cap = ring(half,          radius * 0.78)

    rings = [left_cap, left, mid_l, mid_r, right, right_cap]
    for i in range(len(rings) - 1):
        cur = rings[i]
        nxt = rings[i + 1]
        for si in range(segs):
            sn = (si + 1) % segs
            bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
    # Caps.
    bm.faces.new(left_cap[::-1])
    bm.faces.new(right_cap)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ────────────────────────────────────────────────────────────────────
# Gate — two posts + crossbar
# ────────────────────────────────────────────────────────────────────

def build_gate_mesh(name: str, *, half_width: float = 14.0, height: float = 6.0, post_radius: float = 0.35) -> bpy.types.Mesh:
    """Two vertical posts at ±half_width, joined by a horizontal bar at
    height. Each post is an 8-sided cylinder."""
    bm = bmesh.new()
    segs = 8

    def cylinder(centre: Vector, axis: Vector, length: float, r: float):
        # Build a cylinder of *length* along *axis* starting at *centre*.
        # We construct two rings perpendicular to the axis using two
        # orthogonal basis vectors.
        a = axis.normalized()
        # Pick a vector not parallel to the axis to derive the basis.
        helper = Vector((1.0, 0.0, 0.0)) if abs(a.dot(Vector((1, 0, 0)))) < 0.9 else Vector((0, 1, 0))
        u = a.cross(helper).normalized() * r
        v = a.cross(u).normalized() * r
        ring0 = []
        ring1 = []
        for i in range(segs):
            ang = (i / segs) * math.tau
            offs = u * math.cos(ang) + v * math.sin(ang)
            ring0.append(bm.verts.new(centre + offs))
            ring1.append(bm.verts.new(centre + a * length + offs))
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new([ring0[i], ring0[j], ring1[j], ring1[i]])
        bm.faces.new(ring0[::-1])
        bm.faces.new(ring1)

    # Left post
    cylinder(Vector((-half_width, 0.0, 0.0)), Vector((0, 0, 1)), height, post_radius)
    # Right post
    cylinder(Vector(( half_width, 0.0, 0.0)), Vector((0, 0, 1)), height, post_radius)
    # Crossbar — span from -half_width to +half_width at z=height
    bar_radius = post_radius * 0.7
    cylinder(Vector((-half_width, 0.0, height)), Vector((1, 0, 0)), half_width * 2.0, bar_radius)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ────────────────────────────────────────────────────────────────────
# Turn indicator — static chevron (matches the operator's gizmo)
# ────────────────────────────────────────────────────────────────────

def build_turn_indicator_mesh(name: str, *, length: float = 4.0, half_width: float = 2.0) -> bpy.types.Mesh:
    """Flat chevron pointing in +X (bend direction). Two triangles
    forming a notched arrow head. Same geometry the curvature-driven
    operator already builds; this is for fixed-position author use."""
    bm = bmesh.new()
    # Triangle 1: outer arrow
    p0 = bm.verts.new((0.0, -half_width, 0.0))
    p1 = bm.verts.new((length, 0.0, 0.0))
    p2 = bm.verts.new((0.0, half_width, 0.0))
    # Inner notch — pulls the trailing edge into a V
    p3 = bm.verts.new((length * 0.3, 0.0, 0.0))
    bm.faces.new([p0, p1, p3])
    bm.faces.new([p3, p1, p2])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ────────────────────────────────────────────────────────────────────
# Biome prop kits (Phase γ of docs/level-visual-quality-research.md)
# ────────────────────────────────────────────────────────────────────
#
# Each builder produces a small, distinctive silhouette under 200 verts
# with a single material slot. Goal is "reads correctly at 40 m/s, fewer
# than 200 verts, single material slot" — geometric placeholders an
# author can replace with sculpted/textured versions later. Coordinates
# are local; the props library lays each one out along +X for outliner
# readability. Every mesh sets `COLOR_0` to terrain defaults (or to a
# sway gradient where appropriate) so the runtime sway shader is opt-in
# via material-name prefix.


def _cylinder_z(bm: bmesh.types.BMesh, *, radius: float, z0: float, z1: float, segs: int = 12, cap_top: bool = True, cap_bottom: bool = True) -> tuple[list[bmesh.types.BMVert], list[bmesh.types.BMVert]]:
    """Build a Z-axis cylinder ring stack. Returns (bottom_ring, top_ring)
    so callers can extend with custom caps or further extrusions. Caps
    default ON because most props need closed geometry."""
    def ring(z: float) -> list[bmesh.types.BMVert]:
        return [
            bm.verts.new((math.cos(s / segs * math.tau) * radius,
                          math.sin(s / segs * math.tau) * radius,
                          z))
            for s in range(segs)
        ]
    bottom = ring(z0)
    top = ring(z1)
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([bottom[i], bottom[j], top[j], top[i]])
    if cap_bottom:
        bm.faces.new(bottom[::-1])
    if cap_top:
        bm.faces.new(top)
    return bottom, top


def _box(bm: bmesh.types.BMesh, *, half_x: float, half_y: float, half_z: float, z_centre: float = 0.0) -> list[bmesh.types.BMVert]:
    """8-vertex axis-aligned box centred on (0, 0, z_centre). Returns the
    vert list in (-x-y-z, +x-y-z, +x+y-z, -x+y-z, -x-y+z, +x-y+z, +x+y+z,
    -x+y+z) order. All six faces created."""
    v = [
        bm.verts.new((-half_x, -half_y, z_centre - half_z)),
        bm.verts.new(( half_x, -half_y, z_centre - half_z)),
        bm.verts.new(( half_x,  half_y, z_centre - half_z)),
        bm.verts.new((-half_x,  half_y, z_centre - half_z)),
        bm.verts.new((-half_x, -half_y, z_centre + half_z)),
        bm.verts.new(( half_x, -half_y, z_centre + half_z)),
        bm.verts.new(( half_x,  half_y, z_centre + half_z)),
        bm.verts.new((-half_x,  half_y, z_centre + half_z)),
    ]
    bm.faces.new([v[0], v[3], v[2], v[1]])  # bottom
    bm.faces.new([v[4], v[5], v[6], v[7]])  # top
    bm.faces.new([v[0], v[1], v[5], v[4]])  # -Y
    bm.faces.new([v[1], v[2], v[6], v[5]])  # +X
    bm.faces.new([v[2], v[3], v[7], v[6]])  # +Y
    bm.faces.new([v[3], v[0], v[4], v[7]])  # -X
    return v


# ── Urban kit ──────────────────────────────────────────────────────


def build_lamp_post_mesh(name: str, *, height: float = 3.6) -> bpy.types.Mesh:
    """Slim pole + boxy lampshade. The top face sits at z=height and
    gets material index 1 (emissive) so the lit panel pops at night."""
    bm = bmesh.new()
    _cylinder_z(bm, radius=0.06, z0=0.0, z1=height - 0.3, segs=8)
    # Lampshade — small rectangular box at the top of the pole.
    bm.verts.ensure_lookup_table()
    _box(bm, half_x=0.18, half_y=0.10, half_z=0.15, z_centre=height - 0.15)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    # Mark the lampshade top face (highest face by avg z) as emissive.
    # We tag by face index: the box was added last, its top face is the
    # second-to-last face per `_box`'s order.
    top_face_idx = len(me.polygons) - 5  # 5 box faces follow the top
    me.polygons[top_face_idx].material_index = 1
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_antenna_mast_mesh(name: str, *, height: float = 7.0) -> bpy.types.Mesh:
    """Lattice-style antenna mast: four tapered vertical struts +
    three cross-braces. Tall thin silhouette reads as a comm tower /
    rooftop antenna at race speed."""
    bm = bmesh.new()
    base_half = 0.4
    top_half = 0.08

    levels = 4   # number of horizontal cross-brace rings
    rings: list[list[bmesh.types.BMVert]] = []
    for li in range(levels + 1):
        t = li / levels
        z = t * height
        half = base_half * (1 - t) + top_half * t
        rings.append([
            bm.verts.new(( half, -half, z)),
            bm.verts.new(( half,  half, z)),
            bm.verts.new((-half,  half, z)),
            bm.verts.new((-half, -half, z)),
        ])
    # Four vertical struts via thin quad strips between adjacent ring
    # corners. Each strut is a 4-faced ribbon.
    for li in range(levels):
        cur = rings[li]
        nxt = rings[li + 1]
        for ci in range(4):
            cn = (ci + 1) % 4
            # Strut face: vertical quad between two adjacent corner pairs.
            bm.faces.new([cur[ci], nxt[ci], nxt[cn], cur[cn]])
    # Cap top + bottom so the silhouette closes.
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_vent_stack_mesh(name: str, *, height: float = 1.2, radius: float = 0.32) -> bpy.types.Mesh:
    """Rooftop vent / chimney — short cylinder with a mushroom cap.
    Cap reads as a weatherproofed exhaust at distance."""
    bm = bmesh.new()
    _, top = _cylinder_z(bm, radius=radius, z0=0.0, z1=height - 0.18, segs=12, cap_top=False)
    # Mushroom cap — wider ring at top.
    cap_radius = radius * 1.4
    cap_ring = [
        bm.verts.new((math.cos(s / 12 * math.tau) * cap_radius,
                      math.sin(s / 12 * math.tau) * cap_radius,
                      height - 0.06))
        for s in range(12)
    ]
    cap_top_ring = [
        bm.verts.new((math.cos(s / 12 * math.tau) * cap_radius * 0.9,
                      math.sin(s / 12 * math.tau) * cap_radius * 0.9,
                      height))
        for s in range(12)
    ]
    # Skirt — connect top of cylinder out to cap ring.
    for i in range(12):
        j = (i + 1) % 12
        bm.faces.new([top[i], top[j], cap_ring[j], cap_ring[i]])
        bm.faces.new([cap_ring[i], cap_ring[j], cap_top_ring[j], cap_top_ring[i]])
    bm.faces.new(cap_top_ring)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_ac_unit_mesh(name: str) -> bpy.types.Mesh:
    """Boxy rooftop AC unit — 1.0 × 0.7 × 0.8 m. Two thinner inset
    boxes on top read as condenser fans at distance."""
    bm = bmesh.new()
    _box(bm, half_x=0.5, half_y=0.35, half_z=0.4, z_centre=0.4)
    # Two small "fan" bumps on top.
    _box(bm, half_x=0.18, half_y=0.18, half_z=0.05, z_centre=0.85)
    _box(bm, half_x=0.18, half_y=0.18, half_z=0.05, z_centre=0.85)
    # Move the second bump to +x.
    bm.verts.ensure_lookup_table()
    # The second box's verts are the last 8 in the bmesh; shift them +0.3 X
    # (in-place mutation is safe because we built them last and there are
    # no shared verts with the first box / chassis).
    for v in bm.verts[-8:]:
        v.co.x += 0.30
    # First bump verts are -16 .. -9 from the end; shift -0.3 X.
    for v in bm.verts[-16:-8]:
        v.co.x -= 0.30

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_signage_panel_mesh(name: str, *, panel_width: float = 2.4, panel_height: float = 1.6, post_height: float = 1.2) -> bpy.types.Mesh:
    """Billboard panel — two stub posts + flat rectangular face. Top
    face gets material index 1 (emissive) so neon signage reads at
    night without bloom."""
    bm = bmesh.new()
    half_w = panel_width / 2
    # Two stub posts under each end of the panel.
    _cylinder_z(bm, radius=0.06, z0=0.0, z1=post_height, segs=8)
    bm.verts.ensure_lookup_table()
    # Second post at +half_w * 0.7
    bm_count_before = len(bm.verts)
    _cylinder_z(bm, radius=0.06, z0=0.0, z1=post_height, segs=8)
    for v in bm.verts[bm_count_before:]:
        v.co.x += half_w * 0.7
    # Move first post to -half_w * 0.7.
    for v in bm.verts[:bm_count_before]:
        v.co.x -= half_w * 0.7
    # Flat panel — thin box at z = post_height + panel_height / 2.
    panel_z = post_height + panel_height / 2
    panel_verts = _box(bm, half_x=half_w, half_y=0.05, half_z=panel_height / 2, z_centre=panel_z)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # The panel's +Y face is the front-facing emissive surface. Order
    # from `_box`: bottom, top, -Y, +X, +Y, -X. So the panel's +Y face
    # (index = len-2) is the front.
    panel_front_idx = len(me.polygons) - 2
    me.polygons[panel_front_idx].material_index = 1
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ── Industrial kit ──────────────────────────────────────────────────


def build_container_mesh(name: str, *, length: float = 6.0, width: float = 2.4, height: float = 2.6) -> bpy.types.Mesh:
    """Shipping container — 20-ft equivalent at ~6 × 2.4 × 2.6 m. Just a
    box for now; corrugation can come in a follow-up modifier."""
    bm = bmesh.new()
    _box(bm, half_x=length / 2, half_y=width / 2, half_z=height / 2, z_centre=height / 2)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_oil_drum_mesh(name: str, *, height: float = 0.95, radius: float = 0.30) -> bpy.types.Mesh:
    """55-gallon drum — cylinder with two slightly-wider rings (top and
    bottom rim bands) for visual interest. ~30 verts."""
    bm = bmesh.new()
    segs = 12
    # Main body: 4 ring stack (bottom, lower-rim, upper-rim, top).
    rings = []
    for z, r in [
        (0.0,            radius),
        (0.08,           radius * 1.08),
        (height - 0.08,  radius * 1.08),
        (height,         radius),
    ]:
        rings.append([
            bm.verts.new((math.cos(s / segs * math.tau) * r,
                          math.sin(s / segs * math.tau) * r,
                          z))
            for s in range(segs)
        ])
    for ri in range(3):
        cur = rings[ri]
        nxt = rings[ri + 1]
        for si in range(segs):
            sn = (si + 1) % segs
            bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_mooring_bollard_mesh(name: str, *, height: float = 0.55, radius: float = 0.22) -> bpy.types.Mesh:
    """Dock mooring bollard — squat cylinder + knob top. Reads as
    "harbour" at a glance."""
    bm = bmesh.new()
    _, top = _cylinder_z(bm, radius=radius, z0=0.0, z1=height - 0.1, segs=10, cap_top=False)
    # Knob — small sphere-ish cap.
    knob_ring = [
        bm.verts.new((math.cos(s / 10 * math.tau) * radius * 1.2,
                      math.sin(s / 10 * math.tau) * radius * 1.2,
                      height - 0.04))
        for s in range(10)
    ]
    cap = bm.verts.new((0.0, 0.0, height + 0.08))
    for i in range(10):
        j = (i + 1) % 10
        bm.faces.new([top[i], top[j], knob_ring[j], knob_ring[i]])
        bm.faces.new([knob_ring[i], knob_ring[j], cap])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ── Volcanic kit ────────────────────────────────────────────────────


def build_basalt_boulder_mesh(name: str) -> bpy.types.Mesh:
    """Angular basalt boulder — icosphere with a bmesh.ops.bevel pass
    to add planar facets. Reads as a chunk of cooled lava at distance."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    # Squish vertically so it reads as ground-borne, not a billiard ball.
    for v in bm.verts:
        v.co.z *= 0.65
    bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.faces[:] + bm.verts[:],
                    offset=0.05, segments=1, profile=0.5,
                    affect="EDGES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_ash_heap_mesh(name: str, *, radius: float = 1.2, height: float = 0.5) -> bpy.types.Mesh:
    """Low ash mound — flattened half-sphere via a circle of verts
    rising to a central peak. Cheap silhouette for cooled ash drifts."""
    bm = bmesh.new()
    segs = 14
    base = [
        bm.verts.new((math.cos(s / segs * math.tau) * radius,
                      math.sin(s / segs * math.tau) * radius,
                      0.0))
        for s in range(segs)
    ]
    # Single mid ring for shape.
    mid = [
        bm.verts.new((math.cos(s / segs * math.tau) * radius * 0.55,
                      math.sin(s / segs * math.tau) * radius * 0.55,
                      height * 0.65))
        for s in range(segs)
    ]
    apex = bm.verts.new((0.0, 0.0, height))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([base[i], base[j], mid[j], mid[i]])
        bm.faces.new([mid[i], mid[j], apex])
    # Floor disc (cap-bottom).
    bm.faces.new(base[::-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_scorched_stump_mesh(name: str, *, height: float = 1.4, radius: float = 0.32) -> bpy.types.Mesh:
    """Broken tree stump — short cylinder with a jagged top ring (per-
    vertex Z perturbation gives the splintered silhouette)."""
    bm = bmesh.new()
    segs = 10
    bottom = [
        bm.verts.new((math.cos(s / segs * math.tau) * radius,
                      math.sin(s / segs * math.tau) * radius,
                      0.0))
        for s in range(segs)
    ]
    # Top ring with random Z perturbation; deterministic via fixed
    # offsets so the seed-script result is reproducible.
    splinter_offsets = [0.18, -0.08, 0.25, -0.15, 0.10, -0.20, 0.22, -0.05, 0.15, -0.18]
    top = [
        bm.verts.new((math.cos(s / segs * math.tau) * radius * 0.95,
                      math.sin(s / segs * math.tau) * radius * 0.95,
                      height + splinter_offsets[s]))
        for s in range(segs)
    ]
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([bottom[i], bottom[j], top[j], top[i]])
    # Cap top with a fan to the centroid for a believable cross-section.
    centroid = bm.verts.new((0.0, 0.0, height + 0.05))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([top[i], top[j], centroid])
    bm.faces.new(bottom[::-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ── Jungle kit ──────────────────────────────────────────────────────


def build_fern_clump_mesh(name: str, *, frond_count: int = 5, frond_length: float = 1.0) -> bpy.types.Mesh:
    """Ground fern cluster — small quad-strip fronds emerging upward
    from a tight base. Sway gradient on COLOR_0.R so the foliage shader
    picks them up via the `mat_foliage_*` material name."""
    bm = bmesh.new()
    # Tiny base puck so the cluster grounds visually.
    _cylinder_z(bm, radius=0.10, z0=0.0, z1=0.05, segs=6)

    # Fronds — flat quad strips angled outward from the base.
    frond_segs = 4
    for fi in range(frond_count):
        ang = (fi / frond_count) * math.tau
        # Each frond leans outward + upward.
        dir_xy = Vector((math.cos(ang) * 0.6, math.sin(ang) * 0.6, 1.0)).normalized()
        side = Vector((-math.sin(ang), math.cos(ang), 0.0))
        left, right = [], []
        for si in range(frond_segs + 1):
            t = si / frond_segs
            # Slight arc: tip droops back toward the base.
            radial = t * frond_length
            arc_z = math.sin(t * math.pi) * 0.12
            centre = dir_xy * radial + Vector((0.0, 0.0, arc_z + 0.05))
            # Width: thin at base, fatter in middle, thin at tip.
            if t < 0.2:
                w = 0.02 + 0.10 * (t / 0.2)
            elif t < 0.7:
                w = 0.12
            else:
                w = 0.12 + (0.02 - 0.12) * ((t - 0.7) / 0.3)
            left.append(bm.verts.new(centre + side * w))
            right.append(bm.verts.new(centre - side * w))
        for si in range(frond_segs):
            bm.faces.new([left[si], left[si + 1], right[si + 1], right[si]])

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    # Sway gradient: trunk (z=0) doesn't sway, frond tips sway most.
    # frond_length * 1.05 keeps the gradient just below saturation at
    # the tips so the shader has headroom.
    set_linear_sway_z(me, z_min=0.0, z_max=frond_length * 0.9, ao=1.0)
    return me


def build_mossy_boulder_mesh(name: str) -> bpy.types.Mesh:
    """Variant of the basalt boulder — different jaggedness profile so
    the silhouette reads distinct from the volcanic kit at scatter
    density. Same procedural strategy, different inputs."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.2)
    # Wider squish — mossy boulders look squatter than basalt.
    for v in bm.verts:
        v.co.z *= 0.45
    # Subtle bevel, no facet-emphasis (mossy = rounded).
    bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.faces[:] + bm.verts[:],
                    offset=0.02, segments=2, profile=0.7,
                    affect="EDGES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_fallen_pillar_mesh(name: str, *, length: float = 3.2, radius: float = 0.32) -> bpy.types.Mesh:
    """Toppled column lying on its side along +X. One end intact (full
    cap), other end broken (jagged ring + offset)."""
    bm = bmesh.new()
    segs = 10
    bottom = []
    top = []
    # Cylinder along +X axis, lying on the ground at z=radius.
    splinter = [0.0, 0.0, -0.12, -0.18, -0.08, -0.20, -0.06, -0.10, 0.0, 0.0]
    for i in range(segs):
        ang = i / segs * math.tau
        y = math.cos(ang) * radius
        z = math.sin(ang) * radius + radius  # lift so the underside touches z=0
        bottom.append(bm.verts.new((0.0, y, z)))
        # Top (broken) end: slightly inset radius + per-vert X recess.
        recess = splinter[i % len(splinter)]
        top.append(bm.verts.new((length + recess, y, z)))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([bottom[i], bottom[j], top[j], top[i]])
    # Cap intact end with a fan.
    centre_bottom = bm.verts.new((0.0, 0.0, radius))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([bottom[j], bottom[i], centre_bottom])
    # Broken end — no clean cap; ring closes itself via tris to a recessed
    # centre for that "core showing" look.
    centre_top = bm.verts.new((length - 0.12, 0.0, radius))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([top[i], top[j], centre_top])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ── Venetian kit ────────────────────────────────────────────────────


def build_gondola_mesh(name: str, *, length: float = 4.8, beam: float = 0.7, depth: float = 0.45) -> bpy.types.Mesh:
    """Stylised gondola — flat-bottomed canoe silhouette with the
    signature upturned ferro prow. Sits in the water (z=0 is the
    waterline, hull descends to -depth). ~40 verts."""
    bm = bmesh.new()
    # Bottom keel: 5-point spine running along +X, slightly bowed up
    # toward the prow end so the silhouette curls at both ends.
    spine = []
    for i in range(5):
        t = i / 4  # 0..1
        # Upturn at both ends, lowest amidships.
        z_rise = 0.18 * abs(t - 0.5) * 2  # 0..0.18 at endpoints
        spine.append(bm.verts.new((t * length, 0.0, -depth + z_rise)))
    # Gunwale (deck rim): mirrored pair along +Y / -Y at z=0.
    left = []
    right = []
    for i in range(5):
        t = i / 4
        # Beam tapers to zero at each end; widest at midships.
        b = beam * math.sin(t * math.pi)
        left.append(bm.verts.new((t * length, -b, 0.0)))
        right.append(bm.verts.new((t * length,  b, 0.0)))
    # Hull faces — quads between spine ↔ rim along each side.
    for i in range(4):
        bm.faces.new([spine[i], spine[i + 1], left[i + 1], left[i]])
        bm.faces.new([spine[i], right[i], right[i + 1], spine[i + 1]])
    # Deck — close the top with a single ngon ringing the gunwale.
    bm.faces.new(left + list(reversed(right)))
    # Ferro prow ornament — tall thin curl rising off the +X end.
    ferro_base = bm.verts.new((length, 0.0, 0.0))
    ferro_mid  = bm.verts.new((length + 0.20, 0.0, 0.45))
    ferro_top  = bm.verts.new((length + 0.05, 0.0, 0.75))
    # Two triangles form a flat ornament that reads in silhouette.
    bm.faces.new([spine[-1], ferro_base, ferro_mid])
    bm.faces.new([ferro_base, ferro_top, ferro_mid])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_venetian_mooring_mesh(name: str, *, height: float = 1.8, radius: float = 0.10) -> bpy.types.Mesh:
    """Venice mooring post (`palina`) — slender striped pole. Two-tone
    paint via material slot swap on the upper half-face range, so a
    scatter pass can paint each post a different stripe colour later."""
    bm = bmesh.new()
    segs = 8
    # 4-ring stack so we can mark the middle ring's faces as stripe-band.
    rings = []
    for z in (0.0, height * 0.45, height * 0.55, height):
        rings.append([
            bm.verts.new((math.cos(s / segs * math.tau) * radius,
                          math.sin(s / segs * math.tau) * radius,
                          z))
            for s in range(segs)
        ])
    for ri in range(3):
        cur = rings[ri]
        nxt = rings[ri + 1]
        for si in range(segs):
            sn = (si + 1) % segs
            bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    # Middle band — faces between the two midpoint rings — gets material
    # slot 1 (the stripe colour). The ring-stack creates them in order
    # (bottom→mid_low, mid_low→mid_high, mid_high→top), so the stripe
    # faces are segs .. 2*segs.
    for i in range(segs, segs * 2):
        me.polygons[i].material_index = 1
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_canal_lantern_mesh(name: str, *, height: float = 0.55, radius: float = 0.12) -> bpy.types.Mesh:
    """Wrought-iron canal lantern — small box cage on a thin stem. The
    glass panel face is material slot 1 (emissive) so the lantern lights
    up at night."""
    bm = bmesh.new()
    # Stem — short stub the lantern can sit atop a mooring or rooftop.
    _cylinder_z(bm, radius=0.025, z0=0.0, z1=height * 0.3, segs=6)
    # Lantern body — small box centred above the stem.
    body_centre_z = height * 0.7
    _box(bm, half_x=radius, half_y=radius, half_z=radius, z_centre=body_centre_z)
    # Snapshot the 4 top-of-box verts BEFORE adding the finial, otherwise
    # `bm.verts[-4:]` would include the finial itself and a face would
    # try to use the same vert twice.
    bm.verts.ensure_lookup_table()
    top_verts = list(bm.verts[-4:])
    # Decorative finial — tiny pyramid cap.
    finial_ring_z = body_centre_z + radius
    finial = bm.verts.new((0.0, 0.0, finial_ring_z + radius * 0.6))
    for i in range(4):
        bm.faces.new([top_verts[i], top_verts[(i + 1) % 4], finial])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # Mark all four side faces of the body box as emissive (the panes).
    # _box face order: bottom, top, -Y, +X, +Y, -X — so the four sides
    # are the last 4 faces of the box block. The stem-cylinder + caps
    # came before, then the 6 box faces; subtract 4 to skip bottom+top.
    # The fan tris are added AFTER the box, so we count back past them.
    box_top_offset = 4 + 1 + 4 + 4  # 4 fan tris + finial + 4 box sides + box top
    # Easier: pre-record polygon count before adding fan would have been
    # cleaner; instead, walk the polygon list and grab the four largest
    # vertical quads with |normal.z| < 0.2 (the four lantern panes).
    for poly in me.polygons:
        nz = poly.normal.z
        if abs(nz) < 0.2 and len(poly.vertices) == 4:
            # Lantern panes only — skip the stem cylinder side quads by
            # rejecting anything whose face centre is below body_centre_z * 0.5.
            cz = sum(me.vertices[i].co.z for i in poly.vertices) / 4
            if cz > body_centre_z - radius * 0.5:
                poly.material_index = 1
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_paving_slab_mesh(name: str, *, length: float = 0.9, width: float = 0.6, thick: float = 0.08) -> bpy.types.Mesh:
    """Broken Istrian-stone paving slab — flat rectangle with one corner
    chipped (replaced with an inset triangle). Reads as canal-side rubble."""
    bm = bmesh.new()
    half_x = length / 2
    half_y = width / 2
    half_z = thick / 2
    # 5-vertex top face: 3 intact corners + 2 chip-cut verts replacing
    # the 4th corner. The chip removes ~25 % of one corner.
    top = [
        bm.verts.new((-half_x, -half_y, half_z)),
        bm.verts.new(( half_x, -half_y, half_z)),
        bm.verts.new(( half_x,  half_y * 0.5, half_z)),  # chip-cut #1
        bm.verts.new(( half_x * 0.5,  half_y, half_z)),  # chip-cut #2
        bm.verts.new((-half_x,  half_y, half_z)),
    ]
    bot = [bm.verts.new((v.co.x, v.co.y, -half_z)) for v in top]
    bm.faces.new(top)
    bm.faces.new(bot[::-1])
    # Skirt — vertical quads round the perimeter.
    for i in range(len(top)):
        j = (i + 1) % len(top)
        bm.faces.new([top[i], bot[i], bot[j], top[j]])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_ivy_patch_mesh(name: str, *, count: int = 9, spread: float = 0.45) -> bpy.types.Mesh:
    """Wall-clinging ivy clump — a cluster of overlapping cross-quads.
    Sway gradient on COLOR_0.R via the foliage shader. Stays flat against
    the XZ plane so authors can park it on a vertical surface."""
    bm = bmesh.new()
    # Two cross-quads stacked + scattered leaves around.
    leaf_offsets = [
        (-0.30,  0.05),
        ( 0.25, -0.08),
        ( 0.10,  0.32),
        (-0.18, -0.20),
        ( 0.32,  0.20),
        (-0.05, -0.30),
        ( 0.18,  0.05),
        (-0.28,  0.28),
        ( 0.02,  0.20),
    ][:count]
    for (ox, oy) in leaf_offsets:
        # Each leaf is a flat XZ quad (Y near 0 so the cluster reads as
        # a thin sheet glued to a wall).
        size = 0.18
        v00 = bm.verts.new((ox - size, 0.0, oy - size))
        v10 = bm.verts.new((ox + size, 0.0, oy - size))
        v11 = bm.verts.new((ox + size, 0.0, oy + size))
        v01 = bm.verts.new((ox - size, 0.0, oy + size))
        bm.faces.new([v00, v10, v11, v01])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    # Sway: tip leaves (higher Z) move more.
    set_linear_sway_z(me, z_min=-0.3, z_max=0.45, ao=1.0)
    return me


# ── Waterpark kit ──────────────────────────────────────────────────


def build_beach_ball_mesh(name: str, *, radius: float = 0.30) -> bpy.types.Mesh:
    """Inflatable beach ball — low-subdiv icosphere. Single material
    slot; the painted stripes can come from a future trim sheet."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_pool_noodle_mesh(name: str, *, length: float = 1.4, radius: float = 0.045) -> bpy.types.Mesh:
    """Foam pool noodle — slim tube laid along +X. Reads as bright
    plastic clutter at race speed."""
    bm = bmesh.new()
    segs = 8
    rings = 6
    ring_verts = []
    for ri in range(rings):
        t = ri / (rings - 1)
        x = t * length
        ring_verts.append([
            bm.verts.new((x,
                          math.cos(s / segs * math.tau) * radius,
                          math.sin(s / segs * math.tau) * radius + radius))
            for s in range(segs)
        ])
    for ri in range(rings - 1):
        cur = ring_verts[ri]
        nxt = ring_verts[ri + 1]
        for si in range(segs):
            sn = (si + 1) % segs
            bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
    bm.faces.new(ring_verts[0][::-1])
    bm.faces.new(ring_verts[-1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_inflatable_ring_mesh(name: str, *, major_radius: float = 0.45, minor_radius: float = 0.10) -> bpy.types.Mesh:
    """Pool donut — coarse torus. ~120 verts at 12×8 subdiv. Sits on
    the water surface (z=0 ≈ widest part)."""
    bm = bmesh.new()
    major_segs = 12
    minor_segs = 8
    rings: list[list[bmesh.types.BMVert]] = []
    for mj in range(major_segs):
        a = mj / major_segs * math.tau
        cx = math.cos(a) * major_radius
        cy = math.sin(a) * major_radius
        ring = []
        for mi in range(minor_segs):
            b = mi / minor_segs * math.tau
            r = math.cos(b) * minor_radius
            z = math.sin(b) * minor_radius
            # Offset normal direction is outward in the XY plane.
            ring.append(bm.verts.new((cx + math.cos(a) * r,
                                      cy + math.sin(a) * r,
                                      z + minor_radius)))
        rings.append(ring)
    for mj in range(major_segs):
        mj2 = (mj + 1) % major_segs
        for mi in range(minor_segs):
            mi2 = (mi + 1) % minor_segs
            bm.faces.new([rings[mj][mi], rings[mj][mi2],
                          rings[mj2][mi2], rings[mj2][mi]])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_slide_piece_mesh(name: str, *, length: float = 4.0, width: float = 1.2, wall: float = 0.45) -> bpy.types.Mesh:
    """Half-pipe waterslide segment — open U-channel laid along +X with
    side walls. Reads as broken-off Aqualand infrastructure scattered
    in the lagoons."""
    bm = bmesh.new()
    segs = 6  # cross-section profile points
    rings = 5  # along-length samples
    # U-shaped cross-section: walk -y around bottom to +y.
    profile = []
    for si in range(segs):
        t = si / (segs - 1)
        ang = -math.pi / 2 - math.pi / 2 + t * math.pi  # -180°..0° in YZ plane
        py = math.cos(ang) * (width / 2)
        pz = math.sin(ang) * (width / 2) + (width / 2)
        profile.append((py, pz))
    # Extrude profile along +X.
    rings_v: list[list[bmesh.types.BMVert]] = []
    for ri in range(rings):
        t = ri / (rings - 1)
        x = t * length
        rings_v.append([bm.verts.new((x, py, pz)) for (py, pz) in profile])
    for ri in range(rings - 1):
        cur = rings_v[ri]
        nxt = rings_v[ri + 1]
        for si in range(segs - 1):
            bm.faces.new([cur[si], cur[si + 1], nxt[si + 1], nxt[si]])
    # Side wall lip — extrude the two end edges of each profile up by `wall`.
    for ri in range(rings):
        r = rings_v[ri]
        x = r[0].co.x
        # Left wall — extrude profile[0] up.
        lift_l = bm.verts.new((x, r[0].co.y, r[0].co.z + wall))
        lift_r = bm.verts.new((x, r[-1].co.y, r[-1].co.z + wall))
        # Stitch onto neighbour ring next iteration via deferred list.
        r.append(lift_l)
        r.append(lift_r)
    for ri in range(rings - 1):
        cur = rings_v[ri]
        nxt = rings_v[ri + 1]
        # Wall quads — left edge (profile[0] → lift_l) and right edge.
        bm.faces.new([cur[0], cur[-2], nxt[-2], nxt[0]])
        bm.faces.new([cur[-1], cur[-3], nxt[-3], nxt[-1]])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_faded_sign_mesh(name: str, *, panel_w: float = 1.8, panel_h: float = 1.2, post_h: float = 1.5) -> bpy.types.Mesh:
    """Crooked waterpark sign — single post + tilted billboard panel.
    Similar silhouette to prop_signage_panel but no emissive face — this
    one's a faded leftover from before the flood."""
    bm = bmesh.new()
    # Single off-centre post — sign tilts slightly so it reads as not-quite-vertical.
    _cylinder_z(bm, radius=0.07, z0=0.0, z1=post_h, segs=8)
    # Panel — thin box at top of post, tilted via per-vertex Z offset on +X side.
    panel_z = post_h + panel_h / 2
    bm_count_before = len(bm.verts)
    _box(bm, half_x=panel_w / 2, half_y=0.04, half_z=panel_h / 2, z_centre=panel_z)
    # Apply a slight tilt — verts on +X get lifted, verts on -X stay put.
    for v in bm.verts[bm_count_before:]:
        if v.co.x > 0:
            v.co.z += 0.18

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ── Open Sea kit ────────────────────────────────────────────────────


def build_sea_stack_mesh(name: str, *, height: float = 6.0, base_radius: float = 1.6) -> bpy.types.Mesh:
    """Tall thin sea-stack rock — eroded pillar. Tapers from base to ~60 %
    radius at the top. Reads as a coastal landmark at distance."""
    bm = bmesh.new()
    segs = 10
    rings = 5
    # Profile points: deterministic "eroded" radial variation per ring.
    radial_jitter = [1.00, 0.78, 0.92, 0.72, 0.60]
    for ri in range(rings):
        z = ri / (rings - 1) * height
        r = base_radius * radial_jitter[ri]
        ring = [
            bm.verts.new((math.cos(s / segs * math.tau) * r,
                          math.sin(s / segs * math.tau) * r,
                          z))
            for s in range(segs)
        ]
        if ri == 0:
            prev = ring
            bm.faces.new(ring[::-1])  # base cap
            continue
        for si in range(segs):
            sn = (si + 1) % segs
            bm.faces.new([prev[si], prev[sn], ring[sn], ring[si]])
        prev = ring
    # Cap top.
    bm.faces.new(prev)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_nav_marker_mesh(name: str, *, height: float = 2.4) -> bpy.types.Mesh:
    """Channel-marker navigation buoy — flat-bottom can with topmark
    triangle. Emissive top reads as a lit channel marker at night."""
    bm = bmesh.new()
    # Floating can — short squat cylinder at the waterline.
    _, can_top = _cylinder_z(bm, radius=0.35, z0=0.0, z1=0.6, segs=10, cap_top=True)
    # Topmark — vertical post atop the can.
    bm_count_before = len(bm.verts)
    _cylinder_z(bm, radius=0.05, z0=0.6, z1=height - 0.4, segs=6)
    # Triangle topmark at the top — a flat upward-pointing dart. Single
    # face only; the runtime material renders both sides via DoubleSide.
    tip   = bm.verts.new((0.0, 0.0, height))
    base_l = bm.verts.new((-0.18, 0.0, height - 0.4))
    base_r = bm.verts.new(( 0.18, 0.0, height - 0.4))
    bm.faces.new([base_l, base_r, tip])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    # The last polygon is the topmark triangle → emissive slot.
    me.polygons[-1].material_index = 1
    set_constant(me, DEFAULT_TERRAIN)
    return me


def build_kelp_strand_mesh(name: str, *, height: float = 2.4) -> bpy.types.Mesh:
    """Submerged kelp strand — vertical ribbon with a sway gradient
    along Z. Stays under the waterline; scatter with z_max < 0 on the
    HV_Scatter altitude filter so it doesn't poke through."""
    bm = bmesh.new()
    rings = 6
    half_w = 0.12
    for ri in range(rings - 1):
        t0 = ri / (rings - 1)
        t1 = (ri + 1) / (rings - 1)
        z0 = t0 * height
        z1 = t1 * height
        # Slight horizontal drift — looks current-pulled rather than rigid.
        x0 = math.sin(t0 * math.pi) * 0.10
        x1 = math.sin(t1 * math.pi) * 0.10
        # Taper width toward tip.
        w0 = half_w * (1.0 - t0 * 0.7)
        w1 = half_w * (1.0 - t1 * 0.7)
        v00 = bm.verts.new((x0 - w0, 0.0, z0))
        v10 = bm.verts.new((x0 + w0, 0.0, z0))
        v11 = bm.verts.new((x1 + w1, 0.0, z1))
        v01 = bm.verts.new((x1 - w1, 0.0, z1))
        bm.faces.new([v00, v10, v11, v01])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_linear_sway_z(me, z_min=0.0, z_max=height * 0.9, ao=1.0)
    return me


def build_foam_tuft_mesh(name: str, *, radius: float = 0.40) -> bpy.types.Mesh:
    """Surface-foam tuft — flat disc near the waterline with slight
    centre-rise. Material is `mat_foliage_*` so it gets a faint sway and
    reads as wind-blown foam at race speed."""
    bm = bmesh.new()
    segs = 10
    rim = [
        bm.verts.new((math.cos(s / segs * math.tau) * radius,
                      math.sin(s / segs * math.tau) * radius,
                      0.0))
        for s in range(segs)
    ]
    crest = bm.verts.new((0.0, 0.0, 0.08))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new([rim[i], rim[j], crest])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    set_linear_sway_z(me, z_min=0.0, z_max=0.08, ao=1.0)
    return me


def build_gull_crag_mesh(name: str, *, base_radius: float = 0.8, height: float = 1.4) -> bpy.types.Mesh:
    """Small rocky outcrop — squat icosphere with a perch on top. Adds
    micro-relief in open-water stretches between the bigger sea-stacks."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=base_radius)
    for v in bm.verts:
        v.co.z = v.co.z * 0.55 + base_radius * 0.55
    # Crown — flatter top by clamping high verts.
    for v in bm.verts:
        if v.co.z > height * 0.85:
            v.co.z = height * 0.85
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_constant(me, DEFAULT_TERRAIN)
    return me


# ────────────────────────────────────────────────────────────────────
# HV_Scatter — Geometry Nodes graph for foliage / rock / debris scatter
# ────────────────────────────────────────────────────────────────────
#
# Wishlist Item 4 / Phase β of docs/level-visual-quality-research.md.
# The graph distributes points on a target mesh (a scatter zone's child
# plane, or a chunk of terrain) and instances a Collection's objects on
# them. Inputs let the author dial density, size variance, slope and
# altitude masks, and a seed. Per-instance Z rotation + random size are
# applied so a row of palms doesn't read as a stamped grid; per-instance
# COLOR_0.B phase is stamped via Store Named Attribute so the foliage
# sway shader gives each palm its own swing.
#
# Output keeps instances un-realized — Blender's glTF exporter sees the
# InstanceOnPoints output and emits ``EXT_mesh_gpu_instancing`` (the
# repo's export.py already passes export_gpu_instances=True), which the
# runtime lifts into ``THREE.InstancedMesh``. So a 400-palm scatter zone
# costs roughly one draw call per prop archetype in the GLB.

SCATTER_GROUP = "HV_Scatter"


def build_scatter_group() -> bpy.types.NodeTree:
    """HV_Scatter — Distribute Points on Faces → Instance on Points (from
    a Collection), with slope + altitude filters, random rotation and
    size, and a per-instance phase stamp on COLOR_0.B.

    Inputs:
      - Source Collection : collection to instance from (one prop per
        point picked uniformly).
      - Density (per m²)  : sample density on the input mesh's surface.
      - Slope Max (deg)   : drop instances where the face normal points
        further off +Z than this (0..90; 90 = no slope filter).
      - Z Min / Z Max     : drop instances outside this world-Z band
        (useful for "above waterline, below tree line").
      - Size Min / Max    : per-instance uniform scale; sampled uniformly.
      - Seed              : deterministic per-scatter-zone seed.
    """
    if SCATTER_GROUP in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[SCATTER_GROUP])
    g = bpy.data.node_groups.new(SCATTER_GROUP, "GeometryNodeTree")

    _new_socket(g, "Geometry",         "INPUT",  "NodeSocketGeometry")
    _new_socket(g, "Source",           "INPUT",  "NodeSocketCollection")
    _new_socket(g, "Density",          "INPUT",  "NodeSocketFloat",  0.05, mn=0.0, mx=10.0)
    _new_socket(g, "Slope Max (deg)",  "INPUT",  "NodeSocketFloat",  35.0, mn=0.0, mx=90.0)
    _new_socket(g, "Z Min",            "INPUT",  "NodeSocketFloat", -100.0)
    _new_socket(g, "Z Max",            "INPUT",  "NodeSocketFloat",  500.0)
    _new_socket(g, "Size Min",         "INPUT",  "NodeSocketFloat",  0.85, mn=0.05)
    _new_socket(g, "Size Max",         "INPUT",  "NodeSocketFloat",  1.20, mn=0.05)
    _new_socket(g, "Seed",             "INPUT",  "NodeSocketInt",    0)
    _new_socket(g, "Geometry",         "OUTPUT", "NodeSocketGeometry")

    gi = _add_node(g, "NodeGroupInput",  -1800, 0)
    go = _add_node(g, "NodeGroupOutput",  1600, 0)

    # 1. Distribute points on the input mesh's surface, weighted by
    #    Density. Random method gives a stochastic spread without the
    #    grid-stamp look Poisson Disk would soften — at 60 fps race
    #    pace the spread is fine. Poisson Disk + min-distance is the
    #    upgrade path if clumping reads bad once we ship hundreds of
    #    instances.
    distribute = _add_node(g, "GeometryNodeDistributePointsOnFaces", -1400, 0)
    distribute.distribute_method = "RANDOM"
    g.links.new(gi.outputs["Geometry"], distribute.inputs["Mesh"])
    g.links.new(gi.outputs["Density"],  distribute.inputs["Density"])
    g.links.new(gi.outputs["Seed"],     distribute.inputs["Seed"])

    # 2. Slope filter — face Normal's Z component vs cos(Slope Max).
    #    Drop any point whose underlying normal tilts further off +Z than
    #    Slope Max degrees. We do this via Delete Geometry on the
    #    distributed point cloud.
    radians = _add_node(g, "ShaderNodeMath", -1200, -300, operation="RADIANS")
    g.links.new(gi.outputs["Slope Max (deg)"], radians.inputs[0])
    cosine = _add_node(g, "ShaderNodeMath", -1000, -300, operation="COSINE")
    g.links.new(radians.outputs[0], cosine.inputs[0])
    # Separate the captured Normal vector into XYZ to get the Z component.
    sep_normal = _add_node(g, "ShaderNodeSeparateXYZ", -1000, -100)
    g.links.new(distribute.outputs["Normal"], sep_normal.inputs["Vector"])
    slope_ok = _add_node(g, "ShaderNodeMath", -800, -200, operation="GREATER_THAN")
    g.links.new(sep_normal.outputs["Z"], slope_ok.inputs[0])
    g.links.new(cosine.outputs[0],       slope_ok.inputs[1])

    # 3. Altitude filter — Position Z within [Z Min, Z Max].
    pos = _add_node(g, "GeometryNodeInputPosition", -1000,  100)
    sep_pos = _add_node(g, "ShaderNodeSeparateXYZ", -800,  100)
    g.links.new(pos.outputs["Position"], sep_pos.inputs["Vector"])
    above_min = _add_node(g, "ShaderNodeMath", -600,  200, operation="GREATER_THAN")
    g.links.new(sep_pos.outputs["Z"], above_min.inputs[0])
    g.links.new(gi.outputs["Z Min"],  above_min.inputs[1])
    below_max = _add_node(g, "ShaderNodeMath", -600,  100, operation="LESS_THAN")
    g.links.new(sep_pos.outputs["Z"], below_max.inputs[0])
    g.links.new(gi.outputs["Z Max"],  below_max.inputs[1])
    alt_ok = _add_node(g, "ShaderNodeMath", -400,  150, operation="MULTIPLY")
    g.links.new(above_min.outputs[0], alt_ok.inputs[0])
    g.links.new(below_max.outputs[0], alt_ok.inputs[1])

    # 4. Combine masks: keep iff (slope_ok AND alt_ok). We multiply two
    #    0/1 floats and compare > 0.5.
    combined = _add_node(g, "ShaderNodeMath", -200,  0, operation="MULTIPLY")
    g.links.new(slope_ok.outputs[0], combined.inputs[0])
    g.links.new(alt_ok.outputs[0],   combined.inputs[1])
    keep = _add_node(g, "ShaderNodeMath", 0, 0, operation="GREATER_THAN")
    g.links.new(combined.outputs[0], keep.inputs[0])
    keep.inputs[1].default_value = 0.5

    # 5. Delete points whose mask is 0. Delete Geometry with Selection
    #    inverted (delete where Selection is false) keeps the survivors.
    invert = _add_node(g, "ShaderNodeMath", 200, 0, operation="SUBTRACT")
    invert.inputs[0].default_value = 1.0
    g.links.new(keep.outputs[0], invert.inputs[1])
    delete_pts = _add_node(g, "GeometryNodeDeleteGeometry", 400, 0)
    delete_pts.domain = "POINT"
    delete_pts.mode = "ALL"
    g.links.new(distribute.outputs["Points"], delete_pts.inputs["Geometry"])
    g.links.new(invert.outputs[0],            delete_pts.inputs["Selection"])

    # 6. Instance on Points — Pick Instance ON so each point picks a
    #    random object from the source collection. Reset Children OFF
    #    keeps each prop's hierarchy intact.
    coll_info = _add_node(g, "GeometryNodeCollectionInfo", 200, -300)
    coll_info.transform_space = "ORIGINAL"
    g.links.new(gi.outputs["Source"], coll_info.inputs["Collection"])
    coll_info.inputs["Separate Children"].default_value = True
    coll_info.inputs["Reset Children"].default_value = False

    iop = _add_node(g, "GeometryNodeInstanceOnPoints", 600, 0)
    iop.inputs["Pick Instance"].default_value = True
    g.links.new(delete_pts.outputs["Geometry"], iop.inputs["Points"])
    g.links.new(coll_info.outputs["Instances"], iop.inputs["Instance"])
    g.links.new(gi.outputs["Seed"],             iop.inputs["Instance Index"])

    # 7. Random Z rotation per instance.
    rand_rot = _add_node(g, "FunctionNodeRandomValue", 400, 300)
    rand_rot.data_type = "FLOAT_VECTOR"
    rand_rot.inputs["Min"].default_value = (0.0, 0.0, 0.0)
    rand_rot.inputs["Max"].default_value = (0.0, 0.0, 6.2831853)
    g.links.new(gi.outputs["Seed"], rand_rot.inputs["Seed"])
    rot_inst = _add_node(g, "GeometryNodeRotateInstances", 800, 0)
    g.links.new(iop.outputs["Instances"], rot_inst.inputs["Instances"])
    g.links.new(rand_rot.outputs[0],      rot_inst.inputs["Rotation"])

    # 8. Random uniform scale per instance.
    rand_scale = _add_node(g, "FunctionNodeRandomValue", 800, -300)
    rand_scale.data_type = "FLOAT"
    g.links.new(gi.outputs["Size Min"], rand_scale.inputs[2])  # Min
    g.links.new(gi.outputs["Size Max"], rand_scale.inputs[3])  # Max
    seed_offset = _add_node(g, "ShaderNodeMath", 600, -300, operation="ADD")
    seed_offset.inputs[1].default_value = 7919.0
    g.links.new(gi.outputs["Seed"], seed_offset.inputs[0])
    g.links.new(seed_offset.outputs[0], rand_scale.inputs["Seed"])
    scale_inst = _add_node(g, "GeometryNodeScaleInstances", 1000, 0)
    g.links.new(rot_inst.outputs["Instances"], scale_inst.inputs["Instances"])
    # Scale uniform — pass the scalar through a Combine XYZ to feed all
    # three axes the same value.
    scale_vec = _add_node(g, "ShaderNodeCombineXYZ", 800, -150)
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["X"])
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["Y"])
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["Z"])
    g.links.new(scale_vec.outputs[0], scale_inst.inputs["Scale"])

    # 9. Per-instance COLOR_0.B phase stamp — gives each palm its own
    #    sway phase so a cluster doesn't lock-step. Stored on the
    #    instance domain so the runtime InstancedMesh sees it.
    rand_phase = _add_node(g, "FunctionNodeRandomValue", 1000, 300)
    rand_phase.data_type = "FLOAT"
    rand_phase.inputs[2].default_value = 0.0
    rand_phase.inputs[3].default_value = 1.0
    seed_offset_b = _add_node(g, "ShaderNodeMath", 800, 300, operation="ADD")
    seed_offset_b.inputs[1].default_value = 2347.0
    g.links.new(gi.outputs["Seed"], seed_offset_b.inputs[0])
    g.links.new(seed_offset_b.outputs[0], rand_phase.inputs["Seed"])
    store_phase = _add_node(g, "GeometryNodeStoreNamedAttribute", 1200, 0)
    store_phase.domain = "INSTANCE"
    store_phase.data_type = "FLOAT"
    store_phase.inputs["Name"].default_value = "sway_phase"
    g.links.new(scale_inst.outputs["Instances"], store_phase.inputs["Geometry"])
    g.links.new(rand_phase.outputs[1],           store_phase.inputs["Value"])

    g.links.new(store_phase.outputs["Geometry"], go.inputs["Geometry"])
    # The graph has no consumers inside the library .blend (each track
    # links and applies it to its own scatter-zone target meshes). Pin
    # a fake user so Blender's save-time purge keeps the group around.
    g.use_fake_user = True
    return g


# ────────────────────────────────────────────────────────────────────
# Biome-palette scatter (Proposal A) — auto-distributes props per biome
# ────────────────────────────────────────────────────────────────────

BIOME_PALETTE_GROUP = "HV_BiomePalette"

# Per-biome config:
#   (display name, A min, A max, default density, seed offset, density min, density max)
#
# Biome buckets correspond to ``COLOR_0.A`` / ``baked_biome`` values of
# 0.0 / 0.333 / 0.667 / 1.0. The min/max ranges are half-bucket windows
# around each canonical value, so a face whose Captured A averages a
# boundary value still falls into one biome — no overlap between chains.
#
# The seed offsets are co-prime additions to the modifier's Seed input
# so each biome's Distribute Points pass sees a different random state
# even when the modifier's Seed is 0 (the default).
# Densities are per m² of terrain face area — *not* per scatter zone
# like HV_Scatter's 0.05 default — so a 1 km² terrain sees ~5000 jungle
# instances at the default jungle density (0.005). Sparse-forest feel,
# Blender viewport handles it without lag. Authors crank up per-track.
#
# The 6th tuple entry is the per-biome **mask** vertex-group name
# (Proposal B). The addon's Add operator initialises each group to
# weight 1.0 on every vert when the palette is created; painting down
# in Weight Paint reduces scatter density in that region without
# touching A's biome routing or any other biome's distribution. Names
# match ``BIOME_MASK_NAMES`` in ``biome_palette.py``; bumping one side
# without the other breaks the live link.
BIOME_PALETTE_BUCKETS = (
    ("Deep",     -0.001, 0.166, 0.000, 101, "mask_deep"),
    ("Seafloor",  0.166, 0.500, 0.005, 103, "mask_seafloor"),
    ("Beach",     0.500, 0.833, 0.002, 107, "mask_beach"),
    ("Jungle",    0.833, 1.001, 0.005, 109, "mask_jungle"),
)


def build_biome_palette_group() -> bpy.types.NodeTree:
    """HV_BiomePalette — Proposal A scatter. Read ``baked_biome`` /
    ``baked_path`` / ``baked_ao`` from a terrain object, route Distribute
    Points samples into a per-biome Instance on Points chain (one per
    deep / seafloor / beach / jungle bucket), join the four streams, and
    return the union as instances.

    The modifier sits on a sibling Mesh under a ``scatter_biome_palette``
    Empty so the InstanceOnPoints output qualifies for the
    ``EXT_mesh_gpu_instancing`` glTF extension at export.

    Inputs:
        Geometry            — ignored (passed for socket compatibility;
                              the modifier owner is a near-empty mesh).
        Terrain             — Object the graph reads the source geometry
                              + baked_* attributes from.
        <Biome> Source      — collection for each biome bucket (4×).
        <Biome> Density     — points per m² within that biome (4×).
        Size Min / Max      — uniform random scale per instance.
        Path Wear Avoid     — 0..1 multiplier on COLOR_0.B's racing-line
                              exclusion (1 = full avoidance, 0 = ignore).
        AO Floor            — points whose baked_ao falls below this are
                              dropped (0 = no AO gate, 0.4 = drop deep
                              cavity points).
        Seed                — base seed; each biome adds a co-prime offset.

    Output:
        Geometry            — joined instance streams from all four biomes.

    Author flow:
      1. Click *Add Biome Palette Scatter* — the operator drops the
         Empty + surf + modifier and binds Terrain to the active mesh.
      2. Tune per-biome density and source collections in the sidebar.
      3. Run *Apply Terrain Vertex Colors* on the terrain (if not
         already done) so ``baked_biome`` reflects world-Z biomes.
      4. Export the track — instances ship as EXT_mesh_gpu_instancing.
    """
    if BIOME_PALETTE_GROUP in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[BIOME_PALETTE_GROUP])
    g = bpy.data.node_groups.new(BIOME_PALETTE_GROUP, "GeometryNodeTree")

    # ── Sockets ─────────────────────────────────────────────────────
    _new_socket(g, "Geometry",        "INPUT",  "NodeSocketGeometry")
    _new_socket(g, "Terrain",         "INPUT",  "NodeSocketObject")
    for name, _mn, _mx, default_density, _seed_off, _mask_name in BIOME_PALETTE_BUCKETS:
        _new_socket(g, f"{name} Source",  "INPUT",  "NodeSocketCollection")
        _new_socket(
            g, f"{name} Density", "INPUT", "NodeSocketFloat",
            default_density, mn=0.0, mx=10.0,
        )
    _new_socket(g, "Size Min",        "INPUT",  "NodeSocketFloat",  0.85, mn=0.05)
    _new_socket(g, "Size Max",        "INPUT",  "NodeSocketFloat",  1.20, mn=0.05)
    _new_socket(g, "Path Wear Avoid", "INPUT",  "NodeSocketFloat",  1.00, mn=0.0, mx=1.0)
    _new_socket(g, "AO Floor",        "INPUT",  "NodeSocketFloat",  0.00, mn=0.0, mx=1.0)
    _new_socket(g, "Seed",            "INPUT",  "NodeSocketInt",    0)
    _new_socket(g, "Geometry",        "OUTPUT", "NodeSocketGeometry")

    gi = _add_node(g, "NodeGroupInput",  -2600, 0)
    go = _add_node(g, "NodeGroupOutput",  2600, 0)

    # ── Source geometry — read the terrain object via Object Info ───
    obj_info = _add_node(g, "GeometryNodeObjectInfo", -2400, 200)
    obj_info.transform_space = "RELATIVE"
    g.links.new(gi.outputs["Terrain"], obj_info.inputs["Object"])
    terrain_geo_socket = obj_info.outputs["Geometry"]

    # Per-biome chains read ``baked_biome`` directly via Named Attribute
    # rather than going through Capture Attribute on FACE domain. Blender
    # evaluates the named-attribute field at each face when its result is
    # piped into Distribute Points' Density socket — and the implicit
    # interpolation softens biome boundaries instead of blocking them on
    # triangle topology. ``baked_path`` / ``baked_ao`` are read the same
    # way inside each chain after distribution (point-domain sampling
    # auto-interpolates from the underlying face). Each chain owns its
    # own Named Attribute reader so the Blender graph stays untangled.

    # ── Per-biome chains ────────────────────────────────────────────
    join = _add_node(g, "GeometryNodeJoinGeometry", 2400, 0)

    chain_y_step = -900  # vertical spacing between biome chains
    for idx, (name, biome_min, biome_max, _default_density, seed_off, mask_name) in enumerate(BIOME_PALETTE_BUCKETS):
        y = idx * chain_y_step
        x = -1800  # leftmost column for this chain

        # 1. Read baked_biome as a per-vertex FLOAT field.
        named_biome = _add_node(g, "GeometryNodeInputNamedAttribute", x - 200, y, data_type="FLOAT")
        named_biome.inputs["Name"].default_value = "baked_biome"

        # 2. Biome predicate: 1.0 inside [biome_min, biome_max], else 0.0.
        above_min = _add_node(g, "ShaderNodeMath", x, y, operation="GREATER_THAN")
        above_min.inputs[1].default_value = biome_min
        g.links.new(named_biome.outputs["Attribute"], above_min.inputs[0])

        below_max = _add_node(g, "ShaderNodeMath", x, y - 200, operation="LESS_THAN")
        below_max.inputs[1].default_value = biome_max
        g.links.new(named_biome.outputs["Attribute"], below_max.inputs[0])

        in_biome = _add_node(g, "ShaderNodeMath", x + 200, y - 100, operation="MULTIPLY")
        g.links.new(above_min.outputs[0], in_biome.inputs[0])
        g.links.new(below_max.outputs[0], in_biome.inputs[1])

        # 3. Density = in_biome × biome_density. Blender evaluates this
        #    field per-face when piped into Distribute Points' Density
        #    socket — no Capture Attribute needed, and the implicit
        #    point-to-face interpolation softens biome boundaries.
        density_factor = _add_node(g, "ShaderNodeMath", x + 400, y - 100, operation="MULTIPLY")
        g.links.new(in_biome.outputs[0], density_factor.inputs[0])
        g.links.new(gi.outputs[f"{name} Density"], density_factor.inputs[1])

        # 3a. Paint-mask multiplier (Proposal B). Each biome row reads a
        #     per-biome vertex group as a FLOAT field; the addon's
        #     palette-add operator initialises every weight to 1.0 so
        #     unpainted terrain scatters A's density unchanged. Painting
        #     in Weight Paint lowers the weight in a region, which
        #     multiplies into the density below — paint 0 = suppress
        #     that biome's scatter, paint somewhere between for thinning.
        named_mask = _add_node(g, "GeometryNodeInputNamedAttribute", x + 250, y - 450, data_type="FLOAT")
        named_mask.inputs["Name"].default_value = mask_name
        masked_density = _add_node(g, "ShaderNodeMath", x + 600, y - 100, operation="MULTIPLY")
        g.links.new(density_factor.outputs[0],     masked_density.inputs[0])
        g.links.new(named_mask.outputs["Attribute"], masked_density.inputs[1])

        # 4. Per-biome seed: base Seed + biome offset so the same modifier
        #    Seed gives four uncorrelated distributions.
        seed_node = _add_node(g, "ShaderNodeMath", x + 200, y - 300, operation="ADD")
        seed_node.inputs[1].default_value = float(seed_off)
        g.links.new(gi.outputs["Seed"], seed_node.inputs[0])

        # 5. Distribute Points on the terrain's evaluated geometry.
        distribute = _add_node(g, "GeometryNodeDistributePointsOnFaces", x + 800, y)
        distribute.distribute_method = "RANDOM"
        g.links.new(terrain_geo_socket,         distribute.inputs["Mesh"])
        g.links.new(masked_density.outputs[0],  distribute.inputs["Density"])
        g.links.new(seed_node.outputs[0],       distribute.inputs["Seed"])

        # 5. Sample path-wear and AO at each point. Named Attribute on a
        #    POINT-domain geometry samples by the point's underlying face
        #    (interpolated). Path wear: factor = 1 - B × PathWearAvoid.
        named_path = _add_node(g, "GeometryNodeInputNamedAttribute", x + 700, y - 350, data_type="FLOAT")
        named_path.inputs["Name"].default_value = "baked_path"
        wear_scaled = _add_node(g, "ShaderNodeMath", x + 900, y - 350, operation="MULTIPLY")
        g.links.new(named_path.outputs["Attribute"], wear_scaled.inputs[0])
        g.links.new(gi.outputs["Path Wear Avoid"],   wear_scaled.inputs[1])
        wear_keep = _add_node(g, "ShaderNodeMath", x + 1100, y - 350, operation="SUBTRACT")
        wear_keep.use_clamp = True
        wear_keep.inputs[0].default_value = 1.0
        g.links.new(wear_scaled.outputs[0], wear_keep.inputs[1])

        # 6. AO gate: keep = smoothstep(AO Floor, 1.0, baked_ao). Use a
        #    Map Range with SMOOTHSTEP interpolation — produces 0 below
        #    the floor and 1 at full open sky, smoothly clamped.
        named_ao = _add_node(g, "GeometryNodeInputNamedAttribute", x + 700, y - 550, data_type="FLOAT")
        named_ao.inputs["Name"].default_value = "baked_ao"
        ao_mr = _add_node(g, "ShaderNodeMapRange", x + 900, y - 550, interpolation_type="SMOOTHSTEP", clamp=True)
        ao_mr.inputs["From Max"].default_value = 1.0
        ao_mr.inputs["To Min"].default_value = 0.0
        ao_mr.inputs["To Max"].default_value = 1.0
        g.links.new(named_ao.outputs["Attribute"], ao_mr.inputs["Value"])
        g.links.new(gi.outputs["AO Floor"],        ao_mr.inputs["From Min"])

        # 7. Combine path-wear keep × AO keep → final keep factor. Then
        #    sample a per-point random [0,1] and survive if random < keep.
        keep = _add_node(g, "ShaderNodeMath", x + 1300, y - 450, operation="MULTIPLY")
        g.links.new(wear_keep.outputs[0], keep.inputs[0])
        g.links.new(ao_mr.outputs[0],     keep.inputs[1])

        rand_keep = _add_node(g, "FunctionNodeRandomValue", x + 1300, y - 250)
        rand_keep.data_type = "FLOAT"
        rand_keep.inputs[2].default_value = 0.0
        rand_keep.inputs[3].default_value = 1.0
        seed_keep = _add_node(g, "ShaderNodeMath", x + 1100, y - 250, operation="ADD")
        seed_keep.inputs[1].default_value = float(seed_off) + 0.5
        g.links.new(gi.outputs["Seed"], seed_keep.inputs[0])
        g.links.new(seed_keep.outputs[0], rand_keep.inputs["Seed"])

        surv = _add_node(g, "ShaderNodeMath", x + 1500, y - 350, operation="LESS_THAN")
        g.links.new(rand_keep.outputs[1], surv.inputs[0])
        g.links.new(keep.outputs[0],      surv.inputs[1])

        invert = _add_node(g, "ShaderNodeMath", x + 1700, y - 350, operation="SUBTRACT")
        invert.inputs[0].default_value = 1.0
        g.links.new(surv.outputs[0], invert.inputs[1])

        delete_pts = _add_node(g, "GeometryNodeDeleteGeometry", x + 1900, y - 100)
        delete_pts.domain = "POINT"
        delete_pts.mode = "ALL"
        g.links.new(distribute.outputs["Points"], delete_pts.inputs["Geometry"])
        g.links.new(invert.outputs[0],            delete_pts.inputs["Selection"])

        # 8. Instance on Points — Pick Instance ON randomises across the
        #    biome collection's children.
        coll_info = _add_node(g, "GeometryNodeCollectionInfo", x + 1900, y - 500)
        coll_info.transform_space = "ORIGINAL"
        coll_info.inputs["Separate Children"].default_value = True
        coll_info.inputs["Reset Children"].default_value = False
        g.links.new(gi.outputs[f"{name} Source"], coll_info.inputs["Collection"])

        iop = _add_node(g, "GeometryNodeInstanceOnPoints", x + 2200, y - 100)
        iop.inputs["Pick Instance"].default_value = True
        g.links.new(delete_pts.outputs["Geometry"], iop.inputs["Points"])
        g.links.new(coll_info.outputs["Instances"], iop.inputs["Instance"])
        g.links.new(seed_node.outputs[0],           iop.inputs["Instance Index"])

        # 9. Random Z rotation.
        rand_rot = _add_node(g, "FunctionNodeRandomValue", x + 2400, y + 100)
        rand_rot.data_type = "FLOAT_VECTOR"
        rand_rot.inputs["Min"].default_value = (0.0, 0.0, 0.0)
        rand_rot.inputs["Max"].default_value = (0.0, 0.0, 6.2831853)
        g.links.new(seed_node.outputs[0], rand_rot.inputs["Seed"])
        rot_inst = _add_node(g, "GeometryNodeRotateInstances", x + 2600, y - 100)
        g.links.new(iop.outputs["Instances"], rot_inst.inputs["Instances"])
        g.links.new(rand_rot.outputs[0],      rot_inst.inputs["Rotation"])

        # 10. Random uniform scale.
        rand_scale = _add_node(g, "FunctionNodeRandomValue", x + 2400, y - 400)
        rand_scale.data_type = "FLOAT"
        g.links.new(gi.outputs["Size Min"], rand_scale.inputs[2])
        g.links.new(gi.outputs["Size Max"], rand_scale.inputs[3])
        scale_seed = _add_node(g, "ShaderNodeMath", x + 2200, y - 400, operation="ADD")
        scale_seed.inputs[1].default_value = float(seed_off) + 0.25
        g.links.new(gi.outputs["Seed"], scale_seed.inputs[0])
        g.links.new(scale_seed.outputs[0], rand_scale.inputs["Seed"])
        scale_vec = _add_node(g, "ShaderNodeCombineXYZ", x + 2600, y - 400)
        g.links.new(rand_scale.outputs[1], scale_vec.inputs["X"])
        g.links.new(rand_scale.outputs[1], scale_vec.inputs["Y"])
        g.links.new(rand_scale.outputs[1], scale_vec.inputs["Z"])
        scale_inst = _add_node(g, "GeometryNodeScaleInstances", x + 2800, y - 100)
        g.links.new(rot_inst.outputs["Instances"], scale_inst.inputs["Instances"])
        g.links.new(scale_vec.outputs[0],          scale_inst.inputs["Scale"])

        # 11. Join into the unified output.
        g.links.new(scale_inst.outputs["Instances"], join.inputs["Geometry"])

    g.links.new(join.outputs["Geometry"], go.inputs["Geometry"])
    g.use_fake_user = True
    return g


# ────────────────────────────────────────────────────────────────────
# Stroke scatter (Proposal C) — curve-bounded scatter zones
# ────────────────────────────────────────────────────────────────────

STROKE_SCATTER_GROUP = "HV_StrokeScatter"


def build_stroke_scatter_group() -> bpy.types.NodeTree:
    """HV_StrokeScatter — Proposal C scatter. Reads a Bezier curve via
    Object Info, builds a flat ribbon along the curve with width
    ``2 × Width``, scatters Distribute Points samples across the ribbon
    at the given Density, and instances a Source collection on each.

    The modifier sits on a sibling Mesh under a
    ``scatter_<prop>_stroke_NN`` Empty (same EXT_mesh_gpu_instancing
    requirement as the other scatter graphs). The curve itself is a
    sibling under the same Empty — author edits the curve, the scatter
    re-evaluates live via the existing depsgraph handler.

    Inputs:
        Geometry  — ignored (modifier owner is a near-empty surf mesh).
        Curve     — Object whose evaluated curve geometry shapes the
                    ribbon's centre line.
        Source    — Collection to instance from.
        Width     — perpendicular half-extent (metres). Ribbon area =
                    curve_length × 2 × Width.
        Density   — instances per m² of ribbon area.
        Size Min / Max — uniform random scale per instance.
        Seed      — base seed for distribution + random transforms.

    Output:
        Geometry  — instance stream (rotated, scaled).

    Path-wear gating is intentionally **not** in v1 — would require a
    Raycast node sampling the terrain's baked_path per point. The
    author shapes the curve to avoid the racing line; a follow-up will
    add the gate.
    """
    if STROKE_SCATTER_GROUP in bpy.data.node_groups:
        bpy.data.node_groups.remove(bpy.data.node_groups[STROKE_SCATTER_GROUP])
    g = bpy.data.node_groups.new(STROKE_SCATTER_GROUP, "GeometryNodeTree")

    # ── Sockets ─────────────────────────────────────────────────────
    _new_socket(g, "Geometry",  "INPUT",  "NodeSocketGeometry")
    _new_socket(g, "Curve",     "INPUT",  "NodeSocketObject")
    _new_socket(g, "Source",    "INPUT",  "NodeSocketCollection")
    _new_socket(g, "Width",     "INPUT",  "NodeSocketFloat",  8.0,  mn=0.5, mx=200.0)
    _new_socket(g, "Density",   "INPUT",  "NodeSocketFloat",  0.10, mn=0.0, mx=10.0)
    _new_socket(g, "Size Min",  "INPUT",  "NodeSocketFloat",  0.85, mn=0.05)
    _new_socket(g, "Size Max",  "INPUT",  "NodeSocketFloat",  1.20, mn=0.05)
    _new_socket(g, "Seed",      "INPUT",  "NodeSocketInt",    0)
    _new_socket(g, "Geometry",  "OUTPUT", "NodeSocketGeometry")

    gi = _add_node(g, "NodeGroupInput",  -1800, 0)
    go = _add_node(g, "NodeGroupOutput",  1800, 0)

    # ── Read the stroke curve via Object Info ───────────────────────
    obj_info = _add_node(g, "GeometryNodeObjectInfo", -1600, 200)
    obj_info.transform_space = "RELATIVE"
    g.links.new(gi.outputs["Curve"], obj_info.inputs["Object"])
    curve_geo = obj_info.outputs["Geometry"]

    # ── Build the line profile: a horizontal line of length 2 × Width.
    #    Curve Primitive Line takes a Start and End vector; we anchor
    #    one end at (-Width, 0, 0) and the other at (+Width, 0, 0) so
    #    the sweep produces a flat ribbon (X = perpendicular, Y/Z =
    #    along curve and curve normal). Curve to Mesh's auto-frame
    #    keeps the ribbon perpendicular to the curve's tangent.
    profile_line = _add_node(g, "GeometryNodeCurvePrimitiveLine", -1400, -300)
    # Start vector: (-Width, 0, 0)
    neg_width = _add_node(g, "ShaderNodeMath", -1600, -300, operation="MULTIPLY")
    neg_width.inputs[1].default_value = -1.0
    g.links.new(gi.outputs["Width"], neg_width.inputs[0])
    start_vec = _add_node(g, "ShaderNodeCombineXYZ", -1450, -250)
    g.links.new(neg_width.outputs[0], start_vec.inputs["X"])
    g.links.new(start_vec.outputs[0], profile_line.inputs["Start"])
    end_vec = _add_node(g, "ShaderNodeCombineXYZ", -1450, -400)
    g.links.new(gi.outputs["Width"], end_vec.inputs["X"])
    g.links.new(end_vec.outputs[0], profile_line.inputs["End"])

    # ── Sweep the profile along the curve → ribbon mesh ─────────────
    curve_to_mesh = _add_node(g, "GeometryNodeCurveToMesh", -1100, 0)
    curve_to_mesh.inputs["Fill Caps"].default_value = False
    g.links.new(curve_geo,                       curve_to_mesh.inputs["Curve"])
    g.links.new(profile_line.outputs["Curve"],   curve_to_mesh.inputs["Profile Curve"])

    # ── Distribute Points on the ribbon at Density ──────────────────
    distribute = _add_node(g, "GeometryNodeDistributePointsOnFaces", -800, 0)
    distribute.distribute_method = "RANDOM"
    g.links.new(curve_to_mesh.outputs["Mesh"], distribute.inputs["Mesh"])
    g.links.new(gi.outputs["Density"],         distribute.inputs["Density"])
    g.links.new(gi.outputs["Seed"],            distribute.inputs["Seed"])

    # ── Instance on Points from the Source collection ───────────────
    coll_info = _add_node(g, "GeometryNodeCollectionInfo", -500, -300)
    coll_info.transform_space = "ORIGINAL"
    coll_info.inputs["Separate Children"].default_value = True
    coll_info.inputs["Reset Children"].default_value = False
    g.links.new(gi.outputs["Source"], coll_info.inputs["Collection"])

    iop = _add_node(g, "GeometryNodeInstanceOnPoints", -200, 0)
    iop.inputs["Pick Instance"].default_value = True
    g.links.new(distribute.outputs["Points"],   iop.inputs["Points"])
    g.links.new(coll_info.outputs["Instances"], iop.inputs["Instance"])
    g.links.new(gi.outputs["Seed"],             iop.inputs["Instance Index"])

    # ── Random Z rotation ───────────────────────────────────────────
    rand_rot = _add_node(g, "FunctionNodeRandomValue", -200, 300)
    rand_rot.data_type = "FLOAT_VECTOR"
    rand_rot.inputs["Min"].default_value = (0.0, 0.0, 0.0)
    rand_rot.inputs["Max"].default_value = (0.0, 0.0, 6.2831853)
    g.links.new(gi.outputs["Seed"], rand_rot.inputs["Seed"])
    rot_inst = _add_node(g, "GeometryNodeRotateInstances", 100, 0)
    g.links.new(iop.outputs["Instances"], rot_inst.inputs["Instances"])
    g.links.new(rand_rot.outputs[0],      rot_inst.inputs["Rotation"])

    # ── Random uniform scale ────────────────────────────────────────
    rand_scale = _add_node(g, "FunctionNodeRandomValue", 100, -300)
    rand_scale.data_type = "FLOAT"
    g.links.new(gi.outputs["Size Min"], rand_scale.inputs[2])
    g.links.new(gi.outputs["Size Max"], rand_scale.inputs[3])
    scale_seed = _add_node(g, "ShaderNodeMath", -100, -300, operation="ADD")
    scale_seed.inputs[1].default_value = 1933.0
    g.links.new(gi.outputs["Seed"],    scale_seed.inputs[0])
    g.links.new(scale_seed.outputs[0], rand_scale.inputs["Seed"])
    scale_vec = _add_node(g, "ShaderNodeCombineXYZ", 300, -300)
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["X"])
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["Y"])
    g.links.new(rand_scale.outputs[1], scale_vec.inputs["Z"])
    scale_inst = _add_node(g, "GeometryNodeScaleInstances", 500, 0)
    g.links.new(rot_inst.outputs["Instances"], scale_inst.inputs["Instances"])
    g.links.new(scale_vec.outputs[0],          scale_inst.inputs["Scale"])

    g.links.new(scale_inst.outputs["Instances"], go.inputs["Geometry"])
    g.use_fake_user = True
    return g


# ────────────────────────────────────────────────────────────────────
# Per-prop builder
# ────────────────────────────────────────────────────────────────────

def _layer_collection_link(coll: bpy.types.Collection) -> None:
    """Link the collection under the scene's master collection. We use
    layer collections directly (rather than children of a wrapper)
    because each prop collection is its own top-level asset."""
    bpy.context.scene.collection.children.link(coll)


def _mark_collection_asset(coll: bpy.types.Collection, *, catalog_path: str, description: str, tags: list[str]) -> None:
    """Mark *coll* as an asset, assign catalogue, write tags and
    metadata. Idempotent — re-marking a collection just refreshes the
    metadata."""
    if coll.asset_data is None:
        coll.asset_mark()
    ad = coll.asset_data
    # catalog_simple_name is read-only and derived by Blender from the
    # catalog the UUID points to (resolved from blender_assets.cats.txt).
    ad.catalog_id = CATALOG_UUIDS[catalog_path]
    ad.description = description
    ad.author = "Hoverbike"
    # Refresh tags
    for t in list(ad.tags):
        ad.tags.remove(t)
    for t in tags:
        ad.tags.new(name=t)


def _make_prop_collection(
    name: str,
    mesh: bpy.types.Mesh,
    gn_group: bpy.types.NodeTree | None,
    materials: list[bpy.types.Material],
    *,
    gn_inputs: dict | None = None,
    position: tuple[float, float, float] = (0, 0, 0),
    wave_rider_archetype: str | None = None,
) -> bpy.types.Collection:
    """Build the standard prop collection layout:

        Collection: prop_<id>
        ├── Empty: prop_<id>_root   (kind=prop, prop_id=<id>)
        │   └── Mesh:  prop_<id>_mesh  (GN modifier applied if group is given)

    ``wave_rider_archetype`` (optional) tags the root with
    ``wave_rider_archetype = <buoy|log>`` extras. Tracks that instance
    the prop pick up the tag at GLB-load time; the runtime spawns a
    kinematic wave-rider body for each placement instead of a static
    collider. Mirror of ``waveRider.archetype`` in the build_prop spec
    schema — this seed path is used when authors hand-export collections
    via the addon, whereas the standalone GLB pipeline (`build_prop.py`)
    reads the archetype from the spec JSON.

    Returns the collection, ready to be marked as an asset.
    """
    coll = bpy.data.collections.new(name)
    _layer_collection_link(coll)

    # Empty root — collection-instances are placed at the empty's transform.
    root = bpy.data.objects.new(f"{name}_root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    root.location = position
    root["kind"] = "prop"
    root["prop_id"] = name.removeprefix("prop_")
    if wave_rider_archetype is not None:
        root["wave_rider_archetype"] = wave_rider_archetype
    coll.objects.link(root)

    mesh_obj = bpy.data.objects.new(f"{name}_mesh", mesh)
    coll.objects.link(mesh_obj)
    mesh_obj.parent = root

    for mat in materials:
        if mat.name not in mesh.materials:
            mesh.materials.append(mat)

    if gn_group is not None:
        mod = mesh_obj.modifiers.new(name="HV_Prop", type="NODES")
        mod.node_group = gn_group
        if gn_inputs:
            # Map socket names → identifiers and assign through modifier indexing.
            interface = gn_group.interface
            name_to_id = {}
            for item in interface.items_tree:
                if getattr(item, "in_out", None) == "INPUT" and getattr(item, "item_type", None) == "SOCKET":
                    name_to_id[item.name] = item.identifier
            for sock_name, value in gn_inputs.items():
                ident = name_to_id.get(sock_name)
                if ident is not None:
                    mod[ident] = value

    return coll


# ────────────────────────────────────────────────────────────────────
# Layout — spread props in a row so the .blend's viewport is useful
# ────────────────────────────────────────────────────────────────────

PROP_POSITIONS = {
    "prop_rock":            ( 0.0, 0.0, 0.0),
    "prop_palm":            ( 6.0, 0.0, 0.0),
    "prop_buoy":            (12.0, 0.0, 0.0),
    "prop_log":             (18.0, 0.0, 0.0),
    "prop_gate":            (24.0, 0.0, 0.0),
    "prop_turn_indicator":  (60.0, 0.0, 0.0),
    # Phase γ biome kits — laid out along +X past the existing props
    # so the .blend's viewport reads as a row of kits when opened.
    # Urban kit (Shibuya / Marina Bay / Liberty)
    "prop_lamp_post":       (70.0, 0.0, 0.0),
    "prop_antenna_mast":    (76.0, 0.0, 0.0),
    "prop_vent_stack":      (82.0, 0.0, 0.0),
    "prop_ac_unit":         (86.0, 0.0, 0.0),
    "prop_signage_panel":   (92.0, 0.0, 0.0),
    # Industrial kit (Marina Bay)
    "prop_container":       (102.0, 0.0, 0.0),
    "prop_oil_drum":        (110.0, 0.0, 0.0),
    "prop_mooring_bollard": (114.0, 0.0, 0.0),
    # Volcanic kit (Kilauea)
    "prop_basalt_boulder":  (120.0, 0.0, 0.0),
    "prop_ash_heap":        (124.0, 0.0, 0.0),
    "prop_scorched_stump":  (128.0, 0.0, 0.0),
    # Jungle kit (Angkor Drowned)
    "prop_fern_clump":      (134.0, 0.0, 0.0),
    "prop_mossy_boulder":   (138.0, 0.0, 0.0),
    "prop_fallen_pillar":   (142.0, 0.0, 0.0),
    # Venetian kit (Doge's Drift)
    "prop_gondola":         (150.0, 0.0, 0.0),
    "prop_venetian_mooring":(158.0, 0.0, 0.0),
    "prop_canal_lantern":   (162.0, 0.0, 0.0),
    "prop_paving_slab":     (166.0, 0.0, 0.0),
    "prop_ivy_patch":       (170.0, 0.0, 0.0),
    # Waterpark kit (Aqualand)
    "prop_beach_ball":      (178.0, 0.0, 0.0),
    "prop_pool_noodle":     (182.0, 0.0, 0.0),
    "prop_inflatable_ring": (186.0, 0.0, 0.0),
    "prop_slide_piece":     (192.0, 0.0, 0.0),
    "prop_faded_sign":      (200.0, 0.0, 0.0),
    # Open Sea kit (denser ammunition for The Maw / Hatteras / Cape Town)
    "prop_sea_stack":       (208.0, 0.0, 0.0),
    "prop_nav_marker":      (216.0, 0.0, 0.0),
    "prop_kelp_strand":     (220.0, 0.0, 0.0),
    "prop_foam_tuft":       (224.0, 0.0, 0.0),
    "prop_gull_crag":       (228.0, 0.0, 0.0),
}


# ────────────────────────────────────────────────────────────────────
# Build pipeline
# ────────────────────────────────────────────────────────────────────

def build_props() -> dict:
    rock_mat  = make_material("mat_prop_rock", "#7a7570", roughness=0.85)
    palm_trunk_mat = make_material("mat_foliage_palm_trunk", "#6e4a2e", roughness=0.75)
    palm_frond_mat = make_material("mat_foliage_palm", "#3e7a32", roughness=0.55)
    buoy_body_mat  = make_material("mat_prop_buoy", "#cc3322", roughness=0.5)
    buoy_top_mat   = make_material("mat_prop_buoy_light", "#fff2a8", roughness=0.3, emission_hex="#fff8d0", emission_strength=4.0)
    log_mat        = make_material("mat_prop_log", "#6b4a2a", roughness=0.85)
    gate_mat       = make_material("mat_prop_gate", "#d6d3ce", roughness=0.45)
    indicator_mat  = make_material("mat_prop_indicator", "#ffaa1a", roughness=0.4, emission_hex="#ffaa1a", emission_strength=1.2)

    summary: dict[str, dict] = {}

    # ── Rock ────────────────────────────────────────────────────────
    rock_group = build_rock_group()
    rock_mesh  = build_rock_mesh("prop_rock_mesh")
    rock_coll  = _make_prop_collection(
        "prop_rock", rock_mesh, rock_group, [rock_mat],
        gn_inputs={"Size": 1.5, "Jaggedness": 0.35, "Noise Scale": 1.4, "Seed": 0.0},
        position=PROP_POSITIONS["prop_rock"],
    )
    _mark_collection_asset(rock_coll,
                            catalog_path="Hoverbike/Track Props/Rocks",
                            description="Procedural rock — distorted icosphere with FBM noise. Tune Size, Jaggedness, Noise Scale, Seed on the HV_Prop modifier.",
                            tags=["rock", "static", "scatterable"])
    summary["rock"] = {"verts": len(rock_mesh.vertices)}

    # ── Palm ───────────────────────────────────────────────────────
    palm_group = build_palm_group()
    palm_mesh  = build_palm_mesh("prop_palm_mesh", height=4.5, frond_count=7)
    palm_coll  = _make_prop_collection(
        "prop_palm", palm_mesh, palm_group, [palm_trunk_mat, palm_frond_mat],
        gn_inputs={"Scale": 1.0},
        position=PROP_POSITIONS["prop_palm"],
    )
    # Material slot 0 = trunk, slot 1 = fronds. Assign per-polygon by
    # face centroid: any face whose centroid sits above the trunk-top
    # (z > height * 0.95) belongs to a frond.
    frond_threshold = 4.5 * 0.95
    for poly in palm_mesh.polygons:
        centroid_z = sum(palm_mesh.vertices[i].co.z for i in poly.vertices) / len(poly.vertices)
        poly.material_index = 1 if centroid_z > frond_threshold else 0
    _mark_collection_asset(palm_coll,
                            catalog_path="Hoverbike/Track Props/Palms",
                            description="Procedural palm — tapered trunk + radial fronds. Sway gradient pre-stamped in COLOR_0.R so the foliage shader animates the leaves. Scale knob on the HV_Prop modifier.",
                            tags=["palm", "foliage", "sway", "scatterable"])
    summary["palm"] = {"verts": len(palm_mesh.vertices)}

    # ── Buoy ───────────────────────────────────────────────────────
    # ``wave_rider_archetype="buoy"`` opts every instance into the
    # runtime kinematic-buoyancy path (`createWaveRider`). The runtime
    # picks up the tag from glTF extras on the prop root and routes
    # placement through the wave-rider system + render system instead
    # of the static-collider path.
    buoy_mesh  = build_buoy_mesh("prop_buoy_mesh", radius=0.6, height=1.5)
    buoy_coll  = _make_prop_collection(
        "prop_buoy", buoy_mesh, None, [buoy_body_mat, buoy_top_mat],
        position=PROP_POSITIONS["prop_buoy"],
        wave_rider_archetype="buoy",
    )
    _mark_collection_asset(buoy_coll,
                            catalog_path="Hoverbike/Track Props/Buoys",
                            description="Marker buoy — pylon with emissive top. Wave-rider: bobs on the wave surface and reacts to bike impacts at runtime via the kinematic-body system (see src/game/components/wave-rider.ts).",
                            tags=["buoy", "water", "emissive", "wave-rider"])
    summary["buoy"] = {"verts": len(buoy_mesh.vertices)}

    # ── Log ────────────────────────────────────────────────────────
    # Second wave-rider archetype — runs along the cylinder's long axis
    # so authored ``yaw`` rotates the log around its waterline. Tuning
    # (`'log'` entry in ``WAVE_RIDER_TUNING``) gives it a heavier feel
    # than the buoy: stiffer normalFollow, longer tilt period, smaller
    # floatOffsetY (the log half-submerges instead of bobbing on top).
    log_mesh = build_log_mesh("prop_log_mesh", length=2.4, radius=0.30)
    log_coll = _make_prop_collection(
        "prop_log", log_mesh, None, [log_mat],
        position=PROP_POSITIONS["prop_log"],
        wave_rider_archetype="log",
    )
    _mark_collection_asset(log_coll,
                            catalog_path="Hoverbike/Track Props/Logs",
                            description="Drift log — horizontal cylinder. Wave-rider: half-submerged, rolls with the surface normal and reacts to bike impacts (heavier feel than the buoy archetype).",
                            tags=["log", "water", "wave-rider"])
    summary["log"] = {"verts": len(log_mesh.vertices)}

    # ── Gate ───────────────────────────────────────────────────────
    gate_mesh  = build_gate_mesh("prop_gate_mesh", half_width=14.0, height=6.0, post_radius=0.35)
    gate_coll  = _make_prop_collection(
        "prop_gate", gate_mesh, None, [gate_mat],
        position=PROP_POSITIONS["prop_gate"],
    )
    _mark_collection_asset(gate_coll,
                            catalog_path="Hoverbike/Track Props/Gates",
                            description="Real gate mesh at canonical 28m x 6m gizmo dimensions. Use for decorative or fixed-position gates; spline-driven race gates remain JSON-owned.",
                            tags=["gate", "static"])
    summary["gate"] = {"verts": len(gate_mesh.vertices)}

    # ── Turn indicator ─────────────────────────────────────────────
    ti_mesh  = build_turn_indicator_mesh("prop_turn_indicator_mesh", length=4.0, half_width=2.0)
    ti_coll  = _make_prop_collection(
        "prop_turn_indicator", ti_mesh, None, [indicator_mat],
        position=PROP_POSITIONS["prop_turn_indicator"],
    )
    _mark_collection_asset(ti_coll,
                            catalog_path="Hoverbike/Track Props/Indicators",
                            description="Static chevron — for fixed-position turn hints. Curvature-driven placement lives in the addon panel (Rebuild Turn Indicators).",
                            tags=["indicator", "static", "emissive"])
    summary["turn_indicator"] = {"verts": len(ti_mesh.vertices)}

    # ── Phase γ biome kits ─────────────────────────────────────────
    #
    # Materials. The runtime sway-shader opts in via `mat_foliage_*`
    # name prefix; everything else stays static (`mat_prop_*`). Hex
    # colours are placeholders an author can re-roll before the trim-
    # sheet pass (Phase δ) lands.

    urban_metal_mat  = make_material("mat_prop_urban_metal", "#9aa0a8", roughness=0.55)
    urban_lamp_mat   = make_material("mat_prop_urban_lamp", "#f7e9b2", roughness=0.30,
                                     emission_hex="#fff2d0", emission_strength=2.5)
    urban_sign_mat   = make_material("mat_prop_urban_signage", "#c8c8d4", roughness=0.45)
    urban_sign_emi_mat = make_material("mat_prop_urban_signage_lit", "#ff4cc4", roughness=0.35,
                                       emission_hex="#ff4cc4", emission_strength=2.0)

    container_mat    = make_material("mat_prop_industrial_container", "#a8442a", roughness=0.7)
    drum_mat         = make_material("mat_prop_industrial_drum", "#3a3030", roughness=0.55)
    bollard_mat      = make_material("mat_prop_industrial_bollard", "#4a4f55", roughness=0.6)

    basalt_mat       = make_material("mat_prop_volcanic_basalt", "#2e2a2a", roughness=0.85)
    ash_mat          = make_material("mat_prop_volcanic_ash", "#a8a298", roughness=0.95)
    scorched_mat     = make_material("mat_prop_volcanic_scorched", "#332622", roughness=0.85)

    fern_mat         = make_material("mat_foliage_fern", "#3a6e2c", roughness=0.65)
    mossy_mat        = make_material("mat_prop_jungle_mossy", "#4a5e34", roughness=0.85)
    pillar_mat       = make_material("mat_prop_jungle_pillar", "#a89a78", roughness=0.75)

    # Venetian kit
    gondola_mat      = make_material("mat_prop_venetian_gondola", "#1a1a1e", roughness=0.55)
    venet_post_mat   = make_material("mat_prop_venetian_post", "#d8c8a8", roughness=0.65)
    venet_stripe_mat = make_material("mat_prop_venetian_post_stripe", "#a83838", roughness=0.55)
    lantern_iron_mat = make_material("mat_prop_venetian_lantern", "#2a261e", roughness=0.6)
    lantern_lit_mat  = make_material("mat_prop_venetian_lantern_lit", "#ffe4a8", roughness=0.25,
                                     emission_hex="#ffe4a8", emission_strength=2.5)
    paving_mat       = make_material("mat_prop_venetian_paving", "#b8b0a0", roughness=0.85)
    ivy_mat          = make_material("mat_foliage_ivy", "#3e6238", roughness=0.7)

    # Waterpark kit
    beach_ball_mat   = make_material("mat_prop_waterpark_ball", "#ff6688", roughness=0.40)
    pool_noodle_mat  = make_material("mat_prop_waterpark_noodle", "#42d4ff", roughness=0.45)
    ring_mat         = make_material("mat_prop_waterpark_ring", "#ffdc4a", roughness=0.45)
    slide_mat        = make_material("mat_prop_waterpark_slide", "#5cc0e8", roughness=0.5)
    faded_sign_mat   = make_material("mat_prop_waterpark_sign", "#e8d4a8", roughness=0.7)

    # Open Sea kit
    sea_stack_mat    = make_material("mat_prop_opensea_stack", "#8a8a82", roughness=0.85)
    nav_marker_body_mat = make_material("mat_prop_opensea_nav", "#e84a1a", roughness=0.55)
    nav_marker_lit_mat  = make_material("mat_prop_opensea_nav_lit", "#ffe098", roughness=0.30,
                                        emission_hex="#fff2a8", emission_strength=3.5)
    kelp_mat         = make_material("mat_foliage_kelp", "#3a583a", roughness=0.7)
    foam_mat         = make_material("mat_foliage_foam", "#f0f4f8", roughness=0.9)
    gull_crag_mat    = make_material("mat_prop_opensea_crag", "#6a665e", roughness=0.85)

    biome_summary: list[bpy.types.Collection] = []

    def _add_kit(prop_id: str, mesh: bpy.types.Mesh, materials: list[bpy.types.Material],
                 catalog_path: str, description: str, tags: list[str],
                 emissive_face_indices: list[int] | None = None) -> bpy.types.Collection:
        """Helper: build a prop collection from a finished mesh, mark
        it as an Asset, flag it as a scatter source, and slot it under
        the biome kit's catalog path. `emissive_face_indices` (optional)
        promotes the listed face indices to material slot 1 — used by
        builders whose mesh stamps an emissive surface via face index."""
        coll = _make_prop_collection(
            prop_id, mesh, None, materials,
            position=PROP_POSITIONS[prop_id],
        )
        if emissive_face_indices:
            for fi in emissive_face_indices:
                if 0 <= fi < len(mesh.polygons):
                    mesh.polygons[fi].material_index = 1
        _mark_collection_asset(
            coll,
            catalog_path=catalog_path,
            description=description,
            tags=tags,
        )
        coll["scatter_source"] = True
        biome_summary.append(coll)
        summary[prop_id.removeprefix("prop_")] = {"verts": len(mesh.vertices)}
        return coll

    # Urban kit ────────────────────────────────────────────────────
    _add_kit("prop_lamp_post",
             build_lamp_post_mesh("prop_lamp_post_mesh"),
             [urban_metal_mat, urban_lamp_mat],
             "Hoverbike/Track Props/Urban",
             "Slim street-light pole + emissive lampshade. Reads as urban dressing at race speed.",
             ["urban", "lamp", "emissive", "scatterable"])

    _add_kit("prop_antenna_mast",
             build_antenna_mast_mesh("prop_antenna_mast_mesh"),
             [urban_metal_mat],
             "Hoverbike/Track Props/Urban",
             "Rooftop comm-tower lattice. Tall thin silhouette for skyline density.",
             ["urban", "antenna", "tall", "scatterable"])

    _add_kit("prop_vent_stack",
             build_vent_stack_mesh("prop_vent_stack_mesh"),
             [urban_metal_mat],
             "Hoverbike/Track Props/Urban",
             "Rooftop vent with mushroom cap. HVAC clutter for urban rooftops.",
             ["urban", "vent", "scatterable"])

    _add_kit("prop_ac_unit",
             build_ac_unit_mesh("prop_ac_unit_mesh"),
             [urban_metal_mat],
             "Hoverbike/Track Props/Urban",
             "Rooftop AC condenser unit. Boxy clutter — pairs with prop_vent_stack.",
             ["urban", "ac", "scatterable"])

    _add_kit("prop_signage_panel",
             build_signage_panel_mesh("prop_signage_panel_mesh"),
             [urban_sign_mat, urban_sign_emi_mat],
             "Hoverbike/Track Props/Urban",
             "Billboard / signage panel on stub posts. +Y face emissive for neon-lit feel.",
             ["urban", "signage", "emissive", "scatterable"])

    # Industrial kit ───────────────────────────────────────────────
    _add_kit("prop_container",
             build_container_mesh("prop_container_mesh"),
             [container_mat],
             "Hoverbike/Track Props/Industrial",
             "20-ft shipping container. Pairs with prop_oil_drum for harbour debris.",
             ["industrial", "container", "scatterable"])

    _add_kit("prop_oil_drum",
             build_oil_drum_mesh("prop_oil_drum_mesh"),
             [drum_mat],
             "Hoverbike/Track Props/Industrial",
             "55-gallon drum with rim bands. Small enough to scatter densely along docks.",
             ["industrial", "drum", "scatterable"])

    _add_kit("prop_mooring_bollard",
             build_mooring_bollard_mesh("prop_mooring_bollard_mesh"),
             [bollard_mat],
             "Hoverbike/Track Props/Industrial",
             "Dock mooring bollard. Reads as harbour at a glance.",
             ["industrial", "mooring", "harbor", "scatterable"])

    # Volcanic kit ─────────────────────────────────────────────────
    _add_kit("prop_basalt_boulder",
             build_basalt_boulder_mesh("prop_basalt_boulder_mesh"),
             [basalt_mat],
             "Hoverbike/Track Props/Volcanic",
             "Angular basalt boulder — beveled icosphere. Cooled-lava chunks for Kilauea.",
             ["volcanic", "rock", "scatterable"])

    _add_kit("prop_ash_heap",
             build_ash_heap_mesh("prop_ash_heap_mesh"),
             [ash_mat],
             "Hoverbike/Track Props/Volcanic",
             "Low ash drift mound. Pairs with prop_basalt_boulder for caldera floors.",
             ["volcanic", "ash", "scatterable"])

    _add_kit("prop_scorched_stump",
             build_scorched_stump_mesh("prop_scorched_stump_mesh"),
             [scorched_mat],
             "Hoverbike/Track Props/Volcanic",
             "Burned tree stump with jagged top. Adds vertical interest in volcanic flats.",
             ["volcanic", "stump", "scatterable"])

    # Jungle kit ───────────────────────────────────────────────────
    fern_mesh = build_fern_clump_mesh("prop_fern_clump_mesh")
    _add_kit("prop_fern_clump",
             fern_mesh,
             [fern_mat],
             "Hoverbike/Track Props/Jungle",
             "Ground fern cluster with sway gradient on COLOR_0.R. Foliage shader picks it up "
             "via the mat_foliage_* material name.",
             ["jungle", "foliage", "sway", "scatterable"])

    _add_kit("prop_mossy_boulder",
             build_mossy_boulder_mesh("prop_mossy_boulder_mesh"),
             [mossy_mat],
             "Hoverbike/Track Props/Jungle",
             "Mossy rounded boulder. Softer silhouette than the volcanic basalt boulder.",
             ["jungle", "rock", "scatterable"])

    _add_kit("prop_fallen_pillar",
             build_fallen_pillar_mesh("prop_fallen_pillar_mesh"),
             [pillar_mat],
             "Hoverbike/Track Props/Jungle",
             "Toppled stone column lying on its side. Broken end + intact end for variety.",
             ["jungle", "pillar", "ruin", "scatterable"])

    # Venetian kit ─────────────────────────────────────────────────
    _add_kit("prop_gondola",
             build_gondola_mesh("prop_gondola_mesh"),
             [gondola_mat],
             "Hoverbike/Track Props/Venetian",
             "Stylised gondola — flat-bottom canoe with upturned ferro prow. Sits at waterline.",
             ["venetian", "boat", "water", "scatterable"])

    _add_kit("prop_venetian_mooring",
             build_venetian_mooring_mesh("prop_venetian_mooring_mesh"),
             [venet_post_mat, venet_stripe_mat],
             "Hoverbike/Track Props/Venetian",
             "Venice palina (mooring post) — pale stake with mid-band stripe. Pairs with prop_gondola in canals.",
             ["venetian", "mooring", "water", "scatterable"])

    _add_kit("prop_canal_lantern",
             build_canal_lantern_mesh("prop_canal_lantern_mesh"),
             [lantern_iron_mat, lantern_lit_mat],
             "Hoverbike/Track Props/Venetian",
             "Wrought-iron canal lantern on a short stub. Four emissive glass panes for night Venice.",
             ["venetian", "lantern", "emissive", "scatterable"])

    _add_kit("prop_paving_slab",
             build_paving_slab_mesh("prop_paving_slab_mesh"),
             [paving_mat],
             "Hoverbike/Track Props/Venetian",
             "Broken Istrian-stone paving slab with one chipped corner. Canal-edge rubble dressing.",
             ["venetian", "paving", "rubble", "scatterable"])

    _add_kit("prop_ivy_patch",
             build_ivy_patch_mesh("prop_ivy_patch_mesh"),
             [ivy_mat],
             "Hoverbike/Track Props/Venetian",
             "Wall-clinging ivy cluster of flat leaf cards. Sway gradient stamped via mat_foliage_*.",
             ["venetian", "foliage", "sway", "scatterable"])

    # Waterpark kit ─────────────────────────────────────────────────
    _add_kit("prop_beach_ball",
             build_beach_ball_mesh("prop_beach_ball_mesh"),
             [beach_ball_mat],
             "Hoverbike/Track Props/Waterpark",
             "Low-poly beach ball. Bright single colour today; trim-sheet stripes in a later pass.",
             ["waterpark", "inflatable", "small", "scatterable"])

    _add_kit("prop_pool_noodle",
             build_pool_noodle_mesh("prop_pool_noodle_mesh"),
             [pool_noodle_mat],
             "Hoverbike/Track Props/Waterpark",
             "Foam pool noodle laid along +X. Bright plastic clutter for Aqualand lagoons.",
             ["waterpark", "noodle", "small", "scatterable"])

    _add_kit("prop_inflatable_ring",
             build_inflatable_ring_mesh("prop_inflatable_ring_mesh"),
             [ring_mat],
             "Hoverbike/Track Props/Waterpark",
             "Pool inflatable donut — coarse torus. Sits at the waterline.",
             ["waterpark", "inflatable", "scatterable"])

    _add_kit("prop_slide_piece",
             build_slide_piece_mesh("prop_slide_piece_mesh"),
             [slide_mat],
             "Hoverbike/Track Props/Waterpark",
             "Half-pipe waterslide segment — open U-channel. Broken-off Aqualand infrastructure.",
             ["waterpark", "slide", "structure", "scatterable"])

    _add_kit("prop_faded_sign",
             build_faded_sign_mesh("prop_faded_sign_mesh"),
             [faded_sign_mat],
             "Hoverbike/Track Props/Waterpark",
             "Crooked single-post billboard, no emission — pre-flood leftover signage.",
             ["waterpark", "signage", "scatterable"])

    # Open Sea kit ──────────────────────────────────────────────────
    _add_kit("prop_sea_stack",
             build_sea_stack_mesh("prop_sea_stack_mesh"),
             [sea_stack_mat],
             "Hoverbike/Track Props/Open Sea",
             "Tall eroded sea-stack rock pillar. Coastal landmark silhouette at distance.",
             ["open-sea", "rock", "tall", "scatterable"])

    _add_kit("prop_nav_marker",
             build_nav_marker_mesh("prop_nav_marker_mesh"),
             [nav_marker_body_mat, nav_marker_lit_mat],
             "Hoverbike/Track Props/Open Sea",
             "Channel-marker buoy with lit triangle topmark. Pairs with prop_buoy in open water.",
             ["open-sea", "buoy", "emissive", "scatterable"])

    _add_kit("prop_kelp_strand",
             build_kelp_strand_mesh("prop_kelp_strand_mesh"),
             [kelp_mat],
             "Hoverbike/Track Props/Open Sea",
             "Submerged kelp strand with vertical sway gradient. Scatter with z_max < 0 so it stays underwater.",
             ["open-sea", "foliage", "sway", "scatterable"])

    _add_kit("prop_foam_tuft",
             build_foam_tuft_mesh("prop_foam_tuft_mesh"),
             [foam_mat],
             "Hoverbike/Track Props/Open Sea",
             "Surface-foam tuft — flat disc near the waterline with a faint sway. Reads as wind-driven foam.",
             ["open-sea", "foam", "sway", "scatterable"])

    _add_kit("prop_gull_crag",
             build_gull_crag_mesh("prop_gull_crag_mesh"),
             [gull_crag_mat],
             "Hoverbike/Track Props/Open Sea",
             "Squat rocky outcrop — adds micro-relief between sea-stacks in open-water stretches.",
             ["open-sea", "rock", "scatterable"])

    # Mark the legacy collections + every Phase γ collection as scatter sources.
    for c in (rock_coll, palm_coll, buoy_coll, log_coll, gate_coll, ti_coll):
        c["scatter_source"] = True
    # Phase γ collections already get `scatter_source` inside `_add_kit`.

    # Author the HV_Scatter geometry-nodes graph the scatter-zone
    # operator + per-track seed scripts attach to a target mesh. Lives
    # in the props-library .blend so authors link the same graph from
    # every track .blend (rather than rebuilding it in each scene).
    build_scatter_group()
    # HV_BiomePalette — Proposal A scatter that auto-distributes props
    # per terrain biome by reading baked_biome / baked_path / baked_ao
    # off the terrain mesh. Shares the same props-library plumbing as
    # HV_Scatter so authors link one graph from every track .blend.
    build_biome_palette_group()
    # HV_StrokeScatter — Proposal C curve-bounded scatter. Authors draw
    # a Bezier curve; the graph builds a ribbon of width 2 × Width
    # along it and scatters instances across the ribbon area. Pairs
    # with the biome palette for "biome baseline + hand-drawn groves".
    build_stroke_scatter_group()

    return summary


# ────────────────────────────────────────────────────────────────────
# Preview thumbnails
# ────────────────────────────────────────────────────────────────────

def _generate_previews() -> None:
    """Trigger Blender's built-in preview render for each marked
    collection asset.

    Skipped in --background mode: Cycles' GPU-backed thumbnail render
    crashes nvoglv64.dll when run headless with an NVIDIA driver. In
    GUI mode the Asset Browser will render previews lazily on first
    view, which is enough — the seed only needs to ensure the
    catalogue and marks are in place."""
    if bpy.app.background:
        print("[seed-props] skipping preview render (headless mode); open the .blend in Blender to populate thumbnails")
        return
    for c in bpy.data.collections:
        if c.asset_data is None:
            continue
        try:
            with bpy.context.temp_override(id=c):
                bpy.ops.ed.lib_id_generate_preview()
        except Exception as e:  # noqa: BLE001
            print(f"[seed-props] preview gen failed for {c.name}: {e}")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[seed-props] writing catalogue → {CATALOG_PATH}")
    write_catalog_file()

    print(f"[seed-props] writing library → {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    summary = build_props()
    _generate_previews()

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    parts = ", ".join(f"{k}={v['verts']}v" for k, v in summary.items())
    print(f"[seed-props] done — {parts}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[seed-props] FAILED: {e}", file=sys.stderr)
        raise
