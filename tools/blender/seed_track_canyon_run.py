"""Build ``tracks-src/canyon-run.blend`` + GLB/JSON exports.

Run (after ``seed_template_mesa.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_canyon_run.py

Loads ``template-mesa.blend``, reshapes the AI spline into an
inter-mesa figure-8, applies the HV_Mesa modifier into the source
mesh, builds the road through the canyon and up onto the SE plateau,
snaps the spline (water-aware so the canyon-floor section clamps to
the river surface), lints, exports.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

TRACK_ID = "canyon-run"
TEMPLATE_BLEND = os.path.join(REPO_ROOT, "tracks-src", "template-mesa.blend")
OUTPUT_BLEND   = os.path.join(REPO_ROOT, "tracks-src", f"{TRACK_ID}.blend")

# Racing line: a long meander threading the canyon channels between
# the SE, NE, NW, SW mesas, climbing partway up the SE plateau on the
# way through (the SE mesa's 60 m top is approachable from the south
# where the cliff foot tapers in). Snap-spline-to-terrain refines z.
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -380.0, -2.0),  # south canyon entrance
    ( 160.0, -340.0, -2.0),
    ( 280.0, -220.0, 12.0),  # climbing onto SE plateau approach
    ( 360.0,  -40.0, -2.0),  # dropping back into NE canyon channel
    ( 280.0,  150.0, -2.0),
    (  80.0,  300.0, -2.0),  # N canyon between center spire + NE
    (-100.0,  320.0, -2.0),
    (-260.0,  220.0, -2.0),  # NW canyon
    (-380.0,    0.0, -2.0),  # W canyon
    (-300.0, -180.0, -2.0),  # SW canyon
    (-120.0, -340.0, -2.0),  # rejoin start straight
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
# Above the river surface so the bike spawns visibly on the water and
# hover physics settle cleanly (matches the convention of other tracks).
START_Z = 4.0

# Road tool — narrower than dunes to read as a canyon trail.
ROAD_WIDTH        = 12.0
ROAD_LIFT         = 0.3
ROAD_BLEND_RADIUS = 7.0
ROAD_SAMPLES      = 128
ROAD_SMOOTH       = 6   # canyon has steep transitions — smooth aggressively
ROAD_CURB_WIDTH   = 0.7
ROAD_CURB_HEIGHT  = 0.16
ROAD_CURB_STRIPE  = 2.0
ROAD_THICKNESS    = 0.7
SNAP_HOVER_M      = 3.5
GATE_SPACING_M    = 65.0


def _load_addon():
    addon_file = os.path.join(SCRIPT_DIR, "hoverbike_addon.py")
    spec = importlib.util.spec_from_file_location("hoverbike_addon_disk", addon_file)
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    sys.modules["hoverbike_addon_disk"] = addon
    addon.register()
    return addon


def _reshape_spline() -> None:
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None:
        raise RuntimeError("template-mesa.blend has no ai_spline_main")
    curve = bpy.data.curves.new("ai_spline_main_new", type="CURVE")
    curve.dimensions = "3D"
    spl = curve.splines.new(type="NURBS")
    spl.points.add(len(AI_SPLINE_ANCHORS) - 1)
    for i, (x, y, z) in enumerate(AI_SPLINE_ANCHORS):
        spl.points[i].co = (x, y, z, 1.0)
    spl.use_endpoint_u = True
    spl.use_cyclic_u = True
    old_curve = sp.data
    sp.data = curve
    if old_curve.users == 0:
        bpy.data.curves.remove(old_curve)
    curve.name = "ai_spline_main"


def _replace_starts_and_checkpoints() -> None:
    def sample_at_t(t: float):
        pts = list(AI_SPLINE_ANCHORS) + [AI_SPLINE_ANCHORS[0]]
        seg_lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
        total = sum(seg_lengths)
        target = max(0.0, min(1.0, t)) * total
        accum = 0.0
        for i, seg_len in enumerate(seg_lengths):
            if accum + seg_len >= target or i == len(seg_lengths) - 1:
                f = (target - accum) / seg_len if seg_len > 0 else 0.0
                a = pts[i]; b = pts[i + 1]
                sx = a[0] + f * (b[0] - a[0]); sy = a[1] + f * (b[1] - a[1])
                tx = b[0] - a[0]; ty = b[1] - a[1]
                tmag = math.hypot(tx, ty) or 1.0
                return (sx, sy), (tx / tmag, ty / tmag)
            accum += seg_len
        return (pts[0][0], pts[0][1]), (0.0, 1.0)

    (sx, sy), (tx, ty) = sample_at_t(START_T)
    yaw = math.atan2(tx, ty)
    rx, ry = ty, -tx
    for i, off in enumerate([-START_GRID_SPACING_M * 0.5, +START_GRID_SPACING_M * 0.5]):
        name = f"start_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        obj.location = (sx + rx * off, sy + ry * off, START_Z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        obj["start_t"] = float(START_T)

    for i, t in enumerate([0.25, 0.5, 0.75, 0.9]):
        name = f"cp_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        (cx, cy), _ = sample_at_t(t)
        obj.location = (cx, cy, START_Z)


def _set_road_props(scene) -> None:
    scene.hoverbike_road_width = ROAD_WIDTH
    scene.hoverbike_road_lift = ROAD_LIFT
    scene.hoverbike_road_blend_radius = ROAD_BLEND_RADIUS
    scene.hoverbike_road_samples = ROAD_SAMPLES
    scene.hoverbike_road_smooth_passes = ROAD_SMOOTH
    scene.hoverbike_road_curb_width = ROAD_CURB_WIDTH
    scene.hoverbike_road_curb_height = ROAD_CURB_HEIGHT
    scene.hoverbike_road_curb_stripe_length = ROAD_CURB_STRIPE
    scene.hoverbike_road_thickness = ROAD_THICKNESS
    scene.hoverbike_gate_spacing = GATE_SPACING_M
    scene.hoverbike_snap_hover_height = SNAP_HOVER_M


def _select_terrain_active(scene) -> None:
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        return
    for o in scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)


def build() -> None:
    print(f"[seed-track-canyon-run] loading {TEMPLATE_BLEND}")
    bpy.ops.wm.open_mainfile(filepath=TEMPLATE_BLEND)

    addon = _load_addon()
    scene = bpy.context.scene

    print("[seed-track-canyon-run] reshaping ai_spline_main")
    _reshape_spline()
    _replace_starts_and_checkpoints()
    _set_road_props(scene)

    print(f"[seed-track-canyon-run] saving {OUTPUT_BLEND}")
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    _select_terrain_active(scene)

    print("[seed-track-canyon-run] building road (apply_modifiers=True)")
    result = bpy.ops.hoverbike.build_road(apply_modifiers=True)
    if "FINISHED" not in result:
        raise RuntimeError(f"build_road failed: {result}")

    print("[seed-track-canyon-run] snapping spline to terrain (water-aware)")
    result = bpy.ops.hoverbike.snap_spline_to_terrain()
    if "FINISHED" not in result:
        raise RuntimeError(f"snap_spline_to_terrain failed: {result}")

    addon._rebuild_water_preview(scene, size=700.0, subdivisions=120, time=0.0)
    addon._rebuild_gate_preview(scene, spacing=GATE_SPACING_M, half_width=14.0, height=6.0)
    addon._rebuild_racer_preview(scene)
    addon._rebuild_turn_indicators(scene, kappa_threshold=0.02, min_spacing_m=20.0)

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    print("[seed-track-canyon-run] linting")
    errors, warnings = addon._lint_track(scene)
    for w in warnings:
        print(f"  WARN: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        raise RuntimeError(f"lint failed: {errors}")

    print("[seed-track-canyon-run] exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"export_track failed: {result}")

    print(f"[seed-track-canyon-run] done")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-canyon-run] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
