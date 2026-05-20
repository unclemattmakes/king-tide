"""Top-bar Hoverbike menu (View3D header) + viewport pie menu.

This module hangs a traditional dropdown menu off the View3D header bar
— the same surface BlenderGIS uses — so authors can find every Hoverbike
operator without fishing through the N-panel sidebar.

  ┌──────────────────────────────────────────────────────────────┐
  │ View   Select   Add   Object   Hoverbike ▾                   │  ← VIEW3D_MT_editor_menus
  └──────────────────────────────────────────────────────────────┘

The N-panel sidebar (``panel.py``) becomes context-driven — it surfaces
the tool that matches whatever object is selected. The menu here is the
"I just want to find the operator" surface that's *always* available
regardless of selection state.

A pie menu (``HOVERBIKE_MT_pie``) is also registered and bound to
**Shift+W** in the 3D View for the in-viewport quick-add loop. Authors
can rebind it from Edit → Preferences → Keymap if it clashes with their
muscle memory.

The menu's contents flip between Track / Bike / Unknown based on
``detect_mode()`` — same dispatch the sidebar uses, so the top menu
matches what the .blend actually is.
"""

from __future__ import annotations

import bpy
from bpy.types import Menu


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _mode() -> str | None:
    """Track / bike / None — mirrors the dispatch in panel.py."""
    from ._legacy import detect_mode

    return detect_mode(bpy.data.filepath)


# ────────────────────────────────────────────────────────────────────
# Top-level menu
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_main(Menu):
    """Top-level Hoverbike dropdown shown in the View3D header."""

    bl_idname = "HOVERBIKE_MT_main"
    bl_label = "Hoverbike"

    def draw(self, context: bpy.types.Context) -> None:
        mode = _mode()
        layout = self.layout

        if mode == "track":
            self._draw_track(context, layout)
        elif mode == "bike":
            self._draw_bike(context, layout)
        else:
            self._draw_unknown(context, layout)

    # ── Track mode ────────────────────────────────────────────────
    def _draw_track(self, context, layout) -> None:
        # Headline: the export + playtest actions live up here so they
        # are one click away regardless of how the menu is nested.
        layout.operator("hoverbike.export_track", icon="EXPORT")
        layout.operator("hoverbike.lint_track", icon="CHECKMARK")
        layout.operator(
            "hoverbike.reload_track_json", text="Reload from JSON", icon="FILE_REFRESH"
        )

        layout.separator()
        op = layout.operator("hoverbike.open_play_url", text="Play in Browser", icon="PLAY")
        op.edit = False
        op = layout.operator(
            "hoverbike.open_play_url", text="Edit in Browser", icon="GREASEPENCIL"
        )
        op.edit = True
        op = layout.operator(
            "hoverbike.copy_track_url", text="Copy Play URL", icon="URL"
        )
        op.edit = False
        op = layout.operator(
            "hoverbike.copy_track_url", text="Copy Edit URL", icon="URL"
        )
        op.edit = True

        layout.separator()
        layout.menu("HOVERBIKE_MT_add", icon="ADD")
        layout.menu("HOVERBIKE_MT_build", icon="MOD_BUILD")
        layout.menu("HOVERBIKE_MT_spline", icon="CURVE_NCURVE")
        layout.menu("HOVERBIKE_MT_terrain", icon="RNDCURVE")
        layout.menu("HOVERBIKE_MT_thumbnail", icon="RENDER_STILL")
        layout.menu("HOVERBIKE_MT_utility", icon="TOOL_SETTINGS")

        layout.separator()
        layout.menu("HOVERBIKE_MT_pie", text="Quick Pie (Shift+W)", icon="MESH_CIRCLE")
        layout.separator()
        layout.operator(
            "hoverbike.new_map_from_template",
            text="New Map from Template…",
            icon="FILE_NEW",
        )

    # ── Bike mode ─────────────────────────────────────────────────
    def _draw_bike(self, context, layout) -> None:
        layout.operator("hoverbike.export_bike", icon="EXPORT")
        layout.separator()
        op = layout.operator("hoverbike.copy_bike_url", text="Copy Play URL", icon="URL")
        op.viewer = False
        op = layout.operator(
            "hoverbike.copy_bike_url", text="Copy Viewer URL", icon="HIDE_OFF"
        )
        op.viewer = True

    # ── Unknown mode ─────────────────────────────────────────────
    def _draw_unknown(self, context, layout) -> None:
        layout.label(text="Save .blend in tracks-src/ or bikes-src/", icon="INFO")
        layout.separator()
        layout.operator(
            "hoverbike.new_map_from_template",
            text="New Map from Template…",
            icon="FILE_NEW",
        )


# ────────────────────────────────────────────────────────────────────
# Add submenu — spawn new authoring objects
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_add(Menu):
    bl_idname = "HOVERBIKE_MT_add"
    bl_label = "Add"

    def draw(self, context):
        layout = self.layout

        layout.label(text="Track essentials")
        layout.operator("hoverbike.scaffold_track_essentials", icon="ADD")
        layout.operator("hoverbike.add_ai_spline", icon="CURVE_NCURVE")
        layout.operator("hoverbike.add_starts", icon="EMPTY_ARROWS")

        layout.separator()
        layout.label(text="Terrain templates")
        layout.operator(
            "hoverbike.add_island_terrain",
            text="Island Terrain (procedural)",
            icon="RNDCURVE",
        )

        layout.separator()
        layout.label(text="Curves (build → mesh)")
        layout.operator("hoverbike.add_road_starter_curve", icon="CURVE_BEZCURVE")
        layout.operator("hoverbike.add_tunnel_starter_curve", icon="CURVE_BEZCURVE")
        layout.operator("hoverbike.add_antigrav_curve", icon="CURVE_BEZCURVE")

        layout.separator()
        layout.label(text="Gameplay")
        layout.operator("hoverbike.add_ramp", text="Ramp (at cursor)", icon="ADD")
        layout.operator(
            "hoverbike.add_ramp_at_spline_t",
            text="Ramp (at spline t)",
            icon="CURVE_DATA",
        )
        layout.operator(
            "hoverbike.add_ramp_at_helper",
            text="Ramp (at helper)",
            icon="EMPTY_AXIS",
        )
        layout.operator(
            "hoverbike.add_boost_pad", text="Boost Pad", icon="FORCE_FORCE"
        )
        layout.operator(
            "hoverbike.add_boost_pad_at_helper",
            text="Boost Pad (at helper)",
            icon="EMPTY_AXIS",
        )
        layout.operator(
            "hoverbike.add_antigrav_zone",
            text="Anti-Grav Zone",
            icon="ORIENTATION_GIMBAL",
        )
        layout.operator("hoverbike.add_wave_zone", text="Wave Zone", icon="MOD_OCEAN")

        layout.separator()
        layout.label(text="Environment")
        layout.operator("hoverbike.add_water_volume", icon="MOD_FLUIDSIM")
        layout.operator(
            "hoverbike.add_horizon_ring", text="Horizon Ring", icon="WORLD"
        )
        layout.operator("hoverbike.add_downtown", text="Downtown Block", icon="MESH_CUBE")
        layout.operator("hoverbike.add_emitter", text="Emitter", icon="PARTICLES")

        layout.separator()
        layout.label(text="Authoring helpers")
        layout.operator(
            "hoverbike.add_placement_helper",
            text="Placement Helper",
            icon="EMPTY_ARROWS",
        )
        layout.operator(
            "hoverbike.add_camera_hero",
            text="Camera Hero",
            icon="OUTLINER_OB_CAMERA",
        )


# ────────────────────────────────────────────────────────────────────
# Build / Refresh submenu — mesh builders + preview rebuilds
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_build(Menu):
    bl_idname = "HOVERBIKE_MT_build"
    bl_label = "Build / Refresh"

    def draw(self, context):
        layout = self.layout

        layout.label(text="Curve → mesh")
        layout.operator("hoverbike.build_road", icon="MESH_PLANE")
        layout.operator(
            "hoverbike.reconform_terrain_to_road",
            text="Re-conform Terrain to Road",
            icon="MOD_SHRINKWRAP",
        )
        layout.separator()
        layout.operator("hoverbike.build_tunnel", icon="MESH_CYLINDER")
        layout.operator(
            "hoverbike.toggle_tunnel_edit_mode",
            text="Toggle Tunnel Edit Mode",
            icon="OUTLINER_DATA_CURVE",
        )
        layout.separator()
        layout.operator(
            "hoverbike.build_antigrav_surface",
            text="Build Anti-Grav Surface",
            icon="MOD_PARTICLES",
        )

        layout.separator()
        layout.label(text="Previews — gameplay")
        layout.operator(
            "hoverbike.rebuild_gate_preview",
            text="Rebuild Gate Preview",
            icon="FILE_REFRESH",
        )
        layout.operator(
            "hoverbike.hide_gate_preview", text="Hide Gates", icon="HIDE_ON"
        )
        layout.operator(
            "hoverbike.rebuild_racer_preview",
            text="Rebuild Racer Preview",
            icon="FILE_REFRESH",
        )
        layout.operator(
            "hoverbike.hide_racer_preview", text="Hide Racer", icon="HIDE_ON"
        )
        layout.operator(
            "hoverbike.rebuild_turn_indicators",
            text="Rebuild Turn Indicators",
            icon="TRACKING_FORWARDS",
        )
        layout.operator(
            "hoverbike.hide_turn_indicators",
            text="Hide Turn Indicators",
            icon="HIDE_ON",
        )

        layout.separator()
        layout.label(text="Previews — environment")
        layout.operator(
            "hoverbike.rebuild_water_preview",
            text="Rebuild Water Preview",
            icon="MOD_OCEAN",
        )
        layout.operator(
            "hoverbike.hide_water_preview", text="Hide Water", icon="HIDE_ON"
        )
        layout.operator(
            "hoverbike.rebuild_ghost_lap", text="Rebuild Ghost Lap", icon="PLAY"
        )
        layout.operator(
            "hoverbike.hide_ghost_lap", text="Hide Ghost Lap", icon="HIDE_ON"
        )

        layout.separator()
        layout.label(text="Refresh placed gizmos")
        layout.operator(
            "hoverbike.refresh_boost_pads",
            text="Refresh Boost Pads",
            icon="FORCE_FORCE",
        )
        layout.operator(
            "hoverbike.refresh_antigrav_zones",
            text="Refresh Anti-Grav Zones",
            icon="ORIENTATION_GIMBAL",
        )
        layout.operator(
            "hoverbike.refresh_wave_zones",
            text="Refresh Wave Zones",
            icon="MOD_OCEAN",
        )


# ────────────────────────────────────────────────────────────────────
# Spline submenu — snapping, auto-place, tilt presets
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_spline(Menu):
    bl_idname = "HOVERBIKE_MT_spline"
    bl_label = "Spline"

    def draw(self, context):
        layout = self.layout

        layout.label(text="Snap")
        layout.operator(
            "hoverbike.cursor_snap_to_spline",
            text="Cursor → spline @ t",
            icon="PIVOT_CURSOR",
        )
        layout.operator(
            "hoverbike.snap_starts_to_spline",
            text="Snap Starts to Spline",
            icon="EMPTY_ARROWS",
        )
        layout.operator(
            "hoverbike.snap_spline_to_terrain",
            text="Snap Spline to Terrain",
            icon="SNAP_FACE",
        )
        layout.operator(
            "hoverbike.shift_spline_off_obstacles",
            text="Shift Spline Off Obstacles",
            icon="MOD_PUSH",
        )

        layout.separator()
        layout.label(text="Auto-place")
        layout.operator(
            "hoverbike.auto_place_ramps",
            text="Auto-place Ramps from κ",
            icon="MOD_PARTICLES",
        )

        layout.separator()
        layout.label(text="Gates")
        layout.operator(
            "hoverbike.materialize_gates_to_cp_empties",
            text="Materialise → cp_NN",
            icon="OUTLINER_OB_EMPTY",
        )
        layout.operator(
            "hoverbike.demote_gates_to_spline",
            text="Demote to Spline",
            icon="X",
        )

        layout.separator()
        layout.label(text="Anti-grav")
        layout.operator(
            "hoverbike.toggle_spline_antigrav",
            text="Toggle ai_spline_main Anti-Grav",
            icon="ORIENTATION_GIMBAL",
        )

        # Tilt presets only useful while in Edit-Curve mode.
        if context.mode == "EDIT_CURVE":
            layout.separator()
            layout.label(text="Selected anchor tilt:")
            layout.operator(
                "hoverbike.set_spline_tilt_flat", text="Flat (0°)"
            )
            layout.operator(
                "hoverbike.set_spline_tilt_bank_l", text="Bank L (+45°)"
            )
            layout.operator(
                "hoverbike.set_spline_tilt_bank_r", text="Bank R (−45°)"
            )
            layout.operator(
                "hoverbike.set_spline_tilt_wall_l", text="Wall L (+90°)"
            )
            layout.operator(
                "hoverbike.set_spline_tilt_wall_r", text="Wall R (−90°)"
            )
            layout.operator(
                "hoverbike.set_spline_tilt_ceiling", text="Ceiling (180°)"
            )


# ────────────────────────────────────────────────────────────────────
# Terrain submenu — import / sculpt / smooth / bake
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_terrain(Menu):
    bl_idname = "HOVERBIKE_MT_terrain"
    bl_label = "Terrain"

    def draw(self, context):
        layout = self.layout

        layout.label(text="Build")
        layout.operator(
            "hoverbike.add_island_terrain",
            text="Add Island Terrain (procedural)",
            icon="RNDCURVE",
        )
        layout.operator(
            "hoverbike.import_heightmap",
            text="Import Heightmap…",
            icon="IMPORT",
        )
        layout.operator(
            "hoverbike.apply_terrain_modifiers",
            text="Apply Modifiers",
            icon="MODIFIER_DATA",
        )
        layout.operator(
            "hoverbike.subdivide_terrain", text="Subdivide", icon="MOD_SUBSURF"
        )

        layout.separator()
        layout.label(text="Sculpt")
        layout.operator(
            "hoverbike.enter_sculpt_mode", text="Enter Sculpt Mode", icon="BRUSH_DATA"
        )
        op = layout.operator(
            "hoverbike.raise_lower_terrain", text="Raise @ cursor", icon="TRIA_UP"
        )
        op.lower = False
        op = layout.operator(
            "hoverbike.raise_lower_terrain", text="Lower @ cursor", icon="TRIA_DOWN"
        )
        op.lower = True
        layout.operator("hoverbike.smooth_terrain", icon="MOD_SMOOTH")

        layout.separator()
        layout.label(text="Bake to vertex colors")
        layout.operator(
            "hoverbike.bake_terrain_attrs",
            text="Bake AO + Path Worn",
            icon="MOD_NOISE",
        )
        layout.operator(
            "hoverbike.bake_path_worn", text="Bake Path Worn only", icon="MOD_CURVE"
        )


# ────────────────────────────────────────────────────────────────────
# Thumbnail submenu — hero render + tile-only render
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_thumbnail(Menu):
    bl_idname = "HOVERBIKE_MT_thumbnail"
    bl_label = "Thumbnail"

    def draw(self, context):
        layout = self.layout
        layout.operator(
            "hoverbike.render_track_hero",
            text="Render Track Hero",
            icon="RENDER_STILL",
        )
        layout.operator(
            "hoverbike.render_track_thumbnail",
            text="Render Tile Only",
            icon="IMAGE",
        )
        layout.separator()
        layout.operator(
            "hoverbike.add_camera_hero",
            text="Add Camera Hero",
            icon="OUTLINER_OB_CAMERA",
        )


# ────────────────────────────────────────────────────────────────────
# Utility submenu — validation, stats, re-tag, helper management
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_MT_utility(Menu):
    bl_idname = "HOVERBIKE_MT_utility"
    bl_label = "Utility"

    def draw(self, context):
        from .placement_helper import PLACEMENT_HELPER_NAME

        layout = self.layout

        layout.operator("hoverbike.lint_track", icon="CHECKMARK")
        layout.operator(
            "hoverbike.refresh_track_stats",
            text="Refresh Track Stats",
            icon="FILE_REFRESH",
        )
        layout.operator(
            "hoverbike.retag_scene", text="Re-tag Scene", icon="OUTLINER_DATA_FONT"
        )
        layout.separator()
        layout.operator(
            "hoverbike.reload_props_library",
            text="Reload Props / Landmarks Library",
            icon="LIBRARY_DATA_DIRECT",
        )

        layout.separator()
        layout.label(text="Placement helper")
        helper = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        layout.operator(
            "hoverbike.add_placement_helper",
            text=("Re-pose Helper" if helper else "Add Placement Helper"),
            icon="EMPTY_ARROWS",
        )
        if helper is not None:
            layout.operator(
                "hoverbike.cursor_to_helper",
                text="Cursor → Helper",
                icon="PIVOT_CURSOR",
            )
            layout.operator(
                "hoverbike.remove_placement_helper",
                text="Remove Helper",
                icon="X",
            )


# ────────────────────────────────────────────────────────────────────
# Pie menu — eight-slice quick-action wheel bound to Shift+W
# ────────────────────────────────────────────────────────────────────
#
# The pie slots are arranged so the most-used operators land on the
# cardinal directions (left/right/up/down), with the secondary set on
# the diagonals. Order matters — pie.operator() calls fill slots
# clockwise starting from West (left). See the Blender docs on
# Menu.menu_pie() for the slot layout.


class HOVERBIKE_MT_pie(Menu):
    bl_idname = "HOVERBIKE_MT_pie"
    bl_label = "Hoverbike Quick"

    def draw(self, context):
        pie = self.layout.menu_pie()

        # West — Snap cursor to spline (the most-touched "go to here" move)
        pie.operator(
            "hoverbike.cursor_snap_to_spline",
            text="Cursor → Spline",
            icon="PIVOT_CURSOR",
        )
        # East — Add ramp at spline t (next-most touched authoring step)
        pie.operator(
            "hoverbike.add_ramp_at_spline_t", text="Ramp @ t", icon="ADD"
        )
        # South — Rebuild gate preview (sanity glance after spline edits)
        pie.operator(
            "hoverbike.rebuild_gate_preview",
            text="Rebuild Gates",
            icon="FILE_REFRESH",
        )
        # North — Export Track to Game (the headline action)
        pie.operator("hoverbike.export_track", text="Export Track", icon="EXPORT")
        # NW — Cursor → helper
        pie.operator(
            "hoverbike.cursor_to_helper",
            text="Cursor → Helper",
            icon="EMPTY_AXIS",
        )
        # NE — Open Play URL
        op = pie.operator("hoverbike.open_play_url", text="Play", icon="PLAY")
        op.edit = False
        # SW — Build road (rebuilds road mesh from active curve)
        pie.operator("hoverbike.build_road", text="Build Road", icon="MESH_PLANE")
        # SE — Add boost pad at helper
        pie.operator(
            "hoverbike.add_boost_pad_at_helper",
            text="Boost @ Helper",
            icon="FORCE_FORCE",
        )


# ────────────────────────────────────────────────────────────────────
# Header hook + keymap
# ────────────────────────────────────────────────────────────────────


def _draw_in_view3d_header(self, context: bpy.types.Context) -> None:
    """Drawn into ``VIEW3D_MT_editor_menus`` to slot the Hoverbike
    dropdown next to View / Select / Add / Object in the 3D viewport
    header. Same pattern BlenderGIS uses."""
    self.layout.menu("HOVERBIKE_MT_main")


_addon_keymaps: list[tuple] = []


_CLASSES: tuple[type, ...] = (
    HOVERBIKE_MT_add,
    HOVERBIKE_MT_build,
    HOVERBIKE_MT_spline,
    HOVERBIKE_MT_terrain,
    HOVERBIKE_MT_thumbnail,
    HOVERBIKE_MT_utility,
    HOVERBIKE_MT_pie,
    # Main last — its draw() references the submenu bl_idnames above so
    # they have to be in bpy.types first.
    HOVERBIKE_MT_main,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.VIEW3D_MT_editor_menus.append(_draw_in_view3d_header)

    # Pie menu shortcut. Shift+W is unassigned in Blender's default
    # Object Mode keymap, so it doesn't collide with stock bindings.
    # Authors can rebind from Edit → Preferences → Keymap → 3D View if
    # this clashes with their setup.
    wm = bpy.context.window_manager
    kc = wm.keyconfigs.addon
    if kc is not None:
        km = kc.keymaps.new(name="3D View", space_type="VIEW_3D")
        kmi = km.keymap_items.new(
            "wm.call_menu_pie", type="W", value="PRESS", shift=True
        )
        kmi.properties.name = HOVERBIKE_MT_pie.bl_idname
        _addon_keymaps.append((km, kmi))


def unregister() -> None:
    for km, kmi in _addon_keymaps:
        try:
            km.keymap_items.remove(kmi)
        except (RuntimeError, ReferenceError):
            pass
    _addon_keymaps.clear()

    try:
        bpy.types.VIEW3D_MT_editor_menus.remove(_draw_in_view3d_header)
    except (ValueError, RuntimeError):
        pass

    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
