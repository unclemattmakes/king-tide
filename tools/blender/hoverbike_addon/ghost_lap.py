"""Ghost-lap overlay + chase cam.

Animates a bike silhouette along ``ai_spline_main`` at a constant
target speed and attaches a chase camera so the author can hit
Spacebar and see the lap as the player will. The ghost lives in a
``_hoverbike_ghost_lap_preview`` collection (which the export scrubs
out), uses a Follow Path constraint so the curve's actual NURBS shape
drives the motion, and parents the camera to the ghost with a
back-and-up offset.

Why Follow Path over per-frame keyframes: the spline is already the
source of truth — Follow Path automatically interpolates between
control points and reuses Blender's existing path-animation evaluator.
Frame keyframes would diverge if the spline were re-edited mid-lap.
"""

from __future__ import annotations

import bpy
from bpy.props import FloatProperty, IntProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

GHOST_LAP_COLLECTION = "_hoverbike_ghost_lap_preview"
GHOST_BIKE_NAME = "ghost_bike"
GHOST_CAMERA_NAME = "ghost_chase_cam"
GHOST_DEFAULT_SPEED_MS = 25.0  # constant target speed for the lap


# ────────────────────────────────────────────────────────────────────
# Mesh + scene helpers
# ────────────────────────────────────────────────────────────────────


def _ghost_bike_mesh(name: str) -> bpy.types.Mesh:
    """Wireframe bike for the ghost — same geometry as the racer
    preview but slightly larger so it reads at viewport scale during
    the fly-around."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    half_w = 0.7
    z_lo = 0.0
    z_hi = 0.8
    y_tail = -1.5
    y_nose_base = 1.2
    y_nose_tip = 1.8
    verts = [
        (-half_w, y_tail, z_lo), (half_w, y_tail, z_lo),
        (half_w, y_nose_base, z_lo), (-half_w, y_nose_base, z_lo),
        (-half_w, y_tail, z_hi), (half_w, y_tail, z_hi),
        (half_w, y_nose_base, z_hi), (-half_w, y_nose_base, z_hi),
        (0, y_nose_tip, z_lo), (0, y_nose_tip, z_hi),
        (0, 0, z_hi + 0.65),      # rider hump top
        (0, -0.6, z_hi + 0.15),
        (0, 0.6, z_hi + 0.15),
    ]
    edges = [
        (0, 1), (1, 2), (2, 3), (3, 0),
        (4, 5), (5, 6), (6, 7), (7, 4),
        (0, 4), (1, 5), (2, 6), (3, 7),
        (2, 8), (3, 8), (6, 9), (7, 9), (8, 9),
        (10, 11), (10, 12), (11, 12),
    ]
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _wipe_ghost_lap() -> None:
    coll = bpy.data.collections.get(GHOST_LAP_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            # Drop the camera datablock too so the file doesn't
            # accumulate stale orphan cameras after repeated rebuilds.
            data = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if isinstance(data, (bpy.types.Camera, bpy.types.Mesh)) and data.users == 0:
                if isinstance(data, bpy.types.Camera):
                    bpy.data.cameras.remove(data)
                else:
                    bpy.data.meshes.remove(data)
        bpy.data.collections.remove(coll)


def _rebuild_ghost_lap(scene, *, target_speed_ms: float, fps: int) -> dict:
    """Build (or rebuild) the ghost-lap collection: one bike silhouette
    bound to ``ai_spline_main`` via Follow Path, plus a chase camera
    parented behind it. Sets the scene frame range to one full lap at
    constant speed.

    Returns a summary for the operator report."""
    from ._legacy import _find_layer_collection, _spline_arc_length

    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError("Ghost lap needs an `ai_spline_main` curve in the scene.")
    if not (target_speed_ms > 0):
        raise RuntimeError("Target speed must be positive (m/s).")

    arc = _spline_arc_length(sp)
    if arc <= 0:
        raise RuntimeError("`ai_spline_main` has zero arc length — can't animate.")

    lap_seconds = arc / target_speed_ms
    fps_safe = max(1, int(fps))
    lap_frames = max(2, int(round(lap_seconds * fps_safe)))

    _wipe_ghost_lap()
    coll = bpy.data.collections.new(GHOST_LAP_COLLECTION)
    scene.collection.children.link(coll)

    # Configure the curve for animation. ``use_path`` enables the
    # eval-time animation; we keyframe ``eval_time`` from 0 to
    # ``path_duration`` over the scene frame range so the ghost sweeps
    # the whole loop.
    sp.data.use_path = True
    sp.data.path_duration = lap_frames
    # ``use_path_follow`` makes Follow Path rotate the bike to match
    # the curve tangent — without it the bike would slide sideways.
    sp.data.use_radius = False

    # Ghost bike — empty mesh + Follow Path constraint.
    bike_mesh = _ghost_bike_mesh(GHOST_BIKE_NAME + "_mesh")
    bike = bpy.data.objects.new(GHOST_BIKE_NAME, bike_mesh)
    bike.hide_render = True
    coll.objects.link(bike)
    follow = bike.constraints.new(type="FOLLOW_PATH")
    follow.target = sp
    # Blender's Follow Path forward / up convention: forward is the
    # constraint's ``forward_axis``. Our bike silhouette's length runs
    # along +Y, so set forward = +Y, up = +Z.
    follow.forward_axis = "FORWARD_Y"
    follow.up_axis = "UP_Z"
    follow.use_curve_follow = True

    # Animate the curve's eval_time: 0 at frame 1 → path_duration at
    # frame 1 + lap_frames. Linear interpolation = constant speed.
    # Blender 4.4+ replaced the legacy ``Action.fcurves.new(...)`` API
    # with the slot-aware ``fcurve_ensure_for_datablock(...)`` helper;
    # we go through it so the action's layer + slot + channelbag are
    # all created correctly.
    sp.data.animation_data_clear()
    sp.data.animation_data_create()
    action = bpy.data.actions.new(name="hoverbike_ghost_lap")
    sp.data.animation_data.action = action
    fcu = action.fcurve_ensure_for_datablock(sp.data, "eval_time")
    # Clear any prior keys (re-runs reuse the same fcurve via slot).
    while len(fcu.keyframe_points) > 0:
        fcu.keyframe_points.remove(fcu.keyframe_points[0])
    kp0 = fcu.keyframe_points.insert(frame=1.0, value=0.0)
    kp0.interpolation = "LINEAR"
    kp1 = fcu.keyframe_points.insert(frame=1.0 + lap_frames, value=float(lap_frames))
    kp1.interpolation = "LINEAR"

    # Chase camera — parented to the ghost so it inherits the spline
    # follow. Offset: 8m back along bike's -Y (tail), 3m up Z. A
    # Track-To constraint keeps it pointed at the bike no matter how
    # the spline twists, with the world-Z "up" guard so the horizon
    # doesn't roll through banked corners.
    cam_data = bpy.data.cameras.new(GHOST_CAMERA_NAME)
    cam_data.lens = 28.0
    cam_data.clip_start = 0.5
    cam_data.clip_end = 2000.0
    cam = bpy.data.objects.new(GHOST_CAMERA_NAME, cam_data)
    cam.parent = bike
    cam.location = (0.0, -8.0, 3.0)
    coll.objects.link(cam)
    track = cam.constraints.new(type="TRACK_TO")
    track.target = bike
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    # Snap the scene's playback range to the ghost lap so Spacebar
    # plays exactly one lap, looping at the end.
    scene.frame_start = 1
    scene.frame_end = 1 + lap_frames
    scene.frame_set(1)
    scene.render.fps = fps_safe

    # Make the chase cam the active scene camera so View → Cameras →
    # Active Camera frames the lap immediately.
    scene.camera = cam

    # Reveal the ghost-lap collection (clear stale exclusion).
    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, GHOST_LAP_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "arc_m": arc,
        "lap_seconds": lap_seconds,
        "lap_frames": lap_frames,
        "fps": fps_safe,
        "speed_ms": target_speed_ms,
    }


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_rebuild_ghost_lap(Operator):
    """Animate a bike silhouette along ``ai_spline_main`` at the
    configured target speed and attach a chase camera. Hit Spacebar in
    the viewport afterwards to play one lap; the chase camera is
    automatically set as the scene's active camera."""

    bl_idname = "hoverbike.rebuild_ghost_lap"
    bl_label = "Rebuild Ghost Lap"
    bl_description = (
        "Set up a ghost-bike + chase cam that fly the AI spline at a constant target speed"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        try:
            summary = _rebuild_ghost_lap(
                scene,
                target_speed_ms=float(scene.hoverbike_ghost_speed),
                fps=int(scene.hoverbike_ghost_fps),
            )
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Ghost lap: {summary['arc_m']:.0f}m @ {summary['speed_ms']:.0f}m/s = "
            f"{summary['lap_seconds']:.1f}s ({summary['lap_frames']} frames @ {summary['fps']} fps)",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_ghost_lap(Operator):
    """Hide the ghost-lap collection without deleting it. Re-run
    Rebuild to bring it back, or *Wipe* to fully tear it down (the
    underlying animation lingers on ``ai_spline_main`` either way)."""

    bl_idname = "hoverbike.hide_ghost_lap"
    bl_label = "Hide Ghost Lap"
    bl_description = "Hide the ghost-lap preview without deleting it"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import _find_layer_collection

        lc = _find_layer_collection(
            context.view_layer.layer_collection, GHOST_LAP_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_rebuild_ghost_lap,
    HOVERBIKE_OT_hide_ghost_lap,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_ghost_speed = FloatProperty(
        name="Target speed (m/s)",
        description="Constant speed at which the ghost-bike traverses ai_spline_main.",
        default=GHOST_DEFAULT_SPEED_MS,
        min=1.0,
        max=200.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_ghost_fps = IntProperty(
        name="Playback FPS",
        description=(
            "Scene frame rate while ghost-lap is active. 24 fps reads as cinematic; 60 is buttery for tuning."
        ),
        default=30,
        min=12,
        max=120,
    )


def unregister() -> None:
    for prop in ("hoverbike_ghost_speed", "hoverbike_ghost_fps"):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
