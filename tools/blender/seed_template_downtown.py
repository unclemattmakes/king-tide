"""Seed ``tracks-src/template-downtown.blend`` — coastal-hill demo of the
*Downtown* generator's terrain-conformance + the *Placement helper*.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_downtown.py

### What this template shows

The terrain isn't flat. It's a procedural coastal-hill landscape with
three regions designed to demo the full Miami-flat → SF-hilly range
of the *Downtown* generator's `Conform to terrain` pass:

| Object | Terrain regime | Visual read |
|---|---|---|
| ``downtown_00`` (centre, 8×8) | **SF-moderate** — Nob-Hill-style 10–15 m grade across the grid | Streets ramp uphill, towers step into the slope. |
| ``downtown_01`` (NW, 5×4) | **Miami-flat** — sits inside a flat coastal valley | Plinth lays flat, buildings all share a base z. |
| ``downtown_02`` (SE, 6×3) | **SF-steep** — perched on the side of a 25 m ridge | Buildings sink deeply into the downhill side, like Telegraph Hill warehouses. |

For each building, `_generate_downtown` raycasts the four footprint
corners onto the terrain mesh, seats the base at the **highest** corner,
and extends the bottom face down past the **lowest** corner so the
downhill side is buried in the slope. Result: no floating stilts, no
gaps under sloped buildings — placeholder geo that still reads as a
real city stepping into a hill.

The plinth is built as a subdivided grid and per-vertex conformed to
the same terrain mesh, so the streets ramp continuously between
buildings the way they do in a real cityscape.

### Authoring loop

1. Open ``tracks-src/template-downtown.blend``.
2. Drag any ``downtown_NN`` parent empty (G/R/S) to relocate or rotate
   the whole block — children re-pose automatically.
3. To add a new downtown anywhere on the terrain: open the *Placement
   helper* sub-panel (Hoverbike sidebar), scrub `t` and `Offset` to
   park the helper at the desired anchor, click *Cursor → Helper*,
   then open the *Downtown* sub-panel and click *Add Downtown*. The
   conform-to-terrain pass runs automatically and you'll see the new
   downtown step into whatever grade you dropped it on.
4. To re-roll a downtown's layout: delete it and click *Add Downtown*
   again with a different `Seed`.
5. Untick *Conform to terrain* in the Downtown panel to force the
   legacy flat behaviour (e.g. for a city built on a fill plane).
6. Export with the addon's *Export Track to Game* button.

### Terrain palette

Coastal — sea level at z=0 (the `water_volume_main` empty), beach band
0..6 m, urban grade 6..40 m, hilltop scrub 40+ m. The runtime
`mat_terrain_runtime` shader (M9.39 SOTA coloration) reads the altitude
bands directly so the in-game look maps onto the in-Blender preview.

### COLOR_0 stamp

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | baked AO (default 1) |
| B | baked path-worn (default 0) |
| A | 0.5 — single biome flag (urban) |
"""

from __future__ import annotations

import importlib.util
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-downtown.blend")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

# Coastal-hill tile. SUBDIV picked so the hills + flat valley both read
# without shimmering — 192 cells per side ≈ 5 m per cell at the default
# 1024 m tile, fine enough that the building raycasts always find a
# representative terrain point.
TILE_SIZE = 1024.0
SUBDIV = 192

# Procedural terrain: rolling baseline + a Miami-flat coastal valley
# (NW) + a couple of SF-style steep ridges. Heights are deliberately
# *caricatured* — Nob Hill at 65 m and Telegraph Ridge at 95 m read
# clearly at racing speed without needing fog or atmospheric tricks
# to sell the scale. Real-world Nob Hill is ~115 m tall but ~600 m
# across; this version compresses the footprint by ~3× so the same
# vertical change reads as a much steeper grade at the building
# scale. JetMoto / WipeOut-style "looks like cities I know, geometry
# I don't" arcade exaggeration.
COASTAL_VALLEY_CENTER = (-360.0, 280.0)   # Miami-flat downtown sits here
COASTAL_VALLEY_RADIUS = 260.0
NOB_HILL_CENTER = (40.0, 60.0)            # Centre downtown rides this slope
NOB_HILL_HEIGHT = 65.0
NOB_HILL_RADIUS = 180.0
TELEGRAPH_RIDGE_CENTER = (320.0, -300.0)  # SE downtown perches on this
TELEGRAPH_RIDGE_HEIGHT = 95.0
TELEGRAPH_RIDGE_RADIUS = 130.0
TWIN_PEAKS_CENTER = (180.0, 280.0)        # extra silhouette hill behind valley
TWIN_PEAKS_HEIGHT = 55.0
TWIN_PEAKS_RADIUS = 140.0


def terrain_z(x: float, y: float) -> float:
    """Analytic terrain height at world (x, y). The same function is
    sampled in `build_terrain_mesh` to deform the plane and is used as
    a sanity reference for downtown placements above (we don't query it
    after the mesh exists — `_generate_downtown` raycasts the actual
    mesh — but matching the centre-of-feature locations to where the
    downtowns sit keeps the .blend self-documenting)."""
    z = 0.0

    # Rolling baseline: two crossed sin/cos waves at slightly different
    # frequencies so the troughs/peaks don't form an obvious grid.
    # ±8 m at scale ~150–200 m gives the rest of the map texture
    # between the named features.
    z += 8.0 * math.sin(x * 0.012) * math.cos(y * 0.013)
    z += 4.0 * math.sin(x * 0.034 + 1.7) * math.cos(y * 0.029 + 0.6)

    # Nob-Hill slope: smooth gaussian dome whose centre sits inside
    # downtown_00. Tall + narrow = ~35° peak grade, definitely a hill
    # the bike has to *climb* to traverse the downtown rather than
    # just glide over.
    dx = x - NOB_HILL_CENTER[0]
    dy = y - NOB_HILL_CENTER[1]
    nob_d2 = dx * dx + dy * dy
    z += NOB_HILL_HEIGHT * math.exp(-nob_d2 / (NOB_HILL_RADIUS ** 2))

    # Telegraph Ridge: even sharper. Real SF-style promontory the SE
    # downtown sits *on the side of* — building skirts on the
    # downhill face will reach 30+ m to stay buried in the grade.
    dx = x - TELEGRAPH_RIDGE_CENTER[0]
    dy = y - TELEGRAPH_RIDGE_CENTER[1]
    rid_d2 = dx * dx + dy * dy
    z += TELEGRAPH_RIDGE_HEIGHT * math.exp(-rid_d2 / (TELEGRAPH_RIDGE_RADIUS ** 2))

    # Twin Peaks: silhouette feature behind the Miami valley so the
    # NW horizon reads as "hills across the bay" instead of a flat
    # cardboard cutout. No downtown sits on this — purely scenic.
    dx = x - TWIN_PEAKS_CENTER[0]
    dy = y - TWIN_PEAKS_CENTER[1]
    tp_d2 = dx * dx + dy * dy
    z += TWIN_PEAKS_HEIGHT * math.exp(-tp_d2 / (TWIN_PEAKS_RADIUS ** 2))

    # Miami-flat valley: collapse the entire signal toward z=1m near
    # the NW downtown so it sits on a genuinely level coastal plain.
    # Larger radius now so the flattening reaches past the new bigger
    # rolling baseline.
    dx = x - COASTAL_VALLEY_CENTER[0]
    dy = y - COASTAL_VALLEY_CENTER[1]
    val_d2 = dx * dx + dy * dy
    flatten = math.exp(-val_d2 / (COASTAL_VALLEY_RADIUS ** 2))
    z = z * (1.0 - flatten) + 1.0 * flatten

    return z


# Three downtowns showcasing different terrain regimes. Each tuple is
# (parent_location_xyz, parent_yaw_rad, downtown_kwargs). Parent z=0
# everywhere — the conform-to-terrain pass figures out the per-building
# seat from the terrain mesh at runtime, so the parent just marks the
# centre of the city footprint.
DOWNTOWNS: list[tuple[tuple[float, float, float], float, dict]] = [
    # SF-moderate: dense 8×8 mid-rise on the side of Nob Hill. Streets
    # ramp uphill, taller buildings on the downhill side dig deeper
    # extra-depth skirts. The racing line threads two streets across
    # this grid so the demonstration of grade-aware placement is
    # immediately visible at speed.
    (
        (NOB_HILL_CENTER[0], NOB_HILL_CENTER[1] - 60.0, 0.0), 0.0,
        dict(
            blocks_x=8, blocks_y=8,
            block_size=30.0, street_width=10.0,
            height_min=25.0, height_max=85.0,
            seed=7,
        ),
    ),
    # Miami-flat: sparser 5×4 of tall towers in the coastal valley. The
    # plinth comes out genuinely flat because every raycast point hits
    # the same z — same generator, same conform pass, no special-casing.
    (
        (COASTAL_VALLEY_CENTER[0], COASTAL_VALLEY_CENTER[1], 0.0),
        math.radians(30.0),
        dict(
            blocks_x=5, blocks_y=4,
            block_size=42.0, street_width=14.0,
            height_min=45.0, height_max=140.0,
            seed=23,
        ),
    ),
    # SF-steep: 6×3 squat warehouses perched on Telegraph Ridge. Each
    # building's downhill skirt sinks ~10–18 m into the slope; from
    # offshore the silhouette steps down the ridge.
    (
        (TELEGRAPH_RIDGE_CENTER[0] - 30.0, TELEGRAPH_RIDGE_CENTER[1] + 20.0, 0.0),
        math.radians(-15.0),
        dict(
            blocks_x=6, blocks_y=3,
            block_size=36.0, street_width=8.0,
            height_min=10.0, height_max=26.0,
            seed=41,
        ),
    ),
]

# Hover height authors expect for the racing line above the underlying
# terrain. The snap-spline-to-terrain operator (or the equivalent
# in-script call below) lifts each anchor by this amount.
RACE_HOVER_M = 1.5

# Racing line anchors in (x, y) only — the Z is computed by sampling
# `terrain_z(x, y) + RACE_HOVER_M` so the line follows the grade
# instead of clipping into hills. Two consecutive segments cross the
# central downtown so the player threads buildings perpendicular to
# their grid as the road climbs Nob Hill.
AI_SPLINE_ANCHORS_XY: list[tuple[float, float]] = [
    (   0.0, -360.0),  # south plaza approach (start)
    ( 220.0, -240.0),  # SE arc, climbing toward Telegraph
    ( 280.0, -200.0),  # crest of Telegraph approach
    ( 200.0,    0.0),  # east edge of urban core, turning in
    (   0.0,  140.0),  # cross urban core uphill (street 1)
    (-200.0,  240.0),  # NW Miami-valley approach
    (-380.0,  120.0),  # NW outer turn (in the flat valley)
    (-280.0, -100.0),  # west, swinging back uphill
    (-140.0,    0.0),  # cross urban core eastbound (street 2)
    (  80.0, -160.0),  # exit toward Telegraph
    ( 320.0, -360.0),  # SE outer turn before lap close
]

START_T = 0.0
START_GRID_SPACING_M = 4.0

# Checkpoints sit at the four "must-cross" corners of the racing line.
# Z-values are filled in from `terrain_z` at script time so they ride
# the grade just like the spline.
CHECKPOINT_XYS: list[tuple[float, float]] = [
    ( 200.0,    0.0),  # entering urban core (north-bound, uphill)
    (-380.0,  120.0),  # NW outer turn (Miami-flat)
    (-140.0,    0.0),  # exiting urban core (east-bound, downhill)
    ( 320.0, -360.0),  # SE Telegraph turn
]
CHECKPOINT_HALF_WIDTH = 14.0
CHECKPOINT_HEIGHT = 6.0

# Boost pads on the through-streets across `downtown_00`. XY only; the
# Z is sampled from the terrain so the pad sits flush with the
# (conformed) street surface even on the hill grade.
BOOST_PAD_XYS: list[tuple[tuple[float, float], float, float, float, float]] = [
    # ((x, y), yaw_rad, half_width, half_depth, strength)
    ((  0.0, -100.0), math.radians(0.0),   3.0, 6.0, 1.6),  # entering N-bound
    ((-30.0,   60.0), math.radians(180.0), 3.0, 6.0, 1.6),  # mid-grid N-bound exit
    ((-90.0,    0.0), math.radians(-90.0), 3.0, 6.0, 1.6),  # mid-grid E-bound
]

WATER_PREVIEW_SIZE = 1100.0
WATER_PREVIEW_SUBDIVISIONS = 80
# Sea level — coastal city, so the water plane sits at z=0 and the
# Miami-flat valley + most of the racing line is just above it.
WATER_HEIGHT = 0.0


# ────────────────────────────────────────────────────────────────────
# Scene reset
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


# ────────────────────────────────────────────────────────────────────
# Addon import — we reuse `_generate_downtown` so the template
# demonstrates the literal workflow the author would follow in-app
# (not a divergent re-implementation).
# ────────────────────────────────────────────────────────────────────

def _load_addon_module():
    """Load the in-repo Hoverbike addon package without registering it.
    Need its ``_generate_downtown`` helper to build city blocks and the
    ``_rebuild_*_preview`` helpers for the gizmo overlays — both still
    reachable post-2026-05 package-refactor via the back-compat shim
    in ``hoverbike_addon/__init__.py``. ``submodule_search_locations``
    is required so the package's ``from . import ...`` lines resolve
    under the disk alias."""
    import sys
    pkg_dir = os.path.join(SCRIPT_DIR, "hoverbike_addon")
    init_file = os.path.join(pkg_dir, "__init__.py")
    if not os.path.exists(init_file):
        print(f"[seed-template-downtown] WARNING: {init_file} not found")
        return None
    spec = importlib.util.spec_from_file_location(
        "hoverbike_addon_disk",
        init_file,
        submodule_search_locations=[pkg_dir],
    )
    if spec is None or spec.loader is None:
        return None
    addon = importlib.util.module_from_spec(spec)
    sys.modules["hoverbike_addon_disk"] = addon
    spec.loader.exec_module(addon)
    return addon


# ────────────────────────────────────────────────────────────────────
# Terrain mesh — flat plane with COLOR_0 + AO + path attributes so the
# runtime terrain shader picks it up cleanly. Buildings are the silhouette;
# the ground is just the plinth under them.
# ────────────────────────────────────────────────────────────────────

def build_terrain_mesh() -> bpy.types.Object:
    """Build the coastal-hill terrain. Subdivided plane, per-vertex Z
    set via `terrain_z(x, y)` so the bays, the Miami-flat valley, Nob
    Hill, and Telegraph Ridge all read in-Blender without leaning on
    modifiers."""
    mesh = bpy.data.meshes.new("terrain_mesh")
    bm = bmesh.new()
    half = TILE_SIZE * 0.5
    v00 = bm.verts.new((-half, -half, 0))
    v10 = bm.verts.new(( half, -half, 0))
    v11 = bm.verts.new(( half,  half, 0))
    v01 = bm.verts.new((-half,  half, 0))
    bm.faces.new([v00, v10, v11, v01])
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=SUBDIV - 1, use_grid_fill=True)
    # Displace each vertex by terrain_z. bmesh keeps verts in object
    # space — we built the plane at object origin so vert.co == world XY.
    for v in bm.verts:
        v.co.z = terrain_z(v.co.x, v.co.y)
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
        # R=sway(0), G=AO(1), B=path-worn(0), A=biome(0.5 = urban)
        anchor.data[i].color = (0.0, 1.0, 0.0, 0.5)
    mesh.color_attributes.active_color = anchor
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("COLOR_0")
    return terrain


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Concrete-plaza shader for the in-Blender preview. The runtime
    swaps in `mat_terrain_runtime` (the SOTA coloration pass) at GLB
    load — this material exists only so the .blend looks plausible
    while authoring."""
    name = "mat_terrain_main"
    if name in bpy.data.materials:
        bpy.data.materials.remove(bpy.data.materials[name])
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.46, 0.45, 0.43, 1.0)  # warm concrete
        bsdf.inputs["Roughness"].default_value = 0.85
    if terrain.data.materials:
        terrain.data.materials[0] = mat
    else:
        terrain.data.materials.append(mat)


# ────────────────────────────────────────────────────────────────────
# Scene assembly: water, spline, starts, checkpoints, boosts, sun
# ────────────────────────────────────────────────────────────────────

def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, WATER_HEIGHT)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.4  # distant ocean; mostly horizon dressing
    obj["wave_freq"] = 0.6
    bpy.context.scene.collection.objects.link(obj)


def _spline_point_z(x: float, y: float) -> float:
    """Race-line Z at (x, y): terrain + RACE_HOVER_M."""
    return terrain_z(x, y) + RACE_HOVER_M


def add_ai_spline() -> None:
    curve = bpy.data.curves.new("ai_spline_main", type="CURVE")
    curve.dimensions = "3D"
    sp = curve.splines.new(type="NURBS")
    sp.points.add(len(AI_SPLINE_ANCHORS_XY) - 1)
    for i, (x, y) in enumerate(AI_SPLINE_ANCHORS_XY):
        sp.points[i].co = (x, y, _spline_point_z(x, y), 1.0)
    sp.use_endpoint_u = True
    sp.use_cyclic_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    bpy.context.scene.collection.objects.link(obj)


def _sample_spline_at_t(t: float):
    pts = list(AI_SPLINE_ANCHORS_XY) + [AI_SPLINE_ANCHORS_XY[0]]
    seg_lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    total = sum(seg_lengths)
    target = max(0.0, min(1.0, t)) * total
    accum = 0.0
    for i, seg_len in enumerate(seg_lengths):
        if accum + seg_len >= target or i == len(seg_lengths) - 1:
            f = (target - accum) / seg_len if seg_len > 0 else 0.0
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            sx = ax + f * (bx - ax)
            sy = ay + f * (by - ay)
            tx = bx - ax
            ty = by - ay
            tmag = math.hypot(tx, ty) or 1.0
            return (sx, sy), (tx / tmag, ty / tmag)
        accum += seg_len
    return pts[0], (0.0, 1.0)


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
        obj.location = (x, y, _spline_point_z(x, y))
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "start"
        obj["index"] = i
        obj["start_t"] = float(START_T)
        bpy.context.scene.collection.objects.link(obj)


def add_checkpoints() -> None:
    for i, (x, y) in enumerate(CHECKPOINT_XYS):
        obj = bpy.data.objects.new(f"cp_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.location = (x, y, _spline_point_z(x, y))
        obj["kind"] = "checkpoint"
        obj["index"] = i
        obj["half_width"] = CHECKPOINT_HALF_WIDTH
        obj["height"] = CHECKPOINT_HEIGHT
        bpy.context.scene.collection.objects.link(obj)


def add_boost_pads() -> None:
    """Drop the through-street boosters as `boost_NN` empties matching
    the runtime/Blender naming convention. Z is sampled from terrain so
    pads sit flush even on the Nob-Hill grade."""
    for i, ((x, y), yaw, hw, hd, s) in enumerate(BOOST_PAD_XYS):
        obj = bpy.data.objects.new(f"boost_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj.location = (x, y, terrain_z(x, y) + 0.5)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "boost_pad"
        obj["half_width"] = float(hw)
        obj["half_depth"] = float(hd)
        obj["strength"] = float(s)
        bpy.context.scene.collection.objects.link(obj)


def add_sun() -> None:
    light_data = bpy.data.lights.new("sun", type="SUN")
    light_data.energy = 4.5
    light_data.color = (1.0, 0.95, 0.86)  # late-afternoon city warmth
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.55, 0.25, 0.6)  # rakes east-west across grids
    bpy.context.scene.collection.objects.link(obj)


# ────────────────────────────────────────────────────────────────────
# Downtown blocks — the headline showcase
# ────────────────────────────────────────────────────────────────────

def add_downtowns(addon) -> int:
    """Spawn the three demo downtowns via the addon's `_generate_downtown`.
    Returns the total building count across all blocks."""
    if addon is None:
        print("[seed-template-downtown] addon module unavailable; skipping downtowns")
        return 0
    scene = bpy.context.scene
    total = 0
    for (loc, yaw, kw) in DOWNTOWNS:
        parent, n = addon._generate_downtown(
            scene,
            location=loc,
            rotation_z=yaw,
            **kw,
        )
        total += n
        print(
            f"[seed-template-downtown] {parent.name}: {kw['blocks_x']}×{kw['blocks_y']} blocks, "
            f"{n} buildings, seed={kw['seed']}"
        )
    return total


# ────────────────────────────────────────────────────────────────────
# Placement helper — pre-spawned at a useful spot so the user can see
# the workflow without reading the docstring first.
# ────────────────────────────────────────────────────────────────────

def add_placement_helper_demo(addon) -> None:
    """Pre-park the placement helper at the spline's first urban-core
    crossing (~t=0.34, offset=+8 m to demonstrate the lateral knob).
    The helper re-poses live as the user scrubs the sliders, so this
    is purely a "drag the panel sliders to see what they do" hint."""
    if addon is None:
        return
    scene = bpy.context.scene
    # Set the addon's helper-related scene props to defaults that show
    # the helper sitting in the urban-core crossing approach.
    if hasattr(scene, "hoverbike_helper_t"):
        scene.hoverbike_helper_t = 0.34
    if hasattr(scene, "hoverbike_helper_offset"):
        scene.hoverbike_helper_offset = 8.0
    # Ensure the empty + initial pose exist.
    addon._ensure_placement_helper(scene)
    addon._repose_placement_helper(scene)


# ────────────────────────────────────────────────────────────────────
# Collection organisation — keep the outliner tidy. Mirrors the
# convention every other template uses.
# ────────────────────────────────────────────────────────────────────

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
    col_city     = ensure("Downtowns")
    col_water    = ensure("Water")
    col_spline   = ensure("Spline")
    col_gameplay = ensure("Gameplay")
    col_helpers  = ensure("Helpers")

    def move(obj, coll):
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        coll.objects.link(obj)

    for obj in list(scene.objects):
        n = obj.name
        if n == "terrain":
            move(obj, col_terrain)
        elif n.startswith("downtown_") or n.startswith("downtown_") and "_b" in n:
            # Catches both the parent empties and the per-building meshes.
            move(obj, col_city)
        elif n == "water_volume_main":
            move(obj, col_water)
        elif n in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif n.startswith(("start_", "cp_", "pickup_", "boost_")):
            move(obj, col_gameplay)
        elif n == "placement_helper":
            move(obj, col_helpers)


# ────────────────────────────────────────────────────────────────────
# Previews — same pattern as mesa/island so the user opens the .blend
# to a populated viewport, not an empty grid.
# ────────────────────────────────────────────────────────────────────

def add_previews(addon) -> None:
    if addon is None:
        return
    scene = bpy.context.scene
    summary = addon._rebuild_water_preview(
        scene, size=WATER_PREVIEW_SIZE, subdivisions=WATER_PREVIEW_SUBDIVISIONS, time=0.0,
    )
    print(f"[seed-template-downtown] water preview: {summary['vert_count']} verts centered on {summary['centered_on']}")
    n_gates = addon._rebuild_gate_preview(scene, spacing=60.0, half_width=14.0, height=6.0)
    print(f"[seed-template-downtown] gate preview: {n_gates} gates at 60.0m spacing")
    racer_summary = addon._rebuild_racer_preview(scene)
    print(
        "[seed-template-downtown] racer preview: "
        f"1 player + {racer_summary['ai_count']} AI bikes ({racer_summary['grid_source']})"
    )
    turn_summary = addon._rebuild_turn_indicators(scene, kappa_threshold=0.025, min_spacing_m=24.0)
    print(f"[seed-template-downtown] turn indicators: {turn_summary['peak_count']} chevrons")
    addon._refresh_boost_pad_gizmos(scene)


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-template-downtown] writing {OUTPUT_PATH}")
    addon = _load_addon_module()

    reset_scene()
    terrain = build_terrain_mesh()
    build_terrain_material(terrain)
    add_water_volume()
    add_ai_spline()
    add_player_starts()
    add_checkpoints()
    add_boost_pads()
    add_sun()

    # Downtowns + placement helper come last so they read as the
    # "headline content" in the outliner — the rest is scaffolding.
    n_buildings = add_downtowns(addon)
    add_placement_helper_demo(addon)

    organize_collections()

    bpy.context.view_layer.update()
    add_previews(addon)
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-template-downtown] done — {n_buildings} buildings across {len(DOWNTOWNS)} downtowns")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-template-downtown] FAILED: {e}", file=sys.stderr)
