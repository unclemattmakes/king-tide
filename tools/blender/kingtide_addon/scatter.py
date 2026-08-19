"""Scatter zone authoring.

A scatter zone is the authoring surface for Layer A in
[docs/level-visual-quality-research.md](../../../docs/level-visual-quality-research.md).
Each zone is an Empty ``scatter_<NN>`` that parents a target mesh
(the "ground" the scatter samples) carrying the shared HV_Scatter
geometry-nodes modifier. The modifier's Source Collection socket
points at one of the ``prop_*`` collections in
``tracks-src/props-library.blend`` — palms by default.

  scatter_NN          (Empty, organizer + position + custom-prop knobs)
   └─ scatter_NN_surf (Mesh, the scatter target; HV_Scatter modifier)

At export time, Blender's glTF exporter sees the InstanceOnPoints
output of HV_Scatter and emits ``EXT_mesh_gpu_instancing`` (the addon's
exporter already passes ``export_gpu_instances=True``), which the
runtime lifts into ``THREE.InstancedMesh``. The whole zone — hundreds
of palms or rocks — ships as one InstancedMesh per archetype.

This module mirrors ``wave_zone.py`` in shape: a per-zone refresh that
reads custom props off the Empty and re-applies them to the modifier,
plus an Add operator that drops the pair pre-wired.

The HV_Scatter graph itself lives in ``seed_props_library.py``;
re-running the seed regenerates the node group. We link from the
library at operator-execute time so the same graph drives every
track's scatter.
"""

from __future__ import annotations

import math
import os
import re

import bpy
import bmesh
from bpy.props import EnumProperty, FloatProperty
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

SCATTER_OBJECT_PREFIX = "scatter_"
SCATTER_GROUP_NAME = "HV_Scatter"
PROPS_LIBRARY_RELPATH = os.path.join("tracks-src", "props-library.blend")

# Default source collection — palms read at race-pace better than rocks
# do, so a fresh scatter zone instances palms unless the author switches
# the source on the modifier. The user can pick any ``prop_*`` from the
# Source picker.
DEFAULT_SOURCE_COLLECTION = "prop_palm"


# ────────────────────────────────────────────────────────────────────
# Helpers — load HV_Scatter + the source collection from the library
# ────────────────────────────────────────────────────────────────────


def _repo_root_from_blend() -> str | None:
    """The dir holding ``tracks-src/`` (where ``props-library.blend`` lives),
    derived from the open .blend. Honors authoring outside the repo, e.g. a
    Drive-synced ``tracks-src/``. See ``_legacy.assets_root_from_blend``."""
    from ._legacy import assets_root_from_blend

    return assets_root_from_blend(bpy.data.filepath)


def _ensure_scatter_node_group() -> bpy.types.NodeTree | None:
    """Link the HV_Scatter geometry-nodes group from
    ``tracks-src/props-library.blend`` into the current .blend. If it's
    already present (linked or local), return the existing block."""
    g = bpy.data.node_groups.get(SCATTER_GROUP_NAME)
    if g is not None:
        return g
    repo = _repo_root_from_blend()
    if repo is None:
        return None
    library_path = os.path.join(repo, PROPS_LIBRARY_RELPATH)
    if not os.path.isfile(library_path):
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if SCATTER_GROUP_NAME not in data_from.node_groups:
            return None
        data_to.node_groups = [SCATTER_GROUP_NAME]
    return bpy.data.node_groups.get(SCATTER_GROUP_NAME)


def _ensure_source_collection(name: str) -> bpy.types.Collection | None:
    """Link a ``prop_*`` collection from the props library. Same trick
    the per-track seed scripts use for palms."""
    existing = bpy.data.collections.get(name)
    if existing is not None:
        return existing
    repo = _repo_root_from_blend()
    if repo is None:
        return None
    library_path = os.path.join(repo, PROPS_LIBRARY_RELPATH)
    if not os.path.isfile(library_path):
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if name not in data_from.collections:
            return None
        data_to.collections = [name]
    return bpy.data.collections.get(name)


def _next_scatter_name() -> str:
    """First free ``scatter_NN`` slot. Zero-padded to two digits to
    match the ``boost_NN`` / ``wave_zone_NN`` family."""
    i = 0
    while True:
        name = f"{SCATTER_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


# ────────────────────────────────────────────────────────────────────
# Target mesh builder — a flat slab sized to the zone's half-extents
# ────────────────────────────────────────────────────────────────────


def _build_target_surface(
    name: str,
    *,
    half_width: float,
    half_depth: float,
    subdivisions: int = 4,
) -> bpy.types.Mesh:
    """Build the scatter target as a flat ``half_width × half_depth``
    plane subdivided into ``subdivisions`` × ``subdivisions`` quads.
    Stays flat by default so Distribute Points on Faces has uniform
    weighting; authors can edit-mode-displace the surface (or shrinkwrap
    it onto the terrain) for elevation-aware scatter."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_grid(
        bm,
        x_segments=max(1, subdivisions),
        y_segments=max(1, subdivisions),
        size=1.0,
        calc_uvs=False,
    )
    # bmesh's grid is a 2×2-by-default square centred at origin in XY;
    # we scale to the zone's half-extents so the plane covers the empty's
    # footprint. Use bmesh.ops.scale rather than rebuilding so face
    # winding/normal stays consistent (+Z up).
    bmesh.ops.scale(bm, vec=(half_width, half_depth, 1.0), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return me


# ────────────────────────────────────────────────────────────────────
# Modifier wiring — pull custom-prop knobs onto the HV_Scatter modifier
# ────────────────────────────────────────────────────────────────────


def _apply_modifier_inputs(
    obj: bpy.types.Object,
    mod: bpy.types.NodesModifier,
    *,
    source: bpy.types.Collection | None,
) -> None:
    """Map the zone's per-instance knobs (read from custom props on the
    Empty parent) onto HV_Scatter's input sockets. Same identifier-lookup
    dance ``_make_prop_collection`` uses in the seed script."""
    group = mod.node_group
    if group is None:
        return
    name_to_id: dict[str, str] = {}
    for item in group.interface.items_tree:
        if (
            getattr(item, "in_out", None) == "INPUT"
            and getattr(item, "item_type", None) == "SOCKET"
        ):
            name_to_id[item.name] = item.identifier

    def _set(name: str, value):
        ident = name_to_id.get(name)
        if ident is None:
            return
        try:
            mod[ident] = value
        except (TypeError, ValueError):
            pass

    # Knobs live on the Empty parent (the user-facing surface) so the
    # author can tune from one panel; mirror onto the modifier here.
    parent = obj.parent
    knobs = parent if parent is not None else obj
    _set("Source", source)
    _set("Density", float(knobs.get("density", 0.05)))
    _set("Slope Max (deg)", float(knobs.get("slope_max_deg", 35.0)))
    _set("Z Min", float(knobs.get("z_min", -100.0)))
    _set("Z Max", float(knobs.get("z_max", 500.0)))
    _set("Size Min", float(knobs.get("size_min", 0.85)))
    _set("Size Max", float(knobs.get("size_max", 1.20)))
    _set("Seed", int(knobs.get("seed", 0)))


def _spawn_zone(
    context: bpy.types.Context,
    *,
    source_name: str,
    half_width: float,
    half_depth: float,
) -> tuple[bpy.types.Object, bpy.types.Object] | None:
    """Drop a ``scatter_NN`` Empty + ``scatter_NN_surf`` Mesh pair at the
    3D cursor, attach HV_Scatter, point Source at ``source_name``.
    Returns ``(empty, surf)`` or ``None`` if the props library isn't
    reachable from this .blend.
    """
    group = _ensure_scatter_node_group()
    if group is None:
        return None
    source = _ensure_source_collection(source_name)
    if source is None:
        return None

    name = _next_scatter_name()
    cursor = context.scene.cursor

    # Empty — organizer + custom-prop home.
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "CUBE"
    empty.empty_display_size = 4.0
    empty["kind"] = "decoration"  # the empty itself doesn't ship a collider
    empty["scatter_zone"] = True
    empty["density"] = 0.05
    empty["slope_max_deg"] = 35.0
    empty["z_min"] = -100.0
    empty["z_max"] = 500.0
    empty["size_min"] = 0.85
    empty["size_max"] = 1.20
    empty["seed"] = abs(hash(name)) % 100000
    empty["source_collection"] = source_name
    empty.location = cursor.location.copy()
    empty.rotation_euler = cursor.rotation_euler.copy()
    context.scene.collection.objects.link(empty)

    # Surface mesh — child of the Empty so moving / rotating the parent
    # moves the scatter coverage.
    mesh_data = _build_target_surface(
        f"{name}_surf_mesh",
        half_width=half_width,
        half_depth=half_depth,
        subdivisions=4,
    )
    surf = bpy.data.objects.new(f"{name}_surf", mesh_data)
    surf.parent = empty
    surf.matrix_parent_inverse.identity()
    # Hide from the runtime collider attach — the target plane is for
    # the GN graph's sampling, not for the player to collide with. The
    # InstanceOnPoints output is what ships through EXT_mesh_gpu_instancing.
    surf["kind"] = "decoration"
    context.scene.collection.objects.link(surf)

    mod = surf.modifiers.new(name="HV_Scatter", type="NODES")
    mod.node_group = group
    _apply_modifier_inputs(surf, mod, source=source)

    return empty, surf


def refresh_scatter_zones(scene) -> int:
    """Walk every ``scatter_NN`` empty in the scene and re-apply the
    per-zone knobs to its child surface's HV_Scatter modifier. Use
    after editing custom props directly in the Properties panel (the
    panel doesn't trigger an auto-refresh on its own)."""
    count = 0
    for obj in scene.objects:
        if not re.match(r"^scatter_(\d+)$", obj.name):
            continue
        if obj.type != "EMPTY":
            continue
        source_name = str(obj.get("source_collection", DEFAULT_SOURCE_COLLECTION))
        source = bpy.data.collections.get(source_name)
        if source is None:
            source = _ensure_source_collection(source_name)
        for child in obj.children:
            for mod in child.modifiers:
                if mod.type == "NODES" and mod.node_group is not None and mod.node_group.name == SCATTER_GROUP_NAME:
                    _apply_modifier_inputs(child, mod, source=source)
                    count += 1
    return count


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


SOURCE_ENUM_ITEMS = (
    ("prop_palm", "Palm", "Scatter palms (default — tropical / coastal tracks)"),
    ("prop_rock", "Rock", "Scatter rocks (open-sea, alpine, beach edges)"),
    ("prop_buoy", "Buoy", "Scatter buoys (water-band scatter on Atlantic / open-sea tracks)"),
)


class KINGTIDE_OT_add_scatter_zone(Operator):
    """Drop a ``scatter_NN`` Empty + a target plane child at the 3D
    cursor, pre-wired with the HV_Scatter geometry-nodes modifier and a
    source collection from the props library.

    The Empty carries the per-zone knobs as custom properties (``density``,
    ``slope_max_deg``, ``z_min``/``z_max``, ``size_min``/``size_max``,
    ``seed``). Edits to the custom props refresh the modifier via the
    ``Refresh Scatter Zones`` operator (the panel can't auto-listen on
    custom-prop change).

    On export the runtime sees the surface's InstanceOnPoints output as
    ``EXT_mesh_gpu_instancing`` and lifts the whole zone into one
    ``THREE.InstancedMesh`` per source archetype.
    """

    bl_idname = "kingtide.add_scatter_zone"
    bl_label = "Add Scatter Zone"
    bl_description = (
        "Drop a scatter_NN empty + target plane at the 3D cursor with HV_Scatter "
        "pre-attached. Sample density, slope/altitude filters, and source collection "
        "live on the empty as custom properties"
    )
    bl_options = {"REGISTER", "UNDO"}

    source: EnumProperty(  # type: ignore[valid-type]
        name="Source",
        description="Which prop_* collection HV_Scatter instances on each sampled point",
        items=SOURCE_ENUM_ITEMS,
        default=DEFAULT_SOURCE_COLLECTION,
    )
    half_width: FloatProperty(  # type: ignore[valid-type]
        name="Half Width (m)",
        description="Scatter target's half-extent along local +X",
        default=30.0,
        min=2.0,
        soft_max=200.0,
    )
    half_depth: FloatProperty(  # type: ignore[valid-type]
        name="Half Depth (m)",
        description="Scatter target's half-extent along local +Y",
        default=30.0,
        min=2.0,
        soft_max=200.0,
    )

    def execute(self, context):
        result = _spawn_zone(
            context,
            source_name=self.source,
            half_width=self.half_width,
            half_depth=self.half_depth,
        )
        if result is None:
            self.report(
                {"ERROR"},
                "Couldn't link HV_Scatter or source collection from tracks-src/props-library.blend. "
                "Run `pnpm seed:props` and re-save this .blend inside a king-tide repo clone.",
            )
            return {"CANCELLED"}
        empty, surf = result

        for o in context.selected_objects:
            o.select_set(False)
        empty.select_set(True)
        context.view_layer.objects.active = empty

        self.report(
            {"INFO"},
            f"Added {empty.name} ({self.half_width * 2:.0f}m × {self.half_depth * 2:.0f}m, "
            f"source={self.source}). Edit density/slope/z props on the empty, then "
            "Refresh Scatter Zones.",
        )
        return {"FINISHED"}


class KINGTIDE_OT_refresh_scatter_zones(Operator):
    """Re-apply every ``scatter_NN`` empty's custom-prop knobs to its
    child surface's HV_Scatter modifier. Use after editing the empty's
    custom props in the Properties panel — the panel doesn't trigger the
    auto-refresh that addon-managed sliders do."""

    bl_idname = "kingtide.refresh_scatter_zones"
    bl_label = "Refresh Scatter Zones"
    bl_description = "Re-apply each scatter_NN empty's custom-prop knobs to its HV_Scatter modifier"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = refresh_scatter_zones(context.scene)
        self.report({"INFO"}, f"Refreshed {n} scatter zone modifier(s).")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_scatter_zone,
    KINGTIDE_OT_refresh_scatter_zones,
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
