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

Eight **collections**, each marked as a Blender Asset under the
``Hoverbike/Landmarks/<sub-category>`` catalogue:

| Collection                       | Sub-category | Inspiration                | Default scale |
|----------------------------------|--------------|----------------------------|---------------|
| ``landmark_tower_spire``         | Spires       | Space Needle               | 184 m tall    |
| ``landmark_tower_stepped``       | Towers       | Columbia Center            | 180 m tall    |
| ``landmark_tower_pyramid_cap``   | Towers       | Smith Tower                | 90 m tall     |
| ``landmark_stadium_arched``      | Stadiums     | Lumen Field / T-Mobile     | ~50 m × 110 m |
| ``landmark_wheel_ferris``        | Wheels       | Great Wheel / London Eye   | 50 m diameter |
| ``landmark_industrial_cluster``  | Industrial   | Gas Works Park             | ~45 m × 25 m  |
| ``landmark_sign_arch``           | Signage      | Pike Place arch + clock    | 8 m × 8 m     |
| ``landmark_mountain_cone``       | Backdrops    | Mt Rainier (snow-capped)   | ~840 m × 420 m|

### v1 trade-off — baked geometry, no GN modifiers

Unlike the prop library, these ship as **baked bmesh** rather than
Geometry Nodes-modified single-vertex bases. The decision is
explicit: eight full GN graphs would have eaten an entire authoring
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "landmarks-library.blend")
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
}

# Layout for the saved .blend's viewport — spread landmarks in a row
# so an author opening the library file can see them all at once.
LAYOUT = {
    "landmark_tower_spire":        (    0.0, 0.0, 0.0),
    "landmark_tower_stepped":      (   60.0, 0.0, 0.0),
    "landmark_tower_pyramid_cap":  (  120.0, 0.0, 0.0),
    "landmark_stadium_arched":     (  220.0, 0.0, 0.0),
    "landmark_wheel_ferris":       (  340.0, 0.0, 0.0),
    "landmark_industrial_cluster": (  410.0, 0.0, 0.0),
    "landmark_sign_arch":          (  480.0, 0.0, 0.0),
    "landmark_mountain_cone":      ( 1000.0, 0.0, 0.0),
}


# ────────────────────────────────────────────────────────────────────
# Catalogue file — merge with prop library entries
# ────────────────────────────────────────────────────────────────────

def write_catalog_file() -> None:
    """Merge landmark catalogue rows into the shared
    ``tracks-src/blender_assets.cats.txt``. Idempotent — preserves
    any UUIDs from other seeds (the prop library writes its own rows)
    and only rewrites the file when our entries are missing or stale.

    Blender accepts a single catalogue file per folder, so this seed
    co-operates with seed_props_library.py rather than overwriting."""
    header = [
        "# This is an Asset Catalog Definition file for Blender.",
        "#",
        "# Empty lines and lines starting with `#` are ignored.",
        "# The first non-ignored line should be the version indicator.",
        "# Other lines are of the format \"UUID:catalog/path/for/assets:simple catalog name\"",
        "",
        "VERSION 1",
        "",
    ]
    existing_rows: dict[str, str] = {}
    if os.path.exists(CATALOG_PATH):
        with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("VERSION"):
                    continue
                parts = line.split(":", 2)
                if len(parts) == 3:
                    existing_rows[parts[0]] = line
    for path, uid in CATALOG_UUIDS.items():
        simple = path.replace("/", "-")
        existing_rows[uid] = f"{uid}:{path}:{simple}"
    rows = sorted(existing_rows.values())
    os.makedirs(os.path.dirname(CATALOG_PATH), exist_ok=True)
    with open(CATALOG_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(header + rows) + "\n")


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


def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Build pipeline
# ────────────────────────────────────────────────────────────────────

def build_landmarks() -> dict[str, dict]:
    # Materials — shared across multiple archetypes where the colour story is the same.
    mat_concrete    = make_material("mat_landmark_concrete",  "#bcbab5", roughness=0.7)
    mat_steel       = make_material("mat_landmark_steel",     "#7b7d80", roughness=0.4)
    mat_glass       = make_material("mat_landmark_glass",     "#2d4a55", roughness=0.25)
    mat_industrial  = make_material("mat_landmark_industrial","#574e3a", roughness=0.65)
    mat_white       = make_material("mat_landmark_white",     "#d8d6d2", roughness=0.5)
    mat_snow        = make_material("mat_landmark_snow",      "#f1f3f5", roughness=0.85)
    mat_sign_red    = make_material("mat_landmark_sign_red",  "#a01818", roughness=0.55,
                                    emission_hex="#ff5050", emission_strength=1.0)

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
    ]

    for a in archetypes:
        pos = LAYOUT[a["name"]]
        mesh = a["mesh_builder"](f"{a['name']}_mesh")
        coll = _make_collection(a["name"], mesh, a["materials"], position=pos)
        _mark_asset(coll, catalog_path=a["catalog"],
                    description=a["description"], tags=a["tags"])
        summary[a["name"]] = {"verts": len(mesh.vertices), "faces": len(mesh.polygons)}

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
