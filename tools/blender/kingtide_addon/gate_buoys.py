"""Gate-edge buoy markers.

Place floating buoy pairs along the racing line wherever it crosses
open water — one buoy on each side of the spline, spaced at gate-width
intervals. Buoys read as "lane markers" for water-only tracks (Sandbar)
and as decorative shoreline edge markers for hybrid tracks that bridge
over open water.

This module owns:

* The exported buoy mesh (``gate_buoys`` object, ``kind="track"`` so
  the runtime trimesh collider catches a bike that runs through one).
* The standalone rebuild path used by both the operator and the
  depsgraph auto-rebuild handler.
* Scene properties for enable / spacing / side-offset (mirrored in
  the Gates sub-panel of the addon UI).

Why this lives in its own module
--------------------------------

Buoys used to live in ``road.py`` and inherited their lateral position
from the road's half-width + curb width. That coupled buoys to the
road tool, which made them feel mandatory: tracks that don't want a
road (water-only, anti-grav, off-road sprint) still had the buoys
plumbed through road-shaped scene props.

Buoys are racing-line markers, so they belong with the gate tool —
their natural offset reference is ``hoverbike_gate_half_width``, not
the road width. Decoupling also lets the road be optional without
secondary state to maintain.

Legacy migration
----------------

``_wipe_buoys`` removes BOTH the old ``road_buoys`` object name and
the new ``gate_buoys`` name so any .blend that shipped with the old
buoy strip gets cleaned up on its first auto-rebuild after upgrade.
The old ``hoverbike_road_buoy_*`` scene props become orphan
ID-properties on .blend load (they aren't re-registered); their
tuned values are lost but the defaults are reasonable.

Convention is gate-width multiplier for both spacing AND lateral
offset (``_spacing_mult`` and ``_side_offset_mult``). The upstream
multiplier model was kept verbatim — only the module home and
property prefix changed.
"""

from __future__ import annotations

import math

import bpy
import mathutils
from bpy.props import BoolProperty, FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BUOY_OBJECT_NAME = "gate_buoys"
BUOY_MESH_NAME = "gate_buoys_mesh"
BUOY_PREVIEW_COLLECTION = "_hoverbike_buoy_preview"

# Legacy names we still clean up on wipe so upgraded .blends shed
# their old buoy strip on the next auto-rebuild instead of leaving
# orphan geometry hanging around. The kind="track" tag on the older
# ``gate_buoys`` is also cleaned — buoys ship as wave-rider asset
# props now, not as static-collider mesh in the GLB.
_LEGACY_BUOY_OBJECT_NAME = "road_buoys"
_LEGACY_BUOY_MESH_NAME = "road_buoys_mesh"


# ────────────────────────────────────────────────────────────────────
# Materials
# ────────────────────────────────────────────────────────────────────


def _ensure_buoy_material(*, top: bool) -> bpy.types.Material:
    """Marker-buoy materials: red lacquered body + warm emissive top
    cap so the buoy reads against the water surface at distance. Two
    slots so the top cap can be lit without bleeding into the body."""
    name = "mat_gate_buoy_top" if top else "mat_gate_buoy_body"
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        if top:
            bsdf.inputs["Base Color"].default_value = (1.0, 0.95, 0.55, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.35
            emit = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
            if emit is not None:
                emit.default_value = (1.0, 0.85, 0.45, 1.0)
            estr = bsdf.inputs.get("Emission Strength")
            if estr is not None:
                estr.default_value = 4.0
        else:
            bsdf.inputs["Base Color"].default_value = (0.82, 0.10, 0.12, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.55
    return mat


# ────────────────────────────────────────────────────────────────────
# Curve resolution
# ────────────────────────────────────────────────────────────────────


def _resolve_buoy_curve() -> bpy.types.Object | None:
    """Pick the curve buoys should mark. Prefers ``ai_spline_main``;
    falls back to ``road_curve_main`` only as a safety net for legacy
    scenes that somehow have a road but no racing line. Returns None
    if neither is present."""
    for name in ("ai_spline_main", "road_curve_main"):
        obj = bpy.data.objects.get(name)
        if obj is not None and obj.type == "CURVE":
            return obj
    return None


# ────────────────────────────────────────────────────────────────────
# Over-water sample flagging
# ────────────────────────────────────────────────────────────────────


def _flag_over_water_samples(
    samples: list[dict],
    terrain_obj: bpy.types.Object | None,
    sea_level: float,
) -> None:
    """Stamp ``over_water`` (bool) on each sample. A sample is "over
    water" when the terrain mesh either misses entirely or hits below
    the sea level at that XY — i.e. the spline sits above open water,
    not above land.

    Mutates ``samples`` in-place. When no terrain is in the scene every
    sample is treated as over water (the only meaningful surface IS
    the sea, so the buoys still appear). When no sea level was set
    (`sea_level == 0` and no water volume) the track is presumed
    inland — every sample gets ``over_water = False``."""
    if terrain_obj is None:
        for s in samples:
            s["over_water"] = True
        return

    from ._legacy import _PreviewCollectionsHidden

    down = mathutils.Vector((0.0, 0.0, -1.0))
    ray_origin_z = 10000.0
    terrain_mw_inv = terrain_obj.matrix_world.inverted_safe()
    terrain_mw = terrain_obj.matrix_world
    direction_local = terrain_mw_inv.to_3x3() @ down

    with _PreviewCollectionsHidden(bpy.context.view_layer):
        bpy.context.view_layer.update()
        for s in samples:
            origin_local = terrain_mw_inv @ mathutils.Vector(
                (s["x"], s["y"], ray_origin_z)
            )
            result, loc_local, _normal, _index = terrain_obj.ray_cast(
                origin_local, direction_local, distance=ray_origin_z * 2.0
            )
            if not result:
                s["over_water"] = True
                continue
            terrain_z = float((terrain_mw @ loc_local).z)
            # Small epsilon so a coastal vert at exactly the waterline
            # doesn't get flagged either way.
            s["over_water"] = terrain_z < (sea_level - 0.05)


# ────────────────────────────────────────────────────────────────────
# Wipe + mesh builders
# ────────────────────────────────────────────────────────────────────


def _wipe_buoys() -> None:
    """Remove the buoy preview object + mesh datablock. Called before
    each rebuild so previous samples / disabled toggles can't leave a
    stale buoy strip behind. Wipes BOTH the current name and the
    legacy ``road_buoys`` name so .blends saved before this module
    existed shed their old buoys on the next auto-rebuild. Also wipes
    the empty preview collection if it ends up orphaned."""
    for obj_name in (BUOY_OBJECT_NAME, _LEGACY_BUOY_OBJECT_NAME):
        old = bpy.data.objects.get(obj_name)
        if old is not None:
            old_mesh = old.data
            bpy.data.objects.remove(old, do_unlink=True)
            if isinstance(old_mesh, bpy.types.Mesh) and old_mesh.users == 0:
                bpy.data.meshes.remove(old_mesh)
    for mesh_name in (BUOY_MESH_NAME, _LEGACY_BUOY_MESH_NAME):
        leftover = bpy.data.meshes.get(mesh_name)
        if leftover is not None and leftover.users == 0:
            bpy.data.meshes.remove(leftover)


def _iter_buoy_anchors(
    samples: list[dict],
    *,
    spacing_m: float,
    lateral_m: float,
):
    """Yield ``(x, y, tx, ty)`` for every buoy that lands along the
    over-water samples — one tuple per buoy (so each gate-line pair
    emits two yields, left then right of the racing tangent).

    Single source of truth for placement: the preview mesh and the
    exported wave-rider JSON entries call this so the gizmos visible
    in Blender always exactly match the props the runtime spawns. The
    arc-since-emit accumulator resets on entering open water so the
    first buoy lands at the shoreline transition, not at a stale
    offset from the last land segment."""
    arc_since_emit = float("inf")
    for i in range(len(samples) - 1):
        sa = samples[i]
        sb = samples[i + 1]
        seg_len = math.hypot(sb["x"] - sa["x"], sb["y"] - sa["y"])
        if not sa.get("over_water", False):
            arc_since_emit = float("inf")
            continue
        if arc_since_emit + seg_len < spacing_m and arc_since_emit != float("inf"):
            arc_since_emit += seg_len
            continue
        r = float(sa.get("r", 1.0))
        lat = max(0.0, lateral_m) * r
        nx = -sa["ty"]
        ny = sa["tx"]
        # Left buoy then right buoy. Tangent is the racing tangent at
        # the anchor sample — both buoys in a pair share it, which is
        # the natural "face down the lane" yaw for a wave-rider.
        yield (sa["x"] + nx * lat, sa["y"] + ny * lat, sa["tx"], sa["ty"])
        yield (sa["x"] - nx * lat, sa["y"] - ny * lat, sa["tx"], sa["ty"])
        arc_since_emit = 0.0


def _build_buoy_unit_mesh() -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]], list[int]]:
    """Return verts + faces + per-face material slots for a single
    canonical buoy at the local origin. The buoy is centred on the
    water surface (z=0); top cap rises to z ≈ 1.2, keel hangs to z ≈
    -0.25. Caller transforms the verts into world position for each
    buoy instance.

    Material slots:
      0 — body (red lacquered)
      1 — top cap (warm emissive)

    Smaller than the prop-library buoy (radius 0.4 m vs 0.6 m) so a
    long over-water run doesn't pile big floats along the racing
    line. Eight segments — coarse enough to feel like a marker, fine
    enough to read as round at racing distance."""
    segs = 8
    radius_body = 0.4
    radius_top = 0.18
    radius_keel = radius_body * 1.15
    z_keel = -0.25
    z_water = 0.0
    z_shoulder = 1.05
    z_top = 1.25

    def ring(r: float, z: float, start_idx: int) -> tuple[list[tuple[float, float, float]], list[int]]:
        v: list[tuple[float, float, float]] = []
        idx: list[int] = []
        for k in range(segs):
            a = (k / segs) * 2.0 * math.pi
            v.append((math.cos(a) * r, math.sin(a) * r, z))
            idx.append(start_idx + k)
        return v, idx

    verts: list[tuple[float, float, float]] = []
    r0_v, r0_i = ring(radius_keel, z_keel, 0)
    verts.extend(r0_v)
    r1_v, r1_i = ring(radius_body, z_water, segs)
    verts.extend(r1_v)
    r2_v, r2_i = ring(radius_body, z_shoulder, segs * 2)
    verts.extend(r2_v)
    r3_v, r3_i = ring(radius_top, z_top, segs * 3)
    verts.extend(r3_v)

    faces: list[tuple[int, ...]] = []
    mats: list[int] = []

    def strip(a: list[int], b: list[int], mat: int) -> None:
        for k in range(segs):
            j = (k + 1) % segs
            faces.append((a[k], a[j], b[j], b[k]))
            mats.append(mat)

    strip(r0_i, r1_i, 0)
    strip(r1_i, r2_i, 0)
    strip(r2_i, r3_i, 0)
    # Top cap — single n-gon, emissive material.
    faces.append(tuple(r3_i))
    mats.append(1)
    return verts, faces, mats


def _build_buoy_strip_mesh(
    samples: list[dict],
    *,
    sea_level: float,
    spacing_m: float,
    lateral_m: float,
) -> bpy.types.Mesh | None:
    """Render-only preview mesh of every buoy that would spawn for the
    current scene state. Walks the same iterator the export side uses
    (``_iter_buoy_anchors``) so the gizmo and the runtime instances
    can't drift apart.

    Buoys sit at sea level (Z = sea_level) regardless of the spline's
    authored Z — bridges over open water push the spline well above
    the waves but the buoys mark the racing line on the actual water
    below.

    Returns None when no buoys would land."""
    if BUOY_MESH_NAME in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[BUOY_MESH_NAME])

    unit_verts, unit_faces, unit_mats = _build_buoy_unit_mesh()
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    mats: list[int] = []

    def add_buoy(cx: float, cy: float, cz: float) -> None:
        base = len(verts)
        for vx, vy, vz in unit_verts:
            verts.append((cx + vx, cy + vy, cz + vz))
        for f, m in zip(unit_faces, unit_mats):
            faces.append(tuple(base + i for i in f))
            mats.append(m)

    placed = 0
    for x, y, _tx, _ty in _iter_buoy_anchors(
        samples, spacing_m=spacing_m, lateral_m=lateral_m
    ):
        add_buoy(x, y, sea_level)
        placed += 1

    if placed == 0:
        return None

    me = bpy.data.meshes.new(BUOY_MESH_NAME)
    me.from_pydata(verts, [], faces)
    me.update()
    for i, poly in enumerate(me.polygons):
        poly.use_smooth = True
        poly.material_index = mats[i]
    return me


# ────────────────────────────────────────────────────────────────────
# Rebuild path
# ────────────────────────────────────────────────────────────────────


def _maybe_build_buoys_from_samples(
    scene: bpy.types.Scene,
    samples: list[dict],
    terrain: bpy.types.Object | None,
) -> tuple[str | None, int]:
    """Build (or wipe) the buoy *preview* mesh from already-sampled
    curve points. The mesh lands in the ``_hoverbike_buoy_preview``
    collection so it's visible to the author while the .blend is open
    but auto-excluded from the GLB export (preview-collection
    convention). Runtime instances are emitted at export time as
    wave-rider asset props via ``compute_buoy_placements`` — the
    preview here is just the authoring gizmo.

    Returns ``(object_name | None, pair_count)``. Always wipes first
    so a toggle-off or a removed water volume drops the preview
    cleanly instead of leaving stale gizmos floating around."""
    _wipe_buoys()

    sea_level = float(getattr(scene, "hoverbike_water_height", 0.0))
    # water_preview counts as water-authoring evidence too. Earlier
    # versions only honoured water_volume_main + non-zero sea level,
    # which silently disabled buoys on the modern "water_preview-only"
    # scenes the Water sub-panel produces — same bug we already
    # patched in snap_starts_to_spline.
    has_water = (
        sea_level != 0.0
        or bpy.data.objects.get("water_volume_main") is not None
        or bpy.data.objects.get("water_preview") is not None
    )
    enable = bool(getattr(scene, "hoverbike_gate_buoys_enabled", True))
    if not (enable and has_water) or not samples:
        return None, 0

    _flag_over_water_samples(samples, terrain, sea_level)
    if not any(s.get("over_water", False) for s in samples):
        return None, 0

    # Spacing is authored directly in metres so the buoy rhythm is
    # independent of gate width (a track that narrows its gates for
    # difficulty shouldn't also re-space its buoys). Lateral offset
    # stays as a gate-width multiplier so the buoy channel still
    # scales with the gameplay corridor.
    side_offset_mult = float(getattr(scene, "hoverbike_gate_buoy_side_offset_mult", 1.5))
    gate_full_width = 2.0 * float(getattr(scene, "hoverbike_gate_half_width", 14.0))
    spacing_m = max(1.0, float(getattr(scene, "hoverbike_gate_buoy_spacing_m", 42.0)))
    lateral_m = max(0.0, side_offset_mult * gate_full_width)
    buoy_me = _build_buoy_strip_mesh(
        samples,
        sea_level=sea_level,
        spacing_m=spacing_m,
        lateral_m=lateral_m,
    )
    if buoy_me is None:
        return None, 0

    buoy_me.materials.append(_ensure_buoy_material(top=False))
    buoy_me.materials.append(_ensure_buoy_material(top=True))
    buoy_obj = bpy.data.objects.new(BUOY_OBJECT_NAME, buoy_me)
    # No kind tag — this mesh is preview-only. The export pipeline reads
    # buoy positions from compute_buoy_placements() and emits asset-prop
    # JSON refs (assetId='buoy') for the runtime to spawn as wave-riders.
    buoy_obj.hide_render = True

    # Park the gizmo in the dedicated buoy-preview collection. Matching
    # the _hoverbike_*_preview pattern means _PreviewCollectionsHidden
    # automatically excludes it during GLB export.
    coll = bpy.data.collections.get(BUOY_PREVIEW_COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(BUOY_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)
    coll.objects.link(buoy_obj)

    # 25 faces per buoy (3 quad strips × 8 segs + 1 cap), 2 buoys per
    # pair. Derive from the final mesh so the count stays right if the
    # unit geometry ever evolves.
    FACES_PER_BUOY = 25
    n_pairs = len(buoy_me.polygons) // (FACES_PER_BUOY * 2)
    return buoy_obj.name, n_pairs


# ────────────────────────────────────────────────────────────────────
# Export-side placement helper
# ────────────────────────────────────────────────────────────────────


def compute_buoy_placements(scene: bpy.types.Scene) -> list[dict]:
    """Walk the racing line and return the buoy placements that the
    JSON export should emit as wave-rider asset-prop refs.

    Each entry: ``{"x", "y", "z", "yaw"}`` in Blender world coords
    (caller converts to three.js via ``_b2t`` + a Y-axis quaternion).
    ``yaw`` is the Blender Z-euler that aligns the prop's local +Y
    with the racing tangent — same convention every other spline-
    derived empty in the addon uses.

    Returns ``[]`` when buoys are disabled, no water is authored, the
    racing line is missing, or none of the samples cross open water.
    Sea level is the floor for Z; wave-riders override it at runtime
    by sampling the live wave field, so any value the export ships is
    just the spawn placeholder."""
    enable = bool(getattr(scene, "hoverbike_gate_buoys_enabled", True))
    if not enable:
        return []

    sea_level = float(getattr(scene, "hoverbike_water_height", 0.0))
    has_water = (
        sea_level != 0.0
        or bpy.data.objects.get("water_volume_main") is not None
        or bpy.data.objects.get("water_preview") is not None
    )
    if not has_water:
        return []

    curve_obj = _resolve_buoy_curve()
    if curve_obj is None:
        return []

    from .road import _sample_road_path
    from .road_conform_gn import find_source_terrain

    terrain = find_source_terrain()
    samples = _sample_road_path(
        curve_obj,
        terrain,
        n_samples=int(getattr(scene, "hoverbike_road_samples", 64)),
        smooth_passes=int(getattr(scene, "hoverbike_road_smooth_passes", 4)),
        use_curve_z=True,
    )
    if len(samples) < 2:
        return []

    _flag_over_water_samples(samples, terrain, sea_level)
    if not any(s.get("over_water", False) for s in samples):
        return []

    side_offset_mult = float(getattr(scene, "hoverbike_gate_buoy_side_offset_mult", 1.5))
    gate_full_width = 2.0 * float(getattr(scene, "hoverbike_gate_half_width", 14.0))
    spacing_m = max(1.0, float(getattr(scene, "hoverbike_gate_buoy_spacing_m", 42.0)))
    lateral_m = max(0.0, side_offset_mult * gate_full_width)

    placements: list[dict] = []
    for x, y, tx, ty in _iter_buoy_anchors(
        samples, spacing_m=spacing_m, lateral_m=lateral_m
    ):
        # atan2(ty, tx) - π/2 makes Blender +Y align with the tangent,
        # which is the same yaw convention the gate empties use.
        yaw = math.atan2(ty, tx) - math.pi / 2.0
        placements.append({"x": x, "y": y, "z": sea_level, "yaw": yaw})
    return placements


def rebuild_buoys(scene: bpy.types.Scene) -> dict | None:
    """Standalone buoy rebuild — samples the racing line
    (``ai_spline_main`` if present, else ``road_curve_main`` as a
    legacy fallback) and builds the ``gate_buoys`` mesh.

    Fires from the auto-rebuild handler on ai_spline / water-height
    edits so water-only tracks (e.g. Sandbar) get marker buoys at the
    racing line's edges as soon as the spline is touched.

    Returns ``{"buoy_pairs", "curve", "object"}`` on a successful
    build, or ``None`` when there's no curve / not enough samples /
    no authored water (the helper still wipes any stale buoys in
    those cases, so toggling the master flag off or removing a water
    volume is reflected immediately)."""
    curve_obj = _resolve_buoy_curve()
    if curve_obj is None:
        _wipe_buoys()
        return None

    # Lazy import: road owns the curve-sampling primitive used by every
    # spline-walking tool (road build, snap-to-terrain, buoys). Pulling
    # it from here keeps the sampling logic in one place; the import
    # has no side effects beyond the function-table lookup.
    from .road import _sample_road_path
    from .road_conform_gn import find_source_terrain

    terrain = find_source_terrain()

    samples = _sample_road_path(
        curve_obj,
        terrain,
        n_samples=int(getattr(scene, "hoverbike_road_samples", 64)),
        smooth_passes=int(getattr(scene, "hoverbike_road_smooth_passes", 4)),
        use_curve_z=True,
    )
    if len(samples) < 2:
        _wipe_buoys()
        return None

    obj_name, n_pairs = _maybe_build_buoys_from_samples(scene, samples, terrain)
    if obj_name is None:
        return None
    return {"buoy_pairs": n_pairs, "curve": curve_obj.name, "object": obj_name}


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


class KINGTIDE_OT_rebuild_buoys(Operator):
    """Build (or refresh) the ``gate_buoys`` strip from the racing
    line. Useful for kickstarting buoys on an existing .blend without
    nudging the spline first — after this runs once, the depsgraph
    handler keeps them in sync on subsequent edits.

    Works on water-only tracks (no road required) — samples
    ``ai_spline_main`` (or ``road_curve_main`` as a legacy fallback
    if no spline exists)."""

    bl_idname = "kingtide.rebuild_buoys"
    bl_label = "Rebuild Buoys"
    bl_description = (
        "Build / refresh marker buoys along the racing line wherever "
        "it crosses open water. Samples ai_spline_main (or "
        "road_curve_main as a legacy fallback); safe to spam"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        result = rebuild_buoys(context.scene)
        if result is None:
            scene = context.scene
            sea = float(getattr(scene, "hoverbike_water_height", 0.0))
            has_water = (
                sea != 0.0
                or bpy.data.objects.get("water_volume_main") is not None
                or bpy.data.objects.get("water_preview") is not None
            )
            if not has_water:
                self.report(
                    {"WARNING"},
                    "No buoys built — set Sea level (Water panel) or rebuild the water preview.",
                )
            elif _resolve_buoy_curve() is None:
                self.report(
                    {"WARNING"},
                    "No buoys built — no ai_spline_main or road_curve_main in scene.",
                )
            elif not bool(getattr(scene, "hoverbike_gate_buoys_enabled", True)):
                self.report({"INFO"}, "Buoys disabled — toggle Auto buoys to enable.")
            else:
                self.report({"INFO"}, "No samples cross open water — no buoys placed.")
            return {"FINISHED"}
        self.report(
            {"INFO"},
            f"Buoys: {result['buoy_pairs']} pair(s) along {result['curve']}.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_rebuild_buoys,
)

_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_gate_buoys_enabled",
    "hoverbike_gate_buoy_spacing_m",
    "hoverbike_gate_buoy_side_offset_mult",
)


def _on_buoy_prop_update(self, context):
    """Update callback shared by every buoy scene prop. Schedules a
    debounced buoy rebuild so slider drags don't trigger one rebuild
    per frame. Silent no-op if handlers isn't registered yet."""
    try:
        from . import handlers as _handlers
    except ImportError:
        return
    _handlers._schedule_rebuild("buoys")


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_gate_buoys_enabled = BoolProperty(
        name="Auto buoys (over water)",
        description=(
            "Place marker buoys along both sides of the racing line wherever "
            "the spline sits above open water. Buoys float at sea level; "
            "samples flagged by a raycast hitting terrain below the water "
            "surface (or no terrain at all)"
        ),
        default=True,
        update=_on_buoy_prop_update,
    )
    bpy.types.Scene.hoverbike_gate_buoy_spacing_m = FloatProperty(
        name="Buoy spacing (m)",
        description=(
            "Arc-length distance between buoy pairs in metres. Independent "
            "of gate width — narrowing gates for difficulty doesn't re-space "
            "the buoy markers. Default 42 m matches the prior 1.5× default at "
            "the default 28 m gate full-width"
        ),
        default=42.0, min=1.0, max=500.0, precision=1, subtype="DISTANCE",
        update=_on_buoy_prop_update,
    )
    bpy.types.Scene.hoverbike_gate_buoy_side_offset_mult = FloatProperty(
        name="Buoy side offset (× gate w)",
        description=(
            "Lateral distance from the racing line to each buoy, expressed "
            "as a multiplier of the gate's full width (= 2 × hoverbike_gate_half_width). "
            "Default 1.5 = each buoy sits 1.5× a gate-width out from the "
            "curve, so on default geometry (gate half-width 14 m → full 28 m) "
            "buoys land 42 m off the racing line. Per-sample radius scales "
            "this so widened apexes carry a wider buoy channel"
        ),
        default=1.5, min=0.0, max=10.0, precision=2,
        update=_on_buoy_prop_update,
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
