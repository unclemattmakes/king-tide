"""Placement-helper empty + ramp/boost-pad attach.

A persistent, curve-constrained empty that lives in the scene and
acts as the "place this here" reference for ramps, boost pads, props,
decorations — anything that needs to land on or beside the racing
line.

Pose comes from the same ``_sample_curve_at_t`` family the cursor-
snap and auto-ramp operators use, so the helper, the cursor-snap, and
the ramp placer all agree on what ``t = 0.27`` means on a given curve.

Two driving knobs:

  * ``hoverbike_helper_t``      ∈ [0, 1]  — parameter along the curve.
  * ``hoverbike_helper_offset`` ∈ [-200, 200] m — lateral offset to the
    left (-) or right (+) of the curve, perpendicular to the tangent in
    XY.

Re-pose runs through the existing debounce timer on prop changes, so
scrubbing either slider live-updates the helper without per-frame
churn. The helper also seats to whatever the bike would land on at
(x, y), matching ``cursor_snap_to_spline``.
"""

from __future__ import annotations

import bpy
import mathutils
from bpy.props import FloatProperty
from bpy.types import Operator


PLACEMENT_HELPER_NAME = "placement_helper"


def _ensure_placement_helper(scene) -> bpy.types.Object:
    """Return the singleton placement-helper empty, creating it if
    missing. The empty's pose is whatever ``_repose_placement_helper``
    last wrote; the operator below re-poses on demand and the prop-
    update callback re-poses on every slider scrub."""
    obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
    if obj is not None:
        return obj
    obj = bpy.data.objects.new(PLACEMENT_HELPER_NAME, None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 4.0
    obj["kind"] = "placement_helper"
    obj.hide_render = True
    scene.collection.objects.link(obj)
    return obj


def repose_placement_helper(scene) -> dict | None:
    """Recompute the helper's world transform from the configured
    curve, parameter t, and lateral offset. Returns the sample dict on
    success or None if there's no curve / sample is degenerate.

    Z lands on max(terrain, water) + hover so the helper sits at the
    same surface a cursor-snap would. Yaw aligns +Y with the tangent
    (Blender ramp/asset forward convention).

    Public because the package-level debounce timer in
    ``_legacy._run_pending_rebuilds`` calls back into it when
    ``hoverbike_helper_t`` / ``hoverbike_helper_offset`` change."""
    from ._legacy import _PreviewCollectionsHidden
    from .spline import sample_curve_at_t, spline_source_for_placement, yaw_from_tangent_xy

    obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
    if obj is None:
        return None
    curve = spline_source_for_placement(scene)
    if curve is None:
        return None
    t = float(getattr(scene, "hoverbike_helper_t", 0.0))
    s = sample_curve_at_t(curve, t)
    if s is None:
        return None
    # Perpendicular to (tx, ty) in XY, right-hand. Positive offset =
    # right of the tangent direction (matches the snap-starts grid
    # offset sign).
    tx, ty = s["tx"], s["ty"]
    rx, ry = ty, -tx
    off = float(getattr(scene, "hoverbike_helper_offset", 0.0))
    x = s["x"] + rx * off
    y = s["y"] + ry * off
    # Surface seat — same rule as snap_starts_to_spline.
    vol = bpy.data.objects.get("water_volume_main")
    water_z = float(vol.matrix_world.translation.z) if vol is not None else float("-inf")
    hover = float(getattr(scene, "hoverbike_snap_hover_height", 0.0))
    origin = mathutils.Vector((x, y, 10000.0))
    down = mathutils.Vector((0.0, 0.0, -1.0))
    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
    terrain_z = float(loc.z) if hit else s["z"]
    surface_z = max(terrain_z, water_z)
    if surface_z == float("-inf"):
        surface_z = s["z"]
    z = surface_z + hover
    obj.location = (x, y, z)
    obj.rotation_euler = (0.0, 0.0, yaw_from_tangent_xy(tx, ty))
    obj["helper_t"] = float(t)
    obj["helper_offset"] = float(off)
    return {"x": x, "y": y, "z": z, "tx": tx, "ty": ty}


def _on_helper_prop_changed(self, context):
    """FloatProperty update callback — re-poses the helper whenever
    the user scrubs t or offset. No-ops if the helper hasn't been
    spawned."""
    from .handlers import _schedule_rebuild

    if bpy.data.objects.get(PLACEMENT_HELPER_NAME) is not None:
        _schedule_rebuild("helper")


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_placement_helper(Operator):
    """Spawn (or reveal) the singleton ``placement_helper`` empty on
    the racing line at the configured ``t`` / ``offset``. The helper
    is a persistent reference object — drag it indirectly by scrubbing
    the sliders, or read its world transform from any other operator
    that wants a placement anchor."""

    bl_idname = "hoverbike.add_placement_helper"
    bl_label = "Add Placement Helper"
    bl_description = "Spawn the curve-constrained placement helper at t / offset"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from .spline import spline_source_for_placement

        scene = context.scene
        curve = spline_source_for_placement(scene)
        if curve is None:
            self.report(
                {"ERROR"},
                "No source curve found (need `ai_spline_main` or `road_curve_main`).",
            )
            return {"CANCELLED"}
        obj = _ensure_placement_helper(scene)
        s = repose_placement_helper(scene)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r}.")
            return {"CANCELLED"}
        # Make the helper the active selection so the next G/R/S
        # keystroke lands on it (rare — the sliders are the canonical
        # control).
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        self.report(
            {"INFO"},
            f"{PLACEMENT_HELPER_NAME} → {curve.name} @ t={float(scene.hoverbike_helper_t):.3f}, "
            f"offset={float(scene.hoverbike_helper_offset):+.1f} m.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_remove_placement_helper(Operator):
    """Delete the singleton ``placement_helper`` empty. Equivalent to
    selecting it in the outliner and pressing X — provided as a button
    so the helper can be removed without leaving the panel."""

    bl_idname = "hoverbike.remove_placement_helper"
    bl_label = "Remove Helper"
    bl_description = "Delete the placement_helper empty"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        if obj is None:
            self.report({"INFO"}, "No placement helper to remove.")
            return {"CANCELLED"}
        bpy.data.objects.remove(obj, do_unlink=True)
        self.report({"INFO"}, "Removed placement_helper.")
        return {"FINISHED"}


class HOVERBIKE_OT_cursor_to_helper(Operator):
    """Snap the 3D cursor to the placement helper's pose. One-click
    way to jump the cursor to a known anchor before invoking *Add
    Ramp*, *Add Boost Pad*, or any other cursor-driven add operator."""

    bl_idname = "hoverbike.cursor_to_helper"
    bl_label = "Cursor → Helper"
    bl_description = "Move the 3D cursor to the placement helper's transform"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        if obj is None:
            self.report({"ERROR"}, "No placement_helper. Click *Add Placement Helper* first.")
            return {"CANCELLED"}
        loc = obj.matrix_world.translation
        context.scene.cursor.location = (float(loc.x), float(loc.y), float(loc.z))
        context.scene.cursor.rotation_euler = (
            float(obj.rotation_euler.x),
            float(obj.rotation_euler.y),
            float(obj.rotation_euler.z),
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_ramp_at_helper(Operator):
    """Drop a wedge ramp at the placement helper's pose. Snaps the
    cursor first so undo collapses both into a single step."""

    bl_idname = "hoverbike.add_ramp_at_helper"
    bl_label = "Add Ramp at Helper"
    bl_description = "Snap cursor to the placement helper, then drop a tangent-aligned ramp"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        snap = bpy.ops.hoverbike.cursor_to_helper()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_ramp()


class HOVERBIKE_OT_add_boost_pad_at_helper(Operator):
    """Drop a boost pad at the placement helper's pose. Snaps the
    cursor first so the pad inherits the helper's yaw."""

    bl_idname = "hoverbike.add_boost_pad_at_helper"
    bl_label = "Add Boost at Helper"
    bl_description = "Snap cursor to the placement helper, then drop a tangent-aligned boost pad"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        snap = bpy.ops.hoverbike.cursor_to_helper()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_boost_pad()


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_placement_helper,
    HOVERBIKE_OT_remove_placement_helper,
    HOVERBIKE_OT_cursor_to_helper,
    HOVERBIKE_OT_add_ramp_at_helper,
    HOVERBIKE_OT_add_boost_pad_at_helper,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.hoverbike_helper_t = FloatProperty(
        name="Helper t",
        description="Parameter [0,1] along the source curve where the placement helper sits.",
        default=0.0,
        min=0.0,
        max=1.0,
        precision=3,
        update=_on_helper_prop_changed,
    )
    bpy.types.Scene.hoverbike_helper_offset = FloatProperty(
        name="Helper offset (m)",
        description=(
            "Lateral offset from the curve centre. Positive = right of the racing tangent, negative = left."
        ),
        default=0.0,
        min=-200.0,
        max=200.0,
        precision=2,
        update=_on_helper_prop_changed,
    )


def unregister() -> None:
    for prop in ("hoverbike_helper_t", "hoverbike_helper_offset"):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
