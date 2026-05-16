"""Spline-aligned cursor + ramp placement helpers.

Authoring ramps along a spline used to mean computing the tangent in
Python and setting the 3D cursor's rotation by hand. These operators
replace that ritual:

  * ``HOVERBIKE_OT_cursor_snap_to_spline``  → moves the 3D cursor to a
    parameter t in [0, 1] on ``ai_spline_main`` (or another curve via
    scene prop), with rotation aligned to the racing tangent.
  * ``HOVERBIKE_OT_snap_starts_to_spline``  → reposes ``start_00`` /
    ``start_01`` perpendicular to the racing tangent.
  * ``HOVERBIKE_OT_add_ramp_at_spline_t``   → snaps the cursor, then
    immediately drops a ramp via ``hoverbike.add_ramp``. One-click.
  * ``HOVERBIKE_OT_auto_place_ramps``       → reuses the curvature-peak
    detector from turn_indicators.py to spread ramps across the spline
    at the corners that need them most.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import FloatProperty, StringProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Sampling helpers — used here and by placement_helper.py
# ────────────────────────────────────────────────────────────────────


def yaw_from_tangent_xy(tx: float, ty: float) -> float:
    """Z-axis rotation that makes Blender's +Y (ramp / asset forward)
    align with the (tx, ty) tangent. Identity rotation maps +Y to
    world +Y; we want +Y to map to (tx, ty), so α = atan2(-tx, ty)."""
    return math.atan2(-tx, ty)


def sample_curve_at_t(curve_obj: bpy.types.Object, t: float) -> dict | None:
    """Return ``{x, y, z, tx, ty}`` at parameter t in [0, 1] along the
    horizontal arc length of ``curve_obj``'s first spline. Same
    sampling as the road tool so cursor / ramp placement lines up with
    the road. Returns None for degenerate curves."""
    from ._legacy import _sample_curve_to_polyline

    raw = _sample_curve_to_polyline(curve_obj)
    if len(raw) < 2:
        return None
    cum = [0.0]
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total <= 0:
        return None
    t = max(0.0, min(1.0 - 1e-6, float(t)))
    target = t * total
    j = 0
    while j < len(cum) - 1 and cum[j + 1] < target:
        j += 1
    seg_len = cum[j + 1] - cum[j] if (j + 1) < len(cum) else 1.0
    frac = (target - cum[j]) / seg_len if seg_len > 0 else 0.0
    a = raw[j]
    b = raw[j + 1] if (j + 1) < len(raw) else raw[j]
    x = a[0] + (b[0] - a[0]) * frac
    y = a[1] + (b[1] - a[1]) * frac
    z = a[2] + (b[2] - a[2]) * frac
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    tl = math.hypot(dx, dy) or 1.0
    return {"x": x, "y": y, "z": z, "tx": dx / tl, "ty": dy / tl}


def spline_source_for_placement(scene) -> bpy.types.Object | None:
    """Resolve the curve placement operators should sample. Mirrors
    the road tool's preference order so ``ai_spline_main`` is the
    natural racing-line source when the user hasn't authored a
    separate road."""
    from ._legacy import _resolve_road_curve

    name = getattr(scene, "hoverbike_placement_curve_name", "") or "ai_spline_main"
    obj = bpy.data.objects.get(name)
    if obj is not None and obj.type == "CURVE":
        return obj
    # Fall back to the road curve if the AI spline isn't there.
    return _resolve_road_curve()


def _cursor_road_z_at(scene, x: float, y: float, fallback_z: float) -> float:
    """Cast down at (x, y) to find what the bike would land on. Used
    to seat a ramp's base on the road's surface (so the wedge isn't
    floating mid-air, and isn't buried in the slab either)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    origin = mathutils.Vector((x, y, 10000.0))
    down = mathutils.Vector((0.0, 0.0, -1.0))
    hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
    return float(loc.z) if hit else fallback_z


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_cursor_snap_to_spline(Operator):
    """Move the 3D cursor to ``ai_spline_main`` at the configured
    parameter ``t`` in [0, 1], with rotation_z aligned to the racing
    tangent. Useful for placing props, decorations, gates, or anything
    else that should sit on the racing line at a known fraction along
    the lap. Cursor Z lands on the road / terrain surface beneath the
    sample so the wedge sits flush."""

    bl_idname = "hoverbike.cursor_snap_to_spline"
    bl_label = "Cursor → Spline"
    bl_description = "Move the 3D cursor to a parameter t on the racing line, aligned tangent-forward"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        curve = spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve found (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        t = float(scene.hoverbike_placement_t)
        s = sample_curve_at_t(curve, t)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} at t={t}.")
            return {"CANCELLED"}
        z = _cursor_road_z_at(scene, s["x"], s["y"], s["z"])
        scene.cursor.location = (s["x"], s["y"], z)
        scene.cursor.rotation_euler = (0.0, 0.0, yaw_from_tangent_xy(s["tx"], s["ty"]))
        self.report(
            {"INFO"},
            f"Cursor → {curve.name} @ t={t:.3f} ({s['x']:.1f}, {s['y']:.1f}, {z:.2f}).",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_snap_starts_to_spline(Operator):
    """Reposition ``start_00`` and ``start_01`` on the racing line at
    the configured parameter ``t``, lined up perpendicular to the
    spline tangent with the configured grid spacing between them.

    Replaces the per-track Python boilerplate every headless track
    seeder used to re-implement to seed a start line. Picks the
    parameter from ``Spline t`` and the lateral spacing from ``Start
    spacing (m)`` (both in the Spline tools panel).

    Honours the runtime yaw convention used by the existing seed
    templates (``yaw = atan2(tx, ty)``) — the empty's visual
    orientation in Blender will not point along the racing tangent
    because of the Blender↔three.js axis-frame mismatch, but the
    exported JSON yaw is correct.

    Same water-aware surface rule as ``snap_spline_to_terrain``: the
    start's Z lands at ``max(terrain_z, water_z) + hover``. Tracks
    that race through a canyon below water (alpine-sprint,
    canyon-run) spawn cleanly on the river surface rather than below
    it. Preview gizmo collections are excluded during the raycast so
    the cast can't catch a water-preview mesh."""

    bl_idname = "hoverbike.snap_starts_to_spline"
    bl_label = "Snap Starts to Spline"
    bl_description = (
        "Re-derive start_00 / start_01 positions from ai_spline_main at "
        "parameter t, perpendicular to the racing tangent"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _PreviewCollectionsHidden

        scene = context.scene
        curve = spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve found (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        t = float(scene.hoverbike_placement_t)
        s = sample_curve_at_t(curve, t)
        if s is None:
            self.report({"ERROR"}, f"Couldn't sample {curve.name!r} at t={t}.")
            return {"CANCELLED"}

        spacing = float(getattr(scene, "hoverbike_start_grid_spacing", 4.0) or 4.0)
        z_hover = float(scene.hoverbike_snap_hover_height)

        # Find the drivable Z beneath the spline sample. Hide preview
        # collections so the cast can't catch a water-preview mesh,
        # then clamp the result to max(terrain, water) — same rule as
        # snap_spline_to_terrain, so a start in an underwater canyon
        # spawns on the river surface instead of below it.
        vol = bpy.data.objects.get("water_volume_main")
        water_z = float(vol.matrix_world.translation.z) if vol is not None else float("-inf")
        origin = mathutils.Vector((s["x"], s["y"], 10000.0))
        down = mathutils.Vector((0.0, 0.0, -1.0))
        with _PreviewCollectionsHidden(bpy.context.view_layer):
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            hit, loc, *_ = scene.ray_cast(depsgraph, origin, down)
        terrain_z = float(loc.z) if hit else s["z"]
        surface_z = max(terrain_z, water_z)
        if surface_z == float("-inf"):
            surface_z = s["z"]
        clamped_to_water = water_z > terrain_z and hit
        target_z = surface_z + z_hover

        tx, ty = s["tx"], s["ty"]
        rx, ry = ty, -tx
        # Runtime yaw convention (see template-island docstring). This
        # value, written into start.rotation_euler.z, round-trips
        # through `_yaw_from_z_euler` → JSON → runtime, where the bike
        # spawns facing along (tx, ty).
        yaw = math.atan2(tx, ty)

        snapped = 0
        for i, off in enumerate([-spacing * 0.5, +spacing * 0.5]):
            name = f"start_{i:02d}"
            obj = bpy.data.objects.get(name)
            if obj is None:
                continue
            obj.location = (s["x"] + rx * off, s["y"] + ry * off, target_z)
            obj.rotation_euler = (0.0, 0.0, yaw)
            obj["start_t"] = float(t)
            snapped += 1

        if snapped == 0:
            self.report({"ERROR"}, "No `start_00` / `start_01` empties found in the scene.")
            return {"CANCELLED"}
        water_note = " (clamped to water surface)" if clamped_to_water else ""
        self.report(
            {"INFO"},
            f"Snapped {snapped} starts to {curve.name} @ t={t:.3f}"
            f"{water_note} ({spacing:.1f}m apart, hover {z_hover:.1f}m).",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_ramp_at_spline_t(Operator):
    """Combine *Cursor → Spline* with *Add Ramp*. Snaps the cursor to
    the configured parameter t on the racing line, then drops a ramp
    aligned to the tangent. Repeated invocations with different ``t``
    values are the fastest way to litter a track with jumps."""

    bl_idname = "hoverbike.add_ramp_at_spline_t"
    bl_label = "Add Ramp at t"
    bl_description = "Snap cursor to t on the racing line, then drop a tangent-aligned ramp"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        # Just delegate — Blender's undo wraps both into a single step.
        snap = bpy.ops.hoverbike.cursor_snap_to_spline()
        if snap != {"FINISHED"}:
            return snap
        return bpy.ops.hoverbike.add_ramp()


class HOVERBIKE_OT_auto_place_ramps(Operator):
    """Place ramps automatically at the high-curvature points along
    ``ai_spline_main``. Reuses the same signed-curvature peak detector
    that powers the Turn Indicators preview, so ramps land at the
    same hand-of-god corners the chevrons mark. Each ramp is rotated
    tangent to the racing line at its anchor.

    Re-runs delete prior auto-placed ramps (named ``ramp_auto_NN``)
    but leave hand-placed ramps (``ramp_NN`` / any other prefix)
    intact."""

    bl_idname = "hoverbike.auto_place_ramps"
    bl_label = "Auto-place Ramps"
    bl_description = "Drop tangent-aligned ramps at every curvature peak above |κ|"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _sample_curve_to_polyline
        from .ramp import create_gn_ramp
        from .turn_indicators import _signed_curvature_peaks

        scene = context.scene
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "Auto-place ramps needs `ai_spline_main` in the scene.")
            return {"CANCELLED"}

        # Wipe prior auto-placed ramps so re-runs don't pile up.
        for name in list(bpy.data.objects.keys()):
            if name.startswith("ramp_auto_"):
                d = bpy.data.objects[name].data
                bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
                if isinstance(d, bpy.types.Mesh) and d.users == 0:
                    bpy.data.meshes.remove(d)

        points = _sample_curve_to_polyline(sp)
        peaks = _signed_curvature_peaks(
            points,
            kappa_threshold=float(scene.hoverbike_auto_ramp_kappa),
            min_spacing_m=float(scene.hoverbike_auto_ramp_min_spacing),
        )
        if not peaks:
            self.report({"WARNING"}, "No curvature peaks above threshold — no ramps placed.")
            return {"CANCELLED"}

        # Read shared dimensions for every auto-placed ramp from the
        # standard ramp sliders. Per-instance tweaks happen after the
        # fact via the GN modifier on each ramp's mesh.
        length = float(scene.hoverbike_ramp_length)
        width = float(scene.hoverbike_ramp_width)
        height = float(scene.hoverbike_ramp_height)
        if length <= 0 or width <= 0 or height <= 0:
            self.report({"ERROR"}, "Invalid ramp dimensions — fix length/width/height first.")
            return {"CANCELLED"}

        # create_gn_ramp picks `ramp_NN`. Auto-placed ramps used to
        # carry the `ramp_auto_NN` prefix so re-runs could wipe just
        # those; with the unified GN-ramp pipeline they share the
        # `ramp_NN` namespace. Re-runs leave prior placements alone —
        # delete them by hand if you want a clean re-roll.
        placed = 0
        for p in peaks:
            x, y, _ = p["position"]
            tx, ty, _ = p["tangent"]
            yaw = yaw_from_tangent_xy(tx, ty)
            z = _cursor_road_z_at(scene, x, y, float(p["position"][2])) + 0.01
            create_gn_ramp(
                scene,
                location=(x, y, z),
                rotation_z=yaw,
                length=length, width=width, height=height,
            )
            placed += 1

        self.report(
            {"INFO"},
            f"Placed {placed} auto-ramps at curvature peaks "
            f"(|κ| > {scene.hoverbike_auto_ramp_kappa:.3f}).",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Auto-shift spline off obstacles
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_shift_spline_off_obstacles(Operator):
    """Push every ``ai_spline_main`` control point that clips into a
    tall kind=track mesh out of that mesh's XY footprint plus a
    configurable clearance margin. Direction of push is perpendicular
    to the nearest bbox edge — left if the point is closer to the
    obstacle's left wall, right if closer to the right, etc. — so a
    point grazing a building's east face gets nudged east rather than
    straight through the building.

    Pairs with the lint check (and the live obstacle-clip count in
    the parent panel) that flagged the conflict. Runs in a single
    pass; if two obstacles overlap their clearance bands the first
    push may land the point inside the second one, in which case the
    operator can be re-run. The report tells the author how many
    points were touched and the total horizontal distance moved so
    they can tell whether the route is now meaningfully different.

    Z is left alone — only XY is shifted. Authors who lift a spline
    off the seabed should use *Snap Spline to Terrain* afterwards."""

    bl_idname = "hoverbike.shift_spline_off_obstacles"
    bl_label = "Shift Off Obstacles"
    bl_description = (
        "Nudge spline control points out of tall kind=track meshes they clip "
        "into. Push direction = nearest bbox edge"
    )
    bl_options = {"REGISTER", "UNDO"}

    margin: FloatProperty(  # type: ignore[valid-type]
        name="Clearance margin (m)",
        description=(
            "Extra distance past the obstacle's edge to push points, on top "
            "of the lint's bbox padding. 4-6 m typically clears the bike's body."
        ),
        default=4.0, min=0.0, max=20.0, precision=1,
    )

    def execute(self, context):
        from ._legacy import _largest_terrain_mesh, _spline_iter_points
        from .track_meta import _collect_obstacle_bboxes

        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "No ai_spline_main in the scene.")
            return {"CANCELLED"}

        terrain = _largest_terrain_mesh()
        # Same padding the lint uses (so the operator clears what lint
        # warns about); margin then adds the requested extra clearance.
        obstacles = _collect_obstacle_bboxes(terrain, padding=4.0)
        if not obstacles:
            self.report({"INFO"}, "No obstacles in scene — nothing to shift.")
            return {"FINISHED"}

        shifted = 0
        total_distance = 0.0
        obstacles_hit: set[str] = set()
        for _spline, _pt, world_co, setter in _spline_iter_points(sp):
            x, y = world_co.x, world_co.y
            new_x, new_y = x, y
            for obj, xmin, xmax, ymin, ymax in obstacles:
                if not (xmin <= new_x <= xmax and ymin <= new_y <= ymax):
                    continue
                # Distance to exit each of the 4 sides from the current
                # (already-shifted) point. Push in the cheapest direction.
                exit_left  = new_x - xmin
                exit_right = xmax - new_x
                exit_down  = new_y - ymin
                exit_up    = ymax - new_y
                shortest = min(exit_left, exit_right, exit_down, exit_up)
                push = shortest + self.margin
                if shortest == exit_left:
                    new_x -= push
                elif shortest == exit_right:
                    new_x += push
                elif shortest == exit_down:
                    new_y -= push
                else:
                    new_y += push
                obstacles_hit.add(obj.name)
            if (new_x, new_y) != (x, y):
                shifted += 1
                total_distance += math.hypot(new_x - x, new_y - y)
                setter(mathutils.Vector((new_x, new_y, world_co.z)))

        # Force a depsgraph refresh so the gate / clip-count previews
        # see the new spline immediately.
        sp.data.update_tag()

        if shifted == 0:
            self.report({"INFO"}, "No spline points were clipping. Nothing to shift.")
        else:
            self.report(
                {"INFO"},
                f"Shifted {shifted} point(s) {total_distance:.1f} m total "
                f"away from: {', '.join(sorted(obstacles_hit))}.",
            )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_cursor_snap_to_spline,
    HOVERBIKE_OT_snap_starts_to_spline,
    HOVERBIKE_OT_add_ramp_at_spline_t,
    HOVERBIKE_OT_auto_place_ramps,
    HOVERBIKE_OT_shift_spline_off_obstacles,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_placement_t = FloatProperty(
        name="Spline t",
        description=(
            "Parameter in [0, 1] along the racing line. 0 = first control point; 0.5 = halfway around the lap."
        ),
        default=0.25, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_placement_curve_name = StringProperty(
        name="Source curve",
        description="Object name to sample for cursor / ramp-at-t placement. Defaults to `ai_spline_main`.",
        default="ai_spline_main",
    )
    bpy.types.Scene.hoverbike_auto_ramp_kappa = FloatProperty(
        name="Auto-ramp |κ| min (1/m)",
        description="Curvature threshold for auto-placed ramps. Same family as turn indicators; lower = more ramps.",
        default=0.025, min=0.001, max=2.0, precision=4,
    )
    bpy.types.Scene.hoverbike_auto_ramp_min_spacing = FloatProperty(
        name="Auto-ramp min spacing (m)",
        description="Minimum arc-length distance between consecutive auto-placed ramps.",
        default=40.0, min=1.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_start_grid_spacing = FloatProperty(
        name="Start spacing (m)",
        description="Lateral distance between start_00 and start_01 when snapped to the racing line.",
        default=4.0, min=0.5, max=20.0, precision=1,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_placement_t",
        "hoverbike_placement_curve_name",
        "hoverbike_auto_ramp_kappa",
        "hoverbike_auto_ramp_min_spacing",
        "hoverbike_start_grid_spacing",
    ):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
