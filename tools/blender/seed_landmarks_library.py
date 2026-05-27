"""Seed ``tracks-src/landmarks-library.blend`` — Asset-Browser-marked
library of recognisable landmark archetypes for caricature city tracks.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_landmarks_library.py

This is the sibling of ``seed_props_library.py`` — same scaffolding,
same Asset Browser flow, but for "distinctive city building" archetypes
rather than scatter props. Authors drag a collection from the Asset
Browser into a track .blend, scale to taste, and immediately have a
silhouette readable at race-pace viewing distance.

### What the seed produces

Originally eight Seattle-flavoured archetypes; Phase B of
``docs/v1-asset-pipeline-plan.md`` extends the set with seven more
archetypes that cover ten of the eleven v1 ship-track hero set-pieces.
Each ships as one or more collections marked as a Blender Asset under
the ``Hoverbike/Landmarks/<sub-category>`` catalogue:

| Collection                              | Sub-category | Inspiration                          | Default scale |
|-----------------------------------------|--------------|--------------------------------------|---------------|
| ``landmark_tower_spire``                | Spires       | Space Needle                         | 184 m tall    |
| ``landmark_tower_stepped``              | Towers       | Columbia Center                      | 180 m tall    |
| ``landmark_tower_pyramid_cap``          | Towers       | Smith Tower                          | 90 m tall     |
| ``landmark_stadium_arched``             | Stadiums     | Lumen Field / T-Mobile               | ~50 m × 110 m |
| ``landmark_wheel_ferris``               | Wheels       | Great Wheel / London Eye             | 50 m diameter |
| ``landmark_industrial_cluster``         | Industrial   | Gas Works Park                       | ~45 m × 25 m  |
| ``landmark_sign_arch``                  | Signage      | Pike Place arch + clock              | 8 m × 8 m     |
| ``landmark_mountain_cone``              | Backdrops    | Mt Rainier (snow-capped)             | ~840 m × 420 m|
| ``landmark_tower_cylinder_spiral``      | Towers       | Hatteras lighthouse / Campanile      | 60 m tall     |
| ``landmark_arch_ruin``                  | Ruins        | The Maw, Rialto, Liberty torch arm   | 60 m span     |
| ``landmark_drowned_facade_art_deco``    | Facades      | South Beach Art Deco hotels          | 30 m × 12 m   |
| ``landmark_drowned_facade_tokyo``       | Facades      | Shibuya skyscraper tops              | 24 m × 80 m   |
| ``landmark_drowned_facade_venice``      | Facades      | Doge's Palace / Venice palazzi       | 40 m × 18 m   |
| ``landmark_drowned_facade_nyc``         | Facades      | Manhattan rooftops                   | 30 m × 90 m   |
| ``landmark_glass_tank_broken``          | Tanks        | Two Oceans Aquarium / Shibuya glass  | 20 m × 14 m × 10 m |
| ``landmark_mechanical_rig``             | Mechanical   | Marina Bay gantry crane / Liberty torch | 40 m tall  |
| ``landmark_carved_face_block``          | Reliefs      | Bayon smiling faces                  | 6 m cube      |
| ``landmark_lava_river_strip``           | Lava         | Kilauea lava waterfall channel       | 60 m × 4 m    |

### Phase B archetypes — design notes

- **drowned_facade ships as four collections, not one with a style
  enum.** Each style has its own palette, signage pattern, and window
  grid; authors get distinct preview thumbnails in the Asset Browser
  and drag the right style without thinking about a custom property.
  Same shared shader family (``mat_facade_*``) keeps the colour-swap
  story intact.
- **mechanical_rig** carries swing-period metadata on its parented
  swing-arm child (``swing_period_s``, ``swing_amplitude_deg``,
  ``swing_axis``) as custom properties. The runtime won't animate it
  automatically yet — that's a follow-up — but the metadata ships so
  future animation code can read it without re-authoring.
- **lava_river_strip** writes ``COLOR_0.R`` = emissive multiplier
  (per the vertex-attribute spec, R is "sway" for foliage but free for
  non-foliage). The runtime lava shader (when written) is expected to
  read R as a hot-channel mask along the river centreline.

### v1 trade-off — baked geometry, no GN modifiers

Unlike the prop library, these ship as **baked bmesh** rather than
Geometry Nodes-modified single-vertex bases. The decision is
explicit: a dozen+ full GN graphs would have eaten an entire authoring
session, and the realistic 90% use case is "drag, scale to taste,
move on." Authors who need a 250 m skyscraper instead of 180 m just
scale the Z by 1.4×; per-knob parameterisation can land in a future
pass without breaking the file layout (the asset is still a
collection of one mesh object, just with a GN modifier added).

Materials follow the runtime convention (``mat_landmark_*``) and are
shared across archetypes where the colour story is the same — every
"city concrete" tower references the same ``mat_landmark_concrete``
so an in-engine palette swap touches one slot, not eight.

### Asset Browser catalogue

Writes its own ``blender_assets.cats.txt`` UUID rows alongside the
prop-library ones (Blender's catalogue file is shared between every
.blend in a folder, so additive entries don't conflict). Open the
.blend once after a re-seed to populate per-collection thumbnails.
"""

from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.blender.vertex_attrs import (  # noqa: E402
    DEFAULT_TERRAIN,
    set_color_attr,
    set_constant,
)

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")
SHOWCASE_OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "landmarks-showcase.blend")
CATALOG_PATH = os.path.join(REPO_ROOT, "tracks-src", "blender_assets.cats.txt")
CATALOG_ROOT = "Hoverbike/Landmarks"

# UUIDs reserved at 22222222-* so they don't clash with the prop
# library's 11111111-* range. Deterministic so re-seeds produce a
# stable catalogue file (Asset Browser keys on UUID, not path).
CATALOG_UUIDS = {
    "Hoverbike":                          "11111111-1111-4111-8111-000000000001",
    "Hoverbike/Landmarks":                "22222222-2222-4222-8222-000000000001",
    "Hoverbike/Landmarks/Spires":         "22222222-2222-4222-8222-000000000010",
    "Hoverbike/Landmarks/Towers":         "22222222-2222-4222-8222-000000000011",
    "Hoverbike/Landmarks/Stadiums":       "22222222-2222-4222-8222-000000000012",
    "Hoverbike/Landmarks/Wheels":         "22222222-2222-4222-8222-000000000013",
    "Hoverbike/Landmarks/Industrial":     "22222222-2222-4222-8222-000000000014",
    "Hoverbike/Landmarks/Signage":        "22222222-2222-4222-8222-000000000015",
    "Hoverbike/Landmarks/Backdrops":      "22222222-2222-4222-8222-000000000016",
    # Phase B sub-catalogues — keep numeric IDs contiguous so a future
    # grep can see the family at a glance.
    "Hoverbike/Landmarks/Ruins":          "22222222-2222-4222-8222-000000000017",
    "Hoverbike/Landmarks/Facades":        "22222222-2222-4222-8222-000000000018",
    "Hoverbike/Landmarks/Tanks":          "22222222-2222-4222-8222-000000000019",
    "Hoverbike/Landmarks/Mechanical":     "22222222-2222-4222-8222-00000000001a",
    "Hoverbike/Landmarks/Reliefs":        "22222222-2222-4222-8222-00000000001b",
    "Hoverbike/Landmarks/Lava":           "22222222-2222-4222-8222-00000000001c",
}

# Layout for the saved .blend's viewport — spread landmarks in a row
# so an author opening the library file can see them all at once.
LAYOUT = {
    # Row 0 — original Seattle archetypes.
    "landmark_tower_spire":               (    0.0,   0.0, 0.0),
    "landmark_tower_stepped":             (   60.0,   0.0, 0.0),
    "landmark_tower_pyramid_cap":         (  120.0,   0.0, 0.0),
    "landmark_stadium_arched":            (  220.0,   0.0, 0.0),
    "landmark_wheel_ferris":              (  340.0,   0.0, 0.0),
    "landmark_industrial_cluster":        (  410.0,   0.0, 0.0),
    "landmark_sign_arch":                 (  480.0,   0.0, 0.0),
    "landmark_mountain_cone":             ( 1000.0,   0.0, 0.0),
    # Row 1 — Phase B archetypes, 200 m south so a tilted overview
    # camera sees them in a second band.
    "landmark_tower_cylinder_spiral":     (    0.0, 200.0, 0.0),
    "landmark_arch_ruin":                 (   80.0, 200.0, 0.0),
    "landmark_drowned_facade_art_deco":   (  170.0, 200.0, 0.0),
    "landmark_drowned_facade_tokyo":      (  230.0, 200.0, 0.0),
    "landmark_drowned_facade_venice":     (  300.0, 200.0, 0.0),
    "landmark_drowned_facade_nyc":        (  370.0, 200.0, 0.0),
    "landmark_glass_tank_broken":         (  450.0, 200.0, 0.0),
    "landmark_mechanical_rig":            (  520.0, 200.0, 0.0),
    "landmark_carved_face_block":         (  600.0, 200.0, 0.0),
    "landmark_lava_river_strip":          (  670.0, 200.0, 0.0),
    # Trim-sheet variants — single-material landmarks UV-mapped onto
    # the biome's shared trim sheet. New row 2 so they stack below the
    # legacy multi-slot facades in the .blend viewport.
    "landmark_drowned_facade_tokyo_trim": (  230.0, 400.0, 0.0),
}


# ────────────────────────────────────────────────────────────────────
# Catalogue file — merge with prop library entries
# ────────────────────────────────────────────────────────────────────

def write_catalog_file() -> None:
    """Merge landmark catalogue rows into the shared
    ``tracks-src/blender_assets.cats.txt``. Delegates to the shared
    helper; see ``blender_assets_catalog.merge_catalog_file``."""
    from tools.blender.blender_assets_catalog import merge_catalog_file

    merge_catalog_file(CATALOG_PATH, CATALOG_UUIDS)


# ────────────────────────────────────────────────────────────────────
# Materials
# ────────────────────────────────────────────────────────────────────

def _hex(c, gamma=2.2):
    s = c.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** gamma, g ** gamma, b ** gamma, 1.0)


def make_material(name: str, base_color_hex: str, *, roughness: float = 0.7,
                  emission_hex: str | None = None, emission_strength: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = _hex(base_color_hex)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if emission_hex:
            em = bsdf.inputs.get("Emission Color")
            es = bsdf.inputs.get("Emission Strength")
            if em is not None:
                em.default_value = _hex(emission_hex)
            if es is not None:
                es.default_value = emission_strength
    return mat


def make_trim_sheet_material(name: str, image_path: str, *, roughness: float = 0.55) -> bpy.types.Material:
    """Build a Principled BSDF whose Base Color is sourced from a trim
    sheet texture on disk. Used by trim-sheet-enabled landmarks (see
    ``build_drowned_facade_trimmed_mesh``) so a single material covers
    every face of every facade in the biome — geometry just UV-maps onto
    the strip it wants.

    If the texture file is missing (e.g. the user hasn't run
    ``pnpm gen:trim-sheets`` yet), the material falls back to a flat
    grey so the seed still produces a working .blend."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat
    # Idempotent: only inject the Image Texture node once per material.
    tex_node = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeTexImage"), None)
    if tex_node is None:
        tex_node = nt.nodes.new("ShaderNodeTexImage")
        tex_node.location = (bsdf.location.x - 360, bsdf.location.y)
        nt.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    if os.path.isfile(image_path):
        try:
            img = bpy.data.images.load(image_path, check_existing=True)
            img.colorspace_settings.name = "sRGB"
            tex_node.image = img
        except Exception as e:  # noqa: BLE001
            print(f"[trim-sheet] failed to load {image_path}: {e}")
    else:
        # No texture on disk yet — leave Base Color as the bound flat
        # grey so the seed still completes and the GLB is valid.
        print(f"[trim-sheet] {image_path} missing; using grey fallback. "
              f"Run `pnpm gen:trim-sheets` and re-seed to pick up the texture.")
        bsdf.inputs["Base Color"].default_value = _hex("#a8a8ac")
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    return mat


# ────────────────────────────────────────────────────────────────────
# bmesh helpers — small wrappers that keep the per-archetype build
# functions short and readable.
# ────────────────────────────────────────────────────────────────────

def _append_box(bm: bmesh.types.BMesh, *, sx: float, sy: float, sz: float,
                tx: float = 0, ty: float = 0, tz: float = 0,
                material_index: int = 0) -> None:
    """Append a box of dimensions (sx, sy, sz) centred at (tx, ty, tz)
    to ``bm``. Optionally tags every appended face with ``material_index``
    so callers can multi-material their meshes without post-pass face
    walks."""
    pre_face_count = len(bm.faces)
    bmesh.ops.create_cube(bm, size=1.0)
    new_faces = [f for f in bm.faces[pre_face_count:]]
    new_verts = list({v for f in new_faces for v in f.verts})
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=new_verts)
    bmesh.ops.translate(bm, vec=(tx, ty, tz), verts=new_verts)
    for f in new_faces:
        f.material_index = material_index


def _append_cone(bm: bmesh.types.BMesh, *, segments: int, r_base: float,
                 r_top: float, depth: float, tx: float = 0, ty: float = 0,
                 tz: float = 0, material_index: int = 0,
                 axis: str = "Z") -> None:
    """Append a cone (use r_base == r_top for a cylinder) along the
    given axis. ``axis="Z"`` matches Blender's default; ``axis="Y"`` /
    ``axis="X"`` rotate the cone into the horizontal plane (useful for
    stadium arches, ferris-wheel spokes)."""
    pre_face_count = len(bm.faces)
    bmesh.ops.create_cone(
        bm, segments=segments, radius1=r_base, radius2=r_top,
        depth=depth, cap_ends=True,
    )
    new_faces = [f for f in bm.faces[pre_face_count:]]
    new_verts = list({v for f in new_faces for v in f.verts})
    if axis == "Y":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 4, "X"), verts=new_verts)
    elif axis == "X":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 4, "Y"), verts=new_verts)
    bmesh.ops.translate(bm, vec=(tx, ty, tz), verts=new_verts)
    for f in new_faces:
        f.material_index = material_index


def _finalise(bm: bmesh.types.BMesh, mesh_name: str, *,
              smooth: bool = False) -> bpy.types.Mesh:
    me = bpy.data.meshes.new(mesh_name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return me


# ────────────────────────────────────────────────────────────────────
# Archetype builders — one bmesh per landmark
# ────────────────────────────────────────────────────────────────────

def build_tower_spire_mesh(name: str) -> bpy.types.Mesh:
    """Space Needle archetype. Slender central pillar + three splaying
    legs + flying-saucer observation disc + crowning spire. Default
    sized at 184 m so a 1× scale matches the real Space Needle."""
    bm = bmesh.new()
    # Central pillar (slim cylinder) up to the disc.
    _append_cone(bm, segments=24, r_base=2.2, r_top=2.2, depth=118, tz=59)
    # Three splayed legs at the base (boxy struts angled outward).
    for ang in (0.0, 2.094, 4.189):
        leg_bm = bmesh.new()
        bmesh.ops.create_cube(leg_bm, size=1.0)
        bmesh.ops.scale(leg_bm, vec=(1.4, 1.4, 70), verts=leg_bm.verts)
        # Tilt outward, then translate so the foot is at the ground.
        ax, ay = math.cos(ang), math.sin(ang)
        bmesh.ops.rotate(leg_bm, matrix=Matrix.Rotation(0.18, 4, (-ay, ax, 0)), verts=leg_bm.verts)
        bmesh.ops.translate(leg_bm, vec=(ax * 8, ay * 8, 35), verts=leg_bm.verts)
        tmp = bpy.data.meshes.new("_tmp_leg")
        leg_bm.to_mesh(tmp); leg_bm.free()
        bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    # Observation disc — three flat cones stacked to form the saucer.
    _append_cone(bm, segments=32, r_base=18, r_top=24, depth=4, tz=116)
    _append_cone(bm, segments=32, r_base=24, r_top=20, depth=3, tz=119)
    _append_cone(bm, segments=32, r_base=20, r_top=14, depth=4, tz=122)
    # Crowning spire.
    _append_cone(bm, segments=12, r_base=2.0, r_top=0.2, depth=30, tz=139)
    return _finalise(bm, name, smooth=True)


def build_tower_stepped_mesh(name: str) -> bpy.types.Mesh:
    """Columbia Center archetype. Five tapered cube tiers stacked into
    a stepped silhouette. Default ~180 m tall, ~22 m × 22 m at the
    base. Scale Z for shorter / taller downtown anchors."""
    bm = bmesh.new()
    # (z_centre, half-width-x, half-width-y, half-height) per tier.
    tiers = [
        (  4.0, 22.0, 22.0, 4.0),
        ( 44.0, 22.0, 18.0, 4.0),
        ( 94.0, 18.0, 14.0, 4.0),
        (144.0, 14.0, 10.0, 4.0),
        (184.0, 10.0, 10.0, 4.0),
    ]
    for tz, hx, hy, hz in tiers:
        _append_box(bm, sx=hx * 2, sy=hy * 2, sz=hz * 2 + 36, tz=tz + 18)
    return _finalise(bm, name)


def build_tower_pyramid_cap_mesh(name: str) -> bpy.types.Mesh:
    """Smith Tower archetype. Square body + setback step + four-sided
    pyramid cap. Default ~90 m tall — shorter than the modern towers,
    which is the point (it's the historic landmark)."""
    bm = bmesh.new()
    _append_box(bm, sx=28, sy=28, sz=60, tz=30)
    _append_box(bm, sx=20, sy=20, sz=14, tz=67)
    # Pyramid: 4-sided cone rotated 45° so the corners point outward.
    pre_face_count = len(bm.faces)
    bmesh.ops.create_cone(bm, segments=4, radius1=10, radius2=0.3, depth=16, cap_ends=True)
    new_verts = list({v for f in bm.faces[pre_face_count:] for v in f.verts})
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(45), 4, "Z"), verts=new_verts)
    bmesh.ops.translate(bm, vec=(0, 0, 82), verts=new_verts)
    return _finalise(bm, name)


def build_stadium_arched_mesh(name: str) -> bpy.types.Mesh:
    """Stadium archetype — oval bowl + two transverse arches over the
    top. Default footprint ~50 m × 110 m (Lumen Field scale). The
    arches bend by sinusoidal Z displacement so they read as roof
    structure rather than as straight bars."""
    bm = bmesh.new()
    # Bowl — short cone, then squish along X for the oval footprint.
    pre = len(bm.faces)
    bmesh.ops.create_cone(bm, segments=24, radius1=42, radius2=44,
                          depth=14, cap_ends=True)
    bowl_verts = list({v for f in bm.faces[pre:] for v in f.verts})
    bmesh.ops.scale(bm, vec=(1.2, 1.0, 1.0), verts=bowl_verts)
    bmesh.ops.translate(bm, vec=(0, 0, 7), verts=bowl_verts)
    # Two arches over the bowl (north + south ribs).
    for arch_y in (-12, 12):
        arch_bm = bmesh.new()
        bmesh.ops.create_cone(arch_bm, segments=24, radius1=1.5,
                              radius2=1.5, depth=110, cap_ends=True)
        bmesh.ops.rotate(arch_bm, matrix=Matrix.Rotation(math.radians(90), 4, "Y"),
                         verts=arch_bm.verts)
        # Bend the bar into an arch by Z = sin(t*π) profile.
        for v in arch_bm.verts:
            t = (v.co.x + 55) / 110
            v.co.z += 36 * math.sin(math.pi * t)
            v.co.y += arch_y
        tmp = bpy.data.meshes.new("_tmp_arch")
        arch_bm.to_mesh(tmp); arch_bm.free()
        bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    return _finalise(bm, name)


def build_wheel_ferris_mesh(name: str) -> bpy.types.Mesh:
    """Ferris wheel archetype — torus rim + N radial spokes + central
    hub + support pylon. Vertical wheel (axis along world +X) so it
    reads as a Great-Wheel silhouette from the south-approach camera.
    Default 50 m diameter, 8 spokes, 28 m centre height."""
    bm = bmesh.new()
    R = 25.0       # rim major radius
    minor = 0.5    # rim minor radius
    spokes = 8
    cz = 28.0      # centre height above ground
    # Build a torus using bmesh.ops, oriented along Y axis (vertical wheel facing south).
    pre = len(bm.faces)
    bmesh.ops.create_circle(bm, segments=24, radius=R, cap_ends=False)
    # Now extrude into a square cross-section; simplest path is to add a
    # torus via add_torus operator-free using bmesh.ops.
    # Actually use bmesh.ops to build a proper torus.
    bm.free()
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=4, v_segments=4, radius=0.001)
    # Fallback: hand-roll the torus.
    ring_segments = 32
    tube_segments = 8
    torus_verts: list[list[bmesh.types.BMVert]] = []
    for i in range(ring_segments):
        ang = (i / ring_segments) * math.tau
        ring = []
        for j in range(tube_segments):
            phi = (j / tube_segments) * math.tau
            rim_x = (R + minor * math.cos(phi)) * math.cos(ang)
            rim_y = (R + minor * math.cos(phi)) * math.sin(ang)
            rim_z = minor * math.sin(phi)
            ring.append(bm.verts.new((rim_x, rim_y, rim_z)))
        torus_verts.append(ring)
    bm.verts.ensure_lookup_table()
    for i in range(ring_segments):
        nxt = (i + 1) % ring_segments
        for j in range(tube_segments):
            nj = (j + 1) % tube_segments
            v00 = torus_verts[i][j]; v10 = torus_verts[nxt][j]
            v11 = torus_verts[nxt][nj]; v01 = torus_verts[i][nj]
            bm.faces.new((v00, v10, v11, v01))
    # Reorient: torus is in the XY plane; rotate so it stands vertical
    # (axis along X, plane in YZ).
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 4, "X"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, cz), verts=bm.verts)
    # Central hub.
    _append_cone(bm, segments=16, r_base=2.0, r_top=2.0, depth=2.0,
                 tz=cz, axis="X")
    # Spokes — thin cylinders radiating from hub to rim.
    for i in range(spokes):
        ang = (i / spokes) * math.pi  # only half — wheels visually have spokes both ways already
        sk_bm = bmesh.new()
        bmesh.ops.create_cone(sk_bm, segments=8, radius1=0.12, radius2=0.12,
                              depth=R * 2, cap_ends=True)
        # Rotate spoke to align: along world Y axis at angle `ang` in YZ plane
        bmesh.ops.rotate(sk_bm,
                         matrix=Matrix.Rotation(ang, 4, "X"),
                         verts=sk_bm.verts)
        bmesh.ops.translate(sk_bm, vec=(0, 0, cz), verts=sk_bm.verts)
        tmp = bpy.data.meshes.new("_tmp_spoke")
        sk_bm.to_mesh(tmp); sk_bm.free()
        bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    # Support pylon (Y-axis A-frame, simplified to a single thick column).
    _append_box(bm, sx=3, sy=3, sz=cz, tz=cz / 2)
    return _finalise(bm, name)


def build_industrial_cluster_mesh(name: str) -> bpy.types.Mesh:
    """Gas-Works archetype — four large tanks side-by-side, three
    transverse pipework cylinders bridging them, plus a tall offset
    smokestack. ~45 m east-west, 25 m north-south, 30 m max height."""
    bm = bmesh.new()
    tanks = [(-18, 0, 6.0, 22), (-6, 0, 5.0, 18),
             ( 6, 0, 5.5, 24), (18, 0, 6.5, 20)]
    for dx, dy, r, h in tanks:
        _append_cone(bm, segments=16, r_base=r, r_top=r, depth=h,
                     tx=dx, ty=dy, tz=h / 2)
    # Cross pipework — 3 horizontal cylinders connecting tank tops.
    for i in range(3):
        _append_cone(bm, segments=10, r_base=0.9, r_top=0.9,
                     depth=14.0, tx=-12 + i * 12, ty=0, tz=19, axis="X")
    # Smokestack — tall slim cylinder, offset so it doesn't sit on top of a tank.
    _append_cone(bm, segments=14, r_base=2.5, r_top=2.5, depth=34,
                 tx=-4, ty=8, tz=17)
    return _finalise(bm, name)


def build_sign_arch_mesh(name: str) -> bpy.types.Mesh:
    """Pike-Place archetype — short vertical sign pillar + horizontal
    banner + circular clock face. Reads as a "Welcome to <X>" gateway
    at race speed; authors can rotate it 90° around Z to convert into
    a side-of-road gantry."""
    bm = bmesh.new()
    # Vertical sign panel (slot 1, red, for the iconic Public Market script).
    _append_box(bm, sx=0.4, sy=8, sz=8, tz=14, material_index=1)
    # Horizontal banner above (slot 1).
    _append_box(bm, sx=8, sy=0.4, sz=2, tz=19, material_index=1)
    # Clock face (white, slot 0) — disc on the y-facing side.
    pre = len(bm.faces)
    bmesh.ops.create_cone(bm, segments=24, radius1=3, radius2=3,
                          depth=0.8, cap_ends=True)
    clock_verts = list({v for f in bm.faces[pre:] for v in f.verts})
    bmesh.ops.rotate(bm,
                     matrix=Matrix.Rotation(math.radians(90), 4, "X"),
                     verts=clock_verts)
    bmesh.ops.translate(bm, vec=(0, -1, 12), verts=clock_verts)
    # Tag the clock-face poly group with material 0 (white).
    for v in clock_verts:
        for f in v.link_faces:
            f.material_index = 0
    return _finalise(bm, name)


def build_mountain_cone_mesh(name: str) -> bpy.types.Mesh:
    """Mt-Rainier-style backdrop cone. Massive — placed at distance,
    not for race-track use. Snow-cap face slot kept separate so the
    in-engine material can swap to a flat snow tint above z > 50%."""
    bm = bmesh.new()
    _append_cone(bm, segments=48, r_base=420, r_top=20, depth=420,
                 tz=210)
    return _finalise(bm, name, smooth=True)


# ────────────────────────────────────────────────────────────────────
# Phase B builders — v1 hero-set-piece archetypes
# ────────────────────────────────────────────────────────────────────

def build_tower_cylinder_spiral_mesh(name: str, *,
                                     height: float = 60.0,
                                     r_base: float = 4.5,
                                     r_cap: float = 3.8,
                                     stripe_pattern: str = "spiral",
                                     aperture: bool = True) -> bpy.types.Mesh:
    """Cylindrical-shaft tower with stripe-tagged faces and an optional
    open lamp room / belfry at the top.

    Drives Hatteras lighthouse (spiral), Doge's Campanile (checker /
    plain brick with belfry aperture), Angkor central spire (criss-cross
    stone), and the Cocoon Tower face (criss-cross). Stripe pattern is
    encoded by face material index so the runtime can pick from a
    palette per instance via material overrides — no per-instance
    re-meshing.

    Args:
        height:   shaft height (m).
        r_base:   base radius (m). r_cap < r_base gives a subtle taper.
        r_cap:    radius at the lamp-room level.
        stripe_pattern: 'spiral' (Hatteras), 'checker' (Campanile),
            'criss_cross' (Cocoon / Angkor), or 'plain' (untagged).
        aperture: if True, the top adds a wider observation gallery
            ring (lamp room) plus a smaller cap. If False, the shaft
            terminates in a flat disc — useful for chimney-style towers.

    Material slots when stripe is set:
        0 = base/concrete shaft (mat_landmark_concrete)
        1 = stripe / accent (mat_landmark_stripe)
        2 = aperture frame (mat_landmark_steel)
    Authors free to remap slot 2 to a coloured glass per instance.
    """
    bm = bmesh.new()
    segs = 24
    rings = 16

    # Build the shaft as a stack of rings so we can tag faces by ring/seg.
    ring_verts: list[list[bmesh.types.BMVert]] = []
    for ri in range(rings + 1):
        t = ri / rings
        z = t * height
        r = r_base * (1.0 - t) + r_cap * t
        ring = []
        for si in range(segs):
            ang = (si / segs) * math.tau
            ring.append(bm.verts.new((math.cos(ang) * r, math.sin(ang) * r, z)))
        ring_verts.append(ring)
    bm.verts.ensure_lookup_table()

    def _stripe_mat_idx(ri: int, si: int) -> int:
        if stripe_pattern == "spiral":
            # Six bands diagonally — phase shift segment by ring/3.
            return 1 if ((si + ri // 3) % 6) < 3 else 0
        if stripe_pattern == "checker":
            return 1 if ((ri // 2 + si // 2) % 2) == 0 else 0
        if stripe_pattern == "criss_cross":
            # A grid: every 2nd ring AND every 4th seg alternates.
            return 1 if ((ri % 4 == 0) ^ (si % 4 == 0)) else 0
        return 0

    for ri in range(rings):
        cur = ring_verts[ri]
        nxt = ring_verts[ri + 1]
        for si in range(segs):
            sn = (si + 1) % segs
            f = bm.faces.new([cur[si], cur[sn], nxt[sn], nxt[si]])
            f.material_index = _stripe_mat_idx(ri, si)

    # Cap the base with a disc (closed, helps with shadowing).
    bm.faces.new(ring_verts[0][::-1])

    if aperture:
        # Lamp-room / belfry: wider overhang ring above the shaft,
        # a tall thin-walled ring tagged as the aperture frame, capped
        # by a smaller dome-like cone.
        gallery_r = r_cap * 1.35
        gallery_h = 1.6
        # Pre-record face counts so we can tag the new geometry.
        pre = len(bm.faces)
        _append_cone(bm, segments=segs, r_base=gallery_r, r_top=gallery_r,
                     depth=gallery_h, tz=height + gallery_h / 2,
                     material_index=2)
        # Lamp-room cylinder (the aperture window band).
        _append_cone(bm, segments=segs, r_base=r_cap * 1.05, r_top=r_cap * 1.05,
                     depth=3.0, tz=height + gallery_h + 1.5,
                     material_index=2)
        # Cap (dome approximated as a low cone).
        _append_cone(bm, segments=segs, r_base=r_cap * 1.15, r_top=0.2,
                     depth=3.5, tz=height + gallery_h + 4.5,
                     material_index=2)
        _ = pre  # silence linters; bounding marker only.
    else:
        # Flat cap.
        bm.faces.new(ring_verts[-1])

    me = _finalise(bm, name, smooth=False)
    return me


def build_arch_ruin_mesh(name: str, *,
                         span: float = 60.0,
                         rise: float = 22.0,
                         thickness: float = 4.5,
                         decay: float = 0.35,
                         segments: int = 18,
                         seed: int = 7) -> bpy.types.Mesh:
    """Half-circle arch with chipped, decayed edges.

    Drives the three Maw arches (scale span 30-80 m), Rialto Bridge
    arch (span ~30 m, low rise), the Two Oceans Aquarium roof remnant,
    Hatteras lamp room remnant, and Liberty's broken torch arm (used
    at smaller scale, span ~8 m). The arch sits in the XZ plane with
    the opening facing +Y; rotate around Z when placing.

    Args:
        span:       horizontal extent foot-to-foot (m).
        rise:       interior height of the arch crown (m).
        thickness:  depth of the arch along Y (m).
        decay:      0..1 — vertex jitter amplitude as a fraction of
                    ``thickness``. Higher = more ruined / chipped.
        segments:   subdivision of the curve. Even number recommended.
        seed:       per-instance noise seed; same value re-runs are
                    deterministic across re-seeds.
    """
    bm = bmesh.new()
    # Sweep a 4-vert cross-section along a half-circle from foot to
    # foot. The two outer faces (along arch length) are the visible
    # top + back; the inner face is what races pass *under*.
    rng = _det_rng(seed)
    half = span * 0.5

    cross_rings: list[list[bmesh.types.BMVert]] = []
    for i in range(segments + 1):
        t = i / segments
        # Half-circle param: theta = π·t, 0 = +X foot, π = -X foot.
        theta = math.pi * t
        # Arch centreline: x = half·cos(θ), z = rise·sin(θ).
        cx = half * math.cos(theta)
        cz = rise * math.sin(theta)
        # Outward radial direction (away from arch interior).
        rx = math.cos(theta)
        rz = math.sin(theta)
        half_thick = thickness * 0.5
        # 4 verts: ordered around the cross-section, CCW looking down +X.
        #   0: outer-front (+r, -y)
        #   1: outer-back  (+r, +y)
        #   2: inner-back  (-r, +y)
        #   3: inner-front (-r, -y)
        verts4 = []
        for (sr, sy) in ((1, -1), (1, 1), (-1, 1), (-1, -1)):
            jitter_r = (rng() - 0.5) * decay * thickness * 0.6
            jitter_y = (rng() - 0.5) * decay * thickness * 0.3
            x = cx + rx * (sr * half_thick + jitter_r)
            z = cz + rz * (sr * half_thick + jitter_r)
            y = sy * half_thick + jitter_y
            verts4.append(bm.verts.new((x, y, z)))
        cross_rings.append(verts4)

    # Bridge adjacent cross-rings into 4 quad strips (top/back/bottom/
    # front). This is a sweep, no triangulation needed.
    for i in range(segments):
        a = cross_rings[i]
        b = cross_rings[i + 1]
        # outer face (between 0 and 1 of each ring)
        bm.faces.new([a[0], a[1], b[1], b[0]])
        # back face (between 1 and 2)
        bm.faces.new([a[1], a[2], b[2], b[1]])
        # inner face (between 2 and 3)
        bm.faces.new([a[2], a[3], b[3], b[2]])
        # front face (between 3 and 0)
        bm.faces.new([a[3], a[0], b[0], b[3]])

    # Cap the two arch feet so the arch doesn't look hollow at the base.
    bm.faces.new(cross_rings[0])
    bm.faces.new(cross_rings[-1][::-1])

    me = _finalise(bm, name, smooth=False)
    return me


def build_drowned_facade_mesh(name: str, *,
                              style: str,
                              width: float,
                              height: float,
                              depth: float = 3.0,
                              window_cols: int = 6,
                              window_rows: int = 4) -> bpy.types.Mesh:
    """Slab-with-windows facade for half-sunken buildings.

    Four styles, picked at call time:
        ``art_deco`` — short, wide, three-band horizontal stripe.
            South Beach hotel frontages. Window rows pulled into a
            mid-band; setback step at top.
        ``tokyo``   — tall, narrow, dense window grid. Shibuya
            skyscraper face. Top-band signage shelf for neon.
        ``venice``  — mid-rise, ornate top arches, narrow paired windows.
            Doge's Palace / palazzi.
        ``nyc``     — manhattan rooftop. Wide, mid-rise, water-tower
            cluster on the roof (procedural cylinders).

    The window grid is *recessed* — windows are inset boxes carved into
    the facade slab. We approximate the inset with a depth offset on
    each window vertex rather than a Boolean (cheaper, no risk of
    bad topology).
    """
    bm = bmesh.new()

    # Main slab — a box, width x depth x height, base at z=0.
    _append_box(bm, sx=width, sy=depth, sz=height, tz=height / 2)

    # Style-specific signage band.
    if style == "art_deco":
        # Horizontal accent band ~1/3 up the height (slot 1 = accent).
        band_h = height * 0.18
        band_z = height * 0.55
        _append_box(bm, sx=width + 0.4, sy=depth + 0.2, sz=band_h,
                    tz=band_z, material_index=1)
        # Setback step on top.
        _append_box(bm, sx=width * 0.7, sy=depth * 0.85, sz=1.4,
                    tz=height + 0.7, material_index=0)
    elif style == "tokyo":
        # Top-band signage shelf (slot 1 = emissive accent).
        _append_box(bm, sx=width + 0.6, sy=depth + 0.4, sz=2.0,
                    tz=height + 1.0, material_index=1)
        # Vertical signage strip on one face (kanji slot).
        _append_box(bm, sx=0.5, sy=depth * 0.4, sz=height * 0.6,
                    tx=width * 0.45, ty=depth * 0.5,
                    tz=height * 0.5, material_index=1)
    elif style == "venice":
        # Crown arcade — a row of small repeating arches at the top.
        arcade_z = height + 0.5
        spacing = width / max(1, (window_cols + 1))
        for i in range(window_cols):
            cx = -width / 2 + spacing * (i + 1)
            _append_box(bm, sx=spacing * 0.6, sy=depth * 0.7, sz=1.2,
                        tx=cx, tz=arcade_z, material_index=1)
        # Cornice band at top of slab.
        _append_box(bm, sx=width + 0.5, sy=depth + 0.3, sz=0.6,
                    tz=height - 0.3, material_index=1)
    elif style == "nyc":
        # Rooftop water-tower cluster — 2 small cylinders on stilts.
        for dx in (-width * 0.25, width * 0.2):
            # Stilt platform.
            _append_box(bm, sx=4.0, sy=4.0, sz=0.4,
                        tx=dx, tz=height + 0.2, material_index=0)
            # Tank.
            _append_cone(bm, segments=12, r_base=1.6, r_top=1.6,
                         depth=3.0, tx=dx, tz=height + 2.0,
                         material_index=1)
            # Conical roof.
            _append_cone(bm, segments=12, r_base=1.8, r_top=0.05,
                         depth=1.0, tx=dx, tz=height + 4.0,
                         material_index=1)
    else:
        raise ValueError(f"build_drowned_facade_mesh: unknown style {style!r}")

    # Window grid — small flush boxes on the +Y face (front), tagged
    # slot 2 = window glass. Inset by a tiny offset so they read
    # without z-fighting.
    win_w = (width / window_cols) * 0.55
    win_h = (height / window_rows) * 0.55
    win_thick = 0.15
    margin_x = width / window_cols / 2
    margin_z = height / window_rows / 2
    for ri in range(window_rows):
        for ci in range(window_cols):
            cx = -width / 2 + margin_x + (width / window_cols) * ci
            cz = margin_z + (height / window_rows) * ri
            _append_box(bm,
                        sx=win_w, sy=win_thick, sz=win_h,
                        tx=cx, ty=depth / 2 + 0.05, tz=cz,
                        material_index=2)
    # Mirror windows on the -Y face for two-sided facades.
    for ri in range(window_rows):
        for ci in range(window_cols):
            cx = -width / 2 + margin_x + (width / window_cols) * ci
            cz = margin_z + (height / window_rows) * ri
            _append_box(bm,
                        sx=win_w, sy=win_thick, sz=win_h,
                        tx=cx, ty=-depth / 2 - 0.05, tz=cz,
                        material_index=2)
    return _finalise(bm, name)


# ────────────────────────────────────────────────────────────────────
# Trim-sheet UV helpers
# ────────────────────────────────────────────────────────────────────
#
# A trim sheet (see tools/blender/build_trim_sheets.py) is a 1024×1024
# texture packed into 8 horizontal strips. The strip legend matches
# the Python builder:
#
#   0 (top)   windows
#   1         kanji / vertical signage
#   2         horizontal sign band
#   3         concrete weathering streak
#   4         brick / panel
#   5         neon glow
#   6         ledge / moulding
#   7 (bot)   flat dark base
#
# Blender V increases upward in UV space, image V increases downward.
# A strip index 0..7 occupies the V range [1 - (i+1)/8, 1 - i/8].

TRIM_STRIPS: tuple[str, ...] = (
    "windows", "kanji", "signage", "weathering",
    "brick", "neon", "ledge", "base",
)


def _trim_strip_v_range(strip_idx: int) -> tuple[float, float]:
    """Return (v_min, v_max) for the given strip on a Blender UV map."""
    i = max(0, min(7, int(strip_idx)))
    v_max = 1.0 - i / 8.0
    v_min = 1.0 - (i + 1) / 8.0
    return v_min, v_max


def _set_face_uvs_to_strip(bm: bmesh.types.BMesh, faces: list[bmesh.types.BMFace],
                            strip_idx: int, *, tile_u: float = 1.0,
                            u_offset: float = 0.0) -> None:
    """UV-map a set of faces onto a trim sheet strip. Each face gets the
    same V band; U wraps across `tile_u` repeats. Vertex order around
    the face is preserved — for a box face this means the texture
    appears un-rotated regardless of which cube side the face is on."""
    uv_layer = bm.loops.layers.uv.verify()
    v_min, v_max = _trim_strip_v_range(strip_idx)
    for face in faces:
        # Each face's loops walk its vertices in order. Map them to a
        # 0..tile_u × v_min..v_max box. We use loop index modulo 4 for
        # quads (any face count works the same way).
        n = len(face.loops)
        for li, loop in enumerate(face.loops):
            t = li / max(1, n - 1)
            loop[uv_layer].uv = (
                (u_offset + t * tile_u) % 1.0,
                v_min if (li < n // 2) else v_max,
            )


def _new_face_indices(bm: bmesh.types.BMesh, pre_face_count: int) -> list[bmesh.types.BMFace]:
    """Faces added since ``pre_face_count``. Helper for incremental
    UV stamping after a ``_append_box`` / ``_append_cone`` call."""
    bm.faces.ensure_lookup_table()
    return [bm.faces[i] for i in range(pre_face_count, len(bm.faces))]


def build_drowned_facade_trimmed_mesh(name: str, *,
                                      style: str = "tokyo",
                                      width: float = 24.0,
                                      height: float = 80.0,
                                      depth: float = 3.0) -> bpy.types.Mesh:
    """Trim-sheet variant of ``build_drowned_facade_mesh``. Single
    material slot; per-face UVs select the strip that paints each
    surface. Much cheaper geometry than the multi-slot version (no
    per-window box meshes — windows are painted on the slab via UVs).

    Currently only ``style="tokyo"`` is wired; other styles fall back
    to the multi-slot builder's pattern via the legacy function until
    their own trim sheets land.
    """
    if style != "tokyo":
        # Fall through to the legacy builder. Authors can opt back in
        # by passing ``use_trim_sheet=False``.
        return build_drowned_facade_mesh(name, style=style, width=width,
                                         height=height, depth=depth)
    bm = bmesh.new()

    # ── Main slab ────────────────────────────────────────────────
    # 6 faces: bottom, top, -Y (back), +Y (front), -X, +X. The +Y/-Y
    # faces become the dense window grid (strip 0). The +X/-X side
    # faces become weathering strips. Top/bottom are the flat base.
    pre = len(bm.faces)
    _append_box(bm, sx=width, sy=depth, sz=height, tz=height / 2)
    slab_faces = _new_face_indices(bm, pre)
    # bmesh's create_cube emits faces in this order via bmesh.ops:
    # bottom (-Z), top (+Z), -Y, +Y, -X, +X — but `_append_box` calls
    # `create_cube` then scales/translates, so the order is preserved.
    # We tile the window grid 5 across × 20 tall on each front face.
    win_tile_u = 5.0
    _set_face_uvs_to_strip(bm, [slab_faces[3]], strip_idx=0, tile_u=win_tile_u)   # +Y windows
    _set_face_uvs_to_strip(bm, [slab_faces[2]], strip_idx=0, tile_u=win_tile_u)   # -Y windows
    _set_face_uvs_to_strip(bm, [slab_faces[4]], strip_idx=3)                       # -X weathering
    _set_face_uvs_to_strip(bm, [slab_faces[5]], strip_idx=3)                       # +X weathering
    _set_face_uvs_to_strip(bm, [slab_faces[0], slab_faces[1]], strip_idx=7)        # bottom + top base

    # ── Top-band signage shelf ───────────────────────────────────
    # Slightly wider than the slab, sitting on top — gets the horizontal
    # sign band strip on its long sides, base on top/bottom.
    pre = len(bm.faces)
    _append_box(bm, sx=width + 0.6, sy=depth + 0.4, sz=2.0, tz=height + 1.0)
    shelf_faces = _new_face_indices(bm, pre)
    _set_face_uvs_to_strip(bm, [shelf_faces[2], shelf_faces[3]], strip_idx=2)      # ±Y signage
    _set_face_uvs_to_strip(bm, [shelf_faces[4], shelf_faces[5]], strip_idx=2)      # ±X signage
    _set_face_uvs_to_strip(bm, [shelf_faces[0], shelf_faces[1]], strip_idx=7)      # bottom + top base

    # ── Vertical kanji strip on +X side ──────────────────────────
    pre = len(bm.faces)
    _append_box(bm, sx=0.5, sy=depth * 0.4, sz=height * 0.6,
                tx=width * 0.45, ty=depth * 0.5,
                tz=height * 0.5)
    kanji_faces = _new_face_indices(bm, pre)
    # All faces of the protruding kanji slab → kanji strip.
    _set_face_uvs_to_strip(bm, kanji_faces, strip_idx=1)

    # ── Neon ledge trim at the very top of the shelf ─────────────
    pre = len(bm.faces)
    _append_box(bm, sx=width + 0.8, sy=depth + 0.6, sz=0.4, tz=height + 2.4)
    neon_faces = _new_face_indices(bm, pre)
    # Sides only get the neon strip; top + bottom go to the base.
    _set_face_uvs_to_strip(bm, [neon_faces[2], neon_faces[3],
                                 neon_faces[4], neon_faces[5]], strip_idx=5)
    _set_face_uvs_to_strip(bm, [neon_faces[0], neon_faces[1]], strip_idx=7)

    # All faces use material slot 0 (the trim-sheet material). Default
    # for new faces is 0, so no per-face material_index writes needed.
    return _finalise(bm, name)


def build_glass_tank_broken_mesh(name: str, *,
                                 sx: float = 20.0,
                                 sy: float = 14.0,
                                 sz: float = 10.0,
                                 shatter_seed: int = 11) -> bpy.types.Mesh:
    """Rectangular glass volume with one side shattered open.

    Drives the Two Oceans Aquarium predator tank (race-through hole on
    the +Y face) and the Shibuya Crossing window-down view (smaller
    scale instance). The shattered face is the +Y face — authors
    rotate around Z when placing so the race line passes through it.

    Material slots:
        0 = mat_landmark_glass (intact panels)
        1 = mat_landmark_steel (frame edges)
        2 = mat_landmark_glass_shard (broken shards, emissive-edged)
    Authors can drop a contents prop (shark, taxis, hachiko) inside
    the collection after dragging it in — there's no slot in the seed.
    """
    bm = bmesh.new()
    rng = _det_rng(shatter_seed)

    hx, hy, hz = sx / 2, sy / 2, sz / 2

    # Frame: thin boxes around all 12 edges of the rectangular volume.
    frame_thick = 0.4
    edges = [
        # bottom rectangle
        (sx, frame_thick, frame_thick, 0, -hy, -hz),
        (sx, frame_thick, frame_thick, 0,  hy, -hz),
        (frame_thick, sy, frame_thick, -hx, 0, -hz),
        (frame_thick, sy, frame_thick,  hx, 0, -hz),
        # top rectangle
        (sx, frame_thick, frame_thick, 0, -hy, hz),
        (sx, frame_thick, frame_thick, 0,  hy, hz),
        (frame_thick, sy, frame_thick, -hx, 0, hz),
        (frame_thick, sy, frame_thick,  hx, 0, hz),
        # vertical posts
        (frame_thick, frame_thick, sz, -hx, -hy, 0),
        (frame_thick, frame_thick, sz,  hx, -hy, 0),
        (frame_thick, frame_thick, sz, -hx,  hy, 0),
        (frame_thick, frame_thick, sz,  hx,  hy, 0),
    ]
    for ex, ey, ez, tx, ty, tz in edges:
        _append_box(bm, sx=ex, sy=ey, sz=ez, tx=tx, ty=ty, tz=tz,
                    material_index=1)

    # Glass panels — five intact panels (slot 0); the +Y face is omitted
    # and replaced with shards.
    panel_thick = 0.1
    panels = [
        # -Y back wall
        (sx, panel_thick, sz, 0, -hy, 0),
        # -X side
        (panel_thick, sy, sz, -hx, 0, 0),
        # +X side
        (panel_thick, sy, sz,  hx, 0, 0),
        # bottom
        (sx, sy, panel_thick, 0, 0, -hz),
        # top
        (sx, sy, panel_thick, 0, 0,  hz),
    ]
    for ex, ey, ez, tx, ty, tz in panels:
        _append_box(bm, sx=ex, sy=ey, sz=ez, tx=tx, ty=ty, tz=tz,
                    material_index=0)

    # Shattered +Y face — emit ~12 angled triangular shards at the
    # frame perimeter pointing inward. The race line passes through
    # the middle.
    shard_count = 12
    for _i in range(shard_count):
        # Pick an edge: top / bottom / left / right.
        side = int(rng() * 4) % 4
        if side == 0:  # top edge
            cx = (rng() - 0.5) * sx
            cz = hz
            base_dir = (0.0, 0.0, -1.0)
        elif side == 1:  # bottom edge
            cx = (rng() - 0.5) * sx
            cz = -hz
            base_dir = (0.0, 0.0, 1.0)
        elif side == 2:  # left edge
            cx = -hx
            cz = (rng() - 0.5) * sz
            base_dir = (1.0, 0.0, 0.0)
        else:  # right edge
            cx = hx
            cz = (rng() - 0.5) * sz
            base_dir = (-1.0, 0.0, 0.0)
        shard_len = 0.5 + rng() * 2.5
        # Triangle base at the frame, tip pointing inward into the
        # tank — a thin tetrahedron-like fragment.
        p_base_l = bm.verts.new((cx - 0.3, hy + 0.02, cz))
        p_base_r = bm.verts.new((cx + 0.3, hy + 0.02, cz))
        tip = bm.verts.new((cx + base_dir[0] * shard_len,
                            hy + 0.02 + rng() * 0.4,
                            cz + base_dir[2] * shard_len))
        f = bm.faces.new([p_base_l, p_base_r, tip])
        f.material_index = 2

    return _finalise(bm, name)


def build_mechanical_rig_mesh(name: str) -> tuple[bpy.types.Mesh, bpy.types.Mesh]:
    """Two meshes: the stationary base mount and the swing arm.

    Drives Marina Bay gantry cranes (tall A-frame base, long horizontal
    arm), Liberty torch flame fixture (short base, vertical flicker
    mount), and Doge's bell (compact frame, short arm). Default scale
    is the crane.

    Returns:
        (base_mesh, arm_mesh). The arm is authored as its own data-
        block so the seed's collection builder can put it on a child
        object with rotation transforms ready for runtime animation.
    """
    # ── Base — A-frame tower + horizontal cap girder ─────────────────
    base_bm = bmesh.new()
    # Two vertical legs.
    for sx in (-3.5, 3.5):
        _append_box(base_bm, sx=1.0, sy=1.0, sz=40.0, tx=sx, tz=20.0,
                    material_index=0)
    # Cross-bracing X (boxes rotated).
    for tz, sgn in ((10.0, 1), (25.0, -1)):
        brace_bm = bmesh.new()
        bmesh.ops.create_cube(brace_bm, size=1.0)
        bmesh.ops.scale(brace_bm, vec=(8.0, 0.4, 0.4), verts=brace_bm.verts)
        bmesh.ops.rotate(brace_bm,
                         matrix=Matrix.Rotation(math.radians(20 * sgn), 4, "Y"),
                         verts=brace_bm.verts)
        bmesh.ops.translate(brace_bm, vec=(0, 0, tz), verts=brace_bm.verts)
        tmp = bpy.data.meshes.new("_tmp_brace")
        brace_bm.to_mesh(tmp); brace_bm.free()
        base_bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    # Cap girder (the pivot platform).
    _append_box(base_bm, sx=9.0, sy=2.0, sz=1.4, tz=40.7,
                material_index=0)
    # Pivot housing (where the arm attaches).
    _append_cone(base_bm, segments=12, r_base=1.4, r_top=1.4, depth=1.0,
                 tz=41.7, axis="Y", material_index=1)
    base_mesh = _finalise(base_bm, f"{name}_base", smooth=False)

    # ── Arm — long horizontal girder + counterweight ─────────────────
    # Pivots around the arm's local origin (0,0,0); runtime is expected
    # to set that as the rotation point.
    arm_bm = bmesh.new()
    # Main horizontal arm extending +X from the pivot.
    _append_box(arm_bm, sx=24.0, sy=1.0, sz=1.0, tx=10.0, tz=0.0,
                material_index=0)
    # Counterweight extending -X.
    _append_box(arm_bm, sx=4.0, sy=1.6, sz=1.6, tx=-5.0, tz=0.0,
                material_index=1)
    # Hoist cable hanging from the tip.
    _append_box(arm_bm, sx=0.15, sy=0.15, sz=8.0, tx=21.5, tz=-4.5,
                material_index=1)
    # Hook block at the cable's end.
    _append_box(arm_bm, sx=0.9, sy=0.9, sz=0.9, tx=21.5, tz=-9.0,
                material_index=1)
    arm_mesh = _finalise(arm_bm, f"{name}_arm", smooth=False)

    return base_mesh, arm_mesh


def build_carved_face_block_mesh(name: str, *,
                                 size: float = 6.0,
                                 expression_seed: int = 3,
                                 weathering: float = 0.25) -> bpy.types.Mesh:
    """Cube block with a low-relief carved face on the +Y face.

    Drives the Bayon smiling-faces × 16 — Angkor's iconic temple
    relief. Use 16 instances around the central spire at variant
    seeds so the faces feel hand-carved, not stamped. Reusable at
    other scales for generic temple reliefs.

    The face is an inset rectangle on the +Y face, with three
    raised features:
        - Forehead bar (raised band across the top third).
        - Eye blocks (two raised quads, mid-height).
        - Mouth bar (raised band along the lower third — the smile).

    ``weathering`` jitters the vert positions so re-runs of the seed
    produce slightly different reliefs per seed value.
    """
    bm = bmesh.new()
    rng = _det_rng(expression_seed)
    h = size / 2

    # Base block.
    _append_box(bm, sx=size, sy=size, sz=size, tz=h, material_index=0)

    # Relief features inset on the +Y face. Relief depth small enough
    # that the silhouette is still cube-shaped at race-pace distance.
    relief_depth = size * 0.06

    def raised_panel(cx_off: float, cz_off: float, w: float, hgt: float):
        # A raised rectangular boss on the +Y face.
        _append_box(bm,
                    sx=w * (1 + (rng() - 0.5) * weathering),
                    sy=relief_depth,
                    sz=hgt * (1 + (rng() - 0.5) * weathering),
                    tx=cx_off,
                    ty=h + relief_depth / 2,
                    tz=h + cz_off,
                    material_index=1)

    # Forehead band.
    raised_panel(0.0, size * 0.30, size * 0.85, size * 0.10)
    # Eyes — two small blocks symmetric around the centre.
    eye_w = size * 0.18
    eye_h = size * 0.10
    eye_z = size * 0.08
    raised_panel(-size * 0.22, eye_z, eye_w, eye_h)
    raised_panel( size * 0.22, eye_z, eye_w, eye_h)
    # Smiling mouth — curved band approximated by 3 abutting panels.
    smile_w = size * 0.20
    smile_y = -size * 0.18
    raised_panel(-size * 0.22, smile_y - size * 0.02, smile_w, size * 0.06)
    raised_panel(  0.0,         smile_y - size * 0.04, smile_w, size * 0.06)
    raised_panel( size * 0.22, smile_y - size * 0.02, smile_w, size * 0.06)
    # Nose ridge — slim vertical raised box between the eyes.
    raised_panel(0.0, size * 0.0, size * 0.05, size * 0.18)

    return _finalise(bm, name, smooth=False)


def build_lava_river_strip_mesh(name: str, *,
                                length: float = 60.0,
                                width: float = 4.0,
                                segments: int = 24) -> bpy.types.Mesh:
    """Flat curved strip suitable for an animated lava river / waterfall.

    Drives the Kilauea lava waterfall — placed on a sloped piece of
    terrain, the strip becomes the molten flow. Authors are expected
    to drop the strip onto a Bezier path with a Curve modifier post-
    seed; the seed ships a straight strip oriented along +X with the
    flow direction in +X local.

    Vertex-attribute override per the spec:
        COLOR_0.R = emissive multiplier along the channel.
                    Centre line (V = 0) is hottest (1.0); edges fall
                    off to 0.2 so the lava shader can pull a hot core
                    + cooler crust.
        COLOR_0.G = AO (always 1.0; this is a surface, not under
                    geometry).
        COLOR_0.B = flow-phase offset (V coord along length 0..1) —
                    runtime can sample this to scroll a noise pattern
                    down the river without sampling UVs.
        COLOR_0.A = 1.0 (free; reserved for per-instance hot-zone
                    masking by future authoring).
    See ``docs/vertex-attribute-spec.md`` for the foliage-channel
    contract; lava is a non-foliage opt-in.
    """
    bm = bmesh.new()
    # Build a 2-row × segments strip in the XY plane (Z = 0).
    rows: list[list[bmesh.types.BMVert]] = []
    for ri in (-1, 1):
        row = []
        for si in range(segments + 1):
            t = si / segments
            x = t * length
            y = ri * (width / 2)
            row.append(bm.verts.new((x, y, 0.0)))
        rows.append(row)
    for si in range(segments):
        a = rows[0][si]
        b = rows[0][si + 1]
        c = rows[1][si + 1]
        d = rows[1][si]
        bm.faces.new([a, b, c, d])

    me = _finalise(bm, name, smooth=False)

    # Author COLOR_0 with the hot-core mask per the spec override.
    def value_for(i, co):
        # Distance from centreline (Y = 0) as a normalised fraction.
        t_y = min(1.0, abs(co[1]) / (width / 2))
        # Hot at centre, cooler at edges. Quadratic falloff reads better
        # than linear when the lava shader pushes through a glow pass.
        emissive = 1.0 - 0.8 * t_y * t_y
        # Phase along length, wrapped.
        t_x = max(0.0, min(1.0, co[0] / length))
        return (emissive, 1.0, t_x, 1.0)

    set_color_attr(me, value_for)
    return me


# ────────────────────────────────────────────────────────────────────
# Deterministic RNG — small LCG so re-running the seed produces
# identical jitter for the same seed value, without pulling random's
# global state into Blender's session state.
# ────────────────────────────────────────────────────────────────────

def _det_rng(seed: int):
    state = [seed & 0xFFFFFFFF or 1]

    def _next() -> float:
        # Numerical Recipes LCG constants.
        state[0] = (state[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return state[0] / 0xFFFFFFFF

    return _next


# ────────────────────────────────────────────────────────────────────
# Collection / asset plumbing
# ────────────────────────────────────────────────────────────────────

def _layer_link(coll: bpy.types.Collection) -> None:
    bpy.context.scene.collection.children.link(coll)


def _make_collection(name: str, mesh: bpy.types.Mesh,
                     materials: list[bpy.types.Material], *,
                     position: tuple[float, float, float]) -> bpy.types.Collection:
    """One-collection-one-mesh layout — author drags the collection,
    gets a single mesh object they can scale / rotate / position. The
    root Empty pattern from the prop library isn't needed here since
    each landmark is a single object, not a multi-part scatter source."""
    coll = bpy.data.collections.new(name)
    _layer_link(coll)
    obj = bpy.data.objects.new(f"{name}_mesh", mesh)
    obj.location = position
    obj["kind"] = "track"  # collidable when placed in a track scene
    obj["landmark_id"] = name.removeprefix("landmark_")
    for mat in materials:
        if mat.name not in mesh.materials:
            mesh.materials.append(mat)
    coll.objects.link(obj)
    return coll


def _mark_asset(coll: bpy.types.Collection, *, catalog_path: str,
                description: str, tags: list[str]) -> None:
    if coll.asset_data is None:
        coll.asset_mark()
    ad = coll.asset_data
    ad.catalog_id = CATALOG_UUIDS[catalog_path]
    ad.description = description
    ad.author = "Hoverbike"
    for t in list(ad.tags):
        ad.tags.remove(t)
    for t in tags:
        ad.tags.new(name=t)


def _make_mechanical_rig_collection(name: str,
                                    base_mesh: bpy.types.Mesh,
                                    arm_mesh: bpy.types.Mesh,
                                    materials: list[bpy.types.Material], *,
                                    position: tuple[float, float, float],
                                    swing_period_s: float,
                                    swing_amplitude_deg: float,
                                    swing_axis: str) -> bpy.types.Collection:
    """Specialised collection layout for mechanical_rig — base mesh
    sits at the collection origin; arm mesh is a child object parented
    to the base at the pivot height, carrying swing-period extras for
    future runtime animation.

    The arm's local origin is its pivot; rotating the arm object
    around its local Z (or whatever ``swing_axis`` is) animates the
    crane swing without changing geometry. Today the runtime ignores
    these extras — they're metadata for the next animation pass.
    """
    coll = bpy.data.collections.new(name)
    _layer_link(coll)

    base = bpy.data.objects.new(f"{name}_base", base_mesh)
    base.location = position
    base["kind"] = "track"
    base["landmark_id"] = name.removeprefix("landmark_")
    for mat in materials:
        if mat.name not in base_mesh.materials:
            base_mesh.materials.append(mat)
    coll.objects.link(base)

    arm = bpy.data.objects.new(f"{name}_arm", arm_mesh)
    arm.parent = base
    # Position the arm at the cap-girder pivot. This must match the
    # base mesh's pivot housing height (41.7 m) so authors can rotate
    # the arm in-place and see it swing across the deck.
    arm.location = (0.0, 0.0, 41.7)
    arm["kind"] = "track"
    arm["landmark_id"] = f"{name.removeprefix('landmark_')}_arm"
    arm["swing_period_s"] = swing_period_s
    arm["swing_amplitude_deg"] = swing_amplitude_deg
    arm["swing_axis"] = swing_axis  # "X" | "Y" | "Z" in arm-local space
    for mat in materials:
        if mat.name not in arm_mesh.materials:
            arm_mesh.materials.append(mat)
    coll.objects.link(arm)

    return coll


def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Build pipeline
# ────────────────────────────────────────────────────────────────────

def build_landmarks() -> dict[str, dict]:
    # Materials — shared across multiple archetypes where the colour story is the same.
    # One shader family per palette per the v1 pipeline plan's
    # "one shader per family" rule.
    mat_concrete    = make_material("mat_landmark_concrete",  "#bcbab5", roughness=0.7)
    mat_steel       = make_material("mat_landmark_steel",     "#7b7d80", roughness=0.4)
    mat_glass       = make_material("mat_landmark_glass",     "#2d4a55", roughness=0.25)
    mat_industrial  = make_material("mat_landmark_industrial","#574e3a", roughness=0.65)
    mat_white       = make_material("mat_landmark_white",     "#d8d6d2", roughness=0.5)
    mat_snow        = make_material("mat_landmark_snow",      "#f1f3f5", roughness=0.85)
    mat_sign_red    = make_material("mat_landmark_sign_red",  "#a01818", roughness=0.55,
                                    emission_hex="#ff5050", emission_strength=1.0)
    # Phase B shared materials.
    # Stripe pairs for tower_cylinder_spiral. Authors override per-instance
    # for Hatteras (black + white), Doge's (terracotta + cream),
    # Angkor (sandstone + dark stone), Cocoon (white + grey).
    mat_stripe      = make_material("mat_landmark_stripe",    "#22231f", roughness=0.6)
    # Oxidised copper / rusted iron for arch ruins, mechanical rigs.
    mat_oxidised    = make_material("mat_landmark_oxidised",  "#4f7a6b", roughness=0.55)
    # Facade family — one base, three accent colour stories.
    mat_facade_deco       = make_material("mat_facade_art_deco",  "#f5e0d8", roughness=0.55)
    mat_facade_deco_band  = make_material("mat_facade_art_deco_band","#5acfd6", roughness=0.4)
    mat_facade_tokyo      = make_material("mat_facade_tokyo",     "#2a2e36", roughness=0.45)
    mat_facade_tokyo_neon = make_material("mat_facade_tokyo_neon","#ff337b", roughness=0.4,
                                          emission_hex="#ff5aa0", emission_strength=2.8)
    mat_facade_venice     = make_material("mat_facade_venice",    "#d6c4a8", roughness=0.6)
    mat_facade_venice_trim= make_material("mat_facade_venice_trim","#7d5a3e", roughness=0.55)
    mat_facade_nyc        = make_material("mat_facade_nyc",       "#8f7864", roughness=0.65)
    mat_facade_nyc_trim   = make_material("mat_facade_nyc_trim",  "#3a2c20", roughness=0.7)
    mat_facade_window     = make_material("mat_facade_window",    "#1c2a30", roughness=0.2,
                                          emission_hex="#ffc77a", emission_strength=0.6)
    # Trim-sheet materials — one per biome. The texture lives at
    # public/assets/landmarks/trim_<biome>.png (built by
    # tools/blender/build_trim_sheets.py). Each variant landmark UV-maps
    # the right strip onto its faces; one material covers every face.
    trim_tokyo_path = os.path.join(REPO_ROOT, "public", "assets", "landmarks",
                                   "trim_tokyo_neon.png")
    mat_facade_trim_tokyo = make_trim_sheet_material(
        "mat_landmark_trim_tokyo", trim_tokyo_path, roughness=0.5,
    )
    # Glass tank — emissive shard family + intact glass.
    mat_glass_shard       = make_material("mat_landmark_glass_shard","#9ed7d5", roughness=0.2,
                                          emission_hex="#cdf2f0", emission_strength=0.4)
    # Stone for carved-face block.
    mat_stone             = make_material("mat_landmark_stone",   "#a39377", roughness=0.75)
    mat_stone_dark        = make_material("mat_landmark_stone_dark","#5a4b39", roughness=0.78)
    # Lava — emissive hot core. The runtime shader will sample COLOR_0.R
    # for the hot mask; the base colour is the cooler crust.
    mat_lava              = make_material("mat_landmark_lava",    "#0f0a08", roughness=0.4,
                                          emission_hex="#ff5a14", emission_strength=6.0)

    summary: dict[str, dict] = {}

    archetypes: list[dict] = [
        dict(
            name="landmark_tower_spire",
            mesh_builder=build_tower_spire_mesh,
            materials=[mat_white],
            catalog="Hoverbike/Landmarks/Spires",
            description="Slim central pillar + three splayed legs + observation disc + spire. Drag, scale Z for shorter / taller spires. Reads as Space Needle / generic radio tower at race-pace viewing distance.",
            tags=["tower", "spire", "landmark", "centerpiece"],
        ),
        dict(
            name="landmark_tower_stepped",
            mesh_builder=build_tower_stepped_mesh,
            materials=[mat_glass],
            catalog="Hoverbike/Landmarks/Towers",
            description="Five stepped tiers. Default ~180 m tall, ~22 m square base. Scale uniformly for shorter or taller skyscrapers; the silhouette reads as Columbia Center / generic downtown anchor.",
            tags=["tower", "skyscraper", "landmark"],
        ),
        dict(
            name="landmark_tower_pyramid_cap",
            mesh_builder=build_tower_pyramid_cap_mesh,
            materials=[mat_white],
            catalog="Hoverbike/Landmarks/Towers",
            description="Square body + setback step + four-sided pyramid cap. ~90 m tall, art-deco silhouette. Use for Smith Tower-style historic landmarks or capital-building approaches.",
            tags=["tower", "historic", "landmark"],
        ),
        dict(
            name="landmark_stadium_arched",
            mesh_builder=build_stadium_arched_mesh,
            materials=[mat_concrete],
            catalog="Hoverbike/Landmarks/Stadiums",
            description="Oval bowl + two transverse arched roof ribs. ~110 m × 100 m footprint, 50 m to arch peak. Reads as Lumen Field / Wembley / any open-roof stadium.",
            tags=["stadium", "arena", "landmark"],
        ),
        dict(
            name="landmark_wheel_ferris",
            mesh_builder=build_wheel_ferris_mesh,
            materials=[mat_steel],
            catalog="Hoverbike/Landmarks/Wheels",
            description="Vertical ferris wheel — torus rim, eight spokes, hub, support pylon. 50 m diameter, 28 m centre height. Great Wheel / London Eye / generic waterfront landmark.",
            tags=["wheel", "waterfront", "landmark"],
        ),
        dict(
            name="landmark_industrial_cluster",
            mesh_builder=build_industrial_cluster_mesh,
            materials=[mat_industrial],
            catalog="Hoverbike/Landmarks/Industrial",
            description="Four storage tanks + cross pipework + offset smokestack. ~45 m × 25 m × 30 m. Gas Works Park / refinery / generic industrial setpiece.",
            tags=["industrial", "park", "landmark"],
        ),
        dict(
            name="landmark_sign_arch",
            mesh_builder=build_sign_arch_mesh,
            materials=[mat_white, mat_sign_red],
            catalog="Hoverbike/Landmarks/Signage",
            description="Vertical sign pillar + horizontal banner + clock face. 8 m × 8 m, emissive red banner. Rotate around Z for a side-of-road gantry vs gateway arch (Pike Place style).",
            tags=["sign", "arch", "landmark", "emissive"],
        ),
        dict(
            name="landmark_mountain_cone",
            mesh_builder=build_mountain_cone_mesh,
            materials=[mat_snow],
            catalog="Hoverbike/Landmarks/Backdrops",
            description="Massive snow-capped cone for the horizon. ~840 m diameter, 420 m tall. Place at distance (>1 km from the track) for a Mt Rainier / Mt Fuji / generic mountain silhouette. Non-collidable in practice — too big to race against.",
            tags=["mountain", "backdrop", "decoration"],
        ),
        # ── Phase B archetypes ─────────────────────────────────────
        dict(
            name="landmark_tower_cylinder_spiral",
            mesh_builder=build_tower_cylinder_spiral_mesh,
            materials=[mat_white, mat_stripe, mat_steel],
            catalog="Hoverbike/Landmarks/Towers",
            description="Cylindrical tower with diagonal stripe pattern + open lamp room. 60 m tall. Drives Hatteras lighthouse (default), Doge's Campanile (re-tint stripes to terracotta), Angkor central spire (criss-cross stone), Cocoon Tower face (criss-cross). Stripe pattern is face-tagged; the runtime material swap retunes per-instance.",
            tags=["tower", "cylinder", "lighthouse", "campanile", "landmark"],
        ),
        dict(
            name="landmark_arch_ruin",
            mesh_builder=build_arch_ruin_mesh,
            materials=[mat_concrete, mat_oxidised],
            catalog="Hoverbike/Landmarks/Ruins",
            description="Half-circle arch with chipped, decayed edges. 60 m span × 22 m rise × 4.5 m thick. Drives the three Maw arches (scale span to taste), Rialto Bridge arch, Two Oceans Aquarium roof remnant, Liberty's broken torch arm (smaller scale). Decay is bmesh-jitter, not a modifier — re-running the seed produces identical jitter per seed.",
            tags=["arch", "ruin", "wave_zone_companion", "landmark"],
        ),
        dict(
            name="landmark_drowned_facade_art_deco",
            mesh_builder=lambda n: build_drowned_facade_mesh(n, style="art_deco", width=30.0, height=12.0, window_cols=8, window_rows=3),
            materials=[mat_facade_deco, mat_facade_deco_band, mat_facade_window],
            catalog="Hoverbike/Landmarks/Facades",
            description="South Beach Art Deco hotel frontage. 30 m × 12 m with horizontal accent band + setback step. Pastel cream + turquoise band. Stamp three of these per South Beach hotel cluster.",
            tags=["facade", "art_deco", "south_beach", "landmark"],
        ),
        dict(
            name="landmark_drowned_facade_tokyo",
            mesh_builder=lambda n: build_drowned_facade_mesh(n, style="tokyo", width=24.0, height=80.0, window_cols=5, window_rows=20),
            materials=[mat_facade_tokyo, mat_facade_tokyo_neon, mat_facade_window],
            catalog="Hoverbike/Landmarks/Facades",
            description="Shibuya skyscraper face. 24 m × 80 m, dense window grid, emissive top-band signage shelf + vertical neon strip. Use as the Cocoon Tower neighbour / generic Shibuya tower top.",
            tags=["facade", "tokyo", "shibuya", "neon", "emissive", "landmark"],
        ),
        dict(
            name="landmark_drowned_facade_venice",
            mesh_builder=lambda n: build_drowned_facade_mesh(n, style="venice", width=40.0, height=18.0, window_cols=7, window_rows=2),
            materials=[mat_facade_venice, mat_facade_venice_trim, mat_facade_window],
            catalog="Hoverbike/Landmarks/Facades",
            description="Venice palazzo frontage. 40 m × 18 m with crown arcade + cornice. Sandstone palette. Stamp around Doge's Drift for the Piazza San Marco palazzi belt.",
            tags=["facade", "venice", "palazzo", "landmark"],
        ),
        dict(
            name="landmark_drowned_facade_nyc",
            mesh_builder=lambda n: build_drowned_facade_mesh(n, style="nyc", width=30.0, height=90.0, window_cols=6, window_rows=22),
            materials=[mat_facade_nyc, mat_facade_nyc_trim, mat_facade_window],
            catalog="Hoverbike/Landmarks/Facades",
            description="Manhattan rooftop. 30 m × 90 m brownstone-ish slab with two procedural water-tower clusters on the roof. Stamp across the Liberty Drowned approach for the receding mid-town skyline.",
            tags=["facade", "nyc", "manhattan", "rooftop", "landmark"],
        ),
        dict(
            name="landmark_drowned_facade_tokyo_trim",
            mesh_builder=lambda n: build_drowned_facade_trimmed_mesh(n, style="tokyo", width=24.0, height=80.0),
            materials=[mat_facade_trim_tokyo],
            catalog="Hoverbike/Landmarks/Facades",
            description="Trim-sheet variant of the Shibuya tower face. Single material (mat_landmark_trim_tokyo) — windows, kanji, signage, weathering, neon, and ledges are all painted from public/assets/landmarks/trim_tokyo_neon.png via per-face UVs. Lighter geometry than the multi-slot variant (no per-window box meshes). Authors can drop multiple instances + tint the BSDF for variety.",
            tags=["facade", "tokyo", "shibuya", "neon", "trim-sheet", "landmark"],
        ),
        dict(
            name="landmark_glass_tank_broken",
            mesh_builder=build_glass_tank_broken_mesh,
            materials=[mat_glass, mat_steel, mat_glass_shard],
            catalog="Hoverbike/Landmarks/Tanks",
            description="Rectangular glass volume with shattered +Y face. 20 m × 14 m × 10 m. Drives Two Oceans Aquarium predator tank (rotate so the race line enters via the shattered face) and the Shibuya Crossing window-down view (scale smaller). Drop a contents prop (shark, taxis, hachiko) inside the collection post-drag.",
            tags=["glass", "tank", "aquarium", "shatter", "landmark"],
        ),
        dict(
            name="landmark_carved_face_block",
            mesh_builder=build_carved_face_block_mesh,
            materials=[mat_stone, mat_stone_dark],
            catalog="Hoverbike/Landmarks/Reliefs",
            description="6 m cube block with a smiling-face relief on the +Y face. Drives the Angkor Bayon faces × 16 — instance around the central spire with varied rotations + per-instance scale jitter. Re-seed with different expression_seed values for variation.",
            tags=["relief", "carving", "angkor", "bayon", "landmark"],
        ),
        dict(
            name="landmark_lava_river_strip",
            mesh_builder=build_lava_river_strip_mesh,
            materials=[mat_lava],
            catalog="Hoverbike/Landmarks/Lava",
            description="Flat 60 m × 4 m emissive strip for Kilauea's lava waterfall. COLOR_0 carries hot-core mask in R + flow phase in B (override per docs/vertex-attribute-spec.md). Authors are expected to add a Curve modifier post-drag to bend the strip along the lava channel.",
            tags=["lava", "kilauea", "emissive", "landmark"],
        ),
    ]

    for a in archetypes:
        pos = LAYOUT[a["name"]]
        mesh = a["mesh_builder"](f"{a['name']}_mesh")
        coll = _make_collection(a["name"], mesh, a["materials"], position=pos)
        _mark_asset(coll, catalog_path=a["catalog"],
                    description=a["description"], tags=a["tags"])
        summary[a["name"]] = {"verts": len(mesh.vertices), "faces": len(mesh.polygons)}

    # ── mechanical_rig — two meshes, one collection, parented arm ──
    rig_pos = LAYOUT["landmark_mechanical_rig"]
    base_mesh, arm_mesh = build_mechanical_rig_mesh("landmark_mechanical_rig")
    rig_coll = _make_mechanical_rig_collection(
        "landmark_mechanical_rig",
        base_mesh, arm_mesh,
        [mat_steel, mat_oxidised],
        position=rig_pos,
        # Default = Marina Bay gantry — 12 s back-and-forth swing across
        # the racing lane (the Gauntlet timer). Re-tune per instance
        # post-drag for Doge's bell (faster, smaller amplitude) and
        # Liberty's torch flame (very fast, small flicker amplitude).
        swing_period_s=12.0,
        swing_amplitude_deg=40.0,
        swing_axis="Z",
    )
    _mark_asset(rig_coll,
                catalog_path="Hoverbike/Landmarks/Mechanical",
                description="A-frame base + swinging arm + counterweight + hoist cable. 40 m tall. Drives Marina Bay gantry cranes (default — 12 s swing across deck), Doge's Campanile bell (re-scale small, re-tune swing_period_s short), Liberty torch flame fixture (re-rig as vertical flicker). Arm carries swing_period_s/amplitude_deg/axis extras for future runtime animation — today the runtime ignores them; metadata is in place for the next animation pass.",
                tags=["mechanical", "crane", "swing", "animated", "landmark"])
    summary["landmark_mechanical_rig"] = {
        "verts": len(base_mesh.vertices) + len(arm_mesh.vertices),
        "faces": len(base_mesh.polygons) + len(arm_mesh.polygons),
    }

    return summary


# ────────────────────────────────────────────────────────────────────
# Preview thumbnails
# ────────────────────────────────────────────────────────────────────

def _generate_previews() -> None:
    """Trigger Blender's built-in preview render for each marked
    collection asset. Skipped in --background mode — Cycles' GPU-
    backed thumbnail render crashes nvoglv64.dll under NVIDIA drivers
    in headless mode (same workaround as seed_props_library)."""
    if bpy.app.background:
        print("[seed-landmarks] skipping preview render (headless); open the .blend in Blender to populate thumbnails")
        return
    for c in bpy.data.collections:
        if c.asset_data is None:
            continue
        try:
            with bpy.context.temp_override(id=c):
                bpy.ops.ed.lib_id_generate_preview()
        except Exception as e:  # noqa: BLE001
            print(f"[seed-landmarks] preview gen failed for {c.name}: {e}")


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[seed-landmarks] writing catalogue → {CATALOG_PATH}")
    write_catalog_file()

    print(f"[seed-landmarks] writing library → {OUTPUT_PATH}")
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    reset_scene()

    summary = build_landmarks()
    _generate_previews()

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    parts = ", ".join(
        f"{k.removeprefix('landmark_')}={v['verts']}v/{v['faces']}f"
        for k, v in summary.items()
    )
    print(f"[seed-landmarks] done — {parts}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[seed-landmarks] FAILED: {e}", file=sys.stderr)
        raise
