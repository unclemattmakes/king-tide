"""Headless track-build driver — loads a biome template, reshapes the
racing line, applies the modifier, builds the road, snaps the spline,
lints, exports.

Each per-track ``seed_track_<id>.py`` is a ~50-line config that builds
a ``TrackSpec`` and calls :func:`build_track_from_spec`. Reproducibility:
re-running stomps the .blend / GLB / JSON.

This is the in-Blender equivalent of the ``pnpm gen:tracks`` JSON-spec
pipeline (``tools/blender/build_track.py``), but for tracks that *sit
on top of an existing template* rather than building the scene from
scratch.

Example::

    from track_build_lib import TrackSpec, REPO_ROOT, build_track_from_spec
    import os

    SPEC = TrackSpec(
        track_id="dune-rally",
        template_blend=os.path.join(REPO_ROOT, "tracks-src", "template-dunes.blend"),
        spline_anchors=[(0.0, -300.0, 24.0), (220.0, -240.0, 24.0), ...],
        road_width=14.0,
    )
    if __name__ == "__main__":
        build_track_from_spec(SPEC)
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
from dataclasses import dataclass, field

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))


@dataclass
class TrackSpec:
    # ── Required identity + source ──────────────────────────────────
    track_id: str
    """Lowercase-hyphenated id; basename of the output .blend / GLB / JSON."""

    template_blend: str
    """Absolute path to the biome template .blend to load."""

    spline_anchors: list[tuple[float, float, float]]
    """NURBS control-point sequence for the new ``ai_spline_main``.
    The snap-to-terrain pass refines the Z values."""

    # ── Start / checkpoint placement ────────────────────────────────
    start_t: float = 0.0
    """Arc-length parameter along the new spline for ``start_00``."""

    checkpoint_ts: tuple[float, ...] = (0.25, 0.5, 0.75, 0.9)
    """t-values for cp_00..cp_03. Length must match the template's cp count."""

    start_grid_spacing_m: float = 4.0
    """Lateral distance between start_00 and start_01."""

    # ── Road tool parameters ────────────────────────────────────────
    road_width: float = 12.0
    road_lift: float = 0.25
    road_blend_radius: float = 7.0
    road_samples: int = 96
    road_smooth_passes: int = 5
    road_curb_width: float = 0.7
    road_curb_height: float = 0.16
    road_curb_stripe: float = 2.0
    road_thickness: float = 0.6

    # ── Snap / gate / preview parameters ────────────────────────────
    snap_hover_m: float = 3.5
    gate_spacing_m: float = 60.0
    water_preview_size: float = 700.0
    water_preview_subdivisions: int = 120
    turn_kappa: float = 0.02
    turn_min_spacing: float = 20.0


# ────────────────────────────────────────────────────────────────────
# Driver
# ────────────────────────────────────────────────────────────────────

def _load_addon():
    """Import the on-disk hoverbike_addon.py by path and register it."""
    addon_file = os.path.join(SCRIPT_DIR, "hoverbike_addon.py")
    spec = importlib.util.spec_from_file_location("hoverbike_addon_disk", addon_file)
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    sys.modules["hoverbike_addon_disk"] = addon
    addon.register()
    return addon


def _reshape_spline(anchors: list[tuple[float, float, float]]) -> None:
    """Replace ``ai_spline_main``'s control points with `anchors`. The
    curve object and custom props are preserved."""
    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None:
        raise RuntimeError("template scene has no ai_spline_main")
    curve = bpy.data.curves.new("ai_spline_main_new", type="CURVE")
    curve.dimensions = "3D"
    spl = curve.splines.new(type="NURBS")
    spl.points.add(len(anchors) - 1)
    for i, (x, y, z) in enumerate(anchors):
        spl.points[i].co = (x, y, z, 1.0)
    spl.use_endpoint_u = True
    spl.use_cyclic_u = True
    old_curve = sp.data
    sp.data = curve
    if old_curve.users == 0:
        bpy.data.curves.remove(old_curve)
    curve.name = "ai_spline_main"


def _sample_anchor_polyline_at_t(anchors, t: float):
    """Sample the cyclic polyline through `anchors` at arc-length t∈[0,1].
    Returns ((x, y), (tx, ty)) with the tangent normalized."""
    pts = list(anchors) + [anchors[0]]
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


def _reposition_checkpoints(spec: TrackSpec) -> None:
    """Re-place cp_00..cp_NN at the configured t values, in the XY plane
    along the new spline. Z is left at whatever the template seed
    initialised them to — the runtime cares about the gate plane's
    centre, not its altitude, and the post-spline-snap z gets sampled
    on the racing line by the in-app editor's gate auto-place."""
    for i, t in enumerate(spec.checkpoint_ts):
        name = f"cp_{i:02d}"
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        (cx, cy), _ = _sample_anchor_polyline_at_t(spec.spline_anchors, t)
        obj.location = (cx, cy, obj.location.z)


def _apply_road_scene_props(scene, spec: TrackSpec) -> None:
    scene.hoverbike_road_width = spec.road_width
    scene.hoverbike_road_lift = spec.road_lift
    scene.hoverbike_road_blend_radius = spec.road_blend_radius
    scene.hoverbike_road_samples = spec.road_samples
    scene.hoverbike_road_smooth_passes = spec.road_smooth_passes
    scene.hoverbike_road_curb_width = spec.road_curb_width
    scene.hoverbike_road_curb_height = spec.road_curb_height
    scene.hoverbike_road_curb_stripe_length = spec.road_curb_stripe
    scene.hoverbike_road_thickness = spec.road_thickness
    scene.hoverbike_gate_spacing = spec.gate_spacing_m
    scene.hoverbike_snap_hover_height = spec.snap_hover_m
    # Used by the snap-starts-to-spline operator.
    scene.hoverbike_start_grid_spacing = spec.start_grid_spacing_m
    scene.hoverbike_placement_t = spec.start_t


def _select_terrain_active(scene) -> None:
    """Make the terrain mesh the active object so the road tool picks
    it up unambiguously."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None:
        return
    for o in scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)


def build_track_from_spec(spec: TrackSpec) -> None:
    """Drive the full template → playable track pipeline headlessly.

    Steps: load template → reshape spline → reposition starts +
    checkpoints → save .blend → build road (apply_modifiers=True) →
    snap spline (water-aware) → rebuild previews → save .blend →
    lint → export GLB + JSON + manifest entry."""
    tag = f"[track-build:{spec.track_id}]"
    output_blend = os.path.join(REPO_ROOT, "tracks-src", f"{spec.track_id}.blend")

    print(f"{tag} loading {spec.template_blend}")
    bpy.ops.wm.open_mainfile(filepath=spec.template_blend)

    addon = _load_addon()
    scene = bpy.context.scene

    print(f"{tag} reshaping ai_spline_main + repositioning starts/checkpoints")
    _reshape_spline(spec.spline_anchors)
    _apply_road_scene_props(scene, spec)
    # Use the new addon operator so per-track scripts don't reinvent
    # the start-placement math. The operator reads start_t from
    # scene.hoverbike_placement_t (set in _apply_road_scene_props).
    snap_result = bpy.ops.hoverbike.snap_starts_to_spline()
    if "FINISHED" not in snap_result:
        raise RuntimeError(f"{tag} snap_starts_to_spline failed: {snap_result}")
    _reposition_checkpoints(spec)

    print(f"{tag} saving {output_blend}")
    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    _select_terrain_active(scene)

    print(f"{tag} building road (apply_modifiers=True)")
    result = bpy.ops.hoverbike.build_road(apply_modifiers=True)
    if "FINISHED" not in result:
        raise RuntimeError(f"{tag} build_road failed: {result}")

    print(f"{tag} snapping spline to terrain (water-aware)")
    result = bpy.ops.hoverbike.snap_spline_to_terrain()
    if "FINISHED" not in result:
        raise RuntimeError(f"{tag} snap_spline_to_terrain failed: {result}")

    addon._rebuild_water_preview(
        scene, size=spec.water_preview_size,
        subdivisions=spec.water_preview_subdivisions, time=0.0,
    )
    addon._rebuild_gate_preview(scene, spacing=spec.gate_spacing_m, half_width=14.0, height=6.0)
    addon._rebuild_racer_preview(scene)
    addon._rebuild_turn_indicators(
        scene, kappa_threshold=spec.turn_kappa, min_spacing_m=spec.turn_min_spacing,
    )

    bpy.ops.wm.save_as_mainfile(filepath=output_blend)

    print(f"{tag} linting")
    errors, warnings = addon._lint_track(scene)
    for w in warnings:
        print(f"  WARN: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        raise RuntimeError(f"{tag} lint failed: {errors}")

    print(f"{tag} exporting GLB + JSON + manifest")
    result = bpy.ops.hoverbike.export_track()
    if "FINISHED" not in result:
        raise RuntimeError(f"{tag} export_track failed: {result}")

    print(f"{tag} done")
