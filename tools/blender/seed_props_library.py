"""Seed ``tracks-src/props-library.blend`` — Asset-Browser-marked library
of procedural track props (Item 3 from docs/blender-wishlist.md).

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
    "Hoverbike/Track Props/Gates":     "11111111-1111-4111-8111-000000000013",
    "Hoverbike/Track Props/Indicators":"11111111-1111-4111-8111-000000000014",
}


# ────────────────────────────────────────────────────────────────────
# Catalogue file
# ────────────────────────────────────────────────────────────────────

def write_catalog_file() -> None:
    """Blender's catalogue spec: VERSION header, then ``<uuid>:<path>:<simple_name>``
    lines. Simple name = the leaf segment. Path uses ``/``."""
    lines = [
        "# This is an Asset Catalog Definition file for Blender.",
        "#",
        "# Empty lines and lines starting with `#` are ignored.",
        "# The first non-ignored line should be the version indicator.",
        "# Other lines are of the format \"UUID:catalog/path/for/assets:simple catalog name\"",
        "",
        "VERSION 1",
        "",
    ]
    for path, uid in CATALOG_UUIDS.items():
        simple = path.replace("/", "-")
        lines.append(f"{uid}:{path}:{simple}")
    os.makedirs(os.path.dirname(CATALOG_PATH), exist_ok=True)
    with open(CATALOG_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


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


def _make_prop_collection(name: str, mesh: bpy.types.Mesh, gn_group: bpy.types.NodeTree | None, materials: list[bpy.types.Material], *, gn_inputs: dict | None = None, position: tuple[float, float, float] = (0, 0, 0)) -> bpy.types.Collection:
    """Build the standard prop collection layout:

        Collection: prop_<id>
        ├── Empty: prop_<id>_root   (kind=prop, prop_id=<id>)
        │   └── Mesh:  prop_<id>_mesh  (GN modifier applied if group is given)

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
    "prop_gate":            (24.0, 0.0, 0.0),
    "prop_turn_indicator":  (60.0, 0.0, 0.0),
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
    buoy_mesh  = build_buoy_mesh("prop_buoy_mesh", radius=0.6, height=1.5)
    buoy_coll  = _make_prop_collection(
        "prop_buoy", buoy_mesh, None, [buoy_body_mat, buoy_top_mat],
        position=PROP_POSITIONS["prop_buoy"],
    )
    _mark_collection_asset(buoy_coll,
                            catalog_path="Hoverbike/Track Props/Buoys",
                            description="Marker buoy — pylon with emissive top. Static asset; bobbing animation lives at runtime via the water shader.",
                            tags=["buoy", "water", "emissive"])
    summary["buoy"] = {"verts": len(buoy_mesh.vertices)}

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

    # Mark every collection as a scatter source for Item 4's picker.
    for c in (rock_coll, palm_coll, buoy_coll, gate_coll, ti_coll):
        c["scatter_source"] = True

    # Author the HV_Scatter geometry-nodes graph the scatter-zone
    # operator + per-track seed scripts attach to a target mesh. Lives
    # in the props-library .blend so authors link the same graph from
    # every track .blend (rather than rebuilding it in each scene).
    build_scatter_group()

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
