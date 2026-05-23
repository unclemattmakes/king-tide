"""Wave-zone authoring.

Author wave zones as ``wave_zone_NN`` empties — the wave-mastery analogue
of ``antigrav_NN`` anti-grav zones. Each zone is an oriented box that
multiplies the global Gerstner wave amplitude / frequency inside its
extents, with an optional periodic surge for set-piece tsunami sweeps
and an optional dominant-swell-direction override.

The box's local +X is the dominant swell direction (matches the
runtime's ``WaveZone`` convention). Custom properties carry the
per-zone tuning:

  * ``half_width``    — half-extent along local +X (m). Aligned with
                        the dominant swell direction.
  * ``half_height``   — half-extent along local +Z (Blender up; m).
                        Mostly informational — surface samples ignore
                        the vertical extent.
  * ``half_depth``    — half-extent along local +Y (m).
  * ``height_mult``   — multiplier on global wave amplitude inside
                        the zone. 1 = neutral, >1 = bigger waves.
  * ``freq_mult``     — multiplier on per-wave frequency (=
                        1/wavelength). 1 = neutral, >1 = choppier
                        / shorter wavelengths.
  * ``blend_radius_m``— soft-edge falloff outside the OBB face so
                        amplitude doesn't pop at the boundary.
  * ``direction_deg`` — (optional) override of the dominant swell
                        bearing, in degrees, world-XZ. Leave unset to
                        inherit the global wave bearing.
  * ``surge_period_s``— (optional) period of the additive surge
                        term. Pair with ``surge_amplitude``.
  * ``surge_amplitude``— (optional) surge amplitude (m). Both surge
                        fields must be set together.

A translucent cyan box gizmo is parented to each empty (mirrors the
anti-grav zone pattern); it lives in a
``_hoverbike_wave_zone_preview`` collection that the export scrubs.
The actual wave-zone behaviour comes from the JSON's ``waveZones``
array, evaluated by ``sampleZoneFactors`` in
``src/engine/sim/water/wave-field.ts``.
"""

from __future__ import annotations

import re

import bpy
from bpy.types import Operator


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

WAVE_ZONE_OBJECT_PREFIX = "wave_zone_"
WAVE_ZONE_GIZMO_MATERIAL = "mat_wave_zone_preview"
WAVE_ZONE_PREVIEW_COLLECTION = "_hoverbike_wave_zone_preview"


# ────────────────────────────────────────────────────────────────────
# Gizmo material + mesh
# ────────────────────────────────────────────────────────────────────


def _wave_zone_material() -> bpy.types.Material:
    """Translucent cyan-teal material so the zone reads as a soft-edged
    water volume against any terrain. Distinct from the boost-pad cyan
    (which is opaque + emissive) and the anti-grav purple, so authors
    can identify the three zone types at a glance."""
    mat = bpy.data.materials.get(WAVE_ZONE_GIZMO_MATERIAL)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(WAVE_ZONE_GIZMO_MATERIAL)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.18, 0.72, 0.78, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.55
        bsdf.inputs["Alpha"].default_value = 0.18
        try:
            bsdf.inputs["Emission Color"].default_value = (0.30, 0.85, 0.90, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 0.4
        except KeyError:
            pass
    return mat


def _build_wave_zone_gizmo_mesh(
    name: str,
    *,
    half_width: float,
    half_height: float,
    half_depth: float,
) -> bpy.types.Mesh:
    """Box matching the zone's (half_width × half_depth × half_height)
    extents in Blender's Z-up frame, plus a swell-direction arrow along
    local +X (the dominant-swell axis). The arrow sits on the box's
    upper face so it reads as "this is the wave direction" without
    visually competing with the volume itself."""
    if name in bpy.data.meshes:
        bpy.data.meshes.remove(bpy.data.meshes[name])
    me = bpy.data.meshes.new(name)
    hw = half_width
    hh = half_height
    hd = half_depth
    # Box vertices (8 corners). Blender is Z-up: half_height maps to Z,
    # half_depth maps to Y, half_width maps to X — same convention as
    # the runtime after the glTF Y-up swap.
    verts = [
        (-hw, -hd, -hh), (hw, -hd, -hh), (hw, hd, -hh), (-hw, hd, -hh),
        (-hw, -hd,  hh), (hw, -hd,  hh), (hw, hd,  hh), (-hw, hd,  hh),
    ]
    # Swell-direction arrow on the top face, pointing along +X (the
    # dominant swell direction the runtime reads).
    arrow_len = min(hw * 0.7, 6.0)
    arrow_w = min(hd * 0.25, 1.5)
    arrow_z = hh + 0.05
    verts += [
        # Shaft (4 verts) — narrow rectangle, base at x=-arrow_len/2.
        (-arrow_len * 0.4, -arrow_w * 0.3, arrow_z),
        ( arrow_len * 0.3, -arrow_w * 0.3, arrow_z),
        ( arrow_len * 0.3,  arrow_w * 0.3, arrow_z),
        (-arrow_len * 0.4,  arrow_w * 0.3, arrow_z),
        # Head (3 verts) — triangle pointing to +X.
        ( arrow_len * 0.3, -arrow_w, arrow_z),
        ( arrow_len * 0.3,  arrow_w, arrow_z),
        ( arrow_len,        0.0,     arrow_z),
    ]
    box_faces = [
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2),
        (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    arrow_faces = [
        (8, 9, 10, 11),  # shaft
        (12, 14, 13),    # head (CCW from above)
    ]
    me.from_pydata(verts, [], box_faces + arrow_faces)
    me.update()
    me.materials.append(_wave_zone_material())
    return me


def _next_wave_zone_name() -> str:
    """First free ``wave_zone_NN`` slot. Zero-padded to two digits to
    match the ``boost_NN`` / ``antigrav_NN`` convention."""
    i = 0
    while True:
        name = f"{WAVE_ZONE_OBJECT_PREFIX}{i:02d}"
        if name not in bpy.data.objects:
            return name
        i += 1


def refresh_wave_zone_gizmos(scene) -> int:
    """Rebuild every ``wave_zone_NN`` empty's child box so the visual
    geometry tracks the empty's half-extent custom props after they're
    scrubbed. Same lifecycle as boost-pad / anti-grav gizmos — they
    live in a preview collection that the export scrubs.

    Public (no leading underscore) for the same reason as the other
    refresh helpers — the package-level debounce timer in
    ``_legacy._run_pending_rebuilds`` can call back in."""
    coll = bpy.data.collections.get(WAVE_ZONE_PREVIEW_COLLECTION)
    zones = [
        o for o in scene.objects
        if re.match(r"^wave_zone_(\d+)$", o.name) and o.type == "EMPTY"
    ]
    if not zones:
        if coll is not None:
            for o in list(coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(coll)
        return 0
    if coll is None:
        coll = bpy.data.collections.new(WAVE_ZONE_PREVIEW_COLLECTION)
        scene.collection.children.link(coll)

    valid_gizmo_names = {f"{o.name}_gizmo" for o in zones}
    for o in list(coll.objects):
        if o.name not in valid_gizmo_names:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)

    refreshed = 0
    for obj in zones:
        hw = float(obj.get("half_width", 30.0))
        hh = float(obj.get("half_height", 20.0))
        hd = float(obj.get("half_depth", 30.0))
        gizmo_name = f"{obj.name}_gizmo"
        mesh_name = f"{obj.name}_gizmo_mesh"
        mesh = _build_wave_zone_gizmo_mesh(
            mesh_name, half_width=hw, half_height=hh, half_depth=hd
        )
        gizmo = bpy.data.objects.get(gizmo_name)
        if gizmo is None:
            gizmo = bpy.data.objects.new(gizmo_name, mesh)
            coll.objects.link(gizmo)
        else:
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
            gizmo.scale = (1.0, 1.0, 1.0)
        gizmo.hide_render = True
        gizmo.hide_select = True
        # WIRE so the cyan box reads as an outlined volume rather than a
        # translucent fill — keeps the scene readable when several wave
        # zones overlap or sit on top of the terrain. The export still
        # treats the empty's transform as the AABB; only the viewport
        # shading changes here.
        gizmo.display_type = "WIRE"
        refreshed += 1
    return refreshed


def _on_wave_zone_prop_changed(self, context):
    """Custom-property update callback. Same shape as the boost-pad /
    anti-grav callbacks; rebuilds the gizmos so the box visual matches
    new extents the moment a slider is scrubbed."""
    scene = context.scene if context is not None else bpy.context.scene
    if scene is not None:
        refresh_wave_zone_gizmos(scene)


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_add_wave_zone(Operator):
    """Drop a ``wave_zone_NN`` empty at the 3D cursor. The empty carries
    the zone's runtime knobs as custom properties (``half_width`` /
    ``half_height`` / ``half_depth`` / ``height_mult`` / ``freq_mult``
    / ``blend_radius_m``) and exports as one entry in
    ``waveZones[]`` on the next *Export Track to Game*.

    The empty's local +X axis is the dominant swell direction. Rotate
    around Z to aim the swell; scale/edit half-extents to grow / shrink
    the volume. Surge and direction-override fields are NOT set by
    default — add them as custom properties (``surge_period_s`` +
    ``surge_amplitude``, or ``direction_deg``) when the zone needs
    them. A translucent cyan box mesh is parented to the empty as a
    viewport gizmo so the volume + swell direction read at a glance."""

    bl_idname = "hoverbike.add_wave_zone"
    bl_label = "Add Wave Zone"
    bl_description = (
        "Drop a wave_zone_NN empty at the 3D cursor (swell direction = local +X). "
        "Rotate the empty to aim the swell; edit half_* / *_mult custom props to tune"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        scene = context.scene
        name = _next_wave_zone_name()
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "CUBE"
        obj.empty_display_size = 6.0
        obj["kind"] = "wave_zone"
        # Defaults sized for a generous wave-feature volume — 60 m
        # wide, 60 m deep, 40 m tall vertical extent (mostly cosmetic).
        # heightMult=1.5 gives a visible swell bump over the global
        # field without overwhelming buoyancy; freq_mult=1 preserves
        # wavelengths so authors can tune amplitude before tuning
        # frequency. blend_radius_m=20 keeps the boundary invisible
        # at typical viewing distances.
        obj["half_width"] = 30.0
        obj["half_height"] = 20.0
        obj["half_depth"] = 30.0
        obj["height_mult"] = 1.5
        obj["freq_mult"] = 1.0
        obj["blend_radius_m"] = 20.0
        cursor = context.scene.cursor
        obj.location = cursor.location.copy()
        obj.rotation_euler = cursor.rotation_euler.copy()
        scene.collection.objects.link(obj)

        # Build the visual box now so the zone reads in the viewport.
        refresh_wave_zone_gizmos(scene)

        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report(
            {"INFO"},
            f"Added {name} ({obj['half_width'] * 2:.1f}m × "
            f"{obj['half_depth'] * 2:.1f}m, height_mult={obj['height_mult']}). "
            "Rotate around Z to aim swell; +X is the dominant direction.",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_refresh_wave_zones(Operator):
    """Rebuild every ``wave_zone_NN`` empty's child box gizmo. Use after
    editing ``half_width`` / ``half_height`` / ``half_depth`` custom
    props directly in the Properties panel — the panel doesn't trigger
    the auto-refresh that addon-managed sliders do."""

    bl_idname = "hoverbike.refresh_wave_zones"
    bl_label = "Refresh Wave Zones"
    bl_description = "Rebuild every wave_zone_NN gizmo to match its current half-extents"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = refresh_wave_zone_gizmos(context.scene)
        self.report({"INFO"}, f"Refreshed {n} wave zone gizmo(s).")
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_wave_zone,
    HOVERBIKE_OT_refresh_wave_zones,
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
