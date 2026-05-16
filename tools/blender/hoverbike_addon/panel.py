"""Sidebar panel + track sub-panels.

All the UI definitions — what the author sees in the View3D N-panel
under the "Hoverbike" tab — live here. The parent ``HOVERBIKE_PT_panel``
dispatches between track / bike / unknown asset modes; track .blends
get a collapsible sub-panel per domain (spline, road, tunnels, ramps,
terrain, water, gameplay, ghost lap, shader, stats).

This module is pure UI: it consumes operators + scene props registered
by the per-domain modules and arranges them into a usable interface.
No business logic here.
"""

from __future__ import annotations

import os
import re

import bpy
from bpy.types import Panel


# ────────────────────────────────────────────────────────────────────
# Top-level sidebar panel
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_PT_panel(Panel):
    bl_label = "Hoverbike"
    bl_idname = "HOVERBIKE_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"

    def draw(self, context: bpy.types.Context) -> None:
        from ._legacy import detect_mode, find_repo_root

        layout = self.layout
        blend = bpy.data.filepath
        if not blend:
            layout.label(text="Save your .blend first.", icon="ERROR")
            return

        repo = find_repo_root(blend)
        mode = detect_mode(blend)

        if mode == "track":
            self._draw_track(context, layout, blend, repo)
        elif mode == "bike":
            self._draw_bike(context, layout, blend, repo)
        else:
            self._draw_unknown(context, layout, blend, repo)

    def _draw_track(self, context, layout, blend: str, repo: str | None) -> None:
        """Parent-panel content for track-mode .blends. The bulk of the
        UI lives in sub-panels (HOVERBIKE_PT_track_*) so authors can
        collapse the sections they aren't currently using. This method
        just shows the always-relevant header: track id, big Export
        button, lint / reload / play / URL actions."""
        from ._legacy import derive_asset_id

        track_id = derive_asset_id("hoverbike_track_id") or "<unknown>"

        box = layout.box()
        box.label(text=f"Track: {track_id}", icon="WORLD_DATA")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        # Live lap snapshot — arc-length of `ai_spline_main`, projected
        # lap time at the racer top speed, and gate count derived from
        # the same spacing the exporter will use. All three update on
        # every panel redraw (which Blender already triggers on spline
        # edits via the depsgraph callback in handlers.py), so authors
        # see the lap re-shape live as they drag bezier handles instead
        # of finding out at export time that the route is twice the
        # length they thought. Heavier stats (terrain extents, water
        # coverage) stay in the collapsible Track stats sub-panel.
        from .track_meta import _spline_arc_length, _spline_obstacle_clearance
        from ._legacy import _largest_terrain_mesh

        sp = bpy.data.objects.get("ai_spline_main")
        if sp is not None and sp.type == "CURVE":
            arc_m = _spline_arc_length(sp)
            if arc_m > 0:
                # Race pace is closer to 25 m/s through corners than the
                # racer's 28-32 top speed, so use 25 as the "feel" baseline.
                lap_s = arc_m / 25.0
                gate_spacing = float(
                    getattr(context.scene, "hoverbike_gate_spacing", 60.0) or 60.0
                )
                n_gates = max(1, round(arc_m / gate_spacing))
                stat_box = layout.box()
                stat_box.label(
                    text=f"Lap: {arc_m:,.0f} m  ~{lap_s:.0f}s @25m/s",
                    icon="DRIVER_DISTANCE",
                )
                stat_box.label(text=f"{n_gates} gates @ {gate_spacing:.0f} m spacing")
                # Live obstacle-clearance count — same bbox math the
                # lint runs, but surfaced passively so authors see
                # building / pylon clips appear and disappear as they
                # drag the spline. Bbox math only (no raycasts), so
                # it's cheap enough to run on every panel redraw.
                clip_hits = _spline_obstacle_clearance(sp, _largest_terrain_mesh())
                if clip_hits:
                    distinct = len({h[1] for h in clip_hits})
                    stat_box.label(
                        text=f"{len(clip_hits)} spline clip(s) into {distinct} obstacle(s)",
                        icon="ERROR",
                    )
                    stat_box.operator(
                        "hoverbike.shift_spline_off_obstacles",
                        text="Shift Off Obstacles",
                        icon="MOD_PUSH",
                    )
                # Comfort-band nudge — racing-feel sweet spot is roughly
                # 30-180 s. Outside that the lap is either too punchy to
                # read or long enough to drag.
                if lap_s < 30:
                    stat_box.label(text="Very short lap — under 30 s", icon="ERROR")
                elif lap_s > 180:
                    stat_box.label(text="Long lap — over 3 min", icon="ERROR")

        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_track", icon="EXPORT")

        col = layout.column(align=True)
        col.prop(context.scene, "hoverbike_laps_to_finish", text="Laps")
        col.operator("hoverbike.lint_track", icon="CHECKMARK")
        col.operator("hoverbike.reload_track_json", icon="FILE_REFRESH")
        row = col.row(align=True)
        op_play_open = row.operator("hoverbike.open_play_url", text="Play", icon="PLAY")
        op_play_open.edit = False
        op_edit_open = row.operator("hoverbike.open_play_url", text="Edit", icon="GREASEPENCIL")
        op_edit_open.edit = True
        row = col.row(align=True)
        op_play = row.operator(
            "hoverbike.copy_track_url", text="Copy Play URL", icon="URL"
        )
        op_play.edit = False
        op_edit = row.operator(
            "hoverbike.copy_track_url", text="Copy Edit URL", icon="URL"
        )
        op_edit.edit = True

        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Tools below; collapse any section.", icon="INFO")
        # Small "start another map" affordance at the bottom — out of
        # the way of the active-track UI but discoverable for authors
        # who finish a map and want to jump to a fresh template without
        # the file-browser dance.
        col.operator(
            "hoverbike.new_map_from_template",
            text="New Map from Template…",
            icon="FILE_NEW",
        )

    def _draw_bike(self, context, layout, blend: str, repo: str | None) -> None:
        from ._legacy import derive_asset_id

        bike_id = derive_asset_id("hoverbike_bike_id") or "<unknown>"

        box = layout.box()
        box.label(text=f"Bike: {bike_id}", icon="AUTO")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")

        row = layout.row()
        row.scale_y = 1.6
        row.operator("hoverbike.export_bike", icon="EXPORT")

        col = layout.column(align=True)
        op_play = col.operator(
            "hoverbike.copy_bike_url", text="Copy Play URL", icon="URL"
        )
        op_play.viewer = False
        op_view = col.operator(
            "hoverbike.copy_bike_url", text="Copy Viewer URL", icon="HIDE_OFF"
        )
        op_view.viewer = True

        layout.separator()
        col = layout.column(align=True)
        col.scale_y = 0.85
        col.label(text="Shift-click Export:", icon="INFO")
        col.label(text="overwrite the spec")
        col.label(text="from the .blend.")

    def _draw_unknown(self, context, layout, blend: str, repo: str | None) -> None:
        box = layout.box()
        box.label(text="Unknown asset type", icon="QUESTION")
        box.label(text="Save your .blend in:")
        box.label(text="  • tracks-src/<id>.blend")
        box.label(text="  • bikes-src/<id>.blend")
        if repo:
            box.label(text=f"Repo: {os.path.basename(repo)}", icon="FILE_FOLDER")
        else:
            box.label(text="Repo not found", icon="ERROR")
            box.label(text="Save .blend inside a hoverbike/ clone.")
        # New Map shortcut — only useful when we can resolve a repo
        # root, since the operator targets tracks-src/<id>.blend. Surfaces
        # the existing template-*.blend collection without making authors
        # find them in the file browser by hand.
        if repo:
            layout.separator()
            box = layout.box()
            box.label(text="Start from a template:", icon="FILE_NEW")
            row = box.row()
            row.scale_y = 1.4
            row.operator(
                "hoverbike.new_map_from_template",
                text="New Map from Template…",
                icon="DUPLICATE",
            )


# ────────────────────────────────────────────────────────────────────
# Track sub-panels
# ────────────────────────────────────────────────────────────────────
#
# Each sub-panel is a child of HOVERBIKE_PT_panel and only renders in
# track mode. Splitting the original wall-of-tools into collapsible
# sections lets authors hide whatever they aren't using on a given pass
# (e.g. shader knobs are once-per-track so they stay default-closed).
# All sub-panels share the same `poll()` so adding a new one is just a
# matter of subclassing _HoverbikeTrackSubPanelBase + implementing draw.


class _HoverbikeTrackSubPanelBase:
    """Mixin: panel constants + poll() shared by every track sub-panel.
    Sub-panels live under the parent `HOVERBIKE_PT_panel` and only render
    in track mode (.blend in `tracks-src/`)."""
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Hoverbike"
    bl_parent_id = "HOVERBIKE_PT_panel"

    @classmethod
    def poll(cls, context):
        from ._legacy import detect_mode

        return detect_mode(bpy.data.filepath) == "track"


class HOVERBIKE_PT_track_spline(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: AI-spline editing helpers + start placement + the
    spline-aligned cursor / ramp-at-t / auto-ramp operators."""
    bl_label = "Spline tools"
    bl_idname = "HOVERBIKE_PT_track_spline"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        layout.prop(scene, "hoverbike_snap_hover_height", text="Hover (m)")
        layout.operator("hoverbike.snap_spline_to_terrain", icon="SNAP_FACE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_placement_t", text="t")
        row.operator("hoverbike.cursor_snap_to_spline", text="Cursor →", icon="PIVOT_CURSOR")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_start_grid_spacing", text="Start gap")
        row.operator("hoverbike.snap_starts_to_spline", text="Snap Starts", icon="EMPTY_ARROWS")
        layout.separator()
        layout.label(text="Auto-ramp from curvature:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_auto_ramp_kappa", text="|κ|")
        row.prop(scene, "hoverbike_auto_ramp_min_spacing", text="Spacing")
        layout.operator("hoverbike.add_ramp_at_spline_t", icon="ADD")
        layout.operator("hoverbike.auto_place_ramps", icon="MOD_PARTICLES")


class HOVERBIKE_PT_track_road(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: road-curve authoring + width / banking / curb knobs +
    Build Road. Long enough to deserve its own collapsible section."""
    bl_label = "Road tool"
    bl_idname = "HOVERBIKE_PT_track_road"

    def draw(self, context):
        from .road import ROAD_CURVE_NAME

        layout = self.layout
        scene = context.scene
        layout.operator("hoverbike.add_road_starter_curve", icon="CURVE_BEZCURVE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_width", text="Width")
        row.prop(scene, "hoverbike_road_lift", text="Lift")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_blend_radius", text="Blend")
        row.prop(scene, "hoverbike_road_samples", text="Samples")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_smooth_passes", text="Smooth")
        row.prop(scene, "hoverbike_road_thickness", text="Slab (m)")
        layout.separator()
        layout.label(text="Banking:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_bank_strength", text="Bank")
        row.prop(scene, "hoverbike_road_bank_max_deg", text="Max°")
        layout.label(text="(per-point: edit Tilt in N→Curve)", icon="INFO")
        layout.separator()
        layout.label(text="F1 curbs:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_road_curb_width", text="Curb w")
        row.prop(scene, "hoverbike_road_curb_height", text="Curb h")
        layout.prop(scene, "hoverbike_road_curb_stripe_length", text="Stripe (m)")
        layout.separator()
        # Per-point conform — toggle whether a road segment grabs its Z from
        # the terrain (default) or floats at the bezier point's authored Z
        # (bridges, ramps over water). Stored in `weight_softbody` so it
        # survives copy/paste and is editable in Blender's N → Curve panel.
        layout.label(text="Per-point conform:")
        row = layout.row(align=True)
        row.operator("hoverbike.mark_selected_floating", text="Float", icon="ORIENTATION_VIEW")
        row.operator("hoverbike.mark_selected_conforming", text="Conform", icon="OUTLINER_OB_FORCE_FIELD")
        # Live readout of the active curve's float/conform mix
        active = context.active_object
        curve_for_readout = active if (active and active.type == "CURVE") else bpy.data.objects.get(ROAD_CURVE_NAME)
        if curve_for_readout is not None and curve_for_readout.data.splines:
            sp = curve_for_readout.data.splines[0]
            if sp.type == "BEZIER":
                pts = list(sp.bezier_points)
            else:
                pts = list(sp.points)
            n_total = len(pts)
            # weight_softbody stores float weight (1 = floating);
            # default 0 means conforming, so a point counts as floating
            # only when its weight is meaningfully above zero.
            n_float = sum(1 for p in pts if p.weight_softbody > 0.5)
            if n_total:
                layout.label(
                    text=f"{curve_for_readout.name}: {n_float}/{n_total} floating",
                    icon="INFO",
                )
        layout.separator()
        layout.operator("hoverbike.build_road", icon="MESH_PLANE")
        if bpy.data.objects.get(ROAD_CURVE_NAME):
            layout.label(text="Edit road_curve_main, then Build", icon="INFO")


class HOVERBIKE_PT_track_tunnels(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: tunnel through the terrain. Bezier curve along the
    intended path → Build → terrain gets a Boolean DIFFERENCE modifier
    against a cylindrical cutter + an inward-facing interior shell is
    spawned with ``kind="track"``. Default-closed since most tracks
    won't use it."""
    bl_label = "Tunnels"
    bl_idname = "HOVERBIKE_PT_track_tunnels"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        from .tunnel import TUNNEL_CURVE_NAME, TUNNEL_PARENT_PREFIX

        layout = self.layout
        scene = context.scene
        layout.operator("hoverbike.add_tunnel_starter_curve", icon="CURVE_BEZCURVE")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_tunnel_radius", text="Radius")
        row.prop(scene, "hoverbike_tunnel_wall_thickness", text="Wall")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_tunnel_samples", text="Samples")
        row.prop(scene, "hoverbike_tunnel_segments", text="Sides")
        layout.prop(scene, "hoverbike_tunnel_end_extend", text="End extend (m)")
        layout.operator("hoverbike.build_tunnel", icon="MESH_CYLINDER")
        if bpy.data.objects.get(TUNNEL_CURVE_NAME):
            layout.label(text="Edit tunnel_curve_main, then Build", icon="INFO")
        # Count existing tunnels for quick visual feedback.
        n_tunnels = sum(
            1 for o in bpy.data.objects
            if o.name.startswith(TUNNEL_PARENT_PREFIX) and o.name.endswith("_interior")
        )
        if n_tunnels > 0:
            layout.label(text=f"{n_tunnels} tunnel(s) built", icon="MOD_BOOLEAN")


class HOVERBIKE_PT_track_placement(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: persistent placement helper — a curve-constrained empty
    that the author parks at any (t, lateral offset) and uses as a
    placement anchor for ramps, boost pads, props, etc. Sliders re-pose
    live; one-click *Add Ramp at Helper* / *Add Boost at Helper* drop
    items at the helper's pose without needing to snap the cursor first.
    """
    bl_label = "Placement helper"
    bl_idname = "HOVERBIKE_PT_track_placement"

    def draw(self, context):
        from .placement_helper import PLACEMENT_HELPER_NAME

        layout = self.layout
        scene = context.scene
        helper = bpy.data.objects.get(PLACEMENT_HELPER_NAME)
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_helper_t", text="t")
        row.prop(scene, "hoverbike_helper_offset", text="Offset")
        row = layout.row(align=True)
        if helper is None:
            row.operator("hoverbike.add_placement_helper", icon="EMPTY_ARROWS")
        else:
            row.operator("hoverbike.add_placement_helper", text="Re-pose Helper", icon="FILE_REFRESH")
            row.operator("hoverbike.remove_placement_helper", text="", icon="X")
            layout.label(text=f"@ {helper.location.x:+.1f}, {helper.location.y:+.1f}, {helper.location.z:+.1f}",
                         icon="OBJECT_DATAMODE")
            layout.separator()
            layout.label(text="One-click drop:")
            layout.operator("hoverbike.cursor_to_helper", icon="PIVOT_CURSOR")
            row = layout.row(align=True)
            row.operator("hoverbike.add_ramp_at_helper", icon="ADD")
            row.operator("hoverbike.add_boost_pad_at_helper", icon="FORCE_FORCE")


class HOVERBIKE_PT_track_downtown(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: placeholder downtown city-block generator. Drops a
    parented grid of mid-rise tower meshes (kind="track") at the 3D
    cursor. Default-closed since most tracks won't use it."""
    bl_label = "Downtown"
    bl_idname = "HOVERBIKE_PT_track_downtown"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_blocks_x", text="X")
        row.prop(scene, "hoverbike_downtown_blocks_y", text="Y")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_block_size", text="Block")
        row.prop(scene, "hoverbike_downtown_street_width", text="Street")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_downtown_height_min", text="Min h")
        row.prop(scene, "hoverbike_downtown_height_max", text="Max h")
        layout.prop(scene, "hoverbike_downtown_seed", text="Seed")
        layout.prop(scene, "hoverbike_downtown_conform", text="Conform to terrain")
        layout.operator("hoverbike.add_downtown", icon="MESH_CUBE")
        layout.label(text="Spawns at the 3D cursor.", icon="INFO")


class HOVERBIKE_PT_track_ramps(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: simple wedge ramp. Three sliders set the next ramp's
    dimensions; clicking *Add Ramp* drops it at the 3D cursor.

    Each ramp is a parent empty (G/R/S to position/aim) plus a child
    mesh driven by the HV_Ramp Geometry-Nodes modifier. To resize a
    placed ramp, open its mesh's Modifiers tab and edit Length /
    Width / Height directly — the mesh re-evaluates live."""
    bl_label = "Ramps"
    bl_idname = "HOVERBIKE_PT_track_ramps"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_ramp_length", text="Length")
        row.prop(scene, "hoverbike_ramp_width", text="Width")
        layout.prop(scene, "hoverbike_ramp_height", text="Height")
        layout.operator("hoverbike.add_ramp", icon="ADD")
        layout.label(text="Edit Length/Width/Height on the", icon="INFO")
        layout.label(text="mesh's HV_Ramp modifier to resize.")


class HOVERBIKE_PT_track_terrain(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: heightmap import, sculpt entry-points, AO/path-wear
    bakers. Anything that touches the terrain mesh's geometry."""
    bl_label = "Terrain"
    bl_idname = "HOVERBIKE_PT_track_terrain"

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        layout.label(text="Heightmap import:", icon="IMAGE_DATA")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_heightmap_size", text="Size")
        row.prop(scene, "hoverbike_heightmap_subdivisions", text="Subdiv")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_heightmap_height", text="Δz (m)")
        row.prop(scene, "hoverbike_heightmap_base", text="Base z")
        layout.operator("hoverbike.import_heightmap", icon="IMPORT")
        layout.separator()

        layout.label(text="Sculpt:", icon="SCULPTMODE_HLT")
        layout.operator("hoverbike.apply_terrain_modifiers", icon="MODIFIER_DATA")
        layout.operator("hoverbike.subdivide_terrain", icon="MOD_SUBSURF")
        layout.operator("hoverbike.enter_sculpt_mode", icon="BRUSH_DATA")
        layout.separator()

        layout.label(text="Bulk shape @ cursor:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sculpt_radius", text="Radius (m)")
        row.prop(scene, "hoverbike_sculpt_magnitude", text="Δz (m)")
        row = layout.row(align=True)
        op_up = row.operator("hoverbike.raise_lower_terrain", text="Raise", icon="TRIA_UP")
        op_up.lower = False
        op_dn = row.operator("hoverbike.raise_lower_terrain", text="Lower", icon="TRIA_DOWN")
        op_dn.lower = True
        layout.separator()

        layout.label(text="Smooth:", icon="MOD_SMOOTH")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_sculpt_smooth_iters", text="Iters")
        row.prop(scene, "hoverbike_sculpt_smooth_weight", text="Weight")
        layout.operator("hoverbike.smooth_terrain", icon="MOD_SMOOTH")
        layout.separator()

        layout.label(text="Vertex bakes:", icon="MATERIAL")
        layout.label(text="Fills baked_ao + baked_path", icon="NODE_TEXTURE")
        layout.operator("hoverbike.bake_terrain_attrs", icon="MOD_NOISE")


class HOVERBIKE_PT_track_water(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: sea-level slider (proxies water_volume_main.z) + the
    Gerstner-wave preview plane controls."""
    bl_label = "Water"
    bl_idname = "HOVERBIKE_PT_track_water"

    def draw(self, context):
        from .water import WATER_VOLUME_NAME

        layout = self.layout
        scene = context.scene
        if bpy.data.objects.get(WATER_VOLUME_NAME) is None:
            layout.label(text="No water_volume_main", icon="ERROR")
            layout.operator("hoverbike.add_water_volume", icon="ADD")
        else:
            layout.prop(scene, "hoverbike_water_height", text="Sea level (m)")
        layout.separator()
        layout.label(text="Wave preview:", icon="HIDE_OFF")
        layout.prop(scene, "hoverbike_water_size", text="Size (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_water_subdivisions", text="Subdiv")
        row.prop(scene, "hoverbike_water_time", text="Time (s)")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_water_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_water_preview", icon="HIDE_ON")


class HOVERBIKE_PT_track_gameplay(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: gates + boost pads + racers + turn indicators. The
    high-level "what does the player interact with" placement section."""
    bl_label = "Gameplay"
    bl_idname = "HOVERBIKE_PT_track_gameplay"

    def draw(self, context):
        from .previews import GATE_PREVIEW_COLLECTION

        layout = self.layout
        scene = context.scene

        layout.label(text="Gates:", icon="MOD_ARRAY")
        layout.prop(scene, "hoverbike_gate_spacing", text="Spacing (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_gate_half_width", text="Half-width")
        row.prop(scene, "hoverbike_gate_height", text="Height")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_gate_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_gate_preview", icon="HIDE_ON")
        # Gate authoring model: the spline is the source of truth. The
        # export step re-samples `ai_spline_main` at this spacing on every
        # Export Track to Game, so nothing in the .blend "freezes" gate
        # positions — they always reflect the latest spline shape. The
        # preview is the canonical visualisation. Authors who need a
        # hand-placed gate (e.g. just past a jump where arc length puts
        # it in the wrong spot) drop a `cp_NN` empty and that takes over
        # for the whole array.
        n_cp = sum(1 for obj in bpy.data.objects if re.match(r"^cp_\d+$", obj.name))
        if n_cp > 0:
            layout.label(
                text=f"Override: {n_cp} cp_NN empties win over the spline",
                icon="ANCHOR_TOP",
            )
            layout.operator(
                "hoverbike.demote_gates_to_spline",
                text="Demote to Spline (wipe cp_NN)",
                icon="X",
            )
        elif bpy.data.collections.get(GATE_PREVIEW_COLLECTION):
            layout.label(text="Spline-driven, live preview", icon="LINKED")
        else:
            layout.label(text="Spline-driven; click Rebuild to preview", icon="INFO")
        # Pin-to-empty button — works whether you're spline-driven or
        # already overriding; in spline-driven mode it forks into
        # editable empties so you can tweak one corner, in override
        # mode it re-stamps from the current spline.
        layout.operator(
            "hoverbike.materialize_gates_to_cp_empties",
            text=("Re-stamp from Spline" if n_cp > 0 else "Materialise to cp_NN (for hand-edit)"),
            icon="OUTLINER_OB_EMPTY",
        )
        layout.separator()

        layout.label(text="Boost pads:", icon="FORCE_FORCE")
        layout.operator("hoverbike.add_boost_pad", icon="ADD")
        n_pads = sum(
            1 for obj in bpy.data.objects if re.match(r"^boost_(\d+)$", obj.name)
        )
        if n_pads > 0:
            layout.label(text=f"{n_pads} pad(s) — drag, R to aim")
            layout.operator("hoverbike.refresh_boost_pads", icon="FILE_REFRESH")
            layout.label(text="Custom Properties tunes each pad", icon="INFO")
        layout.separator()

        layout.label(text="Racer preview:", icon="AUTO")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_racer_preview", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_racer_preview", icon="HIDE_ON")
        layout.separator()

        layout.label(text="Turn indicators:", icon="TRACKING_FORWARDS")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_turn_kappa", text="|κ| min (1/m)")
        row.prop(scene, "hoverbike_turn_min_spacing", text="Spacing (m)")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_turn_indicators", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_turn_indicators", icon="HIDE_ON")


class HOVERBIKE_PT_track_ghost(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: ghost-lap preview cinematic. Default-closed since it's
    a once-per-session 'play the lap to feel it' tool, not part of the
    core authoring loop."""
    bl_label = "Ghost lap + chase cam"
    bl_idname = "HOVERBIKE_PT_track_ghost"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_ghost_speed", text="Speed (m/s)")
        row.prop(scene, "hoverbike_ghost_fps", text="FPS")
        row = layout.row(align=True)
        row.operator("hoverbike.rebuild_ghost_lap", icon="FILE_REFRESH")
        row.operator("hoverbike.hide_ghost_lap", icon="HIDE_ON")
        layout.label(text="Press Spacebar to fly the lap", icon="PLAY")


class HOVERBIKE_PT_track_shader(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: runtime terrain-shader knobs that round-trip through
    `terrainShader` in the JSON. Default-closed since these are usually
    set once per track."""
    bl_label = "Terrain shader (runtime)"
    bl_idname = "HOVERBIKE_PT_track_shader"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_alt_min", text="Alt min")
        row.prop(scene, "hoverbike_shader_alt_max", text="Alt max")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_slope_start", text="Slope start")
        row.prop(scene, "hoverbike_shader_slope_end", text="Slope end")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_variation", text="Variation")
        row.prop(scene, "hoverbike_shader_wet_band", text="Wet band")
        layout.label(text="Path tint:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_path_tint_r", text="R")
        row.prop(scene, "hoverbike_shader_path_tint_g", text="G")
        row.prop(scene, "hoverbike_shader_path_tint_b", text="B")
        layout.separator()
        layout.label(text="Detail / variation:")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_macro_scale", text="Macro (m)")
        row.prop(scene, "hoverbike_shader_micro_scale", text="Micro (m)")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_warp_strength", text="Warp")
        row.prop(scene, "hoverbike_shader_alt_jitter", text="Alt jitter")
        row = layout.row(align=True)
        row.prop(scene, "hoverbike_shader_scree_band", text="Scree")
        row.prop(scene, "hoverbike_shader_triplanar", text="Triplanar")
        layout.prop(scene, "hoverbike_shader_saturation", text="Saturation")


class HOVERBIKE_PT_track_stats(_HoverbikeTrackSubPanelBase, Panel):
    """Sub-panel: read-only counts + spline-length / lap-time estimate +
    terrain min/max + water coverage. Helpful for sanity-checking before
    export. Default-closed."""
    bl_label = "Track stats"
    bl_idname = "HOVERBIKE_PT_track_stats"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        from .track_meta import _spline_arc_length

        layout = self.layout
        sp = bpy.data.objects.get("ai_spline_main")
        arc_len = _spline_arc_length(sp) if sp else 0.0
        lap_25 = arc_len / 25.0 if arc_len > 0 else 0.0
        layout.label(text=f"Spline length: {arc_len:,.1f} m")
        layout.label(text=f"Lap estimate @25 m/s: {lap_25:.1f} s")
        counts = {"starts": 0, "checkpoints": 0, "pickups": 0, "boosts": 0}
        for obj in context.scene.objects:
            n = obj.name
            if n.startswith("start_"): counts["starts"] += 1
            elif n.startswith("cp_"): counts["checkpoints"] += 1
            elif n.startswith("pickup"): counts["pickups"] += 1
            elif n.startswith("boost") and "_gizmo" not in n: counts["boosts"] += 1
        row = layout.row(align=True)
        row.label(text=f"Starts: {counts['starts']}")
        row.label(text=f"Gates: {counts['checkpoints']}")
        row = layout.row(align=True)
        row.label(text=f"Pickups: {counts['pickups']}")
        row.label(text=f"Boosts: {counts['boosts']}")
        scn = context.scene
        zmin = scn.get("_hoverbike_stats_terrain_min_y")
        zmax = scn.get("_hoverbike_stats_terrain_max_y")
        frac = scn.get("_hoverbike_stats_terrain_water_frac")
        if zmin is not None and zmax is not None and frac is not None:
            layout.label(text=f"Terrain y: [{float(zmin):,.1f}, {float(zmax):,.1f}] m")
            layout.label(text=f"Water coverage: {float(frac) * 100:.0f}%")
        else:
            layout.label(text="Terrain y / water: refresh below", icon="QUESTION")
        layout.operator("hoverbike.refresh_track_stats", icon="FILE_REFRESH")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_PT_panel,
    HOVERBIKE_PT_track_spline,
    HOVERBIKE_PT_track_placement,
    HOVERBIKE_PT_track_road,
    HOVERBIKE_PT_track_tunnels,
    HOVERBIKE_PT_track_ramps,
    HOVERBIKE_PT_track_downtown,
    HOVERBIKE_PT_track_terrain,
    HOVERBIKE_PT_track_water,
    HOVERBIKE_PT_track_gameplay,
    HOVERBIKE_PT_track_ghost,
    HOVERBIKE_PT_track_shader,
    HOVERBIKE_PT_track_stats,
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
