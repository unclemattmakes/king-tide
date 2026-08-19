"""Scatter strokes (Proposal C — curve-bounded scatter).

Authors draw a Bezier curve; the HV_StrokeScatter GN graph builds a
flat ribbon of width ``2 × Width`` along the curve and scatters a
Source collection across the ribbon area. Each stroke is an *additive*
layer on top of the biome palette (Proposal A) — drop a stroke for
"this specific grove" or "this rock pile" without touching the
whole-terrain scatter.

Per-stroke object layout:

  scatter_<prop>_stroke_NN          (Empty, organiser + parent)
   ├─ scatter_<prop>_stroke_NN_curve (Curve, user-editable shape)
   └─ scatter_<prop>_stroke_NN_surf  (Mesh, near-empty; HV_StrokeScatter mod)

The modifier on the surf mesh reads the curve sibling via Object Info,
so editing the curve in the viewport re-evaluates the scatter live
(via the existing depsgraph handler, same as the road / gate-preview
flow). The Empty parent is required because Blender's glTF exporter
only emits ``EXT_mesh_gpu_instancing`` for instanced meshes that are
children of an Empty.

Multiple strokes per track compose: each stroke is independent (own
modifier, own Source, own Width / Density). Strokes of the same
prop get sequential ``_NN`` suffixes (``scatter_palm_stroke_00``,
``scatter_palm_stroke_01``, ...).
"""

from __future__ import annotations

import os
import re

import bpy
from bpy.props import EnumProperty, FloatProperty
from bpy.types import Operator, Panel


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

STROKE_PREFIX_TEMPLATE = "scatter_{prop}_stroke_"
STROKE_GROUP_NAME = "HV_StrokeScatter"
STROKE_MOD_NAME = "HV_StrokeScatter"
PROPS_LIBRARY_RELPATH = os.path.join("tracks-src", "props-library.blend")

# Available stroke source presets. The Add operator picks one of these
# and uses it for both the object naming (so the prop type is visible
# in the outliner) and the initial Source socket value. Authors can
# always swap Source on any stroke's modifier panel afterwards — the
# preset just names the stroke and seeds the right collection.
STROKE_SOURCE_PRESETS = (
    ("palm",      "prop_palm",      "Palm",      "Palms — tropical foliage along curves"),
    ("rock",      "prop_rock",      "Rock",      "Rocks — rocky outcrops, scree, boulders"),
    ("driftwood", "prop_log",       "Driftwood", "Driftwood logs — beach lines, debris fields"),
    ("buoy",      "prop_buoy",      "Buoy",      "Buoys — water-line markers along curves"),
)


# ────────────────────────────────────────────────────────────────────
# Library plumbing
# ────────────────────────────────────────────────────────────────────


def _repo_root_from_blend() -> str | None:
    # The dir holding tracks-src/ (where props-library.blend lives), derived
    # from the open .blend. Honors authoring outside the repo, e.g. a
    # Drive-synced tracks-src/. See _legacy.assets_root_from_blend.
    from ._legacy import assets_root_from_blend

    return assets_root_from_blend(bpy.data.filepath)


def _ensure_node_group() -> bpy.types.NodeTree | None:
    existing = bpy.data.node_groups.get(STROKE_GROUP_NAME)
    if existing is not None:
        return existing
    repo = _repo_root_from_blend()
    if repo is None:
        return None
    library_path = os.path.join(repo, PROPS_LIBRARY_RELPATH)
    if not os.path.isfile(library_path):
        return None
    with bpy.data.libraries.load(library_path, link=True) as (data_from, data_to):
        if STROKE_GROUP_NAME not in data_from.node_groups:
            return None
        data_to.node_groups = [STROKE_GROUP_NAME]
    return bpy.data.node_groups.get(STROKE_GROUP_NAME)


def _ensure_source_collection(name: str) -> bpy.types.Collection | None:
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


# ────────────────────────────────────────────────────────────────────
# Naming + spawning
# ────────────────────────────────────────────────────────────────────


def _next_stroke_name(prop_key: str) -> str:
    """First free ``scatter_<prop>_stroke_NN`` slot. Per-prop counter so
    palm strokes and rock strokes have independent numbering — easier
    to read in the outliner."""
    prefix = STROKE_PREFIX_TEMPLATE.format(prop=prop_key)
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    used = set()
    for obj in bpy.data.objects:
        match = pattern.match(obj.name)
        if match:
            used.add(int(match.group(1)))
    i = 0
    while i in used:
        i += 1
    return f"{prefix}{i:02d}"


def _build_starter_curve(name: str, cursor_location, cursor_rotation) -> bpy.types.Curve:
    """A 4-anchor Bezier centred at the cursor with a small starter
    bend so authors can immediately see the curve and tab-edit its
    handles. ~12 m long, gentle S-curve along local +Y.

    Constants tuned so the curve is visible at default scene scale
    without dominating the viewport — same scale-of-thing as the
    ramp / road starter curves."""
    cu = bpy.data.curves.new(name=name, type="CURVE")
    cu.dimensions = "3D"
    cu.resolution_u = 12

    spline = cu.splines.new("BEZIER")
    spline.bezier_points.add(3)  # spline starts with 1; add 3 → 4 total

    anchors = [
        (-6.0,  0.0, 0.0),
        (-2.0,  1.0, 0.0),
        ( 2.0, -1.0, 0.0),
        ( 6.0,  0.0, 0.0),
    ]
    for bp, (x, y, z) in zip(spline.bezier_points, anchors):
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"

    spline.use_cyclic_u = False
    return cu


def _build_surf_mesh(name: str) -> bpy.types.Mesh:
    """Single-vertex placeholder — the modifier reads the curve via
    Object Info; this mesh's data is unused. Exists so the modifier
    has an owner and the InstanceOnPoints output qualifies for
    ``EXT_mesh_gpu_instancing`` (the spec requires a mesh, child of
    an Empty)."""
    me = bpy.data.meshes.new(name)
    me.vertices.add(1)
    return me


def _socket_name_map(group: bpy.types.NodeTree) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in group.interface.items_tree:
        if (
            getattr(item, "in_out", None) == "INPUT"
            and getattr(item, "item_type", None) == "SOCKET"
        ):
            out[item.name] = item.identifier
    return out


def _apply_modifier_inputs(
    modifier: bpy.types.NodesModifier,
    *,
    curve_obj: bpy.types.Object,
    source: bpy.types.Collection | None,
    width: float,
    density: float,
) -> None:
    group = modifier.node_group
    if group is None:
        return
    ids = _socket_name_map(group)

    def _set(name: str, value) -> None:
        ident = ids.get(name)
        if ident is None:
            return
        try:
            modifier[ident] = value
        except (TypeError, ValueError, RuntimeError):
            pass

    _set("Curve", curve_obj)
    _set("Source", source)
    _set("Width", float(width))
    _set("Density", float(density))
    _set("Size Min", 0.85)
    _set("Size Max", 1.20)
    # Seed: deterministic hash of the stroke name so re-builds are
    # reproducible across re-opens, and different strokes don't
    # share-distribution.
    _set("Seed", abs(hash(curve_obj.name)) % 100000)


def _spawn_stroke(
    context: bpy.types.Context,
    *,
    prop_key: str,
    source_name: str,
    width: float,
    density: float,
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object] | None:
    """Drop the Empty + Curve + Surf triplet at the 3D cursor with the
    HV_StrokeScatter modifier pre-attached and bound to the curve.
    Returns ``(empty, curve_obj, surf)`` or ``None`` if the props
    library is unreachable."""
    group = _ensure_node_group()
    if group is None:
        return None
    source = _ensure_source_collection(source_name)
    if source is None:
        return None

    base_name = _next_stroke_name(prop_key)
    cursor = context.scene.cursor

    # 1. Empty (parent / organiser).
    empty = bpy.data.objects.new(base_name, None)
    empty.empty_display_type = "ARROWS"
    empty.empty_display_size = 4.0
    empty["kind"] = "decoration"
    empty["scatter_stroke"] = True
    empty["scatter_stroke_prop"] = prop_key
    empty.location = cursor.location.copy()
    empty.rotation_euler = cursor.rotation_euler.copy()
    context.scene.collection.objects.link(empty)

    # 2. Curve — the user-facing authored shape. Parented to the Empty
    #    and positioned at origin in parent space so dragging the Empty
    #    drags the whole stroke (curve + surf in lockstep).
    curve_data = _build_starter_curve(
        f"{base_name}_curve",
        cursor.location,
        cursor.rotation_euler,
    )
    curve_obj = bpy.data.objects.new(f"{base_name}_curve", curve_data)
    curve_obj.parent = empty
    curve_obj.matrix_parent_inverse.identity()
    curve_obj["kind"] = "decoration"
    context.scene.collection.objects.link(curve_obj)

    # 3. Surf mesh — modifier owner. Single vertex; the GN graph reads
    #    the curve via Object Info, not this mesh's data.
    surf_data = _build_surf_mesh(f"{base_name}_surf_mesh")
    surf = bpy.data.objects.new(f"{base_name}_surf", surf_data)
    surf.parent = empty
    surf.matrix_parent_inverse.identity()
    surf["kind"] = "decoration"
    context.scene.collection.objects.link(surf)

    # 4. Attach the modifier + apply defaults.
    mod = surf.modifiers.new(name=STROKE_MOD_NAME, type="NODES")
    mod.node_group = group
    _apply_modifier_inputs(
        mod,
        curve_obj=curve_obj,
        source=source,
        width=width,
        density=density,
    )

    return empty, curve_obj, surf


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


_PROP_ENUM_ITEMS = tuple(
    (key, label, desc)
    for (key, _coll, label, desc) in STROKE_SOURCE_PRESETS
)


class KINGTIDE_OT_add_scatter_stroke(Operator):
    """Drop a scatter-stroke triplet (Empty + Curve + surf Mesh) at the
    3D cursor with the HV_StrokeScatter modifier pre-attached. Author
    tabs into edit mode on the curve, drags handles to shape the stroke;
    instances re-distribute live as the curve changes."""

    bl_idname = "kingtide.add_scatter_stroke"
    bl_label = "Add Scatter Stroke"
    bl_description = (
        "Drop a Bezier-curve scatter stroke at the 3D cursor. Edit the curve "
        "in Edit Mode; the HV_StrokeScatter modifier sweeps a ribbon along it "
        "and scatters the chosen prop collection across the ribbon area"
    )
    bl_options = {"REGISTER", "UNDO"}

    prop: EnumProperty(  # type: ignore[valid-type]
        name="Prop",
        description="Which prop collection HV_StrokeScatter instances along the stroke",
        items=_PROP_ENUM_ITEMS,
        default="palm",
    )
    width: FloatProperty(  # type: ignore[valid-type]
        name="Width (m)",
        description="Perpendicular half-extent of the scatter band around the curve",
        default=8.0,
        min=0.5,
        soft_max=50.0,
    )
    density: FloatProperty(  # type: ignore[valid-type]
        name="Density (/m²)",
        description="Instances per square metre of ribbon area",
        default=0.10,
        min=0.0,
        soft_max=2.0,
    )

    def execute(self, context):
        preset = next((p for p in STROKE_SOURCE_PRESETS if p[0] == self.prop), None)
        if preset is None:
            self.report({"ERROR"}, f"unknown stroke prop {self.prop!r}")
            return {"CANCELLED"}
        _key, source_name, _label, _desc = preset

        result = _spawn_stroke(
            context,
            prop_key=self.prop,
            source_name=source_name,
            width=self.width,
            density=self.density,
        )
        if result is None:
            self.report(
                {"ERROR"},
                "Couldn't link HV_StrokeScatter or the source collection from "
                "tracks-src/props-library.blend. Run `pnpm seed:props` and "
                "re-save this .blend inside a king-tide clone.",
            )
            return {"CANCELLED"}
        empty, curve_obj, _surf = result

        # Select + activate the *curve* so the author can Tab straight
        # into Edit Mode to shape it.
        for o in context.selected_objects:
            o.select_set(False)
        curve_obj.select_set(True)
        context.view_layer.objects.active = curve_obj

        self.report(
            {"INFO"},
            f"Added {empty.name} — Tab into edit mode on {curve_obj.name} "
            "to shape the stroke. Add a Shrinkwrap modifier to the curve "
            "for terrain conformance.",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Selection-driven panel
# ────────────────────────────────────────────────────────────────────


_STROKE_NAME_PATTERN = re.compile(r"^scatter_(\w+?)_stroke_(\d+)(?:_curve|_surf)?$")


def _resolve_stroke_objects(
    obj: bpy.types.Object | None,
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object, bpy.types.NodesModifier] | None:
    """Given any one of the three stroke objects, find the triplet +
    the HV_StrokeScatter modifier. Returns ``None`` if ``obj`` isn't
    part of a stroke."""
    if obj is None:
        return None
    match = _STROKE_NAME_PATTERN.match(obj.name)
    if not match:
        return None
    base_name = f"scatter_{match.group(1)}_stroke_{match.group(2)}"
    empty = bpy.data.objects.get(base_name)
    curve_obj = bpy.data.objects.get(f"{base_name}_curve")
    surf = bpy.data.objects.get(f"{base_name}_surf")
    if empty is None or curve_obj is None or surf is None:
        return None
    mod = next(
        (
            m for m in surf.modifiers
            if m.type == "NODES"
            and getattr(m, "node_group", None) is not None
            and m.node_group.name == STROKE_GROUP_NAME
        ),
        None,
    )
    if mod is None:
        return None
    return empty, curve_obj, surf, mod


class KINGTIDE_PT_track_scatter_stroke(Panel):
    """Surfaces when one of the three stroke objects (empty / curve /
    surf) is selected. Exposes the HV_StrokeScatter modifier sockets
    live + an in-edit-mode hint when the curve is being shaped."""

    bl_label = "Scatter stroke"
    bl_idname = "KINGTIDE_PT_track_scatter_stroke"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "King Tide"
    bl_parent_id = "KINGTIDE_PT_panel"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode

        if detect_mode(bpy.data.filepath) != "track":
            return False
        return _resolve_stroke_objects(context.active_object) is not None

    def draw(self, context):
        layout = self.layout
        bundle = _resolve_stroke_objects(context.active_object)
        if bundle is None:
            return
        empty, curve_obj, surf, mod = bundle
        ids = _socket_name_map(mod.node_group)

        header = layout.row(align=True)
        header.label(text=empty.name, icon="OUTLINER_OB_CURVE")

        # Edit-curve shortcut. Selecting the curve + entering edit mode
        # is the primary verb here; surface it as a big button.
        edit_row = layout.row(align=True)
        if context.mode == "EDIT_CURVE" and context.active_object == curve_obj:
            edit_row.label(text="Editing curve", icon="EDITMODE_HLT")
            edit_row.label(text="Tab → back", icon="LOOP_BACK")
        else:
            op = edit_row.operator(
                "object.mode_set",
                text="Edit curve",
                icon="GREASEPENCIL",
            )
            # Can only enter Edit Mode while the curve is active; the
            # author may have the empty or surf active. Switch active
            # here would need a separate operator — for v1, document
            # the requirement and let the author click the curve first.
            op.mode = "EDIT"

        layout.separator()

        def _prop_row(label: str, key: str) -> None:
            ident = ids.get(key)
            if ident is None:
                return
            r = layout.row(align=True)
            r.label(text=label)
            r.prop(mod, f'["{ident}"]', text="")

        _prop_row("Source",         "Source")
        _prop_row("Width (m)",      "Width")
        _prop_row("Density (/m²)",  "Density")
        _prop_row("Size min",       "Size Min")
        _prop_row("Size max",       "Size Max")
        _prop_row("Seed",           "Seed")

        layout.separator()
        # Snap-to-terrain is on the wishlist but the existing
        # ``kingtide.snap_curve_to_terrain`` operator is hard-bound to
        # ``road_curve_main`` — adding a generic version is a small
        # follow-up. For v1 the author drops the curve at the cursor,
        # tabs into edit mode, and drags handles manually. Blender's
        # built-in Shrinkwrap modifier on the curve is another option
        # for one-shot terrain conformance.
        tip = layout.box()
        tip.label(text="To follow terrain:", icon="INFO")
        tip.label(text="  Tab → drag handles, or")
        tip.label(text="  add a Shrinkwrap modifier to the curve")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    KINGTIDE_OT_add_scatter_stroke,
    KINGTIDE_PT_track_scatter_stroke,
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
