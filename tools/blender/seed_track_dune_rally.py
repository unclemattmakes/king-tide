"""Build ``tracks-src/dune-rally.blend`` + GLB/JSON exports.

Run (after ``seed_template_dunes.py``):
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_track_dune_rally.py

Loads ``template-dunes.blend``, reshapes the AI spline into the
dune-rally racing line (an off-axis figure-O that sweeps the western
dune crest, dips into the oasis-edge bank, and climbs the east shoulder),
applies the HV_Dunes Geometry Nodes modifier into the source mesh,
builds the road, water-snaps the spline back onto the conformed surface,
auto-places ramps at the sharpest curvature peaks, lints, and exports
GLB + JSON + manifest entry — all headlessly.

Reproducibility: the script is the source of truth. Re-running stomps
the .blend / GLB / JSON. Hand-edits go via the addon's interactive
flow against the resulting .blend (the editor-owned fields in the JSON
survive subsequent re-exports per ``_merge_export_json``)."""

from __future__ import annotations

import importlib.util
import math
import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

TRACK_ID = "dune-rally"
TEMPLATE_BLEND = os.path.join(REPO_ROOT, "tracks-src", "template-dunes.blend")
OUTPUT_BLEND   = os.path.join(REPO_ROOT, "tracks-src", f"{TRACK_ID}.blend")

# Racing line: an asymmetric loop that hugs the south + east of the
# oasis basin, climbs the western dune at ~350m from the basin centre,
# and dives back through a sandy choke at the north. Z values are
# approximate — the snap-to-terrain pass refines them.
AI_SPLINE_ANCHORS: list[tuple[float, float, float]] = [
    (   0.0, -300.0, 24.0),  # south straight
    ( 220.0, -240.0, 24.0),  # SE turn-in
    ( 340.0,  -80.0, 28.0),  # east shoulder (high)
    ( 320.0,  120.0, 28.0),  # east apex
    ( 180.0,  300.0, 24.0),  # north straight
    ( -60.0,  340.0, 24.0),  # north choke
    (-260.0,  240.0, 28.0),  # west shoulder (high)
    (-360.0,    0.0, 28.0),  # west apex
    (-280.0, -200.0, 24.0),  # SW turn
    ( -80.0, -310.0, 24.0),  # back to start straight
]

START_T = 0.0
START_GRID_SPACING_M = 4.0
START_Z = 24.0

# Road tool settings — wider than default to read as a desert highway.
ROAD_WIDTH        = 14.0
ROAD_LIFT         = 0.25
ROAD_BLEND_RADIUS = 8.0
ROAD_SAMPLES      = 96
ROAD_SMOOTH       = 5
ROAD_CURB_WIDTH   = 0.8
ROAD_CURB_HEIGHT  = 0.18
ROAD_CURB_STRIPE  = 2.5
ROAD_THICKNESS    = 0.6

# Snap-spline hover (lift above ground).
SNAP_HOVER_M = 3.5

GATE_SPACING_M = 70.0


# ────────────────────────────────────────────────────────────────────
# Load the addon module so we can call its helpers / register operators
# ────────────────────────────────────────────────────────────────────

def _load_addon():
    """Import the on-disk hoverbike_addon.py by path and register it.
    Returns the imported module."""
    addon_file = os.path.join(SCRIPT_DIR, "hoverbike_addon.py")
    spec = importlib.util.spec_from_file_location("hoverbike_addon_disk", addon_file)
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    sys.modules["hoverbike_addon_disk"] = addon
    addon.register()
    return addon


# ────────────────────────────────────────────────────────────────────
# Scene manipulation
# ────────────────────────────────────────────────────────────────────

def _reshape_spline() -> None:
    """Replace the existing ai_spline_main control points with the
    dune-rally anchor list. Preserves the curve object + custom props."""
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None:
        raise RuntimeError("template-dunes.blend has no ai_spline_main")
    # Rebuild the curve data from scratch so the point count matches.
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
    """Re-derive start_00 / start_01 from the new spline and reposition
    cp_00..cp_03 at quartile points so the lap arc length is sensible."""
    # Sample spline at param t along the linear-polyline approximation.
    def sample_at_t(t: float):
        pts = list(AI_SPLINE_ANCHORS) + [AI_SPLINE_ANCHORS[0]]
        seg_lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
        total = sum(seg_lengths)
        target = max(0.0, min(1.0, t)) * total
        accum = 0.0
        for i, seg_len in enumerate(seg_lengths):
            if accum + seg_len >= target or i == len(seg_lengths) - 1:
                f = (target - accum) / seg_len if seg_len > 0 else 0.0
                a = pts[i]
                b = pts[i + 1]
                sx = a[0] + f * (b[0] - a[0])
                sy = a[1] + f * (b[1] - a[1])
                tx = b[0] - a[0]
                ty = b[1] - a[1]
                tmag = math.hypot(tx, ty) or 1.0
                return (sx, sy), (tx / tmag, ty / tmag)
            accum += seg_len
        return (pts[0][0], pts[0][1]), (0.0, 1.0)

    # Move starts
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

    # Move checkpoints to quartile arc-length points
    for i, t in enumerate([0.25, 0.5, 0.75, 0.9]):
        name = f"cp_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        (cx, cy), _tangent = sample_at_t(t)
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
    """Set the terrain mesh as the active object so build_road picks it
    up unambiguously."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        return
    for o in scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)


# ────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────

def build() -> None:
    print(f"[seed-track-dune-rally] loading {TEMPLATE_BLEND}")
    bpy.ops.wm.open_mainfile(filepath=TEMPLATE_BLEND)

    addon = _load_addon()
    scene = bpy.context.scene

    print("[seed-track-dune-rally] reshaping ai_spline_main")
    _reshape_spline()
    _replace_starts_and_checkpoints()
    _set_road_props(scene)

    # Save as the new track .blend immediately so bpy.data.filepath is set
    # — the export operator requires a saved file to derive the track id.
    print(f"[seed-track-dune-rally] saving {OUTPUT_BLEND}")
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    _select_terrain_active(scene)

    print("[seed-track-dune-rally] building road (apply_modifiers=True)")
    result = bpy.ops.hoverbike.build_road(apply_modifiers=True)
    if "FINISHED" not in result:
        raise RuntimeError(f"build_road failed: {result}")

    print("[seed-track-dune-rally] snapping spline to terrain (water-aware)")
    result = bpy.ops.hoverbike.snap_spline_to_terrain()
    if "FINISHED" not in result:
        raise RuntimeError(f"snap_spline_to_terrain failed: {result}")

    # Rebuild previews so the .blend opens with the right HUD next time.
    addon._rebuild_water_preview(scene, size=360.0, subdivisions=80, time=0.0)
    addon._rebuild_gate_preview(scene, spacing=GATE_SPACING_M, half_width=14.0, height=6.0)
    addon._rebuild_racer_preview(scene)
    addon._rebuild_turn_indicators(scene, kappa_threshold=0.02, min_spacing_m=20.0)

    # Save the .blend with the road + snapped spline + previews before export.
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_BLEND)

    print("[seed-track-dune-rally] linting")
    errors, warnings = addon._lint_track(scene)
    for w in warnings:
        print(f"  WARN: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        raise RuntimeError(f"lint failed: {errors}")

    print("[seed-track-dune-rally] exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"export_track failed: {result}")

    print(f"[seed-track-dune-rally] done")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[seed-track-dune-rally] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
