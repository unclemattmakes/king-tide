"""Seed ``tracks-src/template-antigrav-showcase.blend`` — reference scene
for the anti-grav ribbon authoring tool.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_template_antigrav_showcase.py

### What this template shows

Three anti-grav surfaces side-by-side, one per cross-section profile.
Authors who haven't used the tool before open this .blend, pick a curve,
hit *Build Anti-Grav Surface*, and see exactly what each profile does —
a working reference next to live editing.

| Profile        | Curve              | Built mesh                | Demo |
|----------------|--------------------|---------------------------|------|
| TUBE           | ``antigrav_curve_00`` | ``antigrav_00_surface``   | Corkscrew climbing a stone pillar — Hatteras lighthouse / Doge's Campanile pattern |
| RIBBON         | ``antigrav_curve_01`` | ``antigrav_01_surface``   | Vertical wall-ride against a Cocoon Tower-style facade |
| BANKED_STRIP   | ``antigrav_curve_02`` | ``antigrav_02_surface``   | Loop with author-controlled tilts (flat → wall → ceiling → wall → flat) |

Each surface ships with its entry / exit zone empties so the runtime
controller picks up the gravity flip on traverse. The terrain is a flat
plate with three pillar-style mounds so the surfaces have something to
sit against.

### Authoring loop

1. Open the .blend, select any ``antigrav_curve_NN``.
2. Tab into edit mode, drag handles to reshape.
3. Pick the profile in the *Anti-grav surfaces* sub-panel, set
   width / radius / samples, hit *Build Anti-Grav Surface*.
4. The surface + entry / exit zones rebuild in place.

### Re-seeding

The seed wipes everything in the .blend and re-emits the three demo
curves. Hand-tuned edits are lost on re-seed — iterate from inside
Blender, not from the seed script.
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

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "template-antigrav-showcase.blend")
TRACK_ID = "template-antigrav-showcase"

TILE_SIZE = 400.0
SUBDIV = 80


def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def _load_addon_package():
    """Load + register the ``hoverbike_addon`` package so the seed can
    reach into ``antigrav_ribbon.build_antigrav_ribbon_from_curve`` etc.
    The package lives at ``tools/blender/hoverbike_addon/`` — adding
    ``SCRIPT_DIR`` to ``sys.path`` (done above) makes the package
    importable from a clean Blender ``--background`` instance.

    Falls back gracefully if the package is missing — the seed still
    writes the .blend, just without the built surfaces. Authors can
    then hit Build Anti-Grav Surface manually after opening it."""
    try:
        import hoverbike_addon as addon
    except ImportError as e:
        print(f"[seed-antigrav-showcase] hoverbike_addon import failed: {e}")
        return None
    try:
        addon.register()
    except Exception as e:  # noqa: BLE001
        print(f"[seed-antigrav-showcase] addon.register() raised: {e}")
    return addon


# ────────────────────────────────────────────────────────────────────
# Terrain — flat plate + three pillar mounds (one per anti-grav demo)
# ────────────────────────────────────────────────────────────────────

# Pillar centres. Each demo curve climbs / wraps around its own pillar
# so the three demos don't visually overlap. Pillars sit on world XY
# spaced ~140 m apart along X.
PILLAR_A = (-140.0, 0.0)   # tube corkscrew climbs this one
PILLAR_B = (   0.0, 0.0)   # ribbon wall-rides against this face
PILLAR_C = ( 140.0, 0.0)   # banked-strip loops around this one
PILLAR_RADIUS = 12.0
PILLAR_HEIGHT = 40.0


def _terrain_z(x: float, y: float) -> float:
    """Flat plate + three gaussian pillars."""
    z = 0.0
    for cx, cy in (PILLAR_A, PILLAR_B, PILLAR_C):
        dx = x - cx
        dy = y - cy
        d2 = dx * dx + dy * dy
        z += PILLAR_HEIGHT * math.exp(-d2 / (PILLAR_RADIUS * 1.4) ** 2)
    return z


def build_terrain() -> bpy.types.Object:
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
        v.co.z = _terrain_z(v.co.x, v.co.y)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = True
    terrain = bpy.data.objects.new("terrain", mesh)
    bpy.context.scene.collection.objects.link(terrain)
    terrain["kind"] = "track"

    # Authoring-time material so the plate doesn't look like a giant
    # white tile in the viewport.
    mat = bpy.data.materials.new("mat_terrain_main")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.36, 0.42, 0.30, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
    mesh.materials.append(mat)
    return terrain


# ────────────────────────────────────────────────────────────────────
# Demo curves — one per profile.
# ────────────────────────────────────────────────────────────────────


def _make_bezier_curve(name: str, points: list[tuple[float, float, float]]) -> bpy.types.Object:
    """Spawn a Bezier curve named ``name`` with AUTO-handle control
    points at ``points``. Tagged ``kind=antigrav_curve`` so the auto-tag
    pass leaves it alone."""
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 32
    sp = curve_data.splines.new(type="BEZIER")
    sp.bezier_points.add(len(points) - 1)
    for bp, (x, y, z) in zip(sp.bezier_points, points):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    sp.use_cyclic_u = False
    obj = bpy.data.objects.new(name, curve_data)
    obj["kind"] = "antigrav_curve"
    bpy.context.scene.collection.objects.link(obj)
    return obj


def make_tube_corkscrew_curve() -> bpy.types.Object:
    """A 3-turn helical corkscrew climbing pillar A. 8 control points
    walking around the pillar at radius ~PILLAR_RADIUS + 4 m. Demoes
    the tube profile under heavy banking."""
    cx, cy = PILLAR_A
    r = PILLAR_RADIUS + 4.0
    n_turns = 3
    n_points = 12
    pts: list[tuple[float, float, float]] = []
    for i in range(n_points):
        t = i / (n_points - 1)
        theta = t * n_turns * math.tau
        z = 2.0 + t * (PILLAR_HEIGHT - 4.0)
        x = cx + r * math.cos(theta)
        y = cy + r * math.sin(theta)
        pts.append((x, y, z))
    return _make_bezier_curve("antigrav_curve_00", pts)


def make_ribbon_wallride_curve() -> bpy.types.Object:
    """A horizontal ribbon at mid-pillar height running tangent to
    pillar B's east face. Demoes RIBBON — the strip lays flat
    horizontally; the *ribbon* is what reads as the wall-ride surface
    because the bike is anti-grav-stuck to it. To stand the strip up
    against the pillar face, the author would rotate the whole curve
    90° around its tangent; for the demo we keep it horizontal so the
    geometry reads cleanly in the viewport."""
    cx, cy = PILLAR_B
    east_x = cx + PILLAR_RADIUS + 2.0
    z_ride = 20.0
    pts = [
        (east_x, cy - 40.0, z_ride),
        (east_x, cy - 13.0, z_ride),
        (east_x, cy + 13.0, z_ride),
        (east_x, cy + 40.0, z_ride),
    ]
    return _make_bezier_curve("antigrav_curve_01", pts)


def make_banked_loop_curve() -> bpy.types.Object:
    """A near-loop curve around pillar C with author-stamped tilts so
    BANKED_STRIP tilts through flat → wall → ceiling → wall → flat as
    the bike traverses. Demonstrates the per-control-point tilt
    pattern authors use to wall-ride or invert."""
    cx, cy = PILLAR_C
    r = PILLAR_RADIUS + 8.0
    z_mid = 22.0
    # 9 points around a circle in the YZ plane, viewed from +X.
    # Theta = 0 is the bottom approach; pi/2 is the right wall; pi is
    # the top (ceiling); 3pi/2 is the left wall.
    n = 9
    pts: list[tuple[float, float, float]] = []
    tilts: list[float] = []
    for i in range(n):
        t = i / (n - 1)
        theta = t * math.tau * 0.9  # not quite full loop so endpoints don't overlap
        py = cy + r * math.sin(theta)
        pz = z_mid - r * math.cos(theta)
        pts.append((cx, py, max(0.5, pz)))
        # Tilt schedule: flat at theta=0, +π/2 at theta=π/2 (right
        # wall), π at theta=π (ceiling), back. Banked-strip rotates
        # the slab around the tangent by this amount.
        tilts.append(theta)
    obj = _make_bezier_curve("antigrav_curve_02", pts)
    # Stamp the per-point tilts.
    sp = obj.data.splines[0]
    for bp, tilt in zip(sp.bezier_points, tilts):
        bp.tilt = tilt
    return obj


# ────────────────────────────────────────────────────────────────────
# Build all three demos
# ────────────────────────────────────────────────────────────────────


def build_demo_surfaces(addon) -> int:
    """Build all three demo surfaces via the public
    ``build_antigrav_ribbon_from_curve`` entry point so the seed and
    the operator share a single source of truth for sweep / zone
    placement."""
    if addon is None:
        print("[seed-antigrav-showcase] addon missing — skipping surface builds")
        return 0
    from hoverbike_addon import antigrav_ribbon as agr

    scene = bpy.context.scene
    built = 0

    # Tube corkscrew.
    curve_a = bpy.data.objects.get("antigrav_curve_00")
    if curve_a is not None:
        agr.build_antigrav_ribbon_from_curve(
            scene, curve_a,
            profile=agr.PROFILE_TUBE,
            width=8.0, thickness=0.5,
            radius=4.0,
            samples=80, segments=16,
        )
        built += 1
        print("[seed-antigrav-showcase] built tube corkscrew (antigrav_00_surface)")

    # Ribbon wall-ride.
    curve_b = bpy.data.objects.get("antigrav_curve_01")
    if curve_b is not None:
        agr.build_antigrav_ribbon_from_curve(
            scene, curve_b,
            profile=agr.PROFILE_RIBBON,
            width=8.0, thickness=0.5,
            radius=8.0,
            samples=32, segments=16,
        )
        built += 1
        print("[seed-antigrav-showcase] built ribbon wall-ride (antigrav_01_surface)")

    # Banked-strip loop.
    curve_c = bpy.data.objects.get("antigrav_curve_02")
    if curve_c is not None:
        agr.build_antigrav_ribbon_from_curve(
            scene, curve_c,
            profile=agr.PROFILE_BANKED_STRIP,
            width=10.0, thickness=0.6,
            radius=8.0,
            samples=64, segments=16,
        )
        built += 1
        print("[seed-antigrav-showcase] built banked-strip loop (antigrav_02_surface)")

    return built


# ────────────────────────────────────────────────────────────────────
# Spline + starts + checkpoints — a minimal racing line that visits
# all three demo zones so a playtest run actually traverses every
# anti-grav surface.
# ────────────────────────────────────────────────────────────────────


def add_ai_spline() -> None:
    pts = [
        (PILLAR_A[0] - 50.0, PILLAR_A[1] - 50.0, 3.0),
        (PILLAR_A[0],         PILLAR_A[1] - 30.0, 3.0),
        (PILLAR_A[0] + 50.0,  PILLAR_A[1] - 50.0, 3.0),
        (PILLAR_B[0],         PILLAR_B[1] - 30.0, 3.0),
        (PILLAR_B[0] + 50.0,  PILLAR_B[1] - 50.0, 3.0),
        (PILLAR_C[0],         PILLAR_C[1] - 30.0, 3.0),
        (PILLAR_C[0] + 50.0,  PILLAR_C[1] - 50.0, 3.0),
        (PILLAR_C[0] + 50.0,  PILLAR_C[1] + 50.0, 3.0),
        (PILLAR_A[0] - 50.0,  PILLAR_A[1] + 50.0, 3.0),
    ]
    curve = bpy.data.curves.new("ai_spline_main", type="CURVE")
    curve.dimensions = "3D"
    sp = curve.splines.new(type="NURBS")
    sp.points.add(len(pts) - 1)
    for i, (x, y, z) in enumerate(pts):
        sp.points[i].co = (x, y, z, 1.0)
    sp.use_endpoint_u = True
    sp.use_cyclic_u = True
    obj = bpy.data.objects.new("ai_spline_main", curve)
    obj["kind"] = "ai_spline"
    obj["branch"] = "main"
    bpy.context.scene.collection.objects.link(obj)


def add_starts() -> None:
    """Two-bike grid just south of pillar A's corkscrew approach."""
    for i, off in enumerate((-2.0, 2.0)):
        obj = bpy.data.objects.new(f"start_{i:02d}", None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 6.0
        obj.location = (PILLAR_A[0] - 50.0 + off, PILLAR_A[1] - 55.0, 3.0)
        obj.rotation_euler = (0.0, 0.0, 0.0)
        obj["kind"] = "start"
        obj["index"] = i
        obj["start_t"] = 0.0
        bpy.context.scene.collection.objects.link(obj)


def add_water_volume() -> None:
    obj = bpy.data.objects.new("water_volume_main", None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1.0
    obj.location = (0.0, 0.0, -8.0)
    obj.scale = (TILE_SIZE * 0.5, TILE_SIZE * 0.5, 2.0)
    obj["kind"] = "water"
    obj["wave_height"] = 0.4
    obj["wave_freq"] = 0.5
    bpy.context.scene.collection.objects.link(obj)


def add_sun() -> None:
    light_data = bpy.data.lights.new("sun", type="SUN")
    light_data.energy = 4.5
    light_data.color = (1.0, 0.96, 0.88)
    obj = bpy.data.objects.new("sun", light_data)
    obj.location = (60.0, 60.0, 200.0)
    obj.rotation_euler = (0.55, 0.25, 0.6)
    bpy.context.scene.collection.objects.link(obj)


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────


def seed() -> None:
    print(f"[seed-antigrav-showcase] writing {OUTPUT_PATH}")
    addon = _load_addon_package()

    reset_scene()
    bpy.context.scene["hoverbike_track_id"] = TRACK_ID

    build_terrain()
    add_water_volume()
    add_ai_spline()
    add_starts()
    add_sun()

    # Curves — one per profile demo.
    make_tube_corkscrew_curve()
    make_ribbon_wallride_curve()
    make_banked_loop_curve()

    bpy.context.view_layer.update()
    n_built = build_demo_surfaces(addon)
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)
    print(f"[seed-antigrav-showcase] saved .blend — {n_built} demo surfaces built")


if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-antigrav-showcase] FAILED: {e}", file=sys.stderr)
