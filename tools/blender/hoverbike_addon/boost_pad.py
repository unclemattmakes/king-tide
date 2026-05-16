"""Boost-pad authoring + gizmo refresh.

Author boost pads as ``boost_NN`` empties — same hybrid-pipeline
pattern as ``cp_NN`` checkpoints. Each empty's local +Y axis is the
boost direction (matches three.js +Z forward via the b2t mapping),
Z position is the pad's height in world coords, custom props carry
the runtime knobs (``half_width`` / ``half_depth`` / ``strength``).

A flat slab mesh is parented to each empty as a viewport gizmo whose
geometry tracks the empty's bounds so authors can scrub the size
sliders and watch the pad resize live. The gizmos live in a
``_hoverbike_boost_pad_preview`` collection that's scrubbed at
export time — only the ``boost_NN`` empty itself round-trips through
the JSON.
"""

from __future__ import annotations

import re

import bpy
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BOOST_PAD_OBJECT_PREFIX = "boost_"
BOOST_PAD_GIZMO_MATERIAL = "mat_boost_pad_preview"
BOOST_PAD_PREVIEW_COLLECTION = "_hoverbike_boost_pad_preview"


# ────────────────────────────────────────────────────────────────────
# Gizmo material + mesh
# ────────────────────────────────────────────────────────────────────


def _boost_pad_material() -> bpy.types.Material:
    """Cyan emissive slab material so the pad reads as a glowing boost
    plate against any terrain. Same colour family as the in-game
    boost-pad helper (``makePadHelper`` in editor-helpers.ts)."""
    mat = bpy.data.materials.get(BOOST_PAD_GIZMO_MATERIAL)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(BOOST_PAD_GIZMO_MATERIAL)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.20, 0.85, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.4
        try:
            bsdf.inputs["Emission Color"].default_value = (0.20, 0.85, 1.0, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 1.5
        except KeyError:
            pass
    return mat


def _build_boost_pad_gizmo_mesh(
    name: str, *, half_width: float, half_depth: float
) -> bpy.types.Mesh:
    """Pad slab in local +Y-forward coords: a flat rectangle in the XY
    plane (slab thickness ~0.1 m) with a forward-pointing arrow on top
    so the boost direction is unambiguous in the viewport. The slab
    matches the runtime collider's ``halfWidth × halfDepth`` bounds so
    visual placement reflects the actual trigger volume."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = half_width
    hd = half_depth
    z_lo = 0.0
    z_hi = 0.1
    arr_len = hd * 0.6
    arr_w = hw * 0.4
    verts = [
        # Slab bottom rect (4)
        (-hw, -hd, z_lo), (hw, -hd, z_lo),
        (hw, hd, z_lo), (-hw, hd, z_lo),
        # Slab top rect (4)
        (-hw, -hd, z_hi), (hw, -hd, z_hi),
        (hw, hd, z_hi), (-hw, hd, z_hi),
        # Top-face arrow (3) — points along +Y so the empty's +Y
        # carries the visual direction.
        (-arr_w, -arr_len * 0.4, z_hi + 0.02),
        (arr_w, -arr_len * 0.4, z_hi + 0.02),
        (0.0, arr_len, z_hi + 0.02),
    ]
    faces = [
        (0, 1, 2, 3),       # bottom
        (4, 7, 6, 5),       # top (CCW from +Z)
        (0, 4, 5, 1),       # -Y side
        (1, 5, 6, 2),       # +X side
        (2, 6, 7, 3),       # +Y side
        (3, 7, 4, 0),       # -X side
        (8, 9, 10),         # arrow on top
    ]
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(_boost_pad_material())
    return me


def _next_boost_pad_name() -> str:
    """First free ``boost_NN`` slot. Zero-padded to two digits to match
    the ``cp_NN`` / ``start_NN`` convention (lexicographic sort =
    numeric)."""
    i = 0
    while True:
        name = f"{BOOST_PAD_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


def refresh_boost_pad_gizmos(scene) -> int:
    """Rebuild every ``boost_NN`` empty's child slab so the visual
    geometry tracks the empty's ``half_width`` / ``half_depth`` props
    after they're scrubbed. Gizmos live in
    ``_hoverbike_boost_pad_preview`` so the export's preview-collection
    scrub removes them — only the boost_NN empty itself round-trips
    through the JSON, and the runtime builds its own visual via
    ``makePadHelper``. Safe no-op if there are no boost pads in the
    scene.

    Public (no leading underscore) because the package-level debounce
    timer in ``_legacy._run_pending_rebuilds`` calls back into it when
    a pad's custom property changes."""
    coll = bpy.data.collections.get(BOOST_PAD_PREVIEW_COLLECTION)
    boost_empties = [o for o in scene.objects if re.match(r"^boost_(\d+)$", o.name)]
    if not boost_empties:
        # Tear down the empty preview collection so it doesn't dangle.
        if coll is not None:
            for o in list(coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(coll)
        return 0
    if coll is None:
        coll = bpy.data.collections.new(BOOST_PAD_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)

    # Drop gizmos that no longer correspond to any empty (renames /
    # deletes leave orphans otherwise).
    valid_gizmo_names = {f"{o.name}_gizmo" for o in boost_empties}
    for o in list(coll.objects):
        if o.name not in valid_gizmo_names:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)

    refreshed = 0
    for obj in boost_empties:
        hw = float(obj.get("half_width", 3.0))
        hd = float(obj.get("half_depth", 6.0))
        gizmo_name = f"{obj.name}_gizmo"
        mesh_name = f"{obj.name}_gizmo_mesh"
        mesh = _build_boost_pad_gizmo_mesh(mesh_name, half_width=hw, half_depth=hd)
        gizmo = bpy.data.objects.get(gizmo_name)
        if gizmo is None:
            gizmo = bpy.data.objects.new(gizmo_name, mesh)
            coll.objects.link(gizmo)
        else:
            # Gizmo exists but might be in the wrong collection (e.g. an
            # earlier addon revision parked it in scene.collection).
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
        gizmo.hide_render = True
        gizmo.hide_select = True
        refreshed += 1
    return refreshed


def _on_boost_pad_prop_changed(self, context):
    """Custom-property update callback fires when half_width / half_depth
    / strength are scrubbed on a ``boost_NN`` empty. Rebuild the gizmos
    so the visual matches the new bounds immediately."""
    scene = context.scene if context is not None else bpy.context.scene
    if scene is not None:
        refresh_boost_pad_gizmos(scene)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_boost_pad(Operator):
    """Drop a ``boost_NN`` empty at the 3D cursor. The empty carries the
    pad's runtime knobs as custom properties (``half_width``,
    ``half_depth``, ``strength``) and exports as one entry in
    ``boostPads[]`` on the next *Export Track to Game*. Boost direction
    is the empty's local +Y (Blender forward → three.js +Z); rotate
    around Z to aim it.

    A flat cyan slab mesh is parented to the empty as a viewport gizmo
    so authors can see the pad's footprint and direction at a glance.
    The gizmo lives in a preview collection that the export scrubs;
    the actual boost trigger is the JSON-side overlap test in
    ``boostPadSystem``."""

    bl_idname = "hoverbike.add_boost_pad"
    bl_label = "Add Boost Pad"
    bl_description = "Drop a boost_NN empty at the 3D cursor (boost direction = local +Y)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        name = _next_boost_pad_name()
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "ARROWS"
        obj.empty_display_size = 4.0
        obj["kind"] = "boost_pad"
        # Defaults match the editor's `placement.ts` boost-pad defaults
        # so a Blender-authored pad behaves identically to one placed
        # in the in-app editor.
        obj["half_width"] = 3.0
        obj["half_depth"] = 6.0
        obj["strength"] = 1.5
        cursor = context.scene.cursor
        obj.location = cursor.location.copy()
        obj.rotation_euler = cursor.rotation_euler.copy()
        scene.collection.objects.link(obj)

        # Build the visual slab now so the pad reads in the viewport.
        refresh_boost_pad_gizmos(scene)

        # Select the new empty so the user can immediately rotate (R)
        # or drag (G) it without picking it from the outliner.
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name} (strength {obj['strength']}, "
            f"{obj['half_width'] * 2:.1f}m × {obj['half_depth'] * 2:.1f}m). "
            "Rotate around Z to aim.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_refresh_boost_pads(Operator):
    """Rebuild every boost_NN empty's child slab gizmo. Use after
    editing ``half_width`` / ``half_depth`` custom props directly on a
    pad in the Properties panel — the panel doesn't trigger the
    auto-refresh that addon-managed sliders do."""

    bl_idname = "hoverbike.refresh_boost_pads"
    bl_label = "Refresh Boost Pad Visuals"
    bl_description = "Rebuild every boost_NN gizmo to match its current half_width / half_depth"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = refresh_boost_pad_gizmos(context.scene)
        self.report({"INFO"}, f"Refreshed {n} boost pad gizmo(s).")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_boost_pad,
    HOVERBIKE_OT_refresh_boost_pads,
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
