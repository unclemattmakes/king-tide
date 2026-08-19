"""Seed ``tracks-src/template-tunnel-island.blend`` — mountainous island
demonstrating the *Tunnel* tool.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_tunnel_island.py

### What this template shows

Three big gaussian-dome mountains on a small coastal island, each
drilled through by its own tunnel. The AI racing line threads each
tunnel in sequence, so a complete lap requires diving through all
three holes — the canonical "is the tunnel tool wired up end-to-end?"
demo.

| Object | Role |
|---|---|
| ``terrain``                  | Subdivided plane displaced by a 3-gaussian island sum (3× peak ~80 m), with a coastline falloff past r≈380 m so the racing line edges genuinely meet water. |
| ``tunnel_A_curve / B / C``   | Bezier curves through each mountain, sampled by the addon helpers into cutter + interior shells. |
| ``tunnel_A_cutter / B / C``  | Closed manifold cylinders in the hidden ``_hoverbike_tunnel_cutters`` collection — Boolean DIFFERENCE operands for the terrain. |
| ``tunnel_A_interior / B / C``| Inward-facing concrete liners, ``kind="track"`` so the runtime trimesh collider attaches. |
| ``ai_spline_main``           | 9-anchor closed NURBS that dips into each tunnel and curves around the coast between them. |
| 4 × ``cp_NN``                | One checkpoint inside each tunnel + one on each coast straight, so a "skip the tunnel" cheese is impossible. |

### In-game expectation

The AI controller follows the spline anchors. Spline anchors inside
each tunnel have z=``TUNNEL_Z`` (well below the mountain peak surface
but above the tunnel floor), so the AI dives below the visible
terrain at each mouth, rides through, and climbs back out. Bike
hover physics keeps the chassis floating above the tunnel-floor
collider regardless of the spline's exact z, so the AI doesn't need
to know about the tunnel — it just steers toward the next spline
sample.

### Authoring loop

1. Open ``tracks-src/template-tunnel-island.blend``.
2. To re-author a tunnel: select ``tunnel_X_curve``, Tab into edit
   mode, drag handles, Tab out, then *Build Tunnel* in the Tunnel
   sub-panel. (Built tunnels with ``tunnel_curve_main`` as the
   source — the addon picks the next free ``tunnel_NN`` slot.)
3. *Export Track to Game* bakes the Boolean modifier into the
   exported terrain (``export_apply=True``) and writes
   ``public/assets/tracks/template-tunnel-island.glb`` +
   ``public/tracks/template-tunnel-island.json``.

### COLOR_0 stamp

| Channel | Stamped value |
|---|---|
| R | 0 — terrain doesn't sway |
| G | baked AO (default 1) |
| B | baked path-worn (default 0) |
| A | 0.65 — island biome flag |
"""

from __future__ import annotations

import importlib.util
import json
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-tunnel-island.blend")
TRACK_ID = "template-tunnel-island"
GLB_DIR = os.path.join(REPO_ROOT, "public", "assets", "tracks")
JSON_DIR = os.path.join(REPO_ROOT, "public", "tracks")

# ────────────────────────────────────────────────────────────────────
# Default scene parameters
# ────────────────────────────────────────────────────────────────────

TILE_SIZE = 1024.0
SUBDIV = 192

MOUNTAINS = [
    {"center": (-180.0, -180.0), "height": 50.0, "radius": 130.0},  # SW
    {"center": ( 180.0, -180.0), "height": 50.0, "radius": 130.0},  # SE
    {"center": (   0.0,  180.0), "height": 50.0, "radius": 130.0},  # N
]
ISLAND_RADIUS = 380.0
COAST_FALLOFF = 100.0

# Mouths form where the tunnel cutter cylinder breaches the gaussian
# surface. Computed analytically so the AI spline + checkpoints can be
# placed *at* the mouth — bike physics needs the spline anchor exactly
# where the hover ray transitions from terrain to tunnel-interior.
#
# Solve for d where mountain(d) = cylinder_top:
#   peak * exp(-d²/r²) = curve_z + cutter_radius
# i.e. d = r * sqrt(ln(peak / (curve_z + cutter_radius)))

WATER_HEIGHT = 0.0
WATER_PREVIEW_SIZE = 1100.0
WATER_PREVIEW_SUBDIVISIONS = 80


def terrain_z(x: float, y: float) -> float:
    """Analytic terrain height at world (x, y). Mountainous island:
    a gentle baseline + three gaussian domes for the mountains + a
    coastal drop past ``ISLAND_RADIUS`` so the island actually has an
    edge."""
    z = 0.0
    # Gentle rolling base so the inter-mountain valleys aren't a
    # featureless plate. ±4 m at ~70 m wavelength.
    z += 4.0 * math.sin(x * 0.014) * math.cos(y * 0.013)
    # Three mountains.
    for m in MOUNTAINS:
        dx = x - m["center"][0]
        dy = y - m["center"][1]
        d2 = dx * dx + dy * dy
        z += m["height"] * math.exp(-d2 / (m["radius"] ** 2))
    # Coast: smoothly drop below sea level past ISLAND_RADIUS.
    d = math.sqrt(x * x + y * y)
    if d > ISLAND_RADIUS:
        drop = min((d - ISLAND_RADIUS) / COAST_FALLOFF, 1.5)
        z -= 25.0 * drop
    return z


# ────────────────────────────────────────────────────────────────────
# Tunnel definitions — one Bezier curve per tunnel, deeply through
# the matching mountain.
# ────────────────────────────────────────────────────────────────────

TUNNEL_RADIUS = 9.0
TUNNEL_WALL_THICKNESS = 1.0
TUNNEL_SAMPLES = 32
TUNNEL_SEGMENTS = 14
TUNNEL_END_EXTEND = 8.0
TUNNEL_Z = 10.0  # racing-line z inside every tunnel — close to sea level

# Cylinder geometry derived from the above.
CUTTER_RADIUS = TUNNEL_RADIUS + TUNNEL_WALL_THICKNESS  # 10 m
CYLINDER_TOP = TUNNEL_Z + CUTTER_RADIUS  # 20 m — the surface-breach z


def _mouth_distance_from_peak(mountain_height: float, mountain_radius: float, cylinder_top: float) -> float:
    """Distance from a mountain's peak xy where the gaussian surface
    equals ``cylinder_top`` — i.e. where the tunnel mouth opens."""
    ratio = max(mountain_height / cylinder_top, 1.0001)
    return mountain_radius * math.sqrt(math.log(ratio))


MOUTH_DIST = _mouth_distance_from_peak(MOUNTAINS[0]["height"], MOUNTAINS[0]["radius"], CYLINDER_TOP)
# With peak=50, radius=130, cylinder_top=20 → MOUTH_DIST ≈ 122 m.
# So Mountain A's tunnel breaches surface at x = -180 ± 122 = -302 / -58.

# Each tunnel: (curve_name, 4-point Bezier anchors). All anchors at
# TUNNEL_Z so the curve runs flat through its mountain. Curve endpoints
# extend ~40 m past each mouth so the cutter cylinder's caps are clear
# of the gaussian surface and don't leave a cap-shaped hole at the
# mouth edge.
def _tunnel_anchors(peak_x: float, peak_y: float, axis: str) -> list[tuple[float, float, float]]:
    """Four-point anchor list for a horizontal tunnel through
    ``(peak_x, peak_y)``. ``axis="x"`` → tunnel runs along world X
    (mouths on east/west faces). ``axis="y"`` → tunnel runs along Y."""
    pad = MOUTH_DIST + 40.0
    if axis == "x":
        return [
            (peak_x - pad,        peak_y, TUNNEL_Z),
            (peak_x - pad / 3.0,  peak_y, TUNNEL_Z),
            (peak_x + pad / 3.0,  peak_y, TUNNEL_Z),
            (peak_x + pad,        peak_y, TUNNEL_Z),
        ]
    return [
        (peak_x, peak_y - pad,        TUNNEL_Z),
        (peak_x, peak_y - pad / 3.0,  TUNNEL_Z),
        (peak_x, peak_y + pad / 3.0,  TUNNEL_Z),
        (peak_x, peak_y + pad,        TUNNEL_Z),
    ]


TUNNELS = [
    # Tunnel A through Mountain A (SW), west↔east.
    ("tunnel_A_curve", _tunnel_anchors(*MOUNTAINS[0]["center"], "x")),
    # Tunnel B through Mountain B (SE), west↔east.
    ("tunnel_B_curve", _tunnel_anchors(*MOUNTAINS[1]["center"], "x")),
    # Tunnel C through Mountain C (N), west↔east.
    ("tunnel_C_curve", _tunnel_anchors(*MOUNTAINS[2]["center"], "x")),
]


# ────────────────────────────────────────────────────────────────────
# Racing line. Each anchor: (x, y, z_override_or_None).
# None → z = terrain_z + RACE_HOVER, so the bike rides ~2.5 m above
# the surface. Explicit z (== TUNNEL_Z) at tunnel-interior anchors
# pulls the spline into the tube.
# ────────────────────────────────────────────────────────────────────

RACE_HOVER = 2.5

# Mouth positions for each tunnel — computed analytically from
# MOUTH_DIST. The spline + checkpoints sit at the mouth-mid-mouth
# triple so the AI's straight-line steering naturally dives into the
# tunnel rather than skirting around the mountain.
A = MOUNTAINS[0]["center"]
B = MOUNTAINS[1]["center"]
C = MOUNTAINS[2]["center"]
A_W_MOUTH = (A[0] - MOUTH_DIST, A[1])
A_E_MOUTH = (A[0] + MOUTH_DIST, A[1])
B_W_MOUTH = (B[0] - MOUTH_DIST, B[1])
B_E_MOUTH = (B[0] + MOUTH_DIST, B[1])
C_W_MOUTH = (C[0] - MOUTH_DIST, C[1])
C_E_MOUTH = (C[0] + MOUTH_DIST, C[1])

# Bike altitude inside a tunnel = tunnel_floor + hover_height. Floor at
# z = TUNNEL_Z - TUNNEL_RADIUS = 1 (the cylinder bottom). Bike hovers
# at ~1.5 m above that → spline anchor at ~3 m inside the tunnel.
TUNNEL_BIKE_Z = TUNNEL_Z - TUNNEL_RADIUS + 1.5  # ≈ 2.5 m

AI_SPLINE_ANCHORS: list[tuple[float, float, float | None]] = [
    # 0: START — west of tunnel A, on coast
    (A_W_MOUTH[0] - 80.0, A_W_MOUTH[1], None),
    # 1: A west mouth approach
    A_W_MOUTH + (TUNNEL_BIKE_Z,),
    # 2: deep inside tunnel A
    (A[0], A[1], TUNNEL_BIKE_Z),
    # 3: A east mouth (gap toward B)
    A_E_MOUTH + (TUNNEL_BIKE_Z,),
    # 4: B west mouth
    B_W_MOUTH + (TUNNEL_BIKE_Z,),
    # 5: deep inside tunnel B
    (B[0], B[1], TUNNEL_BIKE_Z),
    # 6: B east mouth
    B_E_MOUTH + (TUNNEL_BIKE_Z,),
    # 7: east coast loop
    (B_E_MOUTH[0] + 80.0, B_E_MOUTH[1], None),
    ( 320.0,   60.0, None),
    # 9: C east mouth
    C_E_MOUTH + (TUNNEL_BIKE_Z,),
    # 10: deep inside tunnel C
    (C[0], C[1], TUNNEL_BIKE_Z),
    # 11: C west mouth
    C_W_MOUTH + (TUNNEL_BIKE_Z,),
    # 12: west coast loop
    (-320.0,   60.0, None),
]

START_T = 0.0
START_GRID_SPACING_M = 4.0

# Checkpoints at the four tunnel-exit mouths so the AI can't fudge
# them: skipping a tunnel makes the next checkpoint unreachable.
# Generous height tolerance + lifted z so the bike at TUNNEL_BIKE_Z
# (≈ 2.5 m) safely sits inside the trigger range.
CHECKPOINT_DEFS: list[tuple[float, float, float | None]] = [
    (A_E_MOUTH[0], A_E_MOUTH[1], TUNNEL_BIKE_Z),  # cleared tunnel A
    (B_E_MOUTH[0], B_E_MOUTH[1], TUNNEL_BIKE_Z),  # cleared tunnel B
    (C_E_MOUTH[0], C_E_MOUTH[1], TUNNEL_BIKE_Z),  # entered tunnel C from east
    (C_W_MOUTH[0], C_W_MOUTH[1], TUNNEL_BIKE_Z),  # cleared tunnel C
]
CHECKPOINT_HALF_WIDTH = 20.0
CHECKPOINT_HEIGHT = 24.0  # generous so altitude variation inside / outside the tunnel doesn't matter


# ────────────────────────────────────────────────────────────────────
# Boilerplate scene + addon load
# ────────────────────────────────────────────────────────────────────

def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def _load_addon_module():
    """Load the in-repo King Tide addon package by file path, register
    it so the export operator's scene-property reads have something to
    read. Post-2026-05 the addon is a package (``kingtide_addon/`` with
    submodules); ``submodule_search_locations`` makes the package's
    ``from . import water, ...`` lines resolve under the disk alias."""
    import sys
    pkg_dir = os.path.join(SCRIPT_DIR, "kingtide_addon")
    init_file = os.path.join(pkg_dir, "__init__.py")
    if not os.path.exists(init_file):
        print(f"[seed-tunnel-island] WARNING: {init_file} not found")
        return None
    spec = importlib.util.spec_from_file_location(
        "kingtide_addon_disk",
        init_file,
        submodule_search_locations=[pkg_dir],
    )
    if spec is None or spec.loader is None:
        return None
    addon = importlib.util.module_from_spec(spec)
    sys.modules["kingtide_addon_disk"] = addon
    spec.loader.exec_module(addon)
    # Register so the export operator's scene-property reads (terrain
    # shader, gate spacing, etc.) have something to read. Safe — the
    # seed runs in a fresh --background instance.
    try:
        addon.register()
    except Exception as e:
        print(f"[seed-tunnel-island] addon.register() raised: {e}")
    return addon


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
        # R=sway(0), G=AO(1), B=path-worn(0), A=biome(0.65 = island)
        anchor.data[i].color = (0.0, 1.0, 0.0, 0.65)
    mesh.color_attributes.active_color = anchor
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("COLOR_0")
    return terrain


def build_terrain_material(terrain: bpy.types.Object) -> None:
    """Authoring-time terrain material. Runtime swaps in
    ``mat_terrain_runtime`` at GLB load — this exists only so the
    .blend looks plausible while editing."""
    name = "mat_terrain_main"
    if name in bpy.data.materials:
        bpy.data.materials.remove(bpy.data.materials[name])
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.36, 0.42, 0.30, 1.0)  # mossy green
        bsdf.inputs["Roughness"].default_value = 0.85
    if terrain.data.materials:
        terrain.data.materials[0] = mat
    else:
        terrain.data.materials.append(mat)


# ────────────────────────────────────────────────────────────────────
# Tunnels — build each curve, sample via addon helpers, emit cutter
# + interior shell, then hook up the single shared Boolean modifier.
# ────────────────────────────────────────────────────────────────────

def _make_tunnel_curve(name: str, anchors: list[tuple[float, float, float]]) -> bpy.types.Object:
    """Spawn a 4-point Bezier with AUTO handles. Same convention as
    the addon's *Add Tunnel Starter Curve* so the user can edit + re-
    build any one of these without learning new tooling."""
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "3D"
    sp = curve_data.splines.new(type="BEZIER")
    sp.bezier_points.add(len(anchors) - 1)
    for bp, (x, y, z) in zip(sp.bezier_points, anchors):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    sp.use_cyclic_u = False
    curve_data.resolution_u = 24
    obj = bpy.data.objects.new(name, curve_data)
    obj["kind"] = "tunnel_curve"
    bpy.context.scene.collection.objects.link(obj)
    return obj


def add_tunnels(addon) -> int:
    """Build each tunnel by spawning the Bezier curve and calling
    ``addon.tunnel.build_tunnel_from_curve`` — the same path the
    addon's Build Tunnel operator uses, so author-loop and seed share
    a single source of truth for tunnel geometry.

    Returns the count of tunnels successfully built."""
    if addon is None:
        return 0
    from kingtide_addon import tunnel as tunnel_mod

    scene = bpy.context.scene
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        print("[seed-tunnel-island] no 'terrain' object — skipping tunnels")
        return 0
    built = 0
    for curve_name, anchors in TUNNELS:
        curve = _make_tunnel_curve(curve_name, anchors)
        tunnel_mod.build_tunnel_from_curve(
            scene, curve, terrain,
            radius=TUNNEL_RADIUS,
            wall_thickness=TUNNEL_WALL_THICKNESS,
            segments=TUNNEL_SEGMENTS,
            end_extend=TUNNEL_END_EXTEND,
        )
        built += 1
        print(
            f"[seed-tunnel-island] tunnel from {curve_name}: "
            f"r={TUNNEL_RADIUS:.1f} m, wall={TUNNEL_WALL_THICKNESS:.2f} m"
        )
    return built


# ────────────────────────────────────────────────────────────────────
# Water, spline, starts, checkpoints, sun
# ────────────────────────────────────────────────────────────────────

def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, WATER_HEIGHT)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 4.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.5
    obj["wave_freq"] = 0.7
    bpy.context.scene.collection.objects.link(obj)


def _spline_z_for(anchor: tuple[float, float, float | None]) -> float:
    x, y, z_override = anchor
    if z_override is not None:
        return float(z_override)
    return terrain_z(x, y) + RACE_HOVER


def add_ai_spline() -> None:
    curve = bpy.data.curves.new("ai_spline_main", type="CURVE")
    curve.dimensions = "3D"
    sp = curve.splines.new(type="NURBS")
    sp.points.add(len(AI_SPLINE_ANCHORS) - 1)
    for i, anchor in enumerate(AI_SPLINE_ANCHORS):
        x, y, _ = anchor
        z = _spline_z_for(anchor)
        sp.points[i].co = (x, y, z, 1.0)
    sp.use_endpoint_u = True
    sp.use_cyclic_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    bpy.context.scene.collection.objects.link(obj)


def _sample_spline_at_t(t: float):
    pts = [(a[0], a[1]) for a in AI_SPLINE_ANCHORS] + [(AI_SPLINE_ANCHORS[0][0], AI_SPLINE_ANCHORS[0][1])]
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
    z = terrain_z(sx, sy) + RACE_HOVER
    for i, off in enumerate([-START_GRID_SPACING_M * 0.5, +START_GRID_SPACING_M * 0.5]):
        x = sx + rx * off
        y = sy + ry * off
        obj = bpy.data.objects.new(f"start_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 6.0
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "start"
        obj["index"] = i
        obj["start_t"] = float(START_T)
        bpy.context.scene.collection.objects.link(obj)


def _spline_tangent_yaw_at(target_xy: tuple[float, float]) -> float:
    """Find the AI spline segment closest to ``target_xy`` and return
    the Blender Z-euler that makes the *runtime* gate forward point
    along the segment's tangent.

    Maps: Blender tangent (tx, ty) → three.js (tx, 0, -ty). Runtime
    gate forward = quat·(0, 0, 1) = (sin θ, 0, cos θ). Solving
    (sin θ, cos θ) = (tx, -ty) gives θ = atan2(tx, -ty), which is the
    yaw we stamp on cp.rotation_euler.z."""
    pts = [(a[0], a[1]) for a in AI_SPLINE_ANCHORS]
    n = len(pts)
    if n < 2:
        return 0.0
    # Find the anchor closest to ``target_xy`` and use the *outgoing*
    # segment's tangent — i.e. the direction the AI is travelling
    # *after* crossing the checkpoint. The gate's forward axis is
    # measured by the runtime as "the way the bike should be moving as
    # it crosses", which is the outgoing direction.
    best_d2 = float("inf")
    best_i = 0
    for i, (px, py) in enumerate(pts):
        d2 = (target_xy[0] - px) ** 2 + (target_xy[1] - py) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_i = i
    a = pts[best_i]
    b = pts[(best_i + 1) % n]
    tx = b[0] - a[0]
    ty = b[1] - a[1]
    return math.atan2(tx, -ty)


def add_checkpoints() -> None:
    for i, anchor in enumerate(CHECKPOINT_DEFS):
        x, y, z_override = anchor
        z = z_override if z_override is not None else terrain_z(x, y) + RACE_HOVER
        yaw = _spline_tangent_yaw_at((x, y))
        obj = bpy.data.objects.new(f"cp_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.location = (x, y, z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["kind"] = "checkpoint"
        obj["index"] = i
        obj["half_width"] = CHECKPOINT_HALF_WIDTH
        obj["height"] = CHECKPOINT_HEIGHT
        bpy.context.scene.collection.objects.link(obj)


def add_sun() -> None:
    light_data = bpy.data.lights.new("sun", type="SUN")
    light_data.energy = 4.5
    light_data.color = (1.0, 0.97, 0.90)
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (50.0, 50.0, 200.0)
    obj.rotation_euler = (0.55, 0.25, 0.6)
    bpy.context.scene.collection.objects.link(obj)


# ────────────────────────────────────────────────────────────────────
# Collection organisation
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
    col_tunnels  = ensure("Tunnels")
    col_water    = ensure("Water")
    col_spline   = ensure("Spline")
    col_gameplay = ensure("Gameplay")

    def move(obj, coll):
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        coll.objects.link(obj)

    for obj in list(scene.objects):
        n = obj.name
        if n == "terrain":
            move(obj, col_terrain)
        elif n.startswith("tunnel_") and (n.endswith("_curve") or n.endswith("_interior")):
            move(obj, col_tunnels)
        elif n == "water_volume_main":
            move(obj, col_water)
        elif n in ("ai_spline_main", "sun"):
            move(obj, col_spline)
        elif n.startswith(("start_", "cp_", "pickup_", "boost_")):
            move(obj, col_gameplay)


# ────────────────────────────────────────────────────────────────────
# Previews
# ────────────────────────────────────────────────────────────────────

def add_previews(addon) -> None:
    if addon is None:
        return
    scene = bpy.context.scene
    summary = addon._rebuild_water_preview(
        scene, size=WATER_PREVIEW_SIZE, subdivisions=WATER_PREVIEW_SUBDIVISIONS, time=0.0,
    )
    print(f"[seed-tunnel-island] water preview: {summary['vert_count']} verts")
    n_gates = addon._rebuild_gate_preview(scene, spacing=60.0, half_width=14.0, height=6.0)
    print(f"[seed-tunnel-island] gate preview: {n_gates} gates")
    racer_summary = addon._rebuild_racer_preview(scene)
    print(
        "[seed-tunnel-island] racer preview: "
        f"1 player + {racer_summary['ai_count']} AI bikes ({racer_summary['grid_source']})"
    )


# ────────────────────────────────────────────────────────────────────
# Headless export — replicate what the addon's *Export Track to Game*
# operator does, but driveable from --background mode.
# ────────────────────────────────────────────────────────────────────

def headless_export(addon) -> bool:
    """Export the GLB + JSON for the seeded track. Mirrors
    ``KINGTIDE_OT_export_track.execute`` minus the manifest upsert
    (which we still call separately) and the merge-with-existing-JSON
    behaviour (this is a fresh seed)."""
    if addon is None:
        print("[seed-tunnel-island] export skipped — addon module missing")
        return False
    addon.bake_ai_splines()
    errors = addon.validate_track_scene()
    if errors:
        for e in errors:
            print(f"[seed-tunnel-island] VALIDATE ERROR: {e}")
        return False

    os.makedirs(GLB_DIR, exist_ok=True)
    glb_path = os.path.join(GLB_DIR, f"{TRACK_ID}.glb")
    try:
        with addon._PreviewCollectionsHidden(bpy.context.view_layer):
            bpy.ops.export_scene.gltf(
                filepath=glb_path,
                export_format="GLB",
                export_extras=True,
                export_yup=True,
                export_apply=True,
                use_selection=False,
                use_visible=True,
                use_renderable=False,
                use_active_collection=False,
                export_cameras=False,
                export_lights=False,
                export_gpu_instances=True,
                export_gn_mesh=True,
                export_vertex_color="ACTIVE",
                export_all_vertex_colors=False,
                export_active_vertex_color_when_no_material=True,
            )
    except Exception as e:
        print(f"[seed-tunnel-island] GLB export failed: {e}")
        return False
    print(f"[seed-tunnel-island] wrote {glb_path}")

    os.makedirs(JSON_DIR, exist_ok=True)
    json_path = os.path.join(JSON_DIR, f"{TRACK_ID}.json")
    derived = addon.derive_track_json(TRACK_ID, f"/assets/tracks/{TRACK_ID}.glb")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(derived, f, indent=2)
        f.write("\n")
    print(f"[seed-tunnel-island] wrote {json_path}")

    # Manifest upsert so the level picker sees this track.
    try:
        addon._upsert_manifest_track(
            REPO_ROOT,
            track_id=TRACK_ID,
            glb_url=f"/assets/tracks/{TRACK_ID}.glb",
            json_path=json_path,
        )
        print("[seed-tunnel-island] manifest updated")
    except Exception as e:
        print(f"[seed-tunnel-island] manifest update skipped: {e}")
    return True


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def seed() -> None:
    print(f"[seed-tunnel-island] writing {OUTPUT_PATH}")
    addon = _load_addon_module()

    reset_scene()
    # Set track id so derive_track_json picks it up.
    bpy.context.scene["hoverbike_track_id"] = TRACK_ID

    terrain = build_terrain_mesh()
    build_terrain_material(terrain)
    add_water_volume()
    add_ai_spline()
    add_player_starts()
    add_checkpoints()
    add_sun()

    bpy.context.view_layer.update()
    n_tunnels = add_tunnels(addon)
    organize_collections()
    bpy.context.view_layer.update()
    add_previews(addon)
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-tunnel-island] saved .blend — {n_tunnels} tunnels built")

    if headless_export(addon):
        print("[seed-tunnel-island] export OK — open the game with ?track=template-tunnel-island")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-tunnel-island] FAILED: {e}", file=sys.stderr)
