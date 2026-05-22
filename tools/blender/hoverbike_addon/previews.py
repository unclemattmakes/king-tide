"""Authoring-time preview gizmos: gate gates, racer silhouettes,
and the racing-line snap operator that pairs with both.

These previews are visible in Blender to help the author judge gate
spacing, grid layout, and racing-line altitude — but they live in
render-disabled `_hoverbike_*_preview` collections that the GLB
export scrubs, so none of it reaches the runtime.

  * ``HOVERBIKE_OT_rebuild_gate_preview`` / ``HOVERBIKE_OT_hide_gate_preview``
    — drop gate gizmos every gateSpacing metres along ai_spline_main.
  * ``HOVERBIKE_OT_rebuild_racer_preview`` / ``HOVERBIKE_OT_hide_racer_preview``
    — place a bike silhouette at ``start_00`` plus each AI grid slot.
  * ``HOVERBIKE_OT_snap_spline_to_terrain``
    — raycast each ai_spline_main control point onto the terrain (or
    water surface) and lift by a configurable hover height. Belongs
    here because it uses the same preview-collection hiding trick to
    keep gizmos out of the cast.
"""

from __future__ import annotations

import json
import math
import os

import bpy
import mathutils
from bpy.props import FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Gate preview
# ────────────────────────────────────────────────────────────────────
#
# Mirror of `src/game/tracks/gate-placement.ts`. The TypeScript runtime
# uses Y-up arc length (xz); Blender's authoring world is Z-up so we
# measure in xy. Both sides round to the integer gate count that best
# matches the requested spacing — this keeps closed-loop spacing exact
# and avoids a ragged remainder at the loop join.

DEFAULT_GATE_SPACING_M = 60.0
GATE_PREVIEW_COLLECTION = "_hoverbike_gate_preview"
GATE_PREVIEW_MESH = "_hoverbike_gate_gizmo"


def _resample_by_arc_length(points, spacing, vertical_axis=2):
    if len(points) < 2 or not (spacing > 0):
        return []
    horiz = [i for i in range(3) if i != vertical_axis]
    n = len(points)
    cum = [0.0] * (n + 1)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        cum[i + 1] = cum[i] + math.hypot(
            b[horiz[0]] - a[horiz[0]], b[horiz[1]] - a[horiz[1]]
        )
    total = cum[n]
    if total == 0:
        return []
    gate_count = max(1, round(total / spacing))
    out = []
    seg = 0
    for i in range(gate_count):
        target = (i / gate_count) * total
        while seg < n - 1 and cum[seg + 1] < target:
            seg += 1
        seg_len = cum[seg + 1] - cum[seg]
        frac = (target - cum[seg]) / seg_len if seg_len > 0 else 0.0
        t = (seg + frac) / n
        f = (((t % 1) + 1) % 1) * n
        i0 = int(f) % n
        i1 = (i0 + 1) % n
        ff = f - int(f)
        a, b = points[i0], points[i1]
        pos = (
            a[0] + (b[0] - a[0]) * ff,
            a[1] + (b[1] - a[1]) * ff,
            a[2] + (b[2] - a[2]) * ff,
        )
        d0 = b[horiz[0]] - a[horiz[0]]
        d1 = b[horiz[1]] - a[horiz[1]]
        L = math.hypot(d0, d1) or 1.0
        tan = [0.0, 0.0, 0.0]
        tan[horiz[0]] = d0 / L
        tan[horiz[1]] = d1 / L
        out.append({"t": t, "position": pos, "tangent": tuple(tan)})
    return out


def _gate_gizmo_mesh(half_width: float, height: float, arrow_len: float = 4.0):
    """Build (or rebuild) the shared gate-gizmo mesh — a rectangle in the
    local XY plane plus a short tick along local +Z showing the tangent
    direction the racer crosses through."""
    if GATE_PREVIEW_MESH in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[GATE_PREVIEW_MESH])
    me = bpy.data.meshes.new(GATE_PREVIEW_MESH)
    verts = [
        (-half_width, 0, 0),
        ( half_width, 0, 0),
        ( half_width, height, 0),
        (-half_width, height, 0),
        (0, 0, 0),
        (0, 0, arrow_len),
    ]
    edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5)]
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _gate_rotation(tangent_xy):
    """Quaternion that maps local +Z to the tangent direction (horizontal),
    local +Y to world up. Gate frame ends up vertical, perpendicular to
    the racing line."""
    z_axis = mathutils.Vector((tangent_xy[0], tangent_xy[1], 0)).normalized()
    y_axis = mathutils.Vector((0, 0, 1))
    x_axis = y_axis.cross(z_axis).normalized()
    y_axis = z_axis.cross(x_axis)
    mat = mathutils.Matrix((
        (x_axis.x, y_axis.x, z_axis.x, 0),
        (x_axis.y, y_axis.y, z_axis.y, 0),
        (x_axis.z, y_axis.z, z_axis.z, 0),
        (0, 0, 0, 1),
    ))
    return mat.to_quaternion()


def _set_gate_preview_visible(context, visible: bool) -> None:
    from ._legacy import _find_layer_collection

    lc = _find_layer_collection(
        context.view_layer.layer_collection, GATE_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = not visible


def _wipe_gate_preview() -> None:
    coll = bpy.data.collections.get(GATE_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)


def _clear_gate_preview_objects() -> bpy.types.Collection | None:
    """Empty the gate-preview collection's objects but preserve the
    collection itself. The collection's Outliner state (expanded /
    collapsed, color tag, etc.) lives on the Collection datablock; if
    we delete and re-create the collection on every rebuild — which
    fires every time the spline depsgraph trigger debounces — every
    one of those bits resets, so the author's "collapse this so it's
    not in my way" click can't stick. Returning the existing
    collection (or None if it doesn't exist yet) lets the rebuild
    re-link new gate objects into the same datablock the author
    already configured."""
    return bpy.data.collections.get(GATE_PREVIEW_COLLECTION)


PROP_GATE_MESH_NAME = "prop_gate_mesh"
# Author dims of prop_gate_mesh in tracks-src/props-library.blend: posts at
# ±14m along X, crossbar at z=6m. The mesh sits in Blender Z-up so we
# fix-up rotate by Rx(-90°) before placing so author +Z (height) maps to
# the gate gizmo's local +Y (world up) and author +Y (post thickness)
# maps to local +Z (along the racing-line tangent). Same orientation the
# wireframe `_gate_gizmo_mesh` uses, so the wireframe fallback below
# reads identical to the real prop.
PROP_GATE_AUTHOR_HALF_WIDTH = 14.0
PROP_GATE_AUTHOR_HEIGHT = 6.0


def _ensure_prop_gate_mesh_linked(repo_root: str | None) -> bpy.types.Mesh | None:
    """Link `prop_gate_mesh` from `tracks-src/props-library.blend` so the
    gate-preview gizmos can render as the real prop instead of the
    wireframe placeholder. Idempotent — returns the existing local /
    linked datablock if it's already present.

    Returns None if the library file is missing — callers fall back to
    `_gate_gizmo_mesh`. Linking (rather than appending) keeps a single
    source of truth: re-running `tools/blender/seed_props_library.py`
    re-flows every track .blend that's been opened since."""
    me = bpy.data.meshes.get(PROP_GATE_MESH_NAME)
    if me is not None:
        return me
    if not repo_root:
        return None
    library_path = os.path.join(repo_root, "tracks-src", "props-library.blend")
    if not os.path.isfile(library_path):
        return None
    try:
        with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
            if PROP_GATE_MESH_NAME in data_from.meshes:
                data_to.meshes = [PROP_GATE_MESH_NAME]
    except Exception:  # noqa: BLE001 — library load can throw a wide range
        return None
    return bpy.data.meshes.get(PROP_GATE_MESH_NAME)


def _rebuild_gate_preview(scene, *, spacing: float, half_width: float, height: float) -> int:
    """Rebuild the gate-preview collection in the scene. Returns the
    number of gates placed."""
    from ._legacy import _sample_curve_to_polyline, find_repo_root

    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None or sp.type != "CURVE":
        raise RuntimeError(
            "Gate preview needs an `ai_spline_main` curve in the scene."
        )
    points = _sample_curve_to_polyline(sp)
    placements = _resample_by_arc_length(points, spacing, vertical_axis=2)

    # Rotate placements so the one nearest start_00 is index 0 — keeps
    # gate_preview_00 in the Outliner aligned with what the runtime
    # treats as the lap-counter gate (= checkpoints[0] in the exported
    # JSON, see _legacy.derive_track_json). Without this, the preview
    # labels gates by spline-sample order while the runtime picks the
    # nearest-to-start one, and authors get confused trying to find
    # "the start gate" in Blender.
    start_00 = bpy.data.objects.get("start_00")
    if placements and start_00 is not None:
        s_loc = start_00.matrix_world.translation
        sx, sy = float(s_loc.x), float(s_loc.y)
        nearest_i = min(
            range(len(placements)),
            key=lambda i: (
                (placements[i]["position"][0] - sx) ** 2
                + (placements[i]["position"][1] - sy) ** 2
            ),
        )
        if nearest_i != 0:
            placements = placements[nearest_i:] + placements[:nearest_i]

    # Reuse the existing collection if one is already in the scene so
    # the Outliner's expanded/collapsed state survives this rebuild.
    # Only the per-gate objects are recycled. See _clear_gate_preview_objects.
    coll = _clear_gate_preview_objects()
    if coll is None:
        coll = bpy.data.collections.new(GATE_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)
    else:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)

    # Prefer the real prop_gate mesh if the props library is available;
    # otherwise fall back to the wireframe gizmo so the preview still
    # works in fresh .blends that don't yet see the library.
    repo = find_repo_root(bpy.data.filepath) if bpy.data.filepath else None
    prop_me = _ensure_prop_gate_mesh_linked(repo)
    using_prop = prop_me is not None
    if using_prop:
        me = prop_me
        # Rx(-π/2): author +Z (height) → local +Y (up), author +Y → local +Z.
        fix_up = mathutils.Quaternion((1.0, 0.0, 0.0), -math.pi / 2.0)
        scale = (
            half_width / PROP_GATE_AUTHOR_HALF_WIDTH,
            1.0,
            height / PROP_GATE_AUTHOR_HEIGHT,
        )
    else:
        me = _gate_gizmo_mesh(half_width, height)
        fix_up = None
        scale = (1.0, 1.0, 1.0)

    for i, p in enumerate(placements):
        obj = bpy.data.objects.new(f"gate_preview_{i:02d}", me)
        obj.location = p["position"]
        obj.rotation_mode = "QUATERNION"
        if fix_up is not None:
            obj.rotation_quaternion = _gate_rotation(p["tangent"]) @ fix_up
        else:
            obj.rotation_quaternion = _gate_rotation(p["tangent"])
        obj.scale = scale
        obj.hide_render = True
        # Real prop reads in the regular shaded view; the wireframe gizmo
        # needs X-ray to stay visible against terrain.
        obj.show_in_front = not using_prop
        coll.objects.link(obj)

    return len(placements)


# ────────────────────────────────────────────────────────────────────
# Racer-at-start preview (Item 7 from docs/blender-wishlist.md)
# ────────────────────────────────────────────────────────────────────
#
# Shows a bike silhouette at start_00 (player) plus instances at each AI
# grid offset, sourced from `specs/grid-offsets.json` (the same file the
# runtime reads in `src/boot/spawn-bikes.ts`). Designed for visual sanity-
# checking grid spacing and first-frame views — gizmos live in a
# render-disabled collection that the GLB export skips.

RACER_PREVIEW_COLLECTION = "_hoverbike_racer_preview"
RACER_PREVIEW_MESH_PLAYER = "_hoverbike_racer_player"
RACER_PREVIEW_MESH_AI = "_hoverbike_racer_ai"


def _bike_silhouette_mesh(name: str, with_rider_hump: bool):
    """Wireframe bike silhouette in Blender-native local coords: length
    along local +Y (Blender forward), width along ±X, height along +Z.
    A `start_NN` empty in Blender carries a pure rotation around world
    Z (yaw), so inheriting that rotation rotates the bike correctly in
    the horizontal plane while it remains upright.

    Earlier versions of this mesh used the runtime (Y-up, +Z forward)
    convention, which caused the preview to appear vertical — Blender's
    +Z is up, so a length axis along +Z made the bike stand on its tail.
    """
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    # Bike body box: 2.5m long × 1m wide × 0.6m tall.
    half_w = 0.5
    z_lo = 0.0          # ground-skimming hover deck
    z_hi = 0.6
    y_tail = -1.25
    y_nose_base = 1.0
    y_nose_tip = 1.5
    verts = [
        (-half_w, y_tail,      z_lo),  # 0 bottom tail-L
        ( half_w, y_tail,      z_lo),  # 1 bottom tail-R
        ( half_w, y_nose_base, z_lo),  # 2 bottom nose-base-R
        (-half_w, y_nose_base, z_lo),  # 3 bottom nose-base-L
        (-half_w, y_tail,      z_hi),  # 4 top tail-L
        ( half_w, y_tail,      z_hi),  # 5 top tail-R
        ( half_w, y_nose_base, z_hi),  # 6 top nose-base-R
        (-half_w, y_nose_base, z_hi),  # 7 top nose-base-L
        ( 0,      y_nose_tip,  z_lo),  # 8 nose tip (bottom)
        ( 0,      y_nose_tip,  z_hi),  # 9 nose tip (top)
    ]
    edges = [
        # bottom rect
        (0, 1), (1, 2), (2, 3), (3, 0),
        # top rect
        (4, 5), (5, 6), (6, 7), (7, 4),
        # verticals
        (0, 4), (1, 5), (2, 6), (3, 7),
        # nose
        (2, 8), (3, 8), (6, 9), (7, 9), (8, 9),
    ]
    if with_rider_hump:
        # A small hump above the body to mark the player visually.
        hump_top = (0, 0,    z_hi + 0.55)
        hump_back = (0, -0.5, z_hi + 0.1)
        hump_front = (0, 0.5,  z_hi + 0.1)
        base_idx = len(verts)
        verts.extend([hump_top, hump_back, hump_front])
        edges.extend([
            (base_idx, base_idx + 1),
            (base_idx, base_idx + 2),
            (base_idx + 1, base_idx + 2),
        ])
    me.from_pydata(verts, edges, [])
    me.update()
    return me


def _load_grid_offsets(repo_root: str | None) -> list[dict]:
    """Read specs/grid-offsets.json from disk. Falls back to a hardcoded
    grid if the file is missing so the preview still works in scratch
    .blends opened outside a repo clone. Mirrors the runtime: seven AI
    slots in a 2x4 grid, player implicit at the pole (local origin)."""
    fallback = [
        {"dx": 4,  "dz": 0,  "lineOffset": 3},
        {"dx": 8,  "dz": 0,  "lineOffset": 6},
        {"dx": 12, "dz": 0,  "lineOffset": 8},
        {"dx": 0,  "dz": -6, "lineOffset": 0},
        {"dx": 4,  "dz": -6, "lineOffset": 3},
        {"dx": 8,  "dz": -6, "lineOffset": 6},
        {"dx": 12, "dz": -6, "lineOffset": 8},
    ]
    if not repo_root:
        return fallback
    spec_path = os.path.join(repo_root, "specs", "grid-offsets.json")
    if not os.path.isfile(spec_path):
        return fallback
    try:
        with open(spec_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        slots = data.get("slots")
        if isinstance(slots, list) and slots:
            return slots
    except (OSError, ValueError):
        pass
    return fallback


def _wipe_racer_preview() -> None:
    coll = bpy.data.collections.get(RACER_PREVIEW_COLLECTION)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)


def _rebuild_racer_preview(scene) -> dict:
    """Build / refresh the racer-at-start preview collection. Returns a
    summary dict for the operator's status report."""
    from ._legacy import _find_layer_collection, find_repo_root

    start = bpy.data.objects.get("start_00")
    if start is None:
        raise RuntimeError(
            "Racer preview needs a `start_00` empty in the scene."
        )

    repo_root = find_repo_root(bpy.data.filepath) if bpy.data.filepath else None
    slots = _load_grid_offsets(repo_root)
    grid_source = "specs/grid-offsets.json" if (
        repo_root and os.path.isfile(os.path.join(repo_root, "specs", "grid-offsets.json"))
    ) else "fallback (hardcoded)"

    _wipe_racer_preview()
    me_player = _bike_silhouette_mesh(RACER_PREVIEW_MESH_PLAYER, with_rider_hump=True)
    me_ai = _bike_silhouette_mesh(RACER_PREVIEW_MESH_AI, with_rider_hump=False)
    coll = bpy.data.collections.new(RACER_PREVIEW_COLLECTION)
    scene.collection.children.link(coll)

    start_loc = start.matrix_world.translation
    # Inherit start_00's rotation so the bike points the way the player
    # will face on race-start. The AI grid is laid out in the start's
    # *local* frame (matches spawn-bikes.ts after the 2x4 grid rework) —
    # slot offsets rotate with the gate so the visualization stays
    # accurate for any yaw, not just +Z-aligned starts.
    start_rot = start.matrix_world.to_quaternion()

    player = bpy.data.objects.new("racer_preview_player", me_player)
    player.location = start_loc
    player.rotation_mode = "QUATERNION"
    player.rotation_quaternion = start_rot
    player.hide_render = True
    player.show_in_front = True
    coll.objects.link(player)

    ai_objs = []
    # `slot.dx` and `slot.dz` come from specs/grid-offsets.json in the
    # runtime frame (three Y-up, +Z forward, +X right). Map to Blender
    # (Z-up, +Y forward): runtime +X → Blender +X, runtime +Z → Blender
    # −Y, runtime +Y → Blender +Z. The grid is purely horizontal, so we
    # leave the vertical Z alone — earlier versions added dz to Blender
    # Z, stacking the AI bikes above/below the player instead of behind
    # them. Each slot's local offset is then rotated by start_rot so the
    # grid pivots with the gate's facing, matching the runtime.
    from mathutils import Vector

    for i, slot in enumerate(slots):
        obj = bpy.data.objects.new(f"racer_preview_ai_{i:02d}", me_ai)
        local_offset = Vector((
            float(slot.get("dx", 0)),
            -float(slot.get("dz", 0)),
            0.0,
        ))
        world_offset = start_rot @ local_offset
        obj.location = (
            start_loc.x + world_offset.x,
            start_loc.y + world_offset.y,
            start_loc.z + world_offset.z,
        )
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = start_rot
        obj.hide_render = True
        obj.show_in_front = True
        coll.objects.link(obj)
        ai_objs.append(obj)

    # Reveal the collection (clear any stale view-layer exclusion).
    lc = _find_layer_collection(
        bpy.context.view_layer.layer_collection, RACER_PREVIEW_COLLECTION
    )
    if lc:
        lc.exclude = False

    return {
        "player_at": tuple(start_loc),
        "ai_count": len(ai_objs),
        "grid_source": grid_source,
    }


# ────────────────────────────────────────────────────────────────────
# Snap spline to terrain
# ────────────────────────────────────────────────────────────────────
#
# Raycasts each ai_spline_main control point straight down and lifts it
# by a configurable hover height. Drops the "edit terrain, then walk the
# spline by hand to re-fit it" loop. Skips preview collections during the
# cast so the gizmos themselves don't catch the ray.


def _snap_spline_to_terrain(curve_obj: bpy.types.Object, *, hover_m: float) -> dict:
    """Drop each control point of `curve_obj` straight down onto the
    nearest drivable surface and lift by `hover_m`.

    Two surfaces are considered drivable: solid terrain *above* the
    water level, and the water surface itself (the hover bike rides
    waves). Solid terrain *below* water (seafloor) is NOT drivable —
    the bike sinks through it. Earlier versions of this operator
    snapped to whatever the ray hit first, which dragged spline points
    down onto the seafloor wherever the racing line crossed open
    water. The current rule:

      hit terrain at z = h
      water surface at z = w
      target = max(h, w) + hover_m

    so off-shore points clamp to the wave surface and on-shore points
    sit above the actual ground. Returns counts of hits / misses /
    water-snaps for the operator report.

    Cast lands on the *terrain mesh only* (largest kind=track mesh),
    not the scene at large. Previously this used ``scene.ray_cast``
    which would land on the first visible mesh — that meant downtown
    buildings, ramps, or the road slab caught the ray and the spline
    snapped onto their roofs instead of the ground. The terrain-only
    cast also makes the old "temporarily hide road_main during the
    cast" workaround unnecessary.

    Preview collections are still excluded for paranoia, but the
    real isolation now comes from picking the terrain mesh as the
    cast target."""
    from ._legacy import _PreviewCollectionsHidden, _spline_iter_points, _largest_terrain_mesh

    hits = 0
    misses = 0
    water_snaps = 0
    high_z = 0.0
    for *_rest, world_co, _ in _spline_iter_points(curve_obj):
        if world_co.z > high_z:
            high_z = world_co.z
    origin_z = high_z + 1000.0
    down_world = mathutils.Vector((0.0, 0.0, -1.0))

    # Water surface Z is the canonical sea level (scene prop) — see
    # water.current_water_height_m. Tracks with no water authored
    # collapse the max() check to terrain only via -inf.
    from .water import current_water_height_m

    sea = current_water_height_m(bpy.context.scene)
    water_z = sea if sea != 0.0 or bpy.data.objects.get("water_volume_main") is not None else float("-inf")

    terrain = _largest_terrain_mesh()
    if terrain is None:
        return {"hits": 0, "misses": 0, "water_snaps": 0, "no_terrain": True}
    terrain_mw = terrain.matrix_world
    terrain_mw_inv = terrain_mw.inverted_safe()
    down_local = terrain_mw_inv.to_3x3() @ down_world

    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        for _spline, _pt, world_co, setter in _spline_iter_points(curve_obj):
            origin_world = mathutils.Vector((world_co.x, world_co.y, origin_z))
            origin_local = terrain_mw_inv @ origin_world
            result, loc_local, _normal, _index = terrain.ray_cast(
                origin_local, down_local, distance=origin_z * 2.0
            )
            terrain_z = float((terrain_mw @ loc_local).z) if result else float("-inf")
            target_surface = max(terrain_z, water_z)
            if target_surface == float("-inf"):
                # No terrain hit AND no water — leave the point alone.
                misses += 1
                continue
            new_co = mathutils.Vector(
                (world_co.x, world_co.y, target_surface + hover_m)
            )
            setter(new_co)
            hits += 1
            if water_z > terrain_z:
                water_snaps += 1

    # Force a depsgraph refresh so the spline polyline samples the new
    # control points immediately (the gate/turn previews will follow via
    # the auto-rebuild handler).
    curve_obj.data.update_tag()
    return {"hits": hits, "misses": misses, "water_snaps": water_snaps}


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_rebuild_gate_preview(Operator):
    """Sample `ai_spline_main`, resample by arc length at the scene's
    `hoverbike_gate_spacing` (metres), and rebuild a preview collection of
    rectangle-outline gate gizmos along the racing line. The preview lives
    in `_hoverbike_gate_preview`, which is render-disabled and never reaches
    the .glb export."""

    bl_idname = "hoverbike.rebuild_gate_preview"
    bl_label = "Rebuild Gate Preview"
    bl_description = "Place gate gizmos every gateSpacing metres along ai_spline_main"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        spacing = float(scene.hoverbike_gate_spacing)
        half_width = float(scene.hoverbike_gate_half_width)
        height = float(scene.hoverbike_gate_height)
        try:
            n = _rebuild_gate_preview(
                scene,
                spacing=spacing,
                half_width=half_width,
                height=height,
            )
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        _set_gate_preview_visible(context, True)
        self.report({"INFO"}, f"Placed {n} gate previews at {spacing:.1f}m spacing")
        return {"FINISHED"}


class HOVERBIKE_OT_hide_gate_preview(Operator):
    """Toggle the gate-preview collection's view-layer visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "hoverbike.hide_gate_preview"
    bl_label = "Hide Gate Preview"
    bl_description = "Hide gate previews without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        _set_gate_preview_visible(context, False)
        return {"FINISHED"}


class HOVERBIKE_OT_rebuild_racer_preview(Operator):
    """Drop a bike silhouette at `start_00` and at each AI grid offset
    from `specs/grid-offsets.json`. Pure preview — the collection is
    render-disabled and never reaches the .glb export."""

    bl_idname = "hoverbike.rebuild_racer_preview"
    bl_label = "Rebuild Racer Preview"
    bl_description = (
        "Spawn placeholder bikes at the player start + AI grid positions"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            summary = _rebuild_racer_preview(context.scene)
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Placed 1 player + {summary['ai_count']} AI bikes ({summary['grid_source']})",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_hide_racer_preview(Operator):
    """Toggle the racer-preview collection's visibility off without
    deleting it. Re-run Rebuild to bring it back."""

    bl_idname = "hoverbike.hide_racer_preview"
    bl_label = "Hide Racer Preview"
    bl_description = "Hide racer previews without deleting them"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from ._legacy import _find_layer_collection

        lc = _find_layer_collection(
            context.view_layer.layer_collection, RACER_PREVIEW_COLLECTION
        )
        if lc:
            lc.exclude = True
        return {"FINISHED"}


class HOVERBIKE_OT_reload_props_library(Operator):
    """Force Blender to re-read every prop / landmark library file from
    disk and refresh in-scene previews so library edits show up.

    When you edit ``tracks-src/props-library.blend`` (or
    ``landmarks-library.blend``) in a separate Blender window and save,
    Blender doesn't auto-detect the file change — track .blends keep
    using the in-memory snapshot of the linked datablocks until they
    reload. This operator walks ``bpy.data.libraries``, calls
    :meth:`Library.reload` on each library whose path matches a known
    Hoverbike library, then rebuilds the gate preview so the new mesh
    is reflected in the viewport gizmos. Idempotent; safe to spam."""

    bl_idname = "hoverbike.reload_props_library"
    bl_label = "Reload Props Library"
    bl_description = (
        "Re-read props-library.blend / landmarks-library.blend from disk and "
        "refresh the gate preview (call after editing the library in a "
        "separate Blender window)"
    )
    bl_options = {"REGISTER"}

    def execute(self, context):
        # Delegate the actual library walk + reload to the shared
        # helper so the load_post handler and this operator can't
        # drift apart.
        from .handlers import reload_hoverbike_libraries

        reloaded = reload_hoverbike_libraries()

        if not reloaded:
            self.report(
                {"INFO"},
                "No Hoverbike libraries linked in this scene. "
                "(The gate preview links props-library.blend on first rebuild.)",
            )
            return {"FINISHED"}

        # Refresh the gate gizmos so the freshly-reloaded mesh data is
        # what the viewport renders. The objects in
        # _hoverbike_gate_preview keep referencing the same `prop_gate_mesh`
        # datablock — reloading the library updates that datablock
        # in-place, but rebuilding the preview is cheap insurance for
        # cases where dimensions / scale need re-derivation too.
        scene = context.scene
        try:
            _rebuild_gate_preview(
                scene,
                spacing=float(getattr(scene, "hoverbike_gate_spacing", 60.0)),
                half_width=float(getattr(scene, "hoverbike_gate_half_width", 14.0)),
                height=float(getattr(scene, "hoverbike_gate_height", 6.0)),
            )
        except RuntimeError:
            # No spline yet — that's fine, just skip the rebuild.
            pass

        self.report(
            {"INFO"},
            f"Reloaded {len(reloaded)} library file(s): {', '.join(reloaded)}",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_snap_spline_to_terrain(Operator):
    """Drop every control point on ai_spline_main onto the nearest
    surface below it, then lift by the configured hover height. Pairs
    with the live gate preview — re-snapping after a terrain edit slides
    the racing line back onto the terrain in one click."""

    bl_idname = "hoverbike.snap_spline_to_terrain"
    bl_label = "Snap Spline to Terrain"
    bl_description = (
        "Raycast each ai_spline_main control point onto the terrain and "
        "lift by the configured hover height"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        sp = bpy.data.objects.get("ai_spline_main")
        if sp is None or sp.type != "CURVE":
            self.report({"ERROR"}, "ai_spline_main not found.")
            return {"CANCELLED"}
        hover = float(getattr(context.scene, "hoverbike_snap_hover_height", 3.0))
        summary = _snap_spline_to_terrain(sp, hover_m=hover)
        water_note = (
            f" ({summary.get('water_snaps', 0)} clamped to water surface)"
            if summary.get("water_snaps", 0) > 0 else ""
        )
        if summary["misses"]:
            self.report(
                {"WARNING"},
                f"Snapped {summary['hits']} points{water_note}; "
                f"{summary['misses']} missed (no terrain or water below).",
            )
        else:
            self.report(
                {"INFO"},
                f"Snapped {summary['hits']} spline points{water_note} (+{hover:.1f}m hover).",
            )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Property update callback (gate sliders → debounced rebuild)
# ────────────────────────────────────────────────────────────────────


def _on_gate_prop_changed(self, context):
    """FloatProperty update callback — fires when the user scrubs gate
    spacing / half-width / height in the panel. Defers to the central
    debounce timer in `_legacy` so the rebuild coalesces with depsgraph
    notifications from spline edits.

    Also schedules ``"buoys"`` because both buoy spacing and lateral
    offset are derived from ``hoverbike_gate_half_width`` (× the
    ``_spacing_mult`` and ``_side_offset_mult`` props) — tweaking the
    gate half-width should reflow the buoy strip on the same debounce
    tick."""
    from .handlers import _schedule_rebuild

    _schedule_rebuild("gates")
    _schedule_rebuild("buoys")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_rebuild_gate_preview,
    HOVERBIKE_OT_hide_gate_preview,
    HOVERBIKE_OT_rebuild_racer_preview,
    HOVERBIKE_OT_hide_racer_preview,
    HOVERBIKE_OT_reload_props_library,
    HOVERBIKE_OT_snap_spline_to_terrain,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_gate_spacing",
    "hoverbike_gate_half_width",
    "hoverbike_gate_height",
    "hoverbike_snap_hover_height",
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_gate_spacing = FloatProperty(
        name="Gate spacing (m)",
        description="Target spacing between gates along ai_spline_main. "
        "The actual count is rounded to fit the closed loop cleanly.",
        default=DEFAULT_GATE_SPACING_M,
        min=1.0,
        max=1000.0,
        precision=1,
        update=_on_gate_prop_changed,
    )
    bpy.types.Scene.hoverbike_gate_half_width = FloatProperty(
        name="Gate half-width (m)",
        default=14.0,
        min=1.0,
        max=200.0,
        precision=1,
        update=_on_gate_prop_changed,
    )
    bpy.types.Scene.hoverbike_gate_height = FloatProperty(
        name="Gate height (m)",
        default=6.0,
        min=1.0,
        max=100.0,
        precision=1,
        update=_on_gate_prop_changed,
    )

    # Snap-spline-to-terrain hover height. Matches a typical hoverbike
    # ride height so the racing line sits just above the surface.
    bpy.types.Scene.hoverbike_snap_hover_height = FloatProperty(
        name="Snap hover (m)",
        description="Vertical clearance to lift each control point above the surface it lands on.",
        default=3.0, min=0.0, max=50.0, precision=2,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
