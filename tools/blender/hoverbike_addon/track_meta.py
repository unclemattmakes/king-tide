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


_OBSTACLE_NAME_EXCLUDES = (
    "road_",          # road tool output (road_main, road_main_mesh)
    "ramp_",          # ramp tool output (ramps are meant to be ridden)
    "tunnel_",        # tunnel interiors (spline runs through them)
    "_bridge",        # hand-built bridges (e.g. i90_bridge in Seattle)
    "bridge_",
    "antigrav_",      # anti-grav ribbon swept surfaces — the spline is
                      # explicitly meant to pass through them (Kilauea
                      # caldera loop, Shibuya wall-ride, Doge's
                      # Campanile climb). Same family as road / ramp /
                      # tunnel — collidable surface authored to be ridden.
    "_rim",           # ring-shaped colliders (caldera rim, stadium
                      # bowl rims). The bbox check would treat the
                      # ring's hollow interior as "inside the obstacle",
                      # but the racing line is by design *inside* the
                      # ring. Authors who need a non-ring collider
                      # named with `_rim` can skip the suffix.
)
_OBSTACLE_MIN_HEIGHT_M = 5.0


def _collect_obstacle_bboxes(
    terrain_obj: bpy.types.Object | None,
    *,
    padding: float = 0.0,
) -> list[tuple[bpy.types.Object, float, float, float, float]]:
    """Return ``[(obj, xmin, xmax, ymin, ymax), …]`` for every visible
    ``kind="track"`` mesh that looks like a real obstacle — i.e. not
    the terrain, not road infrastructure, and at least
    ``_OBSTACLE_MIN_HEIGHT_M`` tall. Bbox is in world space, optionally
    padded by ``padding`` metres on each side so callers can include
    a clearance band (positive padding = stricter, treats nearby
    points as already-clipping).

    Single source of truth shared by ``_spline_obstacle_clearance``
    (lint) and ``HOVERBIKE_OT_shift_spline_off_obstacles`` (authoring
    fix). Keeping the heuristic in one place stops the two callers
    from disagreeing about what counts as an obstacle."""
    obstacles: list[tuple[bpy.types.Object, float, float, float, float]] = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.get("kind") != "track":
            continue
        if obj == terrain_obj:
            continue
        if obj.hide_get() or obj.hide_viewport:
            continue
        name_lc = obj.name.lower()
        # Defence-in-depth against `_largest_terrain_mesh` picking a
        # bigger-bbox kind=track mesh (e.g. a long road slab) over the
        # actual ground. On tracks where the road or the city sprawl
        # outsizes the terrain plane, the real terrain wouldn't be the
        # "largest" and would otherwise get flagged as an obstacle that
        # every spline point sits inside. Match by name as a backstop —
        # template seeds name ground meshes `terrain*`, which is stable.
        if name_lc.startswith("terrain"):
            continue
        if any(p in name_lc for p in _OBSTACLE_NAME_EXCLUDES):
            continue
        bb = obj.bound_box
        mw = obj.matrix_world
        xs, ys, zs = [], [], []
        for corner in bb:
            wc = mw @ mathutils.Vector(corner)
            xs.append(wc.x); ys.append(wc.y); zs.append(wc.z)
        if (max(zs) - min(zs)) < _OBSTACLE_MIN_HEIGHT_M:
            continue
        obstacles.append(
            (obj,
             min(xs) - padding, max(xs) + padding,
             min(ys) - padding, max(ys) + padding)
        )
    return obstacles


def _spline_obstacle_clearance(
    sp_obj: bpy.types.Object,
    terrain_obj: bpy.types.Object | None,
    *,
    radius: float = 4.0,
) -> list[tuple[str, str]]:
    """Catch spline points that clip into buildings, walls, or other
    tall non-terrain kind=track meshes. Returns
    ``[(spline_pt_name, hit_name), …]`` so the lint can mention
    specific objects in the warning.

    Why this exists: every drivable mesh carries ``kind="track"``, so
    the older "spline above non-kind=track" check waved past downtown
    blocks, locks walls, lock gates, etc. — the road tool would then
    raycast onto a building roof and the road would climb 80 m onto a
    tower. After the May-2026 raycast fix the road tool casts onto
    the terrain mesh only, but a *spline point inside a building*
    still spawns the bike inside a wall. Linting it surfaces the
    conflict pre-export.

    Filters obstacles two ways to keep false positives down:

      * **Name exclusions** drop road infrastructure (road slabs,
        ramps, tunnel interiors, bridges) — the spline is *supposed*
        to coincide with these, so flagging them is noise.
      * **Height threshold** (``>= _OBSTACLE_MIN_HEIGHT_M``) drops
        decorative low-profile meshes (curbs, pad bases) and leaves
        buildings / pylons / walls in scope.

    Uses XY bounding-box overlap (cheap, no raycasts) padded by
    ``radius`` so a spline that grazes a building by 2 m still triggers
    the warning. Vertical extent is part of the *filter* (skip short
    things) but not the *test* — a spline at z=2 over a building whose
    top is z=80 still counts because the bike's chassis would clip
    the building's wall."""
    if sp_obj is None or sp_obj.type != "CURVE":
        return []
    obstacles = _collect_obstacle_bboxes(terrain_obj, padding=radius)
    if not obstacles:
        return []
    hits: list[tuple[str, str]] = []
    mw = sp_obj.matrix_world
    sample_idx = 0
    for spline in sp_obj.data.splines:
        pts = spline.bezier_points if spline.type == "BEZIER" else spline.points
        for pt in pts:
            if spline.type == "BEZIER":
                local = pt.co
            else:
                local = mathutils.Vector((pt.co[0], pt.co[1], pt.co[2]))
            w = mw @ local
            for obj, xmin, xmax, ymin, ymax in obstacles:
                if xmin <= w.x <= xmax and ymin <= w.y <= ymax:
                    hits.append((f"pt_{sample_idx}", obj.name))
                    break
            sample_idx += 1
    return hits


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
    from .water import current_water_height_m

    water_h = current_water_height_m(scene)

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
                    f"snap it back up or lift the Sea level slider."
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

            # Obstacle clearance: spline points whose XY position falls
            # inside (or within a small margin of) a non-terrain
            # collidable mesh's footprint. Surfaces the "AI racing line
            # threads through a building" failure the older lint
            # silently missed because everything collidable is
            # kind=track. Limited to 8 reported pairs so a dense
            # downtown doesn't dump 200 lines into the info bar.
            clearance_hits = _spline_obstacle_clearance(sp, terrain)
            if clearance_hits:
                by_obj: dict[str, int] = {}
                for _pt, obj_name in clearance_hits:
                    by_obj[obj_name] = by_obj.get(obj_name, 0) + 1
                worst = sorted(by_obj.items(), key=lambda kv: -kv[1])[:8]
                summary = ", ".join(f"{name}×{count}" for name, count in worst)
                more = (
                    f" (+{len(by_obj) - len(worst)} more)" if len(by_obj) > len(worst) else ""
                )
                warnings.append(
                    f"{len(clearance_hits)} spline point(s) clip into kind=track props/buildings: "
                    f"{summary}{more}. The bike will spawn inside geometry; shift the spline or "
                    f"the obstacle."
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
