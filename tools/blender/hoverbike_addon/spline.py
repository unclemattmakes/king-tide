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

Scaffolding for from-scratch maps — the lint flags missing
``ai_spline_main`` / ``start_00`` as errors, and authors who didn't
start from a ``template-*.blend`` hit those every time. These
operators promote a one-click fix to the panel:

  * ``HOVERBIKE_OT_add_ai_spline``          → if the active object is a
    CURVE, promote it (rename + tag + cyclic). Otherwise drop a default
    cyclic NURBS loop around the 3D cursor (or fit to the terrain bbox
    if a kind=track terrain mesh exists).
  * ``HOVERBIKE_OT_add_starts``             → create ``start_00`` /
    ``start_01`` empties. If ``ai_spline_main`` exists, immediately
    snaps them to the racing line; otherwise places them at the cursor.
  * ``HOVERBIKE_OT_scaffold_track_essentials`` → one-shot wrapper that
    runs both so the lint passes in a single click on a fresh .blend.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty, StringProperty
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


def nearest_t_on_curve(curve_obj: bpy.types.Object, x: float, y: float) -> float | None:
    """Return the parameter t in [0, 1] of the closest point on
    ``curve_obj``'s racing line (XY only) to world coordinates
    (``x``, ``y``). Walks the polyline-sampled curve, projects (x, y)
    onto each XY segment, and returns the arc-length fraction of the
    closest projection. Mirrors the runtime's ``nearestT`` in
    [src/engine/editor/placement.ts] so a Bind-to-Spline in Blender
    picks the same t the in-app editor's Snap-to-spline would."""
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

    best_d2 = float("inf")
    best_t = 0.0
    for j in range(len(raw) - 1):
        ax, ay = raw[j][0], raw[j][1]
        bx, by = raw[j + 1][0], raw[j + 1][1]
        dx, dy = bx - ax, by - ay
        seg_len2 = dx * dx + dy * dy
        if seg_len2 <= 0:
            continue
        # Project (x,y) onto AB, clamped to the segment.
        u = ((x - ax) * dx + (y - ay) * dy) / seg_len2
        u = max(0.0, min(1.0, u))
        px, py = ax + dx * u, ay + dy * u
        d2 = (x - px) ** 2 + (y - py) ** 2
        if d2 < best_d2:
            best_d2 = d2
            seg_len = math.sqrt(seg_len2)
            arc = cum[j] + u * seg_len
            best_t = arc / total
    return best_t


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
        # When the start is bound to the spline (= Bind to Spline was
        # clicked), the start has its own t value that's authored via
        # the start panel's slider — independent of the shared
        # hoverbike_placement_t the ramp / helper tools use. Pre-bind
        # one-shot Snap Starts (called from the Spline tools panel)
        # still uses the shared t, matching the legacy behaviour.
        if bool(getattr(scene, "hoverbike_start_bound_to_spline", False)):
            t = float(scene.hoverbike_start_t)
        else:
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
        from .water import current_water_height_m

        # Treat the scene as having water if ANY water object exists
        # (water_volume_main / water_preview) or the sea-level prop is
        # explicitly non-zero. The previous heuristic only honoured
        # water_volume_main, which silently disabled the
        # clamp-to-water-surface rule for newer scenes that only have a
        # water_preview — bridges over open ocean snapped to the
        # seafloor + hover instead of the water surface + hover.
        sea = current_water_height_m(scene)
        has_water = bool(
            bpy.data.objects.get("water_volume_main")
            or bpy.data.objects.get("water_preview")
            or sea != 0.0
        )
        water_z = sea if has_water else float("-inf")
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
        # Aim the bike at the start gate, not just along the spline
        # tangent. The two differ whenever the spline curves between
        # the start's t and the nearest gate's t (or whenever the gate
        # spacing puts the gate at a different curve point). Sampling
        # the gate placements the same way the export + gate preview
        # do means the bike spawns staring straight at the gate it's
        # about to cross — what the player expects on lap 1.
        #
        # Falls back to the spline tangent if no gates can be derived
        # (degenerate spline, etc.) so the operator stays usable in
        # half-set-up scenes.
        yaw = math.atan2(tx, ty)
        try:
            from ._legacy import _sample_curve_to_polyline
            from .previews import _resample_by_arc_length
            gate_spacing = float(getattr(scene, "hoverbike_gate_spacing", 120.0))
            pts = _sample_curve_to_polyline(curve)
            placements = _resample_by_arc_length(pts, gate_spacing, vertical_axis=2)
        except (RuntimeError, AttributeError):
            placements = []

        # Re-aim at the nearest gate now that we know each start's
        # final XY. Gate-facing yaw is computed per-start so the two
        # start empties point at the same gate even when the lateral
        # offset puts them slightly off-axis. Same convention as the
        # existing yaw line above: atan2(dx_blender, dy_blender) such
        # that the bike's runtime forward (after the Blender→three.js
        # mapping) aims along (dx, dy) in Blender XY.
        snapped = 0
        for i, off in enumerate([-spacing * 0.5, +spacing * 0.5]):
            name = f"start_{i:02d}"
            obj = bpy.data.objects.get(name)
            if obj is None:
                continue
            sx_i = s["x"] + rx * off
            sy_i = s["y"] + ry * off
            this_yaw = yaw
            if placements:
                nearest_i = min(
                    range(len(placements)),
                    key=lambda j: (
                        (placements[j]["position"][0] - sx_i) ** 2
                        + (placements[j]["position"][1] - sy_i) ** 2
                    ),
                )
                gx = placements[nearest_i]["position"][0]
                gy = placements[nearest_i]["position"][1]
                if math.hypot(gx - sx_i, gy - sy_i) > 1e-3:
                    # Blender atan2(dx, dy) gives a yaw that — once the
                    # runtime applies Ry(yaw) to a bike whose local +Z
                    # is forward in three.js — leaves the bike facing
                    # 90° clockwise of the intended direction (observed
                    # empirically: gate ended up at the player's 9
                    # o'clock). The Blender↔three.js Y/Z axis flip means
                    # the equivalent runtime atan2 is over (dx, -dy),
                    # i.e. add π/2 to the Blender-frame computation.
                    this_yaw = math.atan2(gx - sx_i, -(gy - sy_i))
            obj.location = (sx_i, sy_i, target_z)
            obj.rotation_euler = (0.0, 0.0, this_yaw)
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


class HOVERBIKE_OT_bind_start_to_spline(Operator):
    """Bind ``start_00`` / ``start_01`` to ``ai_spline_main``: find the
    curve parameter t closest to ``start_00``'s current XY, store it on
    the scene as ``hoverbike_start_t``, set the bound flag, and run
    Snap Starts so the pair lands on the racing line at that t with the
    right spacing + yaw.

    Mirrors the web editor's *Snap to spline* button (see
    [editor-ui.ts:424]). After binding, sliding the *t* slider on the
    Start panel re-snaps both empties live (debounced) and editing
    ``ai_spline_main``'s control points repositions them too — same
    "bound entity follows the curve" experience the in-app editor
    offers."""

    bl_idname = "hoverbike.bind_start_to_spline"
    bl_label = "Bind Start to Spline"
    bl_description = (
        "Lock start_00/01 to ai_spline_main at the nearest curve point. "
        "After binding, the t slider slides the start along the curve and "
        "spline edits reposition the start automatically"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return (
            bpy.data.objects.get("start_00") is not None
            and spline_source_for_placement(context.scene) is not None
        )

    def execute(self, context):
        scene = context.scene
        curve = spline_source_for_placement(scene)
        if curve is None:
            self.report({"ERROR"}, "No source curve (need `ai_spline_main` or `road_curve_main`).")
            return {"CANCELLED"}
        start_00 = bpy.data.objects.get("start_00")
        if start_00 is None:
            self.report({"ERROR"}, "No `start_00` empty in the scene — click *Add Player Starts* first.")
            return {"CANCELLED"}
        loc = start_00.matrix_world.translation
        t = nearest_t_on_curve(curve, float(loc.x), float(loc.y))
        if t is None:
            self.report({"ERROR"}, f"Couldn't find a nearest point on {curve.name!r}.")
            return {"CANCELLED"}

        # Write the bound state + t BEFORE calling snap so the operator
        # picks up the new t (see HOVERBIKE_OT_snap_starts_to_spline:
        # the bound branch reads hoverbike_start_t). Use the RNA
        # setter (attribute access), NOT scene["..."] — registered
        # BoolProperty values written via the ID-dict path don't
        # always round-trip through getattr; same gotcha that bit
        # `current_water_height_m` reading via scene.get().
        scene.hoverbike_start_bound_to_spline = True
        scene.hoverbike_start_t = float(t)

        snap_result = bpy.ops.hoverbike.snap_starts_to_spline()
        if snap_result == {"FINISHED"}:
            self.report(
                {"INFO"},
                f"Bound start_00/01 to {curve.name} @ t={t:.3f}. "
                "Drag the t slider to slide; edit the curve to follow.",
            )
            return {"FINISHED"}
        return {"CANCELLED"}


class HOVERBIKE_OT_unbind_start_from_spline(Operator):
    """Release the start pair from ``ai_spline_main`` so the empties
    can be free-placed by hand again. Doesn't move the starts — they
    stay where they were when the bind was released. Mirrors the web
    editor's *Unbind from spline* button."""

    bl_idname = "hoverbike.unbind_start_from_spline"
    bl_label = "Unbind Start from Spline"
    bl_description = (
        "Release start_00/01 from the racing line. Empties stay where they "
        "are; subsequent spline / t edits no longer re-snap them"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        scene.hoverbike_start_bound_to_spline = False
        self.report({"INFO"}, "Start unbound — free-placement mode. Drag the empties or re-Bind.")
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
# Materialise / demote gates — bridges the spline-driven and
# Blender-wins gate-placement modes
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_materialize_gates_to_cp_empties(Operator):
    """Sample ``ai_spline_main`` at the current gate spacing and create
    a ``cp_NN`` empty at each gate position, with rotation matching
    the racing-line tangent. Once these empties exist, the export
    flips into "Blender wins" mode and uses their positions verbatim
    — so the author can drag any single gate off the spline (for a
    tight corner that needs to land at a specific apex, say) without
    losing the spline-driven default placement for every other gate.

    Re-running the operator wipes every existing ``cp_NN`` empty and
    re-stamps from the current spline; useful when the route has
    been re-shaped and the author wants the gates to follow."""

    bl_idname = "hoverbike.materialize_gates_to_cp_empties"
    bl_label = "Materialise Gates to cp_NN Empties"
    bl_description = (
        "Stamp the spline-sampled gate positions as editable cp_NN empties so "
        "individual gates can be hand-tuned. Wipes any prior cp_NN before stamping"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from ._legacy import _sample_curve_to_polyline
        from .previews import _resample_by_arc_length, DEFAULT_GATE_SPACING_M

        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "No ai_spline_main in the scene.")
            return {"CANCELLED"}

        scene = context.scene
        spacing = float(getattr(scene, "hoverbike_gate_spacing", DEFAULT_GATE_SPACING_M))
        half_w = float(getattr(scene, "hoverbike_gate_half_width", 14.0))
        height = float(getattr(scene, "hoverbike_gate_height", 8.0))

        points = _sample_curve_to_polyline(sp)
        placements = _resample_by_arc_length(points, spacing, vertical_axis=2)
        if not placements:
            self.report({"ERROR"}, "Spline produced 0 gate placements — check curve has ≥ 2 points.")
            return {"CANCELLED"}

        # Wipe prior cp_NN before stamping so a shrinking gate count doesn't
        # leave stale empties past the new tail.
        wiped = 0
        for o in list(bpy.data.objects):
            if o.type == "EMPTY" and o.name.startswith("cp_") and o.name[3:].isdigit():
                bpy.data.objects.remove(o, do_unlink=True)
                wiped += 1

        col = scene.collection
        for i, p in enumerate(placements):
            x, y, z = p["position"]
            tx, ty, _ = p["tangent"]
            yaw = math.atan2(ty, tx) - math.pi / 2.0
            e = bpy.data.objects.new(f"cp_{i:02d}", None)
            e.empty_display_type = "SINGLE_ARROW"
            e.empty_display_size = 4.0
            e.location = (x, y, z)
            e.rotation_euler = (0, 0, yaw)
            e["kind"] = "checkpoint"
            e["index"] = i
            e["half_width"] = half_w
            e["height"] = height
            col.objects.link(e)

        self.report(
            {"INFO"},
            f"Materialised {len(placements)} gate empties (wiped {wiped} prior). "
            f"Drag any cp_NN to override its spline-sampled position; "
            f"Demote Gates to Spline returns to auto-derivation.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_demote_gates_to_spline(Operator):
    """Delete every ``cp_NN`` empty in the scene, returning the track
    to spline-driven gate placement. The export will sample
    ``ai_spline_main`` at the current spacing on the next run.

    Inverse of ``materialize_gates_to_cp_empties``. Useful when the
    author tried hand-placement, didn't like the result, and wants
    to fall back to the spline default without manually deleting
    every empty."""

    bl_idname = "hoverbike.demote_gates_to_spline"
    bl_label = "Demote Gates to Spline"
    bl_description = (
        "Delete every cp_NN empty in the scene so gate placement falls back "
        "to spline auto-derivation on next export"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        wiped = 0
        for o in list(bpy.data.objects):
            if o.type == "EMPTY" and o.name.startswith("cp_") and o.name[3:].isdigit():
                bpy.data.objects.remove(o, do_unlink=True)
                wiped += 1
        if wiped == 0:
            self.report({"INFO"}, "No cp_NN empties to remove — already spline-driven.")
        else:
            self.report({"INFO"}, f"Removed {wiped} cp_NN empties. Gates will derive from the spline.")
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
# Scaffolding — first-time authoring of ai_spline_main + start_00/01
# ────────────────────────────────────────────────────────────────────


def _terrain_bbox_xy() -> tuple[float, float, float, float] | None:
    """World-space (xmin, xmax, ymin, ymax) of the largest kind=track
    terrain mesh, or None if no terrain is present. Used by the AI-
    spline scaffolder to size a default loop that actually fits the
    map instead of hovering off the map edge."""
    from ._legacy import _largest_terrain_mesh

    terrain = _largest_terrain_mesh()
    if terrain is None:
        return None
    mw = terrain.matrix_world
    xs, ys = [], []
    for corner in terrain.bound_box:
        wc = mw @ mathutils.Vector(corner)
        xs.append(wc.x)
        ys.append(wc.y)
    return (min(xs), max(xs), min(ys), max(ys))


class HOVERBIKE_OT_add_ai_spline(Operator):
    """Create the racing-line curve required by the exporter, plus the
    standard sidekick scaffolding (start pair, gate gizmos, water
    buoys).

    Two creation modes, picked automatically:

      * **Promote** — if the active object is a CURVE (and isn't already
        ``ai_spline_main``), rename it + its curve data to
        ``ai_spline_main``, tag ``kind=ai_spline`` / ``branch=main``,
        and force every spline inside it cyclic. Lets authors draw any
        Bezier / NURBS curve in Blender's normal UI and promote it
        into the racing-line slot with no boilerplate.
      * **Create** — drop a fresh cyclic Bezier *circle* (or ellipse if a
        terrain mesh forces non-square sizing). Four-anchor circle with
        proper handle math means the loop is actually round, not the
        slightly-octagonal NURBS approximation the previous default
        produced. If a ``kind=track`` terrain mesh is in the scene the
        loop fits ~70 %% of its XY bbox so the racing line sits inside
        the playable area; otherwise it's a ``radius`` -metre circle
        around the 3D cursor.

    After the spline lands, the operator chains:

      * ``hoverbike.add_starts``         → spawn / snap start_00 / 01
      * ``hoverbike.rebuild_gate_preview`` → drop gate gizmos along the line
      * ``hoverbike.rebuild_buoys``      → marker buoys over open water

    Each sub-op is a no-op when its precondition isn't met (no water
    means no buoys; existing starts are left alone), so re-clicking the
    button on a mature scene is harmless.

    No-ops (with an INFO report) if ``ai_spline_main`` already exists —
    the operator never overwrites authored work."""

    bl_idname = "hoverbike.add_ai_spline"
    bl_label = "Add AI Spline"
    bl_description = (
        "Create ai_spline_main as a Bezier circle, then place start_00/01, "
        "gate gizmos, and over-water buoys. Promotes the active CURVE if one is selected"
    )
    bl_options = {"REGISTER", "UNDO"}

    radius: FloatProperty(  # type: ignore[valid-type]
        name="Loop radius (m)",
        description="Half-extent of the default loop when no terrain is present",
        default=200.0, min=5.0, max=4000.0, precision=1,
    )
    fit_to_terrain: BoolProperty(  # type: ignore[valid-type]
        name="Fit to terrain",
        description=(
            "If a kind=track terrain mesh exists, size the loop to ~70%% of "
            "its XY bbox instead of using the radius slider"
        ),
        default=True,
    )
    place_sidekicks: BoolProperty(  # type: ignore[valid-type]
        name="Place starts / gates / buoys",
        description=(
            "After the spline lands, run add_starts + rebuild_gate_preview + "
            "rebuild_buoys so a fresh scene is ready to race in one click. "
            "Each sub-op is a no-op when its precondition isn't met"
        ),
        default=True,
    )

    def _run_sidekicks(self) -> list[str]:
        """Chain the post-spline scaffolding. Each op is independent and
        idempotent; failures are swallowed (with a console note) so a
        broken sub-op can't block the primary spline create. Returns the
        sub-op labels that ran successfully — used for the operator's
        report so authors can see what happened."""
        ran: list[str] = []
        for op_call, label in (
            (bpy.ops.hoverbike.add_starts, "starts"),
            (bpy.ops.hoverbike.rebuild_gate_preview, "gates"),
            (bpy.ops.hoverbike.rebuild_buoys, "buoys"),
        ):
            try:
                # add_starts returns CANCELLED when both empties already
                # exist; that's still "we did the right thing" for the
                # purpose of this chain, so count it as ran.
                result = op_call()
                if result and ("FINISHED" in result or "CANCELLED" in result):
                    ran.append(label)
            except (RuntimeError, AttributeError) as e:  # noqa: BLE001
                print(f"[hoverbike] add_ai_spline sidekick {label!r} skipped: {e}")
        return ran

    def execute(self, context):
        if bpy.data.objects.get("ai_spline_main") is not None:
            # Spline already exists — still run the sidekick chain so
            # this button doubles as a "re-scaffold the rest" affordance.
            if self.place_sidekicks:
                ran = self._run_sidekicks()
                self.report(
                    {"INFO"},
                    f"ai_spline_main already exists — re-ran sidekicks: {', '.join(ran) or 'none'}.",
                )
            else:
                self.report(
                    {"INFO"},
                    "ai_spline_main already exists — edit it in place instead of re-creating.",
                )
            return {"FINISHED"}

        # Promote path: any selected CURVE other than the spline itself
        # gets renamed + tagged + made cyclic.
        active = context.active_object
        if active is not None and active.type == "CURVE" and active.name != "ai_spline_main":
            old_name = active.name
            active.name = "ai_spline_main"
            try:
                active.data.name = "ai_spline_main"
            except Exception:
                pass
            # Force canonical tag — this path explicitly overrides whatever
            # kind the source curve had (e.g. a road_curve user is promoting
            # to the racing line), so we want apply_canonical_tag's force
            # mode to overwrite kind + apply all rule extras.
            from .auto_tag import apply_canonical_tag
            apply_canonical_tag(active, force=True)
            for sp in active.data.splines:
                sp.use_cyclic_u = True
                if sp.type == "NURBS":
                    sp.use_endpoint_u = True
            ran = self._run_sidekicks() if self.place_sidekicks else []
            self.report(
                {"INFO"},
                f"Promoted {old_name!r} → ai_spline_main "
                f"(cyclic, kind=ai_spline). Sidekicks: {', '.join(ran) or 'none'}.",
            )
            return {"FINISHED"}

        # Create path — drop a default loop. Centre + size from terrain
        # bbox if available, else cursor + radius slider.
        cx, cy, cz = context.scene.cursor.location
        rx = ry = float(self.radius)
        sized_from = "radius slider"
        if self.fit_to_terrain:
            bbox = _terrain_bbox_xy()
            if bbox is not None:
                xmin, xmax, ymin, ymax = bbox
                cx = 0.5 * (xmin + xmax)
                cy = 0.5 * (ymin + ymax)
                rx = 0.35 * (xmax - xmin)
                ry = 0.35 * (ymax - ymin)
                sized_from = "terrain bbox"

        # Build a proper 4-anchor cyclic Bezier circle (or ellipse when
        # rx ≠ ry). Anchor 0 sits at (+rx, 0) so start_00 — which
        # add_starts snaps to t=0 — lands at a predictable +X side. The
        # handle scale K = (4/3)·tan(π/8) is the standard cubic-Bezier
        # circle approximation, accurate to ~0.06% radius. Per-axis
        # scaling on the handles keeps the curve smooth on non-circular
        # ellipses.
        curve = bpy.data.curves.new("ai_spline_main", type="CURVE")
        curve.dimensions = "3D"
        spl = curve.splines.new(type="BEZIER")
        spl.bezier_points.add(3)  # creates 4 total
        K = (4.0 / 3.0) * math.tan(math.pi / 8.0)
        for i in range(4):
            theta = i * (math.pi / 2.0)
            ct, st = math.cos(theta), math.sin(theta)
            px = cx + rx * ct
            py = cy + ry * st
            # Tangent (unscaled): (-sin θ, cos θ). Scaled by per-axis
            # radius × K so the handle reach matches the ellipse.
            hx = -rx * K * st
            hy = ry * K * ct
            bp = spl.bezier_points[i]
            bp.co = (px, py, cz)
            bp.handle_left_type = "ALIGNED"
            bp.handle_right_type = "ALIGNED"
            bp.handle_left = (px - hx, py - hy, cz)
            bp.handle_right = (px + hx, py + hy, cz)
        spl.use_cyclic_u = True

        obj = bpy.data.objects.new("ai_spline_main", curve)
        context.scene.collection.objects.link(obj)
        # Canonical tag via the auto_tag rule (kind=ai_spline, branch=main).
        from .auto_tag import apply_canonical_tag
        apply_canonical_tag(obj)

        # Select + make active so the author can immediately enter edit
        # mode to reshape — that's almost always the next step.
        for o in context.scene.objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        ran = self._run_sidekicks() if self.place_sidekicks else []
        sidekick_note = f"Sidekicks: {', '.join(ran)}." if ran else "Sidekicks skipped."
        self.report(
            {"INFO"},
            f"Created ai_spline_main: 4-anchor Bezier circle "
            f"({sized_from}, {2 * rx:.0f}×{2 * ry:.0f} m). {sidekick_note} "
            f"Tab into edit mode to reshape.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_add_starts(Operator):
    """Create the ``start_00`` / ``start_01`` empties required by the
    exporter. If ``ai_spline_main`` exists the new empties are then
    handed straight to ``snap_starts_to_spline`` so they land on the
    racing line with the right yaw + grid spacing; otherwise they sit
    at the 3D cursor with the cursor's Z-rotation as yaw, ready to be
    re-snapped once the spline is authored.

    Skips empties that already exist (so re-running on a partial setup
    fills in only the missing index). Always sets ``kind=start`` +
    ``index`` + ``start_t=0`` so the export pipeline classifies them
    correctly."""

    bl_idname = "hoverbike.add_starts"
    bl_label = "Add Player Starts"
    bl_description = (
        "Spawn start_00 + start_01 empties (kind=start). Snaps to ai_spline_main "
        "when present; otherwise places them at the 3D cursor"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        cursor_yaw = float(scene.cursor.rotation_euler.z)
        created: list[str] = []
        existed: list[str] = []
        for i in range(2):
            name = f"start_{i:02d}"
            if bpy.data.objects.get(name) is not None:
                existed.append(name)
                continue
            obj = bpy.data.objects.new(name, None)
            obj.empty_display_type = "ARROWS"
            obj.empty_display_size = 6.0
            # Lateral offset so the two empties don't z-fight when no
            # spline exists; snap_starts_to_spline will reposition both
            # immediately after if the spline is present.
            off = (-2.0 if i == 0 else +2.0)
            obj.location = (
                float(scene.cursor.location.x) + off,
                float(scene.cursor.location.y),
                float(scene.cursor.location.z),
            )
            obj.rotation_euler = (0.0, 0.0, cursor_yaw)
            obj["kind"] = "start"
            obj["index"] = i
            obj["start_t"] = 0.0
            scene.collection.objects.link(obj)
            created.append(name)

        if not created:
            self.report({"INFO"}, "start_00 + start_01 already exist.")
            return {"CANCELLED"}

        sp = bpy.data.objects.get("ai_spline_main")
        snapped = False
        if sp is not None and sp.type == "CURVE":
            try:
                snap_result = bpy.ops.hoverbike.snap_starts_to_spline()
                snapped = snap_result == {"FINISHED"}
            except Exception:
                snapped = False

        if snapped:
            self.report(
                {"INFO"},
                f"Created {', '.join(created)} and snapped to ai_spline_main.",
            )
        elif sp is None:
            self.report(
                {"INFO"},
                f"Created {', '.join(created)} at the 3D cursor. "
                f"Re-run after adding ai_spline_main to snap to the racing line.",
            )
        else:
            self.report(
                {"INFO"},
                f"Created {', '.join(created)} at the 3D cursor (snap-to-spline failed).",
            )
        return {"FINISHED"}


class HOVERBIKE_OT_scaffold_track_essentials(Operator):
    """One-click: create everything the lint requires (``ai_spline_main``
    + ``start_00`` + ``start_01``) so a from-scratch .blend goes from
    "two lint errors" to "ready to refine" in a single click.

    Just chains ``add_ai_spline`` and ``add_starts`` — both are no-ops
    when their target already exists, so this operator is safe to run
    on partial scenes too."""

    bl_idname = "hoverbike.scaffold_track_essentials"
    bl_label = "Scaffold Track Essentials"
    bl_description = (
        "Create ai_spline_main + start_00 + start_01 in one click so the lint "
        "passes. Safe to re-run; skips anything that already exists"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        # Note both calls return CANCELLED when their target already
        # exists, which is fine — we want the overall scaffold operator
        # to succeed as long as the scene ends up with both pieces.
        bpy.ops.hoverbike.add_ai_spline()
        bpy.ops.hoverbike.add_starts()

        have_sp = bpy.data.objects.get("ai_spline_main") is not None
        have_s0 = bpy.data.objects.get("start_00") is not None
        have_s1 = bpy.data.objects.get("start_01") is not None
        if have_sp and have_s0 and have_s1:
            self.report(
                {"INFO"},
                "Scaffolded ai_spline_main + start_00 + start_01. "
                "Run Lint Track to confirm.",
            )
            return {"FINISHED"}
        missing = [
            n for n, ok in (
                ("ai_spline_main", have_sp),
                ("start_00", have_s0),
                ("start_01", have_s1),
            ) if not ok
        ]
        self.report({"ERROR"}, f"Scaffold incomplete — still missing: {', '.join(missing)}")
        return {"CANCELLED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_cursor_snap_to_spline,
    HOVERBIKE_OT_snap_starts_to_spline,
    HOVERBIKE_OT_bind_start_to_spline,
    HOVERBIKE_OT_unbind_start_from_spline,
    HOVERBIKE_OT_add_ramp_at_spline_t,
    HOVERBIKE_OT_auto_place_ramps,
    HOVERBIKE_OT_shift_spline_off_obstacles,
    HOVERBIKE_OT_materialize_gates_to_cp_empties,
    HOVERBIKE_OT_demote_gates_to_spline,
    HOVERBIKE_OT_add_ai_spline,
    HOVERBIKE_OT_add_starts,
    HOVERBIKE_OT_scaffold_track_essentials,
)


def _on_start_t_changed(self, context):
    """Live re-snap when the start is bound. Calling snap directly here
    would fire mid-property-write (Blender re-enters update callbacks);
    instead we ask the handler module to schedule its debounced rebuild
    so the actual operator runs on the next timer tick."""
    if bool(getattr(self, "hoverbike_start_bound_to_spline", False)):
        try:
            from . import handlers as _handlers
            _handlers._schedule_rebuild("starts")
        except Exception:
            pass


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
        update=_on_start_t_changed,
    )
    bpy.types.Scene.hoverbike_start_t = FloatProperty(
        name="Start t",
        description=(
            "Parameter in [0, 1] where the player-start pair sits along "
            "ai_spline_main when bound. Independent of `hoverbike_placement_t` "
            "(which is shared with ramps / helpers). Editing this slides the "
            "bound start along the curve live."
        ),
        default=0.0, min=0.0, max=1.0, precision=3,
        update=_on_start_t_changed,
    )
    bpy.types.Scene.hoverbike_start_bound_to_spline = BoolProperty(
        name="Start bound to spline",
        description=(
            "When true, start_00/01 follow ai_spline_main: editing the t "
            "slider or moving the spline reposes them. Set via Bind / Unbind "
            "operators in the Start sub-panel."
        ),
        default=False,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_placement_t",
        "hoverbike_placement_curve_name",
        "hoverbike_auto_ramp_kappa",
        "hoverbike_auto_ramp_min_spacing",
        "hoverbike_start_grid_spacing",
        "hoverbike_start_t",
        "hoverbike_start_bound_to_spline",
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
