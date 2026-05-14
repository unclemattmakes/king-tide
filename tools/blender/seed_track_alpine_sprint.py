"""Build ``tracks-src/alpine-sprint.blend`` + GLB/JSON exports.

Run (after ``seed_template_alpine.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_alpine_sprint.py

Loads ``template-alpine.blend``, keeps the default valley-floor oval
racing line (it's already shaped for the biome), applies the HV_Alpine
modifier, builds a narrower-than-default road that hugs the river
along the valley floor, water-snaps the spline (the central river
sections clamp to the river surface), lints, exports.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

TRACK_ID = "alpine-sprint"
TEMPLATE_BLEND = os.path.join(REPO_ROOT, "tracks-src", "template-alpine.blend")
OUTPUT_BLEND   = os.path.join(REPO_ROOT, "tracks-src", f"{TRACK_ID}.blend")

# Oval racing line in the valley; same shape as the template default
# but with smoother U-turns (more anchors on the apex curve).
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (-400.0, +30.0, -2.0),
    (   0.0, +35.0, -2.0),  # slight cross-fade between straights
    ( +400.0, +30.0, -2.0),
    ( +440.0, +15.0, -2.0),  # east U-turn entry
    ( +455.0,   0.0, -2.0),  # east apex
    ( +440.0, -15.0, -2.0),  # east U-turn exit
    ( +400.0, -30.0, -2.0),
    (   0.0, -35.0, -2.0),
    ( -400.0, -30.0, -2.0),
    ( -440.0, -15.0, -2.0),
    ( -455.0,   0.0, -2.0),  # west apex
    ( -440.0, +15.0, -2.0),
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
# Above the river surface so the bike spawns visibly on the water and
# hover physics settle cleanly (matches the convention of other tracks).
START_Z = 4.0

# Narrow road for a "river canyon trail" feel.
ROAD_WIDTH        = 11.0
ROAD_LIFT         = 0.3
ROAD_BLEND_RADIUS = 6.0
ROAD_SAMPLES      = 128
ROAD_SMOOTH       = 4
ROAD_CURB_WIDTH   = 0.6
ROAD_CURB_HEIGHT  = 0.15
ROAD_CURB_STRIPE  = 2.0
ROAD_THICKNESS    = 0.55
SNAP_HOVER_M      = 3.5
GATE_SPACING_M    = 55.0


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
        raise RuntimeError("template-alpine.blend has no ai_spline_main")
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

    for i, t in enumerate([0.18, 0.45, 0.70, 0.92]):
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
    print(f"[seed-track-alpine-sprint] loading {TEMPLATE_BLEND}")
    bpy.ops.wm.open_mainfile(filepath=TEMPLATE_BLEND)

    addon = _load_addon()
    scene = bpy.context.scene

    print("[seed-track-alpine-sprint] reshaping ai_spline_main")
    _reshape_spline()
    _replace_starts_and_checkpoints()
    _set_road_props(scene)

    print(f"[seed-track-alpine-sprint] saving {OUTPUT_BLEND}")
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    _select_terrain_active(scene)

    print("[seed-track-alpine-sprint] building road (apply_modifiers=True)")
    result = bpy.ops.hoverbike.build_road(apply_modifiers=True)
    if "FINISHED" not in result:
        raise RuntimeError(f"build_road failed: {result}")

    print("[seed-track-alpine-sprint] snapping spline to terrain (water-aware)")
    result = bpy.ops.hoverbike.snap_spline_to_terrain()
    if "FINISHED" not in result:
        raise RuntimeError(f"snap_spline_to_terrain failed: {result}")

    addon._rebuild_water_preview(scene, size=900.0, subdivisions=160, time=0.0)
    addon._rebuild_gate_preview(scene, spacing=GATE_SPACING_M, half_width=14.0, height=6.0)
    addon._rebuild_racer_preview(scene)
    addon._rebuild_turn_indicators(scene, kappa_threshold=0.02, min_spacing_m=20.0)

    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    print("[seed-track-alpine-sprint] linting")
    errors, warnings = addon._lint_track(scene)
    for w in warnings:
        print(f"  WARN: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        raise RuntimeError(f"lint failed: {errors}")

    print("[seed-track-alpine-sprint] exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"export_track failed: {result}")

    print(f"[seed-track-alpine-sprint] done")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-alpine-sprint] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
