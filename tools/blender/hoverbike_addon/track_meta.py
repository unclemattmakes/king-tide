"""Track introspection operators: stats refresh and pre-export lint.

Pure inspection — neither operator mutates the scene. Both are
authoring-time conveniences that surface scalar facts (terrain min/max
y, water coverage, lint findings) so authors can sanity-check a track
before exporting.

  * ``HOVERBIKE_OT_refresh_track_stats`` — evaluates the terrain mesh
    and stashes min/max y + water-coverage onto scene props for the
    panel readout.
  * ``HOVERBIKE_OT_lint_track`` — walks the spline, start, and terrain
    looking for the playability traps that bite during a runtime
    playtest (spline underwater, start in void, no kind=track surface).
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Track stats helpers
# ────────────────────────────────────────────────────────────────────


def _spline_arc_length(spline_obj: bpy.types.Object) -> float:
    """Sum the straight-line distances between consecutive sampled
    points on the spline's polyline. Closes the loop for cyclic
    splines — most race tracks are cyclic."""
    from ._legacy import _sample_curve_to_polyline

    if spline_obj is None or spline_obj.type != "CURVE":
        return 0.0
    pts = _sample_curve_to_polyline(spline_obj)
    if len(pts) < 2:
        return 0.0
    total = 0.0
    for i in range(len(pts) - 1):
        a = pts[i]
        b = pts[i + 1]
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    # Cyclic close.
    cyclic = any(
        getattr(sp, "use_cyclic_u", False) for sp in spline_obj.data.splines
    )
    if cyclic:
        a = pts[-1]
        b = pts[0]
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    return total


def _terrain_height_extents() -> tuple[float, float, float] | None:
    """Min Y / max Y / under-water fraction for the evaluated terrain
    mesh. Returns None if the terrain isn't present. Heavy enough
    (~150 k verts) that we only call this on demand via the panel's
    Refresh button, not on every redraw."""
    terrain = bpy.data.objects.get("terrain")
    if terrain is None or terrain.type != "MESH":
        return None
    dg = bpy.context.evaluated_depsgraph_get()
    eobj = terrain.evaluated_get(dg)
    me = eobj.to_mesh()
    try:
        if not me.vertices:
            return None
        mw = terrain.matrix_world
        zmin = float("inf")
        zmax = float("-inf")
        below = 0
        for v in me.vertices:
            wz = (mw @ v.co).z
            if wz < zmin:
                zmin = wz
            if wz > zmax:
                zmax = wz
            if wz < 0.0:
                below += 1
        frac = below / len(me.vertices)
        return zmin, zmax, frac
    finally:
        eobj.to_mesh_clear()


class HOVERBIKE_OT_refresh_track_stats(Operator):
    """Recompute the terrain min/max y + water-coverage stats and stash
    them on scene custom properties so the panel can show them. Splits
    out from the cheap counts (gates, starts, …) which the panel
    recomputes on every redraw."""

    bl_idname = "hoverbike.refresh_track_stats"
    bl_label = "Refresh Terrain Stats"
    bl_description = "Evaluate the terrain mesh and update the min/max y + water-coverage readouts."
    bl_options = {"REGISTER"}

    def execute(self, context):
        ext = _terrain_height_extents()
        scene = context.scene
        if ext is None:
            scene["_hoverbike_stats_terrain_min_y"] = 0.0
            scene["_hoverbike_stats_terrain_max_y"] = 0.0
            scene["_hoverbike_stats_terrain_water_frac"] = 0.0
            self.report({"WARNING"}, "no terrain mesh — stats reset")
            return {"FINISHED"}
        zmin, zmax, frac = ext
        scene["_hoverbike_stats_terrain_min_y"] = float(zmin)
        scene["_hoverbike_stats_terrain_max_y"] = float(zmax)
        scene["_hoverbike_stats_terrain_water_frac"] = float(frac)
        self.report(
            {"INFO"},
            f"Terrain: y∈[{zmin:.1f}, {zmax:.1f}] m, water coverage {frac * 100:.0f}%",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Track lint
# ────────────────────────────────────────────────────────────────────
#
# Pre-export sanity checks. Pure inspection — never mutates the scene.
# Each check returns (severity, message) tuples; the operator surfaces
# them via Blender's report system. Authors can lint before export to
# catch the "why doesn't my track work in-game" failures (no road
# under start, racing line dives underwater, etc.) without having to
# launch the runtime first.


def _lint_track(scene) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) for the current track scene. ERRORS
    are blockers (won't drive); WARNINGS are smells (might race oddly).
    Cheap — no Cycles bake, no GLB export. ~10 raycasts + spline math.

    Preview gizmos (`_hoverbike_*_preview` collections) are hidden
    during the raycasts so we lint against the *exported* state, not
    against gate / water / racer previews that get scrubbed at export."""
    from ._legacy import _PreviewCollectionsHidden, _largest_terrain_mesh

    errors: list[str] = []
    warnings: list[str] = []

    sp = bpy.data.objects.get("ai_spline_main")
    start_00 = bpy.data.objects.get("start_00")
    terrain = _largest_terrain_mesh()

    down = mathutils.Vector((0.0, 0.0, -1.0))
    water_h = 0.0
    vol = bpy.data.objects.get("water_volume_main")
    if vol is not None:
        water_h = float(vol.matrix_world.translation.z)

    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()

        if sp is None or sp.type != "CURVE":
            errors.append("Missing `ai_spline_main` — no racing line authored.")
        else:
            arc_m = _spline_arc_length(sp)
            if arc_m < 60.0:
                warnings.append(f"AI spline arc length is {arc_m:.0f} m (very short — laps will be < 3s).")
            gate_spacing = float(getattr(scene, "hoverbike_gate_spacing", 60.0) or 60.0)
            gate_count = max(1, round(arc_m / gate_spacing))
            if gate_count < 4:
                warnings.append(
                    f"Gate spacing {gate_spacing:.0f} m × {gate_count} gates is sparse for a "
                    f"{arc_m:.0f} m lap — consider tightening spacing."
                )
            elif gate_count > 40:
                warnings.append(
                    f"{gate_count} gates at {gate_spacing:.0f} m spacing is busy for a "
                    f"{arc_m:.0f} m lap."
                )

            underwater_count = 0
            miss_count = 0
            wrong_kind_count = 0
            mw = sp.matrix_world
            for spline in sp.data.splines:
                pts = spline.bezier_points if spline.type == "BEZIER" else spline.points
                for pt in pts:
                    if spline.type == "BEZIER":
                        local = pt.co
                    else:
                        local = mathutils.Vector((pt.co[0], pt.co[1], pt.co[2]))
                    w = mw @ local
                    if w.z < water_h - 0.5:
                        underwater_count += 1
                    origin = mathutils.Vector((w.x, w.y, max(w.z, 0.0) + 1000.0))
                    hit, _loc, _n, _i, hit_obj, _ = bpy.context.scene.ray_cast(depsgraph, origin, down)
                    if not hit:
                        miss_count += 1
                    elif hit_obj is not None and hit_obj.get("kind") != "track":
                        wrong_kind_count += 1
            if underwater_count > 0:
                warnings.append(
                    f"{underwater_count} spline point(s) sit below the water surface "
                    f"(z < {water_h - 0.5:.1f}). The racing line will dive underwater unless you "
                    f"snap it back up or lift `water_volume_main`."
                )
            if miss_count > 0:
                errors.append(
                    f"{miss_count} spline point(s) have no terrain or track beneath — bikes will fall."
                )
            if wrong_kind_count > 0:
                warnings.append(
                    f"{wrong_kind_count} spline point(s) sit above a non-`kind=track` mesh; "
                    f"the runtime won't collide with decoration."
                )

        if start_00 is None:
            errors.append("Missing `start_00` — no player spawn authored.")
        else:
            sloc = start_00.matrix_world.translation
            origin = mathutils.Vector((sloc.x, sloc.y, max(sloc.z, 0.0) + 1000.0))
            hit, _loc, _n, _i, hit_obj, _ = bpy.context.scene.ray_cast(depsgraph, origin, down)
            if not hit:
                errors.append("No surface beneath `start_00` — the player will spawn in the void.")
            elif hit_obj is not None and hit_obj.get("kind") != "track":
                warnings.append(
                    f"`start_00` sits above {hit_obj.name!r} which isn't kind=track; "
                    f"the bike may sink or fall through."
                )

    if terrain is None:
        warnings.append("No `kind=track` terrain mesh found. Tag your terrain mesh's `kind` to `track`.")

    return errors, warnings


class HOVERBIKE_OT_lint_track(Operator):
    """Pre-export sanity check. Walks the spline, the start pose, and
    the terrain looking for the playability traps that hit the runtime
    after authors haven't double-checked: spline points underwater,
    starts in the void, no kind=track terrain, weird gate density."""

    bl_idname = "hoverbike.lint_track"
    bl_label = "Lint Track"
    bl_description = "Sanity-check the scene for common playability issues before export"
    bl_options = {"REGISTER"}

    def execute(self, context):
        errors, warnings = _lint_track(context.scene)
        if not errors and not warnings:
            self.report({"INFO"}, "Lint: scene looks playable — nothing flagged.")
            return {"FINISHED"}
        for w in warnings:
            self.report({"WARNING"}, w)
        for e in errors:
            self.report({"ERROR"}, e)
        self.report(
            {"INFO"},
            f"Lint: {len(errors)} error(s), {len(warnings)} warning(s). See the info bar.",
        )
        return {"FINISHED"} if not errors else {"CANCELLED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_refresh_track_stats,
    HOVERBIKE_OT_lint_track,
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
