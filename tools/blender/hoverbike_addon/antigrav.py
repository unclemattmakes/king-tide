"""Anti-gravity authoring.

Two authoring affordances, both surfaced in the panel and round-tripped
through ``derive_track_json``:

  * **Spline banking** — per-anchor rotation around the racing line's
    tangent. Authored as the NURBS / Bezier control-point ``tilt``
    field (Blender N-panel → Item → Tilt, or via the preset operators
    here). Exported as ``anchorBankings`` parallel to ``anchors``,
    with ``antiGrav: true`` set on the spline. 0 = flat, ±π/2 = wall,
    ±π = upside-down ceiling.

  * **Volume zones** — oriented box empties named ``antigrav_NN``. The
    box's local +Y is the zone's "up" while a bike's centre is inside
    the (half_width × half_height × half_depth) box. Off-route prop
    roads that don't have a spline use these instead.

Each zone empty carries a child gizmo (translucent purple box +
up-arrow) so the volume + direction read in the viewport. The gizmo
lives in a preview collection that the export scrubs — only the
``antigrav_NN`` empty itself round-trips through the JSON.
"""

from __future__ import annotations

import math
import re

import bpy
from bpy.props import FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

ANTIGRAV_ZONE_OBJECT_PREFIX = "antigrav_"
ANTIGRAV_ZONE_GIZMO_MATERIAL = "mat_antigrav_zone_preview"
ANTIGRAV_ZONE_PREVIEW_COLLECTION = "_hoverbike_antigrav_zone_preview"


# ────────────────────────────────────────────────────────────────────
# Gizmo material + mesh
# ────────────────────────────────────────────────────────────────────


def _antigrav_zone_material() -> bpy.types.Material:
    """Translucent purple material so the zone reads as a soft-edged
    volume against any terrain. Same colour family as the in-game
    helper (``makeAntiGravHelper`` in editor-helpers.ts and the
    race-time wireframe in track-mesh.ts)."""
    mat = bpy.data.materials.get(ANTIGRAV_ZONE_GIZMO_MATERIAL)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(ANTIGRAV_ZONE_GIZMO_MATERIAL)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.63, 0.40, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
        bsdf.inputs["Alpha"].default_value = 0.20
        try:
            bsdf.inputs["Emission Color"].default_value = (0.78, 0.62, 1.0, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 0.6
        except KeyError:
            pass
    return mat


def _build_antigrav_zone_gizmo_mesh(
    name: str, *, half_width: float, half_height: float, half_depth: float
) -> bpy.types.Mesh:
    """Box matching the zone's (half_width × half_height × half_depth)
    extents, with an up-arrow along local +Y that conveys the zone's
    "up" direction (gravity inside the zone = −up). The arrow's base
    sits at the box floor so it reads as "this is the floor of the
    road" — exactly what the local +Y means in the runtime."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = half_width
    hh = half_height
    hd = half_depth
    # Box vertices (8 corners).
    verts = [
        (-hw, -hd, -hh), (hw, -hd, -hh), (hw, hd, -hh), (-hw, hd, -hh),
        (-hw, -hd,  hh), (hw, -hd,  hh), (hw, hd,  hh), (-hw, hd,  hh),
    ]
    # Up-arrow vertices in local +Y (Blender forward) starting at the
    # box floor (-hh on Y).
    # NOTE: Blender's +Y is the empty's forward. We want the arrow to
    # show the zone's "up", which is the runtime's +Y. In the b2t
    # mapping, runtime +Y = blender +Z, so the arrow sits along +Z.
    arrow_len = min(hh * 1.4, 3.0)
    base_z = -hh
    tip_z = base_z + arrow_len
    head_r = min(hw, hd) * 0.18
    head_z = tip_z + 0.6
    verts += [
        (-0.1, 0.0, base_z), ( 0.1, 0.0, base_z),
        ( 0.1, 0.0, tip_z), (-0.1, 0.0, tip_z),
        ( 0.0, 0.0, head_z),
        (-head_r, 0.0, tip_z), ( head_r, 0.0, tip_z),
    ]
    box_faces = [
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2),
        (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    arrow_faces = [
        (8, 9, 10, 11),       # arrow shaft (quad)
        (13, 12, 14),         # arrow head (tri)
    ]
    me.from_pydata(verts, [], box_faces + arrow_faces)
    me.update()
    me.materials.append(_antigrav_zone_material())
    return me


def _next_antigrav_zone_name() -> str:
    i = 0
    while True:
        name = f"{ANTIGRAV_ZONE_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


def refresh_antigrav_zone_gizmos(scene) -> int:
    """Rebuild every ``antigrav_NN`` empty's child box so the visual
    geometry tracks the empty's half-extent custom props after they're
    scrubbed. Same lifecycle as boost-pad gizmos — they live in a
    preview collection that the export scrubs."""
    coll = bpy.data.collections.get(ANTIGRAV_ZONE_PREVIEW_COLLECTION)
    zones = [
        o for o in scene.objects
        if re.match(r"^antigrav_(\d+)$", o.name) and o.type == "EMPTY"
    ]
    if not zones:
        if coll is not None:
            for o in list(coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(coll)
        return 0
    if coll is None:
        coll = bpy.data.collections.new(ANTIGRAV_ZONE_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)

    valid_gizmo_names = {f"{o.name}_gizmo" for o in zones}
    for o in list(coll.objects):
        if o.name not in valid_gizmo_names:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)

    refreshed = 0
    for obj in zones:
        hw = float(obj.get("half_width", 8.0))
        hh = float(obj.get("half_height", 5.0))
        hd = float(obj.get("half_depth", 12.0))
        gizmo_name = f"{obj.name}_gizmo"
        mesh_name = f"{obj.name}_gizmo_mesh"
        mesh = _build_antigrav_zone_gizmo_mesh(
            mesh_name, half_width=hw, half_height=hh, half_depth=hd
        )
        gizmo = bpy.data.objects.get(gizmo_name)
        if gizmo is None:
            gizmo = bpy.data.objects.new(gizmo_name, mesh)
            coll.objects.link(gizmo)
        else:
            for c in list(gizmo.users_collection):
                c.objects.unlink(gizmo)
            coll.objects.link(gizmo)
            old_mesh = gizmo.data
            gizmo.data = mesh
            if (
                isinstance(old_mesh, bpy.types.Mesh)
                and old_mesh.users == 0
                and old_mesh.name != mesh.name
            ):
                bpy.data.meshes.remove(old_mesh)
        if gizmo.parent != obj:
            gizmo.parent = obj
            gizmo.matrix_parent_inverse.identity()
            gizmo.location = (0.0, 0.0, 0.0)
            gizmo.rotation_euler = (0.0, 0.0, 0.0)
            gizmo.scale = (1.0, 1.0, 1.0)
        gizmo.hide_render = True
        gizmo.hide_select = True
        gizmo.display_type = "SOLID"
        refreshed += 1
    return refreshed


def _on_antigrav_zone_prop_changed(self, context):
    scene = context.scene if context is not None else bpy.context.scene
    if scene is not None:
        refresh_antigrav_zone_gizmos(scene)


# ────────────────────────────────────────────────────────────────────
# Operators — volume zones
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_antigrav_zone(Operator):
    """Drop an ``antigrav_NN`` empty at the 3D cursor. The empty carries
    the zone's half-extents as custom properties (``half_width``,
    ``half_height``, ``half_depth``); rotate the empty to point the
    zone's local +Y at the road normal (gravity inside the zone =
    −local +Y).

    A translucent purple box mesh is parented as a viewport gizmo so the
    volume's extents + orientation are obvious. Defaults match the
    in-app editor's ``placement.ts`` antiGrav defaults so a Blender-
    authored zone behaves identically to one placed there."""

    bl_idname = "hoverbike.add_antigrav_zone"
    bl_label = "Add Anti-Grav Zone"
    bl_description = (
        "Drop an antigrav_NN empty at the 3D cursor (zone up = local +Y; "
        "gravity inside = −up). Rotate the empty to align with the road"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        name = _next_antigrav_zone_name()
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "antigrav_zone"
        obj["half_width"] = 8.0
        obj["half_height"] = 5.0
        obj["half_depth"] = 12.0
        cursor = context.scene.cursor
        obj.location = cursor.location.copy()
        obj.rotation_euler = cursor.rotation_euler.copy()
        scene.collection.objects.link(obj)

        refresh_antigrav_zone_gizmos(scene)

        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name} ({obj['half_width'] * 2:.1f}m × "
            f"{obj['half_height'] * 2:.1f}m × {obj['half_depth'] * 2:.1f}m). "
            "Rotate so local +Y matches the road normal.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_refresh_antigrav_zones(Operator):
    """Rebuild every ``antigrav_NN`` empty's child gizmo box. Use after
    editing ``half_width`` / ``half_height`` / ``half_depth`` custom
    props directly in the Properties panel."""

    bl_idname = "hoverbike.refresh_antigrav_zones"
    bl_label = "Refresh Anti-Grav Zone Visuals"
    bl_description = "Rebuild every antigrav_NN gizmo to match its current half-extents"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = refresh_antigrav_zone_gizmos(context.scene)
        self.report({"INFO"}, f"Refreshed {n} anti-grav zone gizmo(s).")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Operators — spline banking presets
# ────────────────────────────────────────────────────────────────────


def _iter_selected_curve_points():
    """Yield (object, spline, control_point) for every selected control
    point on every CURVE object currently in edit mode. Handles both
    NURBS and Bezier spline types — both carry a ``tilt`` field."""
    for obj in bpy.context.objects_in_mode:
        if obj.type != "CURVE":
            continue
        data = obj.data
        for spline in data.splines:
            if spline.type == "NURBS":
                for p in spline.points:
                    if p.select:
                        yield obj, spline, p
            elif spline.type == "BEZIER":
                for p in spline.bezier_points:
                    if p.select_control_point:
                        yield obj, spline, p


def _set_tilt_on_selection(value: float) -> int:
    """Apply ``value`` (radians) to every selected control point's
    ``tilt``. Returns the count of points updated. Auto-flags the
    parent curve as ``anti_grav=True`` so the export emits the right
    JSON without a second click."""
    count = 0
    touched_objects: set[str] = set()
    for obj, _spline, p in _iter_selected_curve_points():
        p.tilt = value
        count += 1
        touched_objects.add(obj.name)
    for name in touched_objects:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            obj["anti_grav"] = True
    return count


class HOVERBIKE_OT_set_spline_tilt(Operator):
    """Set ``tilt`` (banking, radians around the tangent) on every
    selected curve control point. Must be in Edit Mode on a curve.

    Presets handle the common authoring values (flat / banked / wall /
    ceiling); the slider on this operator covers anything in between.
    Auto-flags the parent curve with ``anti_grav=True`` so the export
    knows to emit ``anchorBankings`` + ``antiGrav: true``."""

    bl_idname = "hoverbike.set_spline_tilt"
    bl_label = "Set Spline Tilt"
    bl_description = (
        "Set tilt (banking around the tangent, radians) on every selected "
        "control point. Edit-Mode only"
    )
    bl_options = {"REGISTER", "UNDO"}

    value: FloatProperty(  # type: ignore[valid-type]
        name="Tilt (rad)",
        description=(
            "0 = world-up, ±π/2 (1.5708) = wall, ±π (3.1416) = inverted "
            "ceiling. Sign picks the direction of rotation around the tangent"
        ),
        default=0.0, min=-math.pi * 2, max=math.pi * 2, precision=4,
    )

    @classmethod
    def poll(cls, context):
        return context.mode == "EDIT_CURVE"

    def execute(self, context):
        n = _set_tilt_on_selection(float(self.value))
        if n == 0:
            self.report({"WARNING"}, "No curve control points selected.")
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Set tilt = {self.value:.4f} rad ({math.degrees(self.value):.1f}°) "
            f"on {n} control point(s).",
        )
        return {"FINISHED"}


def _make_tilt_preset(suffix: str, label: str, description: str, radians: float):
    """Factory for the quick-preset operators below — each one is just
    a button that calls into _set_tilt_on_selection with a fixed value."""

    class _Preset(Operator):
        bl_idname = f"hoverbike.set_spline_tilt_{suffix}"
        bl_label = label
        bl_description = description
        bl_options = {"REGISTER", "UNDO"}

        @classmethod
        def poll(cls, context):
            return context.mode == "EDIT_CURVE"

        def execute(self, context):
            n = _set_tilt_on_selection(radians)
            if n == 0:
                self.report({"WARNING"}, "No curve control points selected.")
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"Set tilt = {radians:.4f} rad ({math.degrees(radians):.0f}°) on {n} point(s).",
            )
            return {"FINISHED"}

    _Preset.__name__ = f"HOVERBIKE_OT_set_spline_tilt_{suffix}"
    _Preset.__qualname__ = _Preset.__name__
    return _Preset


HOVERBIKE_OT_set_spline_tilt_flat = _make_tilt_preset(
    "flat", "Flat (0°)", "Set tilt = 0 on selected control points (world-up)", 0.0,
)
HOVERBIKE_OT_set_spline_tilt_bank_l = _make_tilt_preset(
    "bank_l", "Bank L (45°)",
    "Set tilt = +π/4 on selected points (banked left, 45°)", math.pi / 4,
)
HOVERBIKE_OT_set_spline_tilt_bank_r = _make_tilt_preset(
    "bank_r", "Bank R (−45°)",
    "Set tilt = -π/4 on selected points (banked right, 45°)", -math.pi / 4,
)
HOVERBIKE_OT_set_spline_tilt_wall_l = _make_tilt_preset(
    "wall_l", "Wall L (90°)",
    "Set tilt = +π/2 on selected points (vertical wall on the left)", math.pi / 2,
)
HOVERBIKE_OT_set_spline_tilt_wall_r = _make_tilt_preset(
    "wall_r", "Wall R (−90°)",
    "Set tilt = -π/2 on selected points (vertical wall on the right)", -math.pi / 2,
)
HOVERBIKE_OT_set_spline_tilt_ceiling = _make_tilt_preset(
    "ceiling", "Ceiling (180°)",
    "Set tilt = π on selected points (upside-down ceiling)", math.pi,
)


class HOVERBIKE_OT_toggle_spline_antigrav(Operator):
    """Toggle ``anti_grav`` custom property on the active AI spline. Use
    when you want to opt the spline into curve-following gravity even
    though every control point's tilt is 0 (e.g. as a placeholder
    before authoring banking, or to disable a spline whose tilts you
    don't want to delete)."""

    bl_idname = "hoverbike.toggle_spline_antigrav"
    bl_label = "Toggle Spline Anti-Grav"
    bl_description = "Flip the anti_grav custom property on ai_spline_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None:
            self.report({"ERROR"}, "No ai_spline_main in the scene.")
            return {"CANCELLED"}
        current = bool(sp.get("anti_grav", False))
        sp["anti_grav"] = not current
        self.report({"INFO"}, f"ai_spline_main: anti_grav = {sp['anti_grav']}")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_antigrav_zone,
    HOVERBIKE_OT_refresh_antigrav_zones,
    HOVERBIKE_OT_set_spline_tilt,
    HOVERBIKE_OT_set_spline_tilt_flat,
    HOVERBIKE_OT_set_spline_tilt_bank_l,
    HOVERBIKE_OT_set_spline_tilt_bank_r,
    HOVERBIKE_OT_set_spline_tilt_wall_l,
    HOVERBIKE_OT_set_spline_tilt_wall_r,
    HOVERBIKE_OT_set_spline_tilt_ceiling,
    HOVERBIKE_OT_toggle_spline_antigrav,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
