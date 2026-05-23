"""Bake Geometry Nodes prop outputs into linkable mesh datablocks.

The problem this solves: when a level .blend links a mesh datablock from
``tracks-src/props-library.blend`` (the gate preview does this in
[previews.py](previews.py)), it gets the **base** mesh data — not the
output of any Geometry Nodes modifier on the source object. GN is an
object-level modifier; library linking happens at the datablock level.
Result: tweak a GN graph in props-library.blend, reload in the level,
see no change.

The fix: split each GN-driven prop into two mesh datablocks held by two
objects:

- ``<name>`` — the authoring object the user edits, keeps its GN
  modifier. Its mesh data is renamed to ``<name>_source`` so the
  datablock name doesn't collide with the bake target.
- ``<name>_baked`` — a hidden host object in the
  ``_hoverbike_baked_props`` collection, holding a mesh datablock
  named ``<name>``. This is what the level links.

A ``save_pre`` handler walks every object whose mesh data ends in
``_source``, evaluates the modifier output, and writes the resulting
geometry + materials into the matching ``<name>`` datablock in-place
(preserves the datablock identity so existing library links pick the
new content up on reload). Authors iterate the GN graph normally; the
bake happens on every Ctrl+S.

The split is deliberately reversible: deleting ``<name>_baked`` and
renaming the source mesh data back to ``<name>`` restores the
pre-migration state.
"""

from __future__ import annotations

import os

import bmesh
import bpy
from bpy.app.handlers import persistent
from bpy.types import Operator, Panel


# ────────────────────────────────────────────────────────────────────
# Conventions
# ────────────────────────────────────────────────────────────────────

# Suffix appended to the mesh datablock name on the authoring object.
# A mesh named "prop_gate_mesh_source" feeds into a bake that writes
# "prop_gate_mesh" — the name the library link expects.
SOURCE_SUFFIX = "_source"

# Hidden collection that hosts the baked output objects. View-layer
# excluded so the props-library viewport isn't cluttered.
BAKED_COLLECTION = "_hoverbike_baked_props"

# Bake fires automatically only when saving this file. Other .blends
# can call the operator manually but won't trigger the save handler.
TARGET_LIBRARY_BASENAME = "props-library.blend"


# ────────────────────────────────────────────────────────────────────
# Bake core
# ────────────────────────────────────────────────────────────────────


def _target_mesh_name(source_mesh_name: str) -> str | None:
    if not source_mesh_name.endswith(SOURCE_SUFFIX):
        return None
    return source_mesh_name[: -len(SOURCE_SUFFIX)]


def bake_prop_obj(obj: bpy.types.Object) -> str | None:
    """Evaluate ``obj``'s modifier output and write the resulting
    geometry + materials into the mesh datablock whose name matches
    ``obj.data.name`` minus the ``_source`` suffix. Returns the target
    mesh name on success, or None if the object isn't a bake source."""
    if obj.type != "MESH" or obj.data is None:
        return None
    target_name = _target_mesh_name(obj.data.name)
    if target_name is None:
        return None
    target = bpy.data.meshes.get(target_name)
    if target is None:
        return None

    dg = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(dg)
    # new_from_object copies the *evaluated* (post-modifier) mesh into
    # a fresh datablock. We then transfer its geometry into the
    # already-existing target via bmesh so the target's datablock
    # identity (and therefore every library link referencing it) is
    # preserved.
    new_mesh = bpy.data.meshes.new_from_object(eval_obj)

    bm = bmesh.new()
    try:
        bm.from_mesh(new_mesh)
        target.clear_geometry()
        bm.to_mesh(target)
    finally:
        bm.free()
    target.update()

    target.materials.clear()
    for mat in new_mesh.materials:
        if mat is not None:
            target.materials.append(mat)

    bpy.data.meshes.remove(new_mesh)
    return target_name


def bake_all_prop_meshes() -> list[str]:
    """Bake every object in the file whose mesh data ends in
    ``_source``. Returns the list of target mesh names actually
    written. Safe to spam — idempotent given a stable GN graph."""
    baked: list[str] = []
    for obj in bpy.data.objects:
        name = bake_prop_obj(obj)
        if name is not None:
            baked.append(name)
    return baked


# ────────────────────────────────────────────────────────────────────
# Migration — one-time per prop
# ────────────────────────────────────────────────────────────────────


def _ensure_baked_collection(scene: bpy.types.Scene) -> bpy.types.Collection:
    coll = bpy.data.collections.get(BAKED_COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(BAKED_COLLECTION)
        scene.collection.children.link(coll)
    # Hide on every view layer so the bake host objects don't render
    # or clutter the outliner.
    for layer in scene.view_layers:
        layer_coll = layer.layer_collection.children.get(BAKED_COLLECTION)
        if layer_coll is not None:
            layer_coll.exclude = True
    return coll


def migrate_prop_to_baked_split(obj: bpy.types.Object) -> str:
    """Split ``obj`` into a source-authoring object + a baked host
    object. ``obj`` keeps its name and modifier; only its mesh data is
    renamed with the ``_source`` suffix. A new ``<base>`` mesh datablock
    + ``<base>_baked`` host object are created and the initial bake is
    run. Returns the new mesh datablock name.

    Idempotent — calling on an already-migrated object is a no-op."""
    if obj.type != "MESH" or obj.data is None:
        raise RuntimeError(f"'{obj.name}' is not a mesh.")
    if obj.data.name.endswith(SOURCE_SUFFIX):
        # Already migrated; just re-bake.
        target = _target_mesh_name(obj.data.name)
        bake_prop_obj(obj)
        return target or ""

    base_mesh_name = obj.data.name
    source_mesh_name = base_mesh_name + SOURCE_SUFFIX

    # Rename the authoring mesh data so its name no longer collides
    # with the bake target.
    obj.data.name = source_mesh_name

    # Create a fresh empty mesh datablock at the original name + a
    # hidden host object to anchor it in the .blend.
    baked_mesh = bpy.data.meshes.new(base_mesh_name)
    baked_obj_name = base_mesh_name + "_baked"
    baked_obj = bpy.data.objects.new(baked_obj_name, baked_mesh)
    baked_obj.matrix_world = obj.matrix_world.copy()
    baked_obj.hide_viewport = True
    baked_obj.hide_render = True
    baked_obj.hide_select = True

    coll = _ensure_baked_collection(bpy.context.scene)
    coll.objects.link(baked_obj)

    bake_prop_obj(obj)
    return base_mesh_name


# ────────────────────────────────────────────────────────────────────
# save_pre handler
# ────────────────────────────────────────────────────────────────────


@persistent
def _hoverbike_save_pre_bake(*_args):
    """Bake every GN prop into its linkable mesh datablock before the
    .blend is written. Only fires for ``props-library.blend`` so
    arbitrary track / bike saves don't pay for unrelated work."""
    blend = bpy.data.filepath
    if not blend:
        return
    if os.path.basename(blend).lower() != TARGET_LIBRARY_BASENAME:
        return
    baked = bake_all_prop_meshes()
    if baked:
        print(
            f"[hoverbike] save_pre: baked {len(baked)} prop mesh(es): "
            f"{', '.join(baked)}"
        )


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_setup_prop_mesh_bake(Operator):
    """Convert the active GN-modified prop into source/baked pair so
    library consumers see the modifier output. Run once per prop; from
    then on the save_pre handler keeps the baked mesh fresh."""

    bl_idname = "hoverbike.setup_prop_mesh_bake"
    bl_label = "Setup GN Bake for Active"
    bl_description = (
        "Split the active GN-modified prop into authoring source + "
        "linkable baked output, so edits to the GN graph reach level "
        ".blends that link this mesh. One-time per prop."
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        if obj is None or obj.type != "MESH" or obj.data is None:
            return False
        if obj.data.name.endswith(SOURCE_SUFFIX):
            return False  # already migrated
        return any(m.type == "NODES" for m in obj.modifiers)

    def execute(self, context):
        obj = context.active_object
        try:
            target = migrate_prop_to_baked_split(obj)
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Split '{obj.name}' → source ('{obj.data.name}') + baked ('{target}'). "
            f"Save the .blend to write the baked mesh to disk.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_bake_prop_meshes(Operator):
    """Re-bake every GN-prop in the current file. Fires automatically
    on save; this button is the manual trigger for ad-hoc refreshes."""

    bl_idname = "hoverbike.bake_prop_meshes"
    bl_label = "Bake All GN Props"
    bl_description = (
        "Evaluate every prop whose mesh data ends in '_source' and "
        "write the result into the matching base mesh datablock. "
        "Fires automatically on save of props-library.blend."
    )
    bl_options = {"REGISTER"}

    def execute(self, context):
        baked = bake_all_prop_meshes()
        if not baked:
            self.report(
                {"INFO"},
                "No GN props to bake. Run 'Setup GN Bake for Active' on a "
                "prop with a Geometry Nodes modifier first.",
            )
            return {"FINISHED"}
        self.report(
            {"INFO"},
            f"Baked {len(baked)} prop mesh(es): {', '.join(baked)}",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Panel
# ────────────────────────────────────────────────────────────────────


def _is_props_library_open() -> bool:
    blend = bpy.data.filepath
    if not blend:
        return False
    return os.path.basename(blend).lower() == TARGET_LIBRARY_BASENAME


class HOVERBIKE_PT_props_library_bake(Panel):
    """Sub-panel: GN-prop bake controls. Visible only when editing
    ``props-library.blend`` — the bake split is a library-side concern,
    not something authors of individual tracks need to see."""

    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"
    bl_label = "GN Prop Bake"
    bl_idname = "HOVERBIKE_PT_props_library_bake"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        return _is_props_library_open()

    def draw(self, context):
        layout = self.layout
        obj = context.active_object

        col = layout.column(align=True)
        col.label(text="Author once per prop:")
        row = col.row(align=True)
        row.operator(HOVERBIKE_OT_setup_prop_mesh_bake.bl_idname, icon="MOD_NODES")
        if obj is not None and obj.type == "MESH" and obj.data is not None:
            if obj.data.name.endswith(SOURCE_SUFFIX):
                target = _target_mesh_name(obj.data.name) or "?"
                col.label(
                    text=f"Active is migrated → '{target}'",
                    icon="CHECKMARK",
                )
            elif any(m.type == "NODES" for m in obj.modifiers):
                col.label(text="Active is GN-modified, not migrated.", icon="INFO")
            else:
                col.label(text="Active has no GN modifier.", icon="DOT")
        else:
            col.label(text="Select a prop mesh.", icon="DOT")

        layout.separator()

        col = layout.column(align=True)
        col.label(text="Manual re-bake:")
        col.operator(HOVERBIKE_OT_bake_prop_meshes.bl_idname, icon="FILE_REFRESH")
        col.label(text="(Fires automatically on Ctrl+S.)", icon="INFO")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES = (
    HOVERBIKE_OT_setup_prop_mesh_bake,
    HOVERBIKE_OT_bake_prop_meshes,
    HOVERBIKE_PT_props_library_bake,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    if _hoverbike_save_pre_bake not in bpy.app.handlers.save_pre:
        bpy.app.handlers.save_pre.append(_hoverbike_save_pre_bake)


def unregister() -> None:
    try:
        bpy.app.handlers.save_pre.remove(_hoverbike_save_pre_bake)
    except ValueError:
        pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
